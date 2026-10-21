import { Pool, PoolClient, types } from 'pg';
import { config } from '../config';


types.setTypeParser(20, (v: string) => BigInt(v));

export type Isolation = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

export interface TxOptions {
  isolation?: Isolation;
  readOnly?: boolean;
  
  maxAttempts?: number;
}


export const retryStats = { serializationFailures: 0, deadlocks: 0, retries: 0, exhausted: 0 };

export function resetRetryStats(): void {
  retryStats.serializationFailures = 0;
  retryStats.deadlocks = 0;
  retryStats.retries = 0;
  retryStats.exhausted = 0;
}

export function createPool(connectionString: string = config.databaseUrl, max: number = config.poolMax): Pool {
  return new Pool({ connectionString, max, application_name: 'ledger-lab' });
}

const RETRYABLE = new Set(['40001', '40P01']); // serialization_failure, deadlock_detected
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const backoffMs = (attempt: number) => Math.min(250, 5 * 2 ** attempt) * (0.5 + Math.random());

export function pgCode(err: unknown): string | undefined {
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const c = (err as { code?: unknown }).code;
    return typeof c === 'string' ? c : undefined;
  }
  return undefined;
}


export async function withTransaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const isolation = opts.isolation ?? 'READ COMMITTED';
  const maxAttempts = opts.maxAttempts ?? 10;
  const begin = `BEGIN ISOLATION LEVEL ${isolation}${opts.readOnly ? ' READ ONLY' : ''}`;

  for (let attempt = 1; ; attempt++) {
    const client = await pool.connect();
    let result!: T;
    try {
      await client.query(begin);
      result = await fn(client);
      await client.query('COMMIT');
    } catch (err) {
      let discard = false;
      try {
        await client.query('ROLLBACK');
      } catch {
        discard = true;
      }
      client.release(discard);

      const code = pgCode(err);
      if (code === '40001') retryStats.serializationFailures++;
      if (code === '40P01') retryStats.deadlocks++;
      if (code && RETRYABLE.has(code)) {
        if (attempt < maxAttempts) {
          retryStats.retries++;
          await sleep(backoffMs(attempt));
          continue;
        }
        retryStats.exhausted++;
      }
      throw err;
    }
    client.release();
    return result;
  }
}
