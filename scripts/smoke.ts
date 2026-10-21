import assert from 'assert';
import {
  LedgerService, createPool, retryStats, resetRetryStats, reconciliationReport, agingSummary,
  IdempotencyConflictError, InsufficientFundsError, IllegalTransitionError, StaleStateError,
} from '../src';

const pool = createPool(process.env.DATABASE_URL, 30);
const svc = new LedgerService(pool);
let passed = 0;
const ok = (name: string) => { passed++; console.log('  ok  ' + name); };

async function sqlState(fn: () => Promise<unknown>): Promise<string> {
  try { await fn(); } catch (e) { return (e as { code?: string }).code ?? 'NOCODE'; }
  return 'NO_ERROR';
}
async function tx(fn: (c: import('pg').PoolClient) => Promise<void>): Promise<void> {
  const c = await pool.connect();
  try { await c.query('BEGIN'); await fn(c); await c.query('COMMIT'); }
  catch (e) { await c.query('ROLLBACK').catch(() => undefined); throw e; }
  finally { c.release(); }
}

async function main() {
  const plat = await svc.bootstrapPlatform('USD');
  const merchant = await svc.createParty({ legalName: 'Acme Coffee', partyType: 'merchant', countryCode: 'US' });
  const mAcct = await svc.createAccount({ partyId: merchant, accountType: 'merchant_payable', currency: 'USD' });
  const holder = await svc.createParty({ legalName: 'Jane Doe', partyType: 'cardholder', countryCode: 'US' });

  // happy path
  const a1 = await svc.authorize({ idempotencyKey: 'auth-1', networkRef: 'NR-1', merchantAccountId: mAcct, cardholderPartyId: holder, amountMinor: 10_000n });
  const a1r = await svc.authorize({ idempotencyKey: 'auth-1', networkRef: 'NR-1', merchantAccountId: mAcct, cardholderPartyId: holder, amountMinor: 10_000n });
  assert.equal(a1r.replayed, true); assert.equal(a1r.authorizationId, a1.authorizationId); ok('authorize idempotent replay');
  await assert.rejects(svc.authorize({ idempotencyKey: 'auth-1', networkRef: 'NR-1', merchantAccountId: mAcct, cardholderPartyId: holder, amountMinor: 999n }), IdempotencyConflictError);
  ok('idempotency key reuse with different payload rejected');

  const c1 = await svc.recordClearing({ networkRef: 'NR-1', merchantAccountId: mAcct, amountMinor: 10_000n, feeMinor: 290n });
  const p1 = await svc.postClearing(c1.clearingId);
  const p1r = await svc.postClearing(c1.clearingId);
  assert.equal(p1.replayed, false); assert.equal(p1r.replayed, true); assert.equal(p1r.transactionId, p1.transactionId);
  assert.equal(await svc.getBalance(mAcct), 9_710n);
  assert.equal(await svc.getBalance(plat.feeRevenue), 290n);
  assert.equal(await svc.getBalance(plat.networkReceivable), 10_000n);
  ok('clearing posted once; balances 9710 / fee 290 / receivable 10000');

  const batch = await svc.createBatch(new Date().toISOString().slice(0, 10), 'USD');
  const s1 = await svc.settleBatch(batch);
  assert.equal(s1.itemCount, 1); assert.equal(s1.totalNetMinor, 9_710n); assert.equal(s1.alreadyPosted, false);
  const s2 = await svc.settleBatch(batch);
  assert.equal(s2.alreadyPosted, true);
  assert.equal(await svc.getBalance(mAcct), 0n);
  assert.equal(await svc.getBalance(plat.platformCash), -9_710n);
  ok('settlement posted once, replay is a no-op, merchant payable drained');

 
  assert.equal(await sqlState(() => pool.query('UPDATE ledger_entries SET amount_minor = 1 WHERE entry_id = 1')), 'LG003'); ok('UPDATE ledger_entries blocked (LG003)');
  assert.equal(await sqlState(() => pool.query('DELETE FROM ledger_entries')), 'LG003'); ok('DELETE ledger_entries blocked (LG003)');
  assert.equal(await sqlState(() => pool.query('TRUNCATE ledger_entries')), 'LG003'); ok('TRUNCATE ledger_entries blocked (LG003)');
  assert.equal(await sqlState(() => pool.query('UPDATE ledger_transactions SET kind = $1', ['adjustment'])), 'LG003'); ok('UPDATE ledger_transactions blocked (LG003)');

  assert.equal(await sqlState(() => tx(async (c) => {
    const t = await c.query("INSERT INTO ledger_transactions (idempotency_key, request_hash, kind, settlement_date) VALUES ('raw-unbal','h','adjustment', current_date) RETURNING transaction_id");
    await c.query("INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, settlement_date) VALUES ($1,$2,'D',100,current_date),($1,$3,'C',99,current_date)", [t.rows[0].transaction_id, plat.platformCash, plat.feeRevenue]);
  })), 'LG004'); ok('unbalanced transaction rejected at COMMIT (LG004)');

  assert.equal(await sqlState(() => tx(async (c) => {
    const t = await c.query("INSERT INTO ledger_transactions (idempotency_key, request_hash, kind, settlement_date) VALUES ('raw-empty','h','adjustment', current_date) RETURNING transaction_id");
    void t;
  })), 'LG004'); ok('transaction with zero entries rejected at COMMIT (LG004)');

  assert.equal(await sqlState(() => pool.query("INSERT INTO ledger_entries (transaction_id, account_id, direction, amount_minor, settlement_date) VALUES ($1,$2,'D',5,current_date)", [p1.transactionId, plat.platformCash])), 'LG003');
  ok('entry appended to an already-committed transaction rejected (LG003)');

  assert.equal(await sqlState(() => pool.query('UPDATE clearing_records SET settlement_batch_id = $1, settled_at = now() WHERE clearing_id = $2', [batch, c1.clearingId])), 'LG001');
  ok('settling an already-settled item rejected (LG001)');
  assert.equal(await sqlState(() => pool.query("UPDATE clearing_records SET settlement_batch_id = NULL, settled_at = NULL WHERE clearing_id = $1", [c1.clearingId])), 'LG001');
  ok('un-settling an item rejected (LG001)');
  assert.equal(await sqlState(() => pool.query("UPDATE settlement_batches SET status = 'open' WHERE batch_id = $1", [batch])), 'LG002'); ok('batch cannot move backwards (LG002)');

  const dupKey = await sqlState(() => pool.query("INSERT INTO ledger_transactions (idempotency_key, request_hash, kind, settlement_date, clearing_id) VALUES ('other-key','h','clearing', current_date, $1)", [c1.clearingId]));
  assert.equal(dupKey, '23505'); ok('second clearing posting under a different key blocked by partial unique index');

  // disputes
  const c2 = await svc.recordClearing({ networkRef: 'NR-2', merchantAccountId: mAcct, amountMinor: 5_000n, feeMinor: 0n });
  await svc.postClearing(c2.clearingId);
  const d = await svc.raiseDispute({ idempotencyKey: 'disp-1', clearingId: c2.clearingId, amountMinor: 5_000n, reasonCode: '4853', actor: 'ops' });
  await assert.rejects(svc.transitionDispute({ disputeId: d.disputeId, from: 'raised', to: 'won', actor: 'ops' }), IllegalTransitionError); ok('raised -> won blocked (LG002)');
  await assert.rejects(svc.transitionDispute({ disputeId: d.disputeId, from: 'represented', to: 'won', actor: 'ops' }), StaleStateError); ok('stale compare-and-set detected');
  await svc.transitionDispute({ disputeId: d.disputeId, from: 'raised', to: 'represented', actor: 'merchant', note: 'evidence uploaded' });
  const before = await svc.getBalance(mAcct);
  const lost = await svc.transitionDispute({ disputeId: d.disputeId, from: 'represented', to: 'lost', actor: 'network' });
  assert.ok(lost.chargebackTransactionId !== null);
  assert.equal(await svc.getBalance(mAcct), before - 5_000n); ok('lost dispute posts chargeback; merchant balance reduced by 5000');
  await assert.rejects(svc.transitionDispute({ disputeId: d.disputeId, from: 'lost', to: 'won', actor: 'ops' }), IllegalTransitionError); ok('terminal state cannot be left (LG002)');
  const log = await pool.query('SELECT from_status, to_status, actor FROM dispute_transitions WHERE dispute_id = $1 ORDER BY transition_id', [d.disputeId]);
  assert.deepEqual(log.rows.map((r) => `${r.from_status ?? '-'}>${r.to_status}`), ['->raised', 'raised>represented', 'represented>lost']);
  ok('dispute_transitions log: ' + log.rows.map((r) => `${r.from_status ?? '-'}>${r.to_status}(${r.actor})`).join(', '));
  assert.equal(await sqlState(() => pool.query("INSERT INTO dispute_transitions (dispute_id, from_status, to_status, actor) VALUES ($1,'raised','won','x')", [d.disputeId])), 'LG003');
  ok('forging a transition log row blocked (LG003)');
  assert.equal(await sqlState(() => pool.query("UPDATE dispute_transitions SET actor = 'evil'")), 'LG003'); ok('transition log is immutable');

  const c3 = await svc.recordClearing({ networkRef: 'NR-3', merchantAccountId: mAcct, amountMinor: 700n, feeMinor: 0n });
  await svc.postClearing(c3.clearingId);
  const d3 = await svc.raiseDispute({ idempotencyKey: 'disp-3', clearingId: c3.clearingId, amountMinor: 700n, reasonCode: '4837', actor: 'ops' });
  await svc.transitionDispute({ disputeId: d3.disputeId, from: 'raised', to: 'represented', actor: 'm' });
  assert.equal(await sqlState(() => tx(async (c) => {
    await c.query("UPDATE disputes SET status = 'lost' WHERE dispute_id = $1", [d3.disputeId]);
  })), 'LG006'); ok('marking a dispute lost without a chargeback is refused at COMMIT (LG006)');

  // wallets: floor, ordering, deadlocks
  const w1p = await svc.createParty({ legalName: 'W1', partyType: 'cardholder', countryCode: 'US' });
  const w2p = await svc.createParty({ legalName: 'W2', partyType: 'cardholder', countryCode: 'US' });
  const w1 = await svc.createAccount({ partyId: w1p, accountType: 'wallet', currency: 'USD', minBalanceMinor: 0n });
  const w2 = await svc.createAccount({ partyId: w2p, accountType: 'wallet', currency: 'USD', minBalanceMinor: 0n });
  await svc.postTransaction({ idempotencyKey: 'fund-w1', kind: 'adjustment', settlementDate: new Date().toISOString().slice(0, 10), entries: [
    { accountId: plat.platformCash, direction: 'D', amountMinor: 1_000_000n }, { accountId: w1, direction: 'C', amountMinor: 1_000_000n }] });
  await svc.postTransaction({ idempotencyKey: 'fund-w2', kind: 'adjustment', settlementDate: new Date().toISOString().slice(0, 10), entries: [
    { accountId: plat.platformCash, direction: 'D', amountMinor: 1_000_000n }, { accountId: w2, direction: 'C', amountMinor: 1_000_000n }] });
  await assert.rejects(svc.transfer({ idempotencyKey: 'overdraw', fromAccountId: w1, toAccountId: w2, amountMinor: 2_000_000n }), InsufficientFundsError); ok('overdraft rejected at COMMIT (LG005)');

  resetRetryStats();
  const jobs: Promise<unknown>[] = [];
  for (let i = 0; i < 200; i++) {
    jobs.push(svc.transfer({ idempotencyKey: `x-${i}`, fromAccountId: i % 2 ? w1 : w2, toAccountId: i % 2 ? w2 : w1, amountMinor: 10n }));
  }
  await Promise.all(jobs);
  assert.equal(retryStats.deadlocks, 0);
  assert.equal(await svc.getBalance(w1), 1_000_000n); assert.equal(await svc.getBalance(w2), 1_000_000n);
  ok(`200 concurrent opposite-direction transfers: 0 deadlocks, balances conserved`);

  // audits
  assert.equal((await pool.query('SELECT * FROM verify_account_balances()')).rowCount, 0);
  assert.equal((await pool.query('SELECT * FROM verify_ledger_balanced()')).rowCount, 0);
  ok('verify_account_balances() and verify_ledger_balanced() are empty');

  // reconciliation
  const mk = async (ref: string, amt: bigint) => svc.authorize({ idempotencyKey: 'k-' + ref, networkRef: ref, merchantAccountId: mAcct, cardholderPartyId: holder, amountMinor: amt });
  await mk('NR-ORPHAN-AUTH', 100n);                                           // auth, never cleared
  await svc.recordClearing({ networkRef: 'NR-ORPHAN-CLR', merchantAccountId: mAcct, amountMinor: 200n, feeMinor: 0n, clearedAt: new Date(Date.now() - 10 * 86400_000) });
  await mk('NR-MISMATCH', 300n);
  await svc.recordClearing({ networkRef: 'NR-MISMATCH', merchantAccountId: mAcct, amountMinor: 350n, feeMinor: 0n });
  await mk('NR-CLEAN', 400n);                                                  // matches exactly, but not yet settled
  await svc.recordClearing({ networkRef: 'NR-CLEAN', merchantAccountId: mAcct, amountMinor: 400n, feeMinor: 0n });
  await pool.query("INSERT INTO settlement_batches (settlement_date, currency) VALUES (current_date - 40, 'USD')");
  const rep = await reconciliationReport(pool);
  const byType = Object.fromEntries(rep.map((r) => [r.exception_type, r]));
  for (const t of ['AUTH_WITHOUT_CLEARING', 'CLEARING_WITHOUT_AUTH', 'AMOUNT_MISMATCH', 'EMPTY_BATCH', 'CLEARED_NOT_SETTLED']) assert.ok(byType[t], 'missing ' + t);
  assert.equal(byType['CLEARING_WITHOUT_AUTH'].aging_bucket, '8-30d');
  assert.equal(byType['EMPTY_BATCH'].aging_bucket, '0-1d'); // created_at is "now" even though the date is old
  const sum = await agingSummary(pool);
  ok('reconciliation flags: ' + sum.map((r) => `${r.exception_type}[${r.aging_bucket}]x${r.item_count}`).join(' '));

  console.log(`\n${passed} checks passed`);
}

main().catch((e) => { console.error('\nFAILED:', e); process.exitCode = 1; }).finally(() => pool.end());
