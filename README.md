# Ledger Lab

A payments settlement ledger whose correctness is enforced by PostgreSQL, plus an optimization lab that scales the same schema to 10M–50M skewed rows.

```
make all      # up -> install -> migrate -> test -> seed -> bench -> report
```

## Layout

| Path | What |
|---|---|
| `db/migrations/` | DDL: core, payments, ledger (double-entry, append-only, balance cache), disputes (state machine), reconciliation |
| `src/ledger/` | `LedgerService`: idempotent posting, deterministic lock ordering, settlement, disputes |
| `src/db/` | pool with serialization/deadlock retry, checksummed migration runner |
| `src/reconciliation/` | wrappers over the `FULL OUTER JOIN` reconciliation + aging functions |
| `docs/SCHEMA.md` | functional dependencies, normal forms, denormalization trade-offs |
| `DECISIONS.md` | design decision log |

## Status

Built: schema, invariant triggers, dispute state machine, reconciliation SQL, ledger engine.
Not yet built: test suites, seeder, benchmark runner, index/partition experiments, one-page summary. `make test`, `seed`, `bench` and `report` point at files that are added in the next steps.
