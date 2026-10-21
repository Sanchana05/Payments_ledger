

CREATE FUNCTION reconciliation_report(p_as_of timestamptz DEFAULT now())
RETURNS TABLE (
    network_ref            text,
    authorization_id       bigint,
    clearing_id            bigint,
    batch_id               bigint,
    auth_amount_minor      bigint,
    clearing_amount_minor  bigint,
    exception_type         text,
    event_at               timestamptz,
    age_days               integer,
    aging_bucket           text
)
LANGUAGE sql STABLE AS $$
WITH joined AS (
    SELECT COALESCE(a.network_ref, c.network_ref) AS ref,
           a.authorization_id    AS a_id,
           a.status              AS a_status,
           a.amount_minor        AS a_amt,
           a.merchant_account_id AS a_merchant,
           a.authorized_at       AS a_at,
           c.clearing_id         AS c_id,
           c.amount_minor        AS c_amt,
           c.merchant_account_id AS c_merchant,
           c.cleared_at          AS c_at,
           b.batch_id            AS b_id,
           b.created_at          AS b_at
      FROM authorizations a
      FULL OUTER JOIN clearing_records c   ON c.network_ref = a.network_ref
      FULL OUTER JOIN settlement_batches b ON b.batch_id = c.settlement_batch_id
), classified AS (
    SELECT j.*,
           CASE
               WHEN j.a_id IS NULL AND j.c_id IS NULL AND j.b_id IS NOT NULL THEN 'EMPTY_BATCH'
               WHEN j.a_id IS NULL AND j.c_id IS NOT NULL                    THEN 'CLEARING_WITHOUT_AUTH'
               WHEN j.c_id IS NULL AND j.a_id IS NOT NULL AND j.a_status = 'authorized' THEN 'AUTH_WITHOUT_CLEARING'
               WHEN j.a_id IS NOT NULL AND j.c_id IS NOT NULL AND j.a_amt <> j.c_amt           THEN 'AMOUNT_MISMATCH'
               WHEN j.a_id IS NOT NULL AND j.c_id IS NOT NULL AND j.a_merchant <> j.c_merchant THEN 'MERCHANT_MISMATCH'
               WHEN j.c_id IS NOT NULL AND j.b_id IS NULL                                      THEN 'CLEARED_NOT_SETTLED'
           END AS exc,
           COALESCE(j.c_at, j.a_at, j.b_at) AS ev_at
      FROM joined j
), aged AS (
    SELECT x.*,
           GREATEST(0, floor(extract(epoch FROM (p_as_of - x.ev_at)) / 86400))::integer AS age
      FROM classified x
     WHERE x.exc IS NOT NULL
)
SELECT g.ref, g.a_id, g.c_id, g.b_id, g.a_amt, g.c_amt, g.exc, g.ev_at, g.age,
       CASE WHEN g.age <= 1  THEN '0-1d'
            WHEN g.age <= 7  THEN '2-7d'
            WHEN g.age <= 30 THEN '8-30d'
            ELSE '30d+' END
  FROM aged g
$$;

CREATE FUNCTION reconciliation_aging_summary(p_as_of timestamptz DEFAULT now())
RETURNS TABLE (
    exception_type         text,
    aging_bucket           text,
    item_count             bigint,
    auth_total_minor       bigint,
    clearing_total_minor   bigint
)
LANGUAGE sql STABLE AS $$
    SELECT r.exception_type,
           r.aging_bucket,
           count(*),
           COALESCE(sum(r.auth_amount_minor), 0)::bigint,
           COALESCE(sum(r.clearing_amount_minor), 0)::bigint
      FROM reconciliation_report(p_as_of) r
     GROUP BY r.exception_type, r.aging_bucket
     ORDER BY r.exception_type, min(r.age_days)
$$;
