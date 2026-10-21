import { createHash } from 'crypto';
import { readdirSync, readFileSync } from 'fs';
import path from 'path';
import type { Pool } from 'pg';
import { createPool } from './pool';

const MIGRATION_LOCK_KEY = 727274;

export const MIGRATIONS_DIR = path.resolve(__dirname, '../../db/migrations');


export async function migrate(pool: Pool, dir: string = MIGRATIONS_DIR): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await client.query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (
        filename   text PRIMARY KEY,
        checksum   text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now()
      )`);
    const done = new Map<string, string>();
    for (const r of (await client.query('SELECT filename, checksum FROM schema_migrations')).rows) {
      done.set(r.filename as string, r.checksum as string);
    }

    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      const sql = readFileSync(path.join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const prior = done.get(file);
      if (prior !== undefined) {
        if (prior !== checksum) {
          throw new Error(`migration ${file} was modified after being applied (checksum mismatch)`);
        }
        continue;
      }
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (filename, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`migration ${file} failed: ${(err as Error).message}`);
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    client.release();
  }
}

if (require.main === module) {
  const pool = createPool();
  migrate(pool)
    .then((applied) => {
      console.log(applied.length ? `applied: ${applied.join(', ')}` : 'schema is up to date');
    })
    .catch((err) => {
      console.error(err);
      process.exitCode = 1;
    })
    .finally(() => pool.end());
}
