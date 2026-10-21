import type { Pool } from 'pg';
import type { AgingSummaryRow, ReconciliationRow } from '../ledger/types';


export async function reconciliationReport(pool: Pool, asOf?: Date): Promise<ReconciliationRow[]> {
  const r = await pool.query('SELECT * FROM reconciliation_report(COALESCE($1::timestamptz, now()))', [asOf ?? null]);
  return r.rows as ReconciliationRow[];
}

export async function agingSummary(pool: Pool, asOf?: Date): Promise<AgingSummaryRow[]> {
  const r = await pool.query('SELECT * FROM reconciliation_aging_summary(COALESCE($1::timestamptz, now()))', [asOf ?? null]);
  return r.rows as AgingSummaryRow[];
}
