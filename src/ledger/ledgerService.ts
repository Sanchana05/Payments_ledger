import type { Pool, PoolClient } from 'pg';
import { withTransaction, type TxOptions } from '../db/pool';
import {
  IdempotencyConflictError,
  NotFoundError,
  StaleStateError,
  UnbalancedTransactionError,
  translatePgError,
} from './errors';
import { requestHash } from './hash';
import type {
  AccountType,
  AuthorizeInput,
  ClearingInput,
  Direction,
  DisputeStatus,
  EntryInput,
  PartyType,
  PlatformAccounts,
  PostResult,
  PostTransactionInput,
  SettleResult,
} from './types';

const cmpBig = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);
const cmpDir = (a: Direction, b: Direction): number => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Deterministic lock ordering: every multi-row write path sorts by account_id ASC (then
 * direction) before touching rows. Two transactions that need accounts {A,B} therefore
 * always acquire A before B, so they can queue behind each other but never deadlock.
 */
export function sortEntries(entries: EntryInput[]): EntryInput[] {
  return [...entries].sort((x, y) => cmpBig(x.accountId, y.accountId) || cmpDir(x.direction, y.direction));
}

/** Cheap client-side fast-fail. The database remains the authority (trg_assert_balanced). */
export function assertBalancedClientSide(entries: EntryInput[]): void {
  if (entries.length < 2) throw new UnbalancedTransactionError('a transaction needs at least 2 entries');
  let debits = 0n;
  let credits = 0n;
  for (const e of entries) {
    if (e.amountMinor <= 0n) throw new UnbalancedTransactionError('entry amounts must be positive');
    if (e.direction === 'D') debits += e.amountMinor;
    else credits += e.amountMinor;
  }
  if (debits !== credits) {
    throw new UnbalancedTransactionError(`debits ${debits} != credits ${credits}`);
  }
}

export class LedgerService {
  constructor(private readonly pool: Pool) {}

  /** Runs a unit of work in a retrying transaction and surfaces DB rejections as domain errors. */
  private async run<T>(fn: (c: PoolClient) => Promise<T>, opts?: TxOptions): Promise<T> {
    try {
      return await withTransaction(this.pool, fn, opts);
    } catch (err) {
      throw translatePgError(err);
    }
  }

  // parties & accounts

  async createParty(input: { legalName: string; partyType: PartyType; countryCode: string }): Promise<bigint> {
    const r = await this.pool.query(
      'INSERT INTO parties (legal_name, party_type, country_code) VALUES ($1, $2, $3) RETURNING party_id',
      [input.legalName, input.partyType, input.countryCode],
    );
    return r.rows[0].party_id as bigint;
  }

  private async createAccountTx(
    c: PoolClient,
    input: { partyId: bigint; accountType: AccountType; currency: string; minBalanceMinor?: bigint | null },
  ): Promise<bigint> {
    // Get-or-create (natural key). The no-op DO UPDATE is what makes RETURNING work on conflict.
    const r = await c.query(
      `INSERT INTO accounts (party_id, account_type, currency, min_balance_minor)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (party_id, account_type, currency) DO UPDATE SET status = accounts.status
       RETURNING account_id`,
      [input.partyId, input.accountType, input.currency, input.minBalanceMinor ?? null],
    );
    const id = r.rows[0].account_id as bigint;
    // Every account owns a balance row from birth, so the balance trigger always takes the
    // UPDATE path and explicit FOR UPDATE locks always have a row to lock.
    await c.query('INSERT INTO account_balances (account_id) VALUES ($1) ON CONFLICT DO NOTHING', [id]);
    return id;
  }

  async createAccount(input: {
    partyId: bigint;
    accountType: AccountType;
    currency: string;
    minBalanceMinor?: bigint | null;
  }): Promise<bigint> {
    return this.run((c) => this.createAccountTx(c, input));
  }

