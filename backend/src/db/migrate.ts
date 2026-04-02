import { Client } from 'pg';

export async function runMigrations(): Promise<void> {
  // First connect to default 'postgres' DB to create app_db if missing
  const adminClient = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    database: 'postgres',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });

  await adminClient.connect();

  const dbCheck = await adminClient.query(
    `SELECT 1 FROM pg_database WHERE datname = 'app_db'`
  );

  if (dbCheck.rowCount === 0) {
    await adminClient.query('CREATE DATABASE app_db');
    console.log('Created database: app_db');
  }

  await adminClient.end();

  // Now connect to app_db and create tables
  const appClient = new Client({
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 5432,
    database: 'app_db',
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    ssl: { rejectUnauthorized: false },
  });

  await appClient.connect();

  await appClient.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email       TEXT UNIQUE NOT NULL,
      created_at  TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('Migrations complete');
  await appClient.end();
}
