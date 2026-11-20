export async function createPostgresPool(env = process.env) {
  if (typeof env.DATABASE_URL !== 'string' || !env.DATABASE_URL.trim()) throw new TypeError('Missing required configuration: DATABASE_URL.');
  let pg;
  try { pg = await import('pg'); } catch { throw new Error('PostgreSQL driver is unavailable; install declared dependencies first.'); }
  return new pg.Pool({
    connectionString: env.DATABASE_URL,
    max: 5,
    connectionTimeoutMillis: 10_000,
    idleTimeoutMillis: 30_000,
    ...(env.PGSSL === 'true' ? { ssl: { rejectUnauthorized: true } } : {}),
  });
}

export async function closePostgresPool(pool) {
  try { await pool.end(); } catch { /* Never print connection or credential details. */ }
}
