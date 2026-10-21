export type Direction = 'D' | 'C';
export type TransactionKind = 'clearing' | 'settlement' | 'chargeback' | 'adjustment' | 'transfer';
export type DisputeStatus = 'raised' | 'represented' | 'won' | 'lost';
export type PartyType = 'merchant' | 'cardholder' | 'platform';
export type AccountType = 'merchant_payable' | 'network_receivable' | 'platform_cash' | 'fee_revenue' | 'wallet';

/** All amounts are integer minor units (e.g. cents). */
export interface EntryInput {
  accountId: bigint;
  direction: Direction;
  amountMinor: bigint;
}

export interface PostTransactionInput {
  idempotencyKey: string;
  kind: TransactionKind;
  /** YYYY-MM-DD */
  settlementDate: string;
  entries: EntryInput[];
  clearingId?: bigint;
  batchId?: bigint;
  disputeId?: bigint;
}

export interface PostResult {
  transactionId: bigint;
  /** true when the idempotency key had already been used with an identical payload. */
  replayed: boolean;
}

export interface AuthorizeInput {
  idempotencyKey: string;
  networkRef: string;
  merchantAccountId: bigint;
  cardholderPartyId: bigint;
  amountMinor: bigint;
}

export interface ClearingInput {
  networkRef: string;
  merchantAccountId: bigint;
  amountMinor: bigint;
  feeMinor: bigint;
  /** Optional, mainly for tests that need aged items. */
  clearedAt?: Date;
}

export interface SettleResult {
  batchId: bigint;
  itemCount: number;
  totalNetMinor: bigint;
  transactionId: bigint | null;
  /** true when the batch had already been posted by an earlier call. */
  alreadyPosted: boolean;
}

export interface PlatformAccounts {
  partyId: bigint;
  networkReceivable: bigint;
  platformCash: bigint;
  feeRevenue: bigint;
}

export interface ReconciliationRow {
  network_ref: string | null;
  authorization_id: bigint | null;
  clearing_id: bigint | null;
  batch_id: bigint | null;
  auth_amount_minor: bigint | null;
  clearing_amount_minor: bigint | null;
  exception_type: string;
  event_at: Date;
  age_days: number;
  aging_bucket: string;
}

export interface AgingSummaryRow {
  exception_type: string;
  aging_bucket: string;
  item_count: bigint;
  auth_total_minor: bigint;
  clearing_total_minor: bigint;
}