  /** Idempotently creates the platform party and its three system accounts for a currency. */
  async bootstrapPlatform(currency: string): Promise<PlatformAccounts> {
    return this.run(async (c) => {
      const p = await c.query(
        `INSERT INTO parties (legal_name, party_type, country_code)
         VALUES ('Platform', 'platform', 'US')
         ON CONFLICT (party_type) WHERE party_type = 'platform'
         DO UPDATE SET legal_name = parties.legal_name
         RETURNING party_id`,
      );
      const partyId = p.rows[0].party_id as bigint;
      const mk = (accountType: AccountType) => this.createAccountTx(c, { partyId, accountType, currency });
      return {
        partyId,
        networkReceivable: await mk('network_receivable'),
        platformCash: await mk('platform_cash'),
        feeRevenue: await mk('fee_revenue'),
      };
    });
  }

  private async systemAccount(c: PoolClient, accountType: AccountType, currency: string): Promise<bigint> {
    const r = await c.query(
      `SELECT a.account_id
         FROM accounts a JOIN parties p ON p.party_id = a.party_id
        WHERE p.party_type = 'platform' AND a.account_type = $1 AND a.currency = $2
        ORDER BY a.account_id LIMIT 1`,
      [accountType, currency],
    );
    if (r.rowCount === 0) throw new NotFoundError(`no platform ${accountType} account for ${currency}; call bootstrapPlatform`);
    return r.rows[0].account_id as bigint;
  }

  // balances

  /** O(1) read of the denormalized cache. */
  async getBalance(accountId: bigint): Promise<bigint> {
    const r = await this.pool.query('SELECT balance_minor FROM account_balances WHERE account_id = $1', [accountId]);
    return r.rowCount ? (r.rows[0].balance_minor as bigint) : 0n;
  }

  /** O(entries) authoritative recomputation, expressed on the account's normal side. */
  async getBalanceFromEntries(accountId: bigint): Promise<bigint> {
    const r = await this.pool.query(
      `SELECT COALESCE(sum(CASE WHEN e.direction = t.normal_side THEN e.amount_minor ELSE -e.amount_minor END), 0)::bigint AS bal
         FROM accounts a
         JOIN account_types t ON t.account_type = a.account_type
         LEFT JOIN ledger_entries e ON e.account_id = a.account_id
        WHERE a.account_id = $1`,
      [accountId],
    );
    return r.rows[0].bal as bigint;
  }


  async lockAccounts(c: PoolClient, accountIds: bigint[]): Promise<void> {
    const sorted = [...new Set(accountIds)].sort(cmpBig);
    await c.query(
      'SELECT account_id FROM account_balances WHERE account_id = ANY($1::bigint[]) ORDER BY account_id ASC FOR UPDATE',
      [sorted],
    );
  }

  // posting core


  async postTransactionTx(c: PoolClient, input: PostTransactionInput): Promise<PostResult> {
    assertBalancedClientSide(input.entries);
    const entries = sortEntries(input.entries);
    const hash = requestHash({
      kind: input.kind,
      settlementDate: input.settlementDate,
      clearingId: input.clearingId ?? null,
      batchId: input.batchId ?? null,
      disputeId: input.disputeId ?? null,
      entries: entries.map((e) => [e.accountId, e.direction, e.amountMinor]),
    });

    const ins = await c.query(
      `INSERT INTO ledger_transactions (idempotency_key, request_hash, kind, settlement_date, clearing_id, batch_id, dispute_id)
       VALUES ($1, $2, $3, $4::date, $5, $6, $7)
       ON CONFLICT (idempotency_key) DO NOTHING
       RETURNING transaction_id`,
      [input.idempotencyKey, hash, input.kind, input.settlementDate, input.clearingId ?? null, input.batchId ?? null, input.disputeId ?? null],
    );

    if (ins.rowCount === 0) {
      const ex = await c.query('SELECT transaction_id, request_hash FROM ledger_transactions WHERE idempotency_key = $1', [
        input.idempotencyKey,
      ]);
      if (ex.rows[0].request_hash !== hash) throw new IdempotencyConflictError(`idempotency key ${input.idempotencyKey} reused with a different payload`);
      return { transactionId: ex.rows[0].transaction_id as bigint, replayed: true };
    }

    const transactionId = ins.rows[0].transaction_id as bigint;
    // Set-based insert (array params avoid the 65k bind-parameter limit on big settlement
    // batches). ORDER BY makes row insertion - and therefore the balance-trigger row locks -
    // follow ascending account_id.
    await c.query(
      `INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, settlement_date)
       SELECT $1::bigint, e.account_id, e.direction, e.amount_minor, $5::date
         FROM unnest($2::bigint[], $3::text[], $4::bigint[]) AS e(account_id, direction, amount_minor)
        ORDER BY e.account_id, e.direction`,
      [transactionId, entries.map((e) => e.accountId), entries.map((e) => e.direction), entries.map((e) => e.amountMinor), input.settlementDate],
    );
    return { transactionId, replayed: false };
  }

