
CREATE TABLE ledger_transactions (
    transaction_id   bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key  text        NOT NULL,
    request_hash     text        NOT NULL,
    kind             text        NOT NULL CHECK (kind IN ('clearing', 'settlement', 'chargeback', 'adjustment', 'transfer')),
    settlement_date  date        NOT NULL,
    clearing_id      bigint      REFERENCES clearing_records (clearing_id),
    batch_id         bigint      REFERENCES settlement_batches (batch_id),
    dispute_id       bigint,     

    created_txid     bigint      NOT NULL DEFAULT (pg_current_xact_id()::text::bigint),
    created_at       timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_ltx_idempotency UNIQUE (idempotency_key),
    -- Exclusive-arc: each kind links to exactly the source object it posts for.
    CONSTRAINT ck_ltx_kind_links CHECK (CASE kind
        WHEN 'clearing'   THEN clearing_id IS NOT NULL AND batch_id IS NULL AND dispute_id IS NULL
        WHEN 'settlement' THEN batch_id    IS NOT NULL AND clearing_id IS NULL AND dispute_id IS NULL
        WHEN 'chargeback' THEN dispute_id  IS NOT NULL AND clearing_id IS NULL AND batch_id IS NULL
        ELSE clearing_id IS NULL AND batch_id IS NULL AND dispute_id IS NULL END)
);

CREATE UNIQUE INDEX uq_ltx_one_clearing_posting   ON ledger_transactions (clearing_id) WHERE kind = 'clearing';
CREATE UNIQUE INDEX uq_ltx_one_settlement_posting ON ledger_transactions (batch_id)    WHERE kind = 'settlement';
CREATE UNIQUE INDEX uq_ltx_one_chargeback_posting ON ledger_transactions (dispute_id)  WHERE kind = 'chargeback';

CREATE TABLE ledger_entries (
    entry_id         bigint  GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    transaction_id   bigint  NOT NULL REFERENCES ledger_transactions (transaction_id),
    account_id       bigint  NOT NULL REFERENCES accounts (account_id),
    direction        text    NOT NULL CHECK (direction IN ('D', 'C')),
    amount_minor     bigint  NOT NULL CHECK (amount_minor > 0),

    settlement_date  date    NOT NULL
);

CREATE INDEX ix_entries_transaction ON ledger_entries (transaction_id);


CREATE FUNCTION trg_forbid_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION '% on % is forbidden: ledger tables are append-only', TG_OP, TG_TABLE_NAME
        USING ERRCODE = 'LG003';
END $$;

CREATE TRIGGER entries_no_mutation  BEFORE UPDATE OR DELETE ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION trg_forbid_mutation();
CREATE TRIGGER entries_no_truncate  BEFORE TRUNCATE ON ledger_entries
    FOR EACH STATEMENT EXECUTE FUNCTION trg_forbid_mutation();
CREATE TRIGGER ltx_no_mutation      BEFORE UPDATE OR DELETE ON ledger_transactions
    FOR EACH ROW EXECUTE FUNCTION trg_forbid_mutation();
CREATE TRIGGER ltx_no_truncate      BEFORE TRUNCATE ON ledger_transactions
    FOR EACH STATEMENT EXECUTE FUNCTION trg_forbid_mutation();

REVOKE UPDATE, DELETE, TRUNCATE ON ledger_entries, ledger_transactions FROM PUBLIC;

CREATE FUNCTION trg_entry_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_hdr    ledger_transactions%ROWTYPE;
    v_status text;
BEGIN
    SELECT * INTO v_hdr FROM ledger_transactions WHERE transaction_id = NEW.transaction_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'ledger transaction % does not exist', NEW.transaction_id USING ERRCODE = 'LG006';
    END IF;
    IF v_hdr.created_txid <> pg_current_xact_id()::text::bigint THEN
        RAISE EXCEPTION 'entries may only be added in the DB transaction that created ledger transaction %',
            NEW.transaction_id USING ERRCODE = 'LG003';
    END IF;
    IF v_hdr.settlement_date <> NEW.settlement_date THEN
        RAISE EXCEPTION 'entry settlement_date % differs from transaction settlement_date %',
            NEW.settlement_date, v_hdr.settlement_date USING ERRCODE = 'LG006';
    END IF;
    SELECT status INTO v_status FROM accounts WHERE account_id = NEW.account_id;
    IF v_status IS DISTINCT FROM 'active' THEN
        RAISE EXCEPTION 'account % is not active (status=%)', NEW.account_id, v_status USING ERRCODE = 'LG006';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER entries_guard BEFORE INSERT ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION trg_entry_guard();


CREATE FUNCTION trg_assert_balanced() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_count integer;
    v_bad   record;
