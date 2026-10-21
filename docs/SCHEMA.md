# Schema, functional dependencies, and the two deliberate denormalizations

All money is `bigint` minor units. Every account is single-currency.

## Functional dependencies and normal form

Notation: `K` = candidate key. A table is in BCNF when every non-trivial FD has a superkey on its left side.

| Table | FDs | Verdict |
|---|---|---|
| `parties` | `party_id → legal_name, party_type, country_code, created_at` | BCNF (only key is `party_id`) |
| `account_types` | `account_type → normal_side, description` | BCNF. Extracted from `accounts`: leaving `normal_side` on `accounts` would create `account_id → account_type → normal_side`, a transitive dependency that violates 3NF |
| `accounts` | `account_id → party_id, account_type, currency, min_balance_minor, status, created_at`; `(party_id, account_type, currency) → account_id` | BCNF (two candidate keys, both determinants are keys) |
| `authorizations` | `authorization_id → *`; `idempotency_key → *`; `network_ref → *` | BCNF (three candidate keys). No `currency` column (it would be `merchant_account_id → currency`, transitive) and no "cleared" flag (derivable from `clearing_records`) |
| `settlement_batches` | `batch_id → *`; `(settlement_date, currency) → *` | BCNF |
| `clearing_records` | `clearing_id → *`; `network_ref → *` | BCNF. "Settled" is not stored: it is `settlement_batch_id IS NOT NULL`. `merchant_account_id` is the clearing *file's* claim, independent of the authorization's, so it is a distinct fact and reconciliation compares the two |
| `ledger_transactions` | `transaction_id → *`; `idempotency_key → *` | BCNF. `clearing_id`/`batch_id`/`dispute_id` form an exclusive arc (CHECK) rather than a `kind`-dependent nullable column set that could drift |
| `ledger_entries` | `entry_id → transaction_id, account_id, direction, amount_minor, settlement_date` | **3NF/BCNF except one declared exception**, see below. `currency` and `created_at` are omitted for the same transitive-FD reasons as above |
| `disputes` | `dispute_id → *`; `idempotency_key → *` | BCNF |
| `dispute_transitions` | `transition_id → *` | BCNF |
| `dispute_allowed_transitions` | `(from_status, to_status)` is the whole key | BCNF (data-driven state machine) |

## Deliberate denormalization #1: `account_balances` (cached running balance)

`account_balances(account_id, balance_minor, entry_count, last_entry_id, updated_at)` is a pure function of `ledger_entries`, kept in sync by an `AFTER INSERT` row trigger in the same transaction.

| Dimension | Without the cache | With the cache |
|---|---|---|
| Read balance | `SUM` over all of an account's entries: O(n), and a hot merchant has millions | Primary-key lookup: O(1) |
| Write cost | 1 insert per entry | 1 insert **plus** 1 upsert (row lock + new tuple version, WAL for both) per entry |
| Contention | None between writers | Writers touching the same account serialize on that account's balance row. A platform account such as `network_receivable` is touched by every clearing posting, so it is a throughput ceiling (known and measured in Phase 2) |
| Consistency | Always exact | Exact for any reader at any isolation level, because the cache and the entry commit atomically. It can only be wrong if triggers are bypassed (bulk load as superuser), and `verify_account_balances()` proves or disproves it |
| Floor / overdraft | Needs a locking read | Enforced by a deferred trigger against the final balance at COMMIT |

Recovery: the cache is derived data, so it can be rebuilt from `ledger_entries` at any time (see `scripts/` in the seeding step).

## Declared exception #2: `ledger_entries.settlement_date` (partition key)

`transaction_id → settlement_date` holds across entries, and `transaction_id` is not a key of `ledger_entries`, so strictly this violates BCNF/3NF. It is kept on purpose so the postings table can be range-partitioned by settlement date (Phase 2) without joining to the header, and partition pruning needs the key in the table itself.

The redundancy cannot drift: `trg_entry_guard` rejects any entry whose `settlement_date` differs from its header's, and both tables are append-only.