  async postTransaction(input: PostTransactionInput, opts?: TxOptions): Promise<PostResult> {
    return this.run((c) => this.postTransactionTx(c, input), opts);
  }

  /** Wallet-to-wallet transfer. Locks both balance rows in ascending id order first. */
  async transfer(input: {
    idempotencyKey: string;
    fromAccountId: bigint;
    toAccountId: bigint;
    amountMinor: bigint;
    settlementDate?: string;
  }): Promise<PostResult> {
    if (input.fromAccountId === input.toAccountId) throw new UnbalancedTransactionError('cannot transfer to the same account');
    return this.run(async (c) => {
      await this.lockAccounts(c, [input.fromAccountId, input.toAccountId]);
      const date = input.settlementDate ?? (await c.query('SELECT current_date::text AS d')).rows[0].d;
      return this.postTransactionTx(c, {
        idempotencyKey: input.idempotencyKey,
        kind: 'transfer',
        settlementDate: date,
        entries: [
          { accountId: input.fromAccountId, direction: 'D', amountMinor: input.amountMinor },
          { accountId: input.toAccountId, direction: 'C', amountMinor: input.amountMinor },
        ],
      });
    });
  }

  // authorization & clearing

  async authorize(input: AuthorizeInput): Promise<{ authorizationId: bigint; replayed: boolean }> {
    const hash = requestHash({
      networkRef: input.networkRef,
      merchantAccountId: input.merchantAccountId,
      cardholderPartyId: input.cardholderPartyId,
      amountMinor: input.amountMinor,
    });
    return this.run(async (c) => {
      const ins = await c.query(
        `INSERT INTO authorizations (idempotency_key, request_hash, network_ref, merchant_account_id, cardholder_party_id, amount_minor)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING authorization_id`,
        [input.idempotencyKey, hash, input.networkRef, input.merchantAccountId, input.cardholderPartyId, input.amountMinor],
      );
      if (ins.rowCount === 1) return { authorizationId: ins.rows[0].authorization_id as bigint, replayed: false };
      const ex = await c.query('SELECT authorization_id, request_hash FROM authorizations WHERE idempotency_key = $1', [input.idempotencyKey]);
      if (ex.rows[0].request_hash !== hash) throw new IdempotencyConflictError(`idempotency key ${input.idempotencyKey} reused with a different payload`);
      return { authorizationId: ex.rows[0].authorization_id as bigint, replayed: true };
    });
  }

  /** Records a line from the network clearing file. The network reference is the natural idempotency key. */
  async recordClearing(input: ClearingInput): Promise<{ clearingId: bigint; replayed: boolean }> {
    return this.run(async (c) => {
      const ins = await c.query(
        `INSERT INTO clearing_records (network_ref, merchant_account_id, amount_minor, fee_minor, cleared_at)
         VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now()))
         ON CONFLICT (network_ref) DO NOTHING
         RETURNING clearing_id`,
        [input.networkRef, input.merchantAccountId, input.amountMinor, input.feeMinor, input.clearedAt ?? null],
      );
      if (ins.rowCount === 1) return { clearingId: ins.rows[0].clearing_id as bigint, replayed: false };
      const ex = await c.query(
        'SELECT clearing_id, merchant_account_id, amount_minor, fee_minor FROM clearing_records WHERE network_ref = $1',
        [input.networkRef],
      );
      const row = ex.rows[0];
      if (row.merchant_account_id !== input.merchantAccountId || row.amount_minor !== input.amountMinor || row.fee_minor !== input.feeMinor) {
        throw new IdempotencyConflictError(`clearing ${input.networkRef} already recorded with different values`);
      }
      return { clearingId: row.clearing_id as bigint, replayed: true };
    });
  }

  
  async postClearing(clearingId: bigint): Promise<PostResult> {
    return this.run(async (c) => {
      const r = await c.query(
        `SELECT cr.merchant_account_id, cr.amount_minor, cr.fee_minor, a.currency, cr.cleared_at::date::text AS d
           FROM clearing_records cr JOIN accounts a ON a.account_id = cr.merchant_account_id
          WHERE cr.clearing_id = $1`,
        [clearingId],
      );
      if (r.rowCount === 0) throw new NotFoundError(`clearing record ${clearingId} not found`);
      const row = r.rows[0];
      const amount = row.amount_minor as bigint;
      const fee = row.fee_minor as bigint;
      const net = amount - fee;
      const entries: EntryInput[] = [
        { accountId: await this.systemAccount(c, 'network_receivable', row.currency), direction: 'D', amountMinor: amount },
      ];
      if (net > 0n) entries.push({ accountId: row.merchant_account_id as bigint, direction: 'C', amountMinor: net });
      if (fee > 0n) entries.push({ accountId: await this.systemAccount(c, 'fee_revenue', row.currency), direction: 'C', amountMinor: fee });
      return this.postTransactionTx(c, {
        idempotencyKey: `clearing:${clearingId}`,
        kind: 'clearing',
        settlementDate: row.d as string,
        clearingId,
        entries,
      });
    });
  }

