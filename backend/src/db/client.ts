import { Pool } from 'pg';

let pool: Pool | null = null;

export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'app_db',
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      // ssl: { rejectUnauthorized: false },
      ssl: process.env.DB_SSL === 'false' ? false : { rejectUnauthorized: false },
      max: 1,            // Lambda: keep pool size at 1
      idleTimeoutMillis: 120000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}
