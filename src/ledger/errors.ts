import { pgCode } from '../db/pool';


export class LedgerError extends Error {
  constructor(message: string, readonly sqlState?: string) {
    super(message);
    this.name = new.target.name;
  }
}

export class IdempotencyConflictError extends LedgerError {} // same key, different payload
export class DuplicatePostingError extends LedgerError {} // one-posting-per-source unique index
export class DoubleSettlementError extends LedgerError {} // LG001
export class IllegalTransitionError extends LedgerError {} // LG002
export class AppendOnlyViolationError extends LedgerError {} // LG003
export class UnbalancedTransactionError extends LedgerError {} // LG004
export class InsufficientFundsError extends LedgerError {} // LG005
export class InvalidPostingError extends LedgerError {} // LG006
export class NotFoundError extends LedgerError {}
export class StaleStateError extends LedgerError {} // compare-and-set lost the race

/** Translates PostgreSQL errors raised by our triggers/constraints into domain errors. */
export function translatePgError(err: unknown): unknown {
  if (err instanceof LedgerError) return err;
  const code = pgCode(err);
  const msg = err instanceof Error ? err.message : String(err);
  switch (code) {
    case 'LG001': return new DoubleSettlementError(msg, code);
    case 'LG002': return new IllegalTransitionError(msg, code);
    case 'LG003': return new AppendOnlyViolationError(msg, code);
    case 'LG004': return new UnbalancedTransactionError(msg, code);
    case 'LG005': return new InsufficientFundsError(msg, code);
    case 'LG006': return new InvalidPostingError(msg, code);
    case '23505': {
      const constraint = (err as { constraint?: string }).constraint ?? '';
      if (constraint.startsWith('uq_ltx_one_')) return new DuplicatePostingError(msg, code);
      return err;
    }
    default: return err;
  }
}
