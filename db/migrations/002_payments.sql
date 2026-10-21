

CREATE TABLE authorizations (
    authorization_id     bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key      text        NOT NULL,
    request_hash         text        NOT NULL,   -- detects key reuse with a different payload
    network_ref          text        NOT NULL,
    merchant_account_id  bigint      NOT NULL REFERENCES accounts (account_id),
    cardholder_party_id  bigint      NOT NULL REFERENCES parties (party_id),
    amount_minor         bigint      NOT NULL CHECK (amount_minor > 0),
    status               text        NOT NULL DEFAULT 'authorized' CHECK (status IN ('authorized', 'voided', 'expired')),
    authorized_at        timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_auth_idempotency UNIQUE (idempotency_key),
    CONSTRAINT uq_auth_network_ref UNIQUE (network_ref)
);

CREATE INDEX ix_auth_merchant_time ON authorizations (merchant_account_id, authorized_at);

CREATE TABLE settlement_batches (
    batch_id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    settlement_date  date        NOT NULL,
    currency         text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
    status           text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'posted', 'closed')),
    created_at       timestamptz NOT NULL DEFAULT now(),
    posted_at        timestamptz,
    closed_at        timestamptz,
    CONSTRAINT uq_batch_date_ccy UNIQUE (settlement_date, currency),
    CONSTRAINT ck_batch_timestamps CHECK (
           (status = 'open'   AND posted_at IS NULL     AND closed_at IS NULL)
        OR (status = 'posted' AND posted_at IS NOT NULL AND closed_at IS NULL)
        OR (status = 'closed' AND posted_at IS NOT NULL AND closed_at IS NOT NULL))
);


CREATE TABLE clearing_records (
    clearing_id          bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    network_ref          text        NOT NULL,
    merchant_account_id  bigint      NOT NULL REFERENCES accounts (account_id),
    amount_minor         bigint      NOT NULL CHECK (amount_minor > 0),
    fee_minor            bigint      NOT NULL DEFAULT 0,
    cleared_at           timestamptz NOT NULL DEFAULT now(),
    settlement_batch_id  bigint      REFERENCES settlement_batches (batch_id),
    settled_at           timestamptz,
    CONSTRAINT uq_clearing_network_ref UNIQUE (network_ref),
    CONSTRAINT ck_clearing_fee CHECK (fee_minor >= 0 AND fee_minor <= amount_minor),
    CONSTRAINT ck_clearing_settled_pair CHECK ((settlement_batch_id IS NULL) = (settled_at IS NULL))
);

CREATE INDEX ix_clearing_batch      ON clearing_records (settlement_batch_id) WHERE settlement_batch_id IS NOT NULL;
CREATE INDEX ix_clearing_unsettled  ON clearing_records (cleared_at)          WHERE settlement_batch_id IS NULL;
CREATE INDEX ix_clearing_merchant   ON clearing_records (merchant_account_id);


CREATE FUNCTION trg_clearing_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_batch settlement_batches%ROWTYPE;
    v_ccy   text;
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'DELETE on clearing_records is forbidden (append-only)' USING ERRCODE = 'LG003';
    END IF;

    IF TG_OP = 'INSERT' THEN
        IF NEW.settlement_batch_id IS NOT NULL OR NEW.settled_at IS NOT NULL THEN
            RAISE EXCEPTION 'clearing record must be created unsettled' USING ERRCODE = 'LG006';
        END IF;
        RETURN NEW;
    END IF;


    IF (NEW.clearing_id, NEW.network_ref, NEW.merchant_account_id, NEW.amount_minor, NEW.fee_minor, NEW.cleared_at)
       IS DISTINCT FROM
       (OLD.clearing_id, OLD.network_ref, OLD.merchant_account_id, OLD.amount_minor, OLD.fee_minor, OLD.cleared_at) THEN
        RAISE EXCEPTION 'clearing record % facts are immutable', OLD.clearing_id USING ERRCODE = 'LG003';
    END IF;

    IF OLD.settlement_batch_id IS NOT NULL THEN
        IF (NEW.settlement_batch_id, NEW.settled_at) IS DISTINCT FROM (OLD.settlement_batch_id, OLD.settled_at) THEN
            RAISE EXCEPTION 'clearing record % is already settled in batch %', OLD.clearing_id, OLD.settlement_batch_id
                USING ERRCODE = 'LG001';
        END IF;
        RETURN NEW;
    END IF;

    IF NEW.settlement_batch_id IS NOT NULL THEN
        SELECT * INTO v_batch FROM settlement_batches WHERE batch_id = NEW.settlement_batch_id;
        IF v_batch.status IS DISTINCT FROM 'open' THEN
            RAISE EXCEPTION 'batch % is not open (status=%)', NEW.settlement_batch_id, v_batch.status
                USING ERRCODE = 'LG006';
        END IF;
        SELECT currency INTO v_ccy FROM accounts WHERE account_id = NEW.merchant_account_id;
        IF v_ccy <> v_batch.currency THEN
            RAISE EXCEPTION 'clearing record % is in % but batch % settles %',
                NEW.clearing_id, v_ccy, v_batch.batch_id, v_batch.currency USING ERRCODE = 'LG006';
        END IF;
        -- Never settle money that the ledger has not yet recognised as owed.
        IF NOT EXISTS (SELECT 1 FROM ledger_transactions lt
                       WHERE lt.clearing_id = NEW.clearing_id AND lt.kind = 'clearing') THEN
            RAISE EXCEPTION 'clearing record % has no ledger posting; cannot settle', NEW.clearing_id
                USING ERRCODE = 'LG006';
        END IF;
        NEW.settled_at := COALESCE(NEW.settled_at, now());
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER clearing_guard
    BEFORE INSERT OR UPDATE OR DELETE ON clearing_records
    FOR EACH ROW EXECUTE FUNCTION trg_clearing_guard();


CREATE FUNCTION trg_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RAISE EXCEPTION 'DELETE on settlement_batches is forbidden' USING ERRCODE = 'LG003';
    END IF;
    IF (NEW.batch_id, NEW.settlement_date, NEW.currency, NEW.created_at)
       IS DISTINCT FROM (OLD.batch_id, OLD.settlement_date, OLD.currency, OLD.created_at) THEN
        RAISE EXCEPTION 'settlement batch identity columns are immutable' USING ERRCODE = 'LG003';
    END IF;
    IF NEW.status <> OLD.status THEN
        IF NOT ((OLD.status = 'open' AND NEW.status = 'posted') OR (OLD.status = 'posted' AND NEW.status = 'closed')) THEN
            RAISE EXCEPTION 'illegal batch transition % -> %', OLD.status, NEW.status USING ERRCODE = 'LG002';
        END IF;
        IF NEW.status = 'posted' THEN NEW.posted_at := COALESCE(NEW.posted_at, now()); END IF;
        IF NEW.status = 'closed' THEN NEW.closed_at := COALESCE(NEW.closed_at, now()); END IF;
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER batch_guard
    BEFORE UPDATE OR DELETE ON settlement_batches
    FOR EACH ROW EXECUTE FUNCTION trg_batch_guard();
