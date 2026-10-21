

CREATE TABLE parties (
    party_id      bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    legal_name    text        NOT NULL CHECK (length(btrim(legal_name)) > 0),
    party_type    text        NOT NULL CHECK (party_type IN ('merchant', 'cardholder', 'platform')),
    country_code  text        NOT NULL CHECK (country_code ~ '^[A-Z]{2}$'),
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX uq_single_platform_party ON parties (party_type) WHERE party_type = 'platform';


CREATE TABLE account_types (
    account_type text PRIMARY KEY,
    normal_side  text NOT NULL CHECK (normal_side IN ('D', 'C')),
    description  text NOT NULL
);
INSERT INTO account_types (account_type, normal_side, description) VALUES
    ('merchant_payable',   'C', 'Liability: net amount owed to a merchant'),
    ('network_receivable', 'D', 'Asset: amount owed to the platform by the card network'),
    ('platform_cash',      'D', 'Asset: settlement bank cash'),
    ('fee_revenue',        'C', 'Revenue: interchange/processing fees earned'),
    ('wallet',             'C', 'Liability: prepaid stored value (balance floor enforced)');

CREATE TABLE accounts (
    account_id         bigint      GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    party_id           bigint      NOT NULL REFERENCES parties (party_id),
    account_type       text        NOT NULL REFERENCES account_types (account_type),
    currency           text        NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),

    min_balance_minor  bigint      CHECK (min_balance_minor IS NULL OR min_balance_minor <= 0),
    status             text        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'frozen', 'closed')),
    created_at         timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT uq_account_natural UNIQUE (party_id, account_type, currency)
);
