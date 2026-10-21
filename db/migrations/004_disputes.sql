

CREATE TABLE dispute_allowed_transitions (
    from_status text NOT NULL,
    to_status   text NOT NULL,
    PRIMARY KEY (from_status, to_status)
);
INSERT INTO dispute_allowed_transitions (from_status, to_status) VALUES
    ('raised',      'represented'),
    ('raised',      'lost'),
    ('represented', 'won'),
    ('represented', 'lost');

CREATE TABLE disputes (
    dispute_id       bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    idempotency_key  text        NOT NULL,
    request_hash     text        NOT NULL,
    clearing_id      bigint      NOT NULL REFERENCES clearing_records (clearing_id),
    reason_code      text        NOT NULL CHECK (length(btrim(reason_code)) > 0),
    amount_minor     bigint      NOT NULL CHECK (amount_minor > 0),
    status           text        NOT NULL DEFAULT 'raised' CHECK (status IN ('raised', 'represented', 'won', 'lost')),
    opened_at        timestamptz NOT NULL DEFAULT now(),
    resolved_at      timestamptz,
    CONSTRAINT uq_dispute_idempotency UNIQUE (idempotency_key),
    CONSTRAINT ck_dispute_resolved CHECK ((status IN ('won', 'lost')) = (resolved_at IS NOT NULL))
);

CREATE UNIQUE INDEX uq_one_open_dispute_per_clearing ON disputes (clearing_id)
    WHERE status IN ('raised', 'represented');