  // settlement

  async createBatch(settlementDate: string, currency: string): Promise<bigint> {
    return this.run(async (c) => {
      const r = await c.query(
        `INSERT INTO settlement_batches (settlement_date, currency) VALUES ($1::date, $2)
         ON CONFLICT (settlement_date, currency) DO UPDATE SET status = settlement_batches.status
         RETURNING batch_id`,
        [settlementDate, currency],
      );
      return r.rows[0].batch_id as bigint;
    });
  }


  async settleBatch(batchId: bigint): Promise<SettleResult> {
    return this.run(async (c) => {
      const b = await c.query(
        'SELECT settlement_date::text AS d, currency, status FROM settlement_batches WHERE batch_id = $1 FOR UPDATE',
        [batchId],
      );
      if (b.rowCount === 0) throw new NotFoundError(`settlement batch ${batchId} not found`);
      const { d, currency, status } = b.rows[0] as { d: string; currency: string; status: string };

      if (status !== 'open') {
        const t = await c.query("SELECT transaction_id FROM ledger_transactions WHERE batch_id = $1 AND kind = 'settlement'", [batchId]);
        const cnt = await c.query('SELECT count(*)::int AS n FROM clearing_records WHERE settlement_batch_id = $1', [batchId]);
        return {
          batchId,
          itemCount: cnt.rows[0].n as number,
          totalNetMinor: 0n,
          transactionId: t.rowCount ? (t.rows[0].transaction_id as bigint) : null,
          alreadyPosted: true,
        };
      }

      const claimed = await c.query(
        `SELECT cr.clearing_id
           FROM clearing_records cr
           JOIN accounts a ON a.account_id = cr.merchant_account_id
          WHERE cr.settlement_batch_id IS NULL
            AND a.currency = $1
            AND cr.cleared_at < ($2::date + 1)
            AND EXISTS (SELECT 1 FROM ledger_transactions lt WHERE lt.clearing_id = cr.clearing_id AND lt.kind = 'clearing')
          ORDER BY cr.clearing_id
          FOR UPDATE OF cr SKIP LOCKED`,
        [currency, d],
      );
      const ids = claimed.rows.map((r) => r.clearing_id as bigint);

      let transactionId: bigint | null = null;
      let total = 0n;
      if (ids.length > 0) {
        await c.query('UPDATE clearing_records SET settlement_batch_id = $1 WHERE clearing_id = ANY($2::bigint[])', [batchId, ids]);

        const per = await c.query(
          `SELECT merchant_account_id, sum(amount_minor - fee_minor)::bigint AS net
             FROM clearing_records WHERE settlement_batch_id = $1
            GROUP BY merchant_account_id HAVING sum(amount_minor - fee_minor) > 0`,
          [batchId],
        );
        const entries: EntryInput[] = per.rows.map((r) => {
          total += r.net as bigint;
          return { accountId: r.merchant_account_id as bigint, direction: 'D' as const, amountMinor: r.net as bigint };
        });
        if (total > 0n) {
          entries.push({ accountId: await this.systemAccount(c, 'platform_cash', currency), direction: 'C', amountMinor: total });
          transactionId = (
            await this.postTransactionTx(c, {
              idempotencyKey: `settlement:batch:${batchId}`,
              kind: 'settlement',
              settlementDate: d,
              batchId,
              entries,
            })
          ).transactionId;
        }
      }

      await c.query("UPDATE settlement_batches SET status = 'posted' WHERE batch_id = $1", [batchId]);
      return { batchId, itemCount: ids.length, totalNetMinor: total, transactionId, alreadyPosted: false };
    });
  }