BEGIN
    SELECT count(*) INTO v_count FROM ledger_entries WHERE transaction_id = NEW.transaction_id;
    IF v_count < 2 THEN
        RAISE EXCEPTION 'ledger transaction % has % entries; at least 2 required', NEW.transaction_id, v_count
            USING ERRCODE = 'LG004';
    END IF;

    SELECT a.currency,
           sum(CASE WHEN e.direction = 'D' THEN e.amount_minor ELSE -e.amount_minor END) AS imbalance
      INTO v_bad
      FROM ledger_entries e
      JOIN accounts a ON a.account_id = e.account_id
     WHERE e.transaction_id = NEW.transaction_id
     GROUP BY a.currency
    HAVING sum(CASE WHEN e.direction = 'D' THEN e.amount_minor ELSE -e.amount_minor END) <> 0
     LIMIT 1;
    IF FOUND THEN
        RAISE EXCEPTION 'ledger transaction % is unbalanced in %: debits - credits = %',
            NEW.transaction_id, v_bad.currency, v_bad.imbalance USING ERRCODE = 'LG004';
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ltx_balanced
    AFTER INSERT ON ledger_transactions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_assert_balanced();


CREATE TABLE account_balances (
    account_id     bigint      PRIMARY KEY REFERENCES accounts (account_id),
    balance_minor  bigint      NOT NULL DEFAULT 0,
    entry_count    bigint      NOT NULL DEFAULT 0,
    last_entry_id  bigint      NOT NULL DEFAULT 0,
    updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION trg_apply_entry_to_balance() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_side  text;
    v_delta bigint;
BEGIN
    SELECT t.normal_side INTO v_side
      FROM accounts a JOIN account_types t ON t.account_type = a.account_type
     WHERE a.account_id = NEW.account_id;
    v_delta := CASE WHEN NEW.direction = v_side THEN NEW.amount_minor ELSE -NEW.amount_minor END;

    INSERT INTO account_balances AS ab (account_id, balance_minor, entry_count, last_entry_id)
    VALUES (NEW.account_id, v_delta, 1, NEW.entry_id)
    ON CONFLICT (account_id) DO UPDATE
       SET balance_minor = ab.balance_minor + EXCLUDED.balance_minor,
           entry_count   = ab.entry_count + 1,
           last_entry_id = GREATEST(ab.last_entry_id, EXCLUDED.last_entry_id),
           updated_at    = now();
    RETURN NULL;
END $$;

CREATE TRIGGER entries_apply_balance AFTER INSERT ON ledger_entries
    FOR EACH ROW EXECUTE FUNCTION trg_apply_entry_to_balance();


CREATE FUNCTION trg_balance_floor() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_floor bigint;
    v_bal   bigint;
BEGIN
    SELECT min_balance_minor INTO v_floor FROM accounts WHERE account_id = NEW.account_id;
    IF v_floor IS NULL THEN RETURN NULL; END IF;
    SELECT balance_minor INTO v_bal FROM account_balances WHERE account_id = NEW.account_id;
    IF v_bal < v_floor THEN
        RAISE EXCEPTION 'account % balance % would fall below its floor %', NEW.account_id, v_bal, v_floor
            USING ERRCODE = 'LG005';
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER balances_floor
    AFTER INSERT OR UPDATE ON account_balances
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW EXECUTE FUNCTION trg_balance_floor();


CREATE FUNCTION verify_account_balances()
RETURNS TABLE (acct_id bigint, cached_balance bigint, recomputed_balance bigint)
LANGUAGE sql STABLE AS $$
    SELECT a.account_id, COALESCE(ab.balance_minor, 0), COALESCE(r.bal, 0)
      FROM accounts a
      LEFT JOIN account_balances ab ON ab.account_id = a.account_id
      LEFT JOIN (
            SELECT e.account_id,
                   sum(CASE WHEN e.direction = t.normal_side THEN e.amount_minor ELSE -e.amount_minor END)::bigint AS bal
              FROM ledger_entries e
              JOIN accounts a2      ON a2.account_id = e.account_id
              JOIN account_types t  ON t.account_type = a2.account_type
             GROUP BY e.account_id
      ) r ON r.account_id = a.account_id
     WHERE COALESCE(ab.balance_minor, 0) <> COALESCE(r.bal, 0)
$$;


CREATE FUNCTION verify_ledger_balanced()
RETURNS TABLE (tx_id bigint, ccy text, imbalance bigint)
LANGUAGE sql STABLE AS $$
    SELECT e.transaction_id, a.currency,
           sum(CASE WHEN e.direction = 'D' THEN e.amount_minor ELSE -e.amount_minor END)::bigint
      FROM ledger_entries e
      JOIN accounts a ON a.account_id = e.account_id
     GROUP BY e.transaction_id, a.currency
    HAVING sum(CASE WHEN e.direction = 'D' THEN e.amount_minor ELSE -e.amount_minor END) <> 0
$$;