CREATE TABLE dispute_transitions (
    transition_id    bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    dispute_id       bigint      NOT NULL REFERENCES disputes (dispute_id),
    from_status      text,       -- NULL for the creation event
    to_status        text        NOT NULL,
    actor            text        NOT NULL,
    note             text,
    transitioned_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ix_dispute_transitions_dispute ON dispute_transitions (dispute_id, transition_id);


CREATE FUNCTION trg_transition_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF pg_trigger_depth() < 2 THEN
        RAISE EXCEPTION 'dispute_transitions is written only by the dispute state-machine trigger'
            USING ERRCODE = 'LG003';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER transitions_insert_guard BEFORE INSERT ON dispute_transitions
    FOR EACH ROW EXECUTE FUNCTION trg_transition_insert_guard();
CREATE TRIGGER transitions_no_mutation BEFORE UPDATE OR DELETE ON dispute_transitions
    FOR EACH ROW EXECUTE FUNCTION trg_forbid_mutation();
CREATE TRIGGER transitions_no_truncate BEFORE TRUNCATE ON dispute_transitions
    FOR EACH STATEMENT EXECUTE FUNCTION trg_forbid_mutation();


CREATE FUNCTION trg_dispute_before_insert() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_amount bigint;
BEGIN
    IF NEW.status <> 'raised' OR NEW.resolved_at IS NOT NULL THEN
        RAISE EXCEPTION 'a dispute must be created in status raised' USING ERRCODE = 'LG002';
    END IF;
    SELECT amount_minor INTO v_amount FROM clearing_records WHERE clearing_id = NEW.clearing_id;
    IF NEW.amount_minor > v_amount THEN
        RAISE EXCEPTION 'dispute amount % exceeds cleared amount %', NEW.amount_minor, v_amount
            USING ERRCODE = 'LG006';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER disputes_before_insert BEFORE INSERT ON disputes
    FOR EACH ROW EXECUTE FUNCTION trg_dispute_before_insert();


CREATE FUNCTION trg_dispute_before_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF (NEW.dispute_id, NEW.idempotency_key, NEW.request_hash, NEW.clearing_id, NEW.reason_code, NEW.amount_minor, NEW.opened_at)
       IS DISTINCT FROM
       (OLD.dispute_id, OLD.idempotency_key, OLD.request_hash, OLD.clearing_id, OLD.reason_code, OLD.amount_minor, OLD.opened_at) THEN
        RAISE EXCEPTION 'dispute % attributes are immutable; only status may change', OLD.dispute_id
            USING ERRCODE = 'LG003';
    END IF;

    IF NEW.status IS DISTINCT FROM OLD.status THEN
        IF NOT EXISTS (SELECT 1 FROM dispute_allowed_transitions
                        WHERE from_status = OLD.status AND to_status = NEW.status) THEN
            RAISE EXCEPTION 'illegal dispute transition % -> % (dispute %)', OLD.status, NEW.status, OLD.dispute_id
                USING ERRCODE = 'LG002';
        END IF;
        IF NEW.status IN ('won', 'lost') THEN
            NEW.resolved_at := COALESCE(NEW.resolved_at, now());
        END IF;
    ELSIF NEW.resolved_at IS DISTINCT FROM OLD.resolved_at THEN
        RAISE EXCEPTION 'dispute % resolved_at is managed by the state machine', OLD.dispute_id
            USING ERRCODE = 'LG003';
    END IF;
    RETURN NEW;
END $$;

CREATE TRIGGER disputes_before_update BEFORE UPDATE ON disputes
    FOR EACH ROW EXECUTE FUNCTION trg_dispute_before_update();
CREATE TRIGGER disputes_no_delete BEFORE DELETE ON disputes
    FOR EACH ROW EXECUTE FUNCTION trg_forbid_mutation();


CREATE FUNCTION trg_dispute_log_insert() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO dispute_transitions (dispute_id, from_status, to_status, actor, note)
    VALUES (NEW.dispute_id, NULL, NEW.status,
            COALESCE(NULLIF(current_setting('app.actor', true), ''), 'unknown'),
            NULLIF(current_setting('app.note', true), ''));
    RETURN NULL;
END $$;

CREATE FUNCTION trg_dispute_log_update() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO dispute_transitions (dispute_id, from_status, to_status, actor, note)
    VALUES (NEW.dispute_id, OLD.status, NEW.status,
            COALESCE(NULLIF(current_setting('app.actor', true), ''), 'unknown'),
            NULLIF(current_setting('app.note', true), ''));
    RETURN NULL;
END $$;

CREATE TRIGGER disputes_log_insert AFTER INSERT ON disputes
    FOR EACH ROW EXECUTE FUNCTION trg_dispute_log_insert();
CREATE TRIGGER disputes_log_update AFTER UPDATE ON disputes
    FOR EACH ROW WHEN (OLD.status IS DISTINCT FROM NEW.status)
    EXECUTE FUNCTION trg_dispute_log_update();


ALTER TABLE ledger_transactions
    ADD CONSTRAINT fk_ltx_dispute FOREIGN KEY (dispute_id) REFERENCES disputes (dispute_id);

CREATE FUNCTION trg_dispute_lost_requires_chargeback() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM ledger_transactions
                    WHERE dispute_id = NEW.dispute_id AND kind = 'chargeback') THEN
        RAISE EXCEPTION 'dispute % is lost but has no chargeback posting', NEW.dispute_id USING ERRCODE = 'LG006';
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER disputes_lost_needs_chargeback
    AFTER UPDATE OF status ON disputes
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW.status = 'lost')
    EXECUTE FUNCTION trg_dispute_lost_requires_chargeback();

CREATE FUNCTION trg_chargeback_requires_lost() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
    v_status text;
BEGIN
    SELECT status INTO v_status FROM disputes WHERE dispute_id = NEW.dispute_id;
    IF v_status IS DISTINCT FROM 'lost' THEN
        RAISE EXCEPTION 'chargeback posting requires dispute % to be lost (status=%)', NEW.dispute_id, v_status
            USING ERRCODE = 'LG006';
    END IF;
    RETURN NULL;
END $$;

CREATE CONSTRAINT TRIGGER ltx_chargeback_needs_lost
    AFTER INSERT ON ledger_transactions
    DEFERRABLE INITIALLY DEFERRED
    FOR EACH ROW WHEN (NEW.kind = 'chargeback')
    EXECUTE FUNCTION trg_chargeback_requires_lost();
