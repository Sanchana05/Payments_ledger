# Design Decision Log

Each entry: decision, why, what it costs. Phase 2 entries (indexing, partitioning, benchmark method) are added once measured.

## D1. Invariants live in the database, not the service
Constraints, triggers and deferred constraint triggers enforce double-entry balance, append-only postings, single settlement and the dispute state machine. The TypeScript layer only fast-fails and translates errors.
*Why:* the service is one of many possible writers (migrations, scripts, an engineer in `psql`). Only the database sees all of them.
*Cost:* triggers add per-row overhead on the write path. That cost is measured in Phase 2 rather than assumed.

## D2. Balance check is a deferred constraint trigger on the *header*, not on each entry
Entries may only be inserted in the same DB transaction that created their header (`created_txid` compared with `pg_current_xact_id()`), so a deferred check fired by the header insert at COMMIT always sees the complete entry set.
*Why:* a per-entry deferred trigger rescans the whole transaction for every entry, which is O(n²) for a 10,000-merchant settlement payout.
*Cost:* a transaction cannot be extended after commit. Corrections are new reversing transactions, which is the correct accounting behaviour anyway.

## D3. Append-only via triggers, plus REVOKE
`BEFORE UPDATE/DELETE` and `BEFORE TRUNCATE` triggers raise `LG003`; `UPDATE/DELETE/TRUNCATE` are revoked from `PUBLIC`.
*Known bypass:* a superuser can set `session_replication_role = replica`, which disables triggers. The bulk seeder uses exactly this for speed and then runs `verify_ledger_balanced()` and `verify_account_balances()` as an audit. In production the service must connect as a non-superuser role.

## D4. Idempotency = UNIQUE key + request fingerprint
Every externally triggered write (`authorize`, `raiseDispute`, `postTransaction`) stores `idempotency_key` (UNIQUE) and a SHA-256 of the canonical payload. `INSERT ... ON CONFLICT DO NOTHING` makes a replay return the original result; same key with a different payload raises `IdempotencyConflictError`.
*Why:* a unique index is the only mechanism that is correct under concurrent retries; check-then-insert is a race.
Separately, partial unique indexes (`uq_ltx_one_clearing_posting`, `..._settlement_...`, `..._chargeback_...`) guarantee one posting per source object even under *different* keys.

## D5. Deterministic lock ordering everywhere
Multi-account writes sort entries by `(account_id, direction)`, explicit locks use `SELECT ... FROM account_balances WHERE account_id = ANY($1) ORDER BY account_id FOR UPDATE`, and the entry insert is `ORDER BY account_id`. Two transactions needing `{A,B}` therefore always lock A then B.
*Why:* it removes the lock-cycle precondition for deadlock instead of relying on the detector (1s default timeout) to break cycles. The retry wrapper remains as a backstop for `40P01`.

## D6. Isolation levels are chosen per problem, not globally
`READ COMMITTED` plus atomic statements or `FOR UPDATE` is enough for lost updates; write skew (an invariant spanning *several* rows, where each transaction writes a different row) needs `SERIALIZABLE`, or locking every row read. `withTransaction` retries `40001`/`40P01` and exposes counters, so tests can assert that retries happened.
*Cost:* `SERIALIZABLE` aborts under contention, so callers must tolerate retries (`fn` has to be side-effect free).

## D7. Settlement claims work with `FOR UPDATE SKIP LOCKED`
Two callers settling the same batch serialize on the batch row; callers settling different batches claim disjoint item sets without waiting. The `clearing_guard` trigger remains the last line of defence (`LG001`).

## D8. Domain-specific SQLSTATEs (`LG001`–`LG006`)
Custom SQLSTATE codes let the service map a rejection to a domain error without parsing message text, and let tests assert *which* invariant fired.

## D9. Two documented departures from strict BCNF
`account_balances` (cached balance) and `ledger_entries.settlement_date` (partition key copy). Both are guarded by the database and analysed in `docs/SCHEMA.md`.

## D10. Container is configured for honest measurement
`fsync`, `synchronous_commit` and `full_page_writes` are explicitly on (the crash test and write-cost numbers are meaningless otherwise); `jit=off` removes compile-time noise from latency percentiles; `track_io_timing=on` makes `EXPLAIN (ANALYZE, BUFFERS)` report I/O time.
