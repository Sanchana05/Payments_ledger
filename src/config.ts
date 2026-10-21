export const config = {
  databaseUrl: process.env.DATABASE_URL ?? 'postgres://ledger:ledger@localhost:54329/ledger',
  poolMax: Number(process.env.PG_POOL_MAX ?? 20),
};