  async closeBatch(batchId: bigint): Promise<void> {
    await this.run(async (c) => {
      await c.query("UPDATE settlement_batches SET status = 'closed' WHERE batch_id = $1", [batchId]);
    });
  }

  // disputes

  async raiseDispute(input: {
    idempotencyKey: string;
    clearingId: bigint;
    amountMinor: bigint;
    reasonCode: string;
    actor: string;
  }): Promise<{ disputeId: bigint; replayed: boolean }> {
    const hash = requestHash({ clearingId: input.clearingId, amountMinor: input.amountMinor, reasonCode: input.reasonCode });
    return this.run(async (c) => {
      await c.query("SELECT set_config('app.actor', $1, true), set_config('app.note', '', true)", [input.actor]);
      const ins = await c.query(
        `INSERT INTO disputes (idempotency_key, request_hash, clearing_id, reason_code, amount_minor)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING dispute_id`,
        [input.idempotencyKey, hash, input.clearingId, input.reasonCode, input.amountMinor],
      );
      if (ins.rowCount === 1) return { disputeId: ins.rows[0].dispute_id as bigint, replayed: false };
      const ex = await c.query('SELECT dispute_id, request_hash FROM disputes WHERE idempotency_key = $1', [input.idempotencyKey]);
      if (ex.rows[0].request_hash !== hash) throw new IdempotencyConflictError(`idempotency key ${input.idempotencyKey} reused with a different payload`);
      return { disputeId: ex.rows[0].dispute_id as bigint, replayed: true };
    });
  }


  async transitionDispute(input: {
    disputeId: bigint;
    from: DisputeStatus;
    to: DisputeStatus;
    actor: string;
    note?: string;
  }): Promise<{ status: DisputeStatus; chargebackTransactionId: bigint | null }> {
    return this.run(async (c) => {
      await c.query("SELECT set_config('app.actor', $1, true), set_config('app.note', $2, true)", [input.actor, input.note ?? '']);
      const upd = await c.query(
        'UPDATE disputes SET status = $2 WHERE dispute_id = $1 AND status = $3 RETURNING clearing_id, amount_minor',
        [input.disputeId, input.to, input.from],
      );
      if (upd.rowCount === 0) {
        const exists = await c.query('SELECT status FROM disputes WHERE dispute_id = $1', [input.disputeId]);
        if (exists.rowCount === 0) throw new NotFoundError(`dispute ${input.disputeId} not found`);
        throw new StaleStateError(`dispute ${input.disputeId} is ${exists.rows[0].status}, expected ${input.from}`);
      }

      let chargebackTransactionId: bigint | null = null;
      if (input.to === 'lost') {
        const { clearing_id, amount_minor } = upd.rows[0] as { clearing_id: bigint; amount_minor: bigint };
        const m = await c.query(
          `SELECT cr.merchant_account_id, a.currency, current_date::text AS d
             FROM clearing_records cr JOIN accounts a ON a.account_id = cr.merchant_account_id
            WHERE cr.clearing_id = $1`,
          [clearing_id],
        );
        const { merchant_account_id, currency, d } = m.rows[0] as { merchant_account_id: bigint; currency: string; d: string };
        chargebackTransactionId = (
          await this.postTransactionTx(c, {
            idempotencyKey: `chargeback:dispute:${input.disputeId}`,
            kind: 'chargeback',
            settlementDate: d,
            disputeId: input.disputeId,
            entries: [
              { accountId: merchant_account_id, direction: 'D', amountMinor: amount_minor },
              { accountId: await this.systemAccount(c, 'network_receivable', currency), direction: 'C', amountMinor: amount_minor },
            ],
          })
        ).transactionId;
      }
      return { status: input.to, chargebackTransactionId };
    });
  }
}
