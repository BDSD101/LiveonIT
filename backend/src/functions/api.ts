import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { Pool, Client } from 'pg';

// ─── DB Pool ────────────────────────────────────────────────────────────────

let pool: Pool | null = null;

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT) || 5432,
      database: process.env.DB_NAME || 'app_db',
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      ssl: { rejectUnauthorized: false },
      max: 1,
      idleTimeoutMillis: 120000,
      connectionTimeoutMillis: 5000,
    });
  }
  return pool;
}

// ─── Migrations ─────────────────────────────────────────────────────────────

let migrated = false;

async function runMigrations(): Promise<void> {
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
      id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      email      TEXT UNIQUE NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
  `);

  console.log('Migrations complete');
  await appClient.end();
}

// ─── CORS ───────────────────────────────────────────────────────────────────

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

function corsResponse(): APIGatewayProxyResult {
  return { statusCode: 200, headers: corsHeaders, body: '' };
}

// ─── In-memory cache (per warm instance) ────────────────────────────────────

const searchCache = new Map<string, unknown>();

// ─── Handler ────────────────────────────────────────────────────────────────

export const handler = async (
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> => {

  const { httpMethod } = event;
  const routePath = event.path || '/';

  // Handle CORS preflight
  if (httpMethod === 'OPTIONS') return corsResponse();

  // Run migrations once per cold start
  if (!migrated) {
    await runMigrations();
    migrated = true;
  }

  const pool = getPool();

  try {

    // ── GET /health ──────────────────────────────────────────────────────────
    if (routePath === '/health' && httpMethod === 'GET') {
      const result = await pool.query('SELECT NOW() as time');
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify({
          status: 'ok',
          db: 'connected',
          time: result.rows[0].time,
        }),
      };
    }

    // ── GET /api/search ──────────────────────────────────────────────────────
    if (routePath === '/api/search' && httpMethod === 'GET') {
      const raw = event.queryStringParameters?.q || '';
      const q = raw.trim().toLowerCase();

      if (!q) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Missing query param q' }),
        };
      }

      if (searchCache.has(q)) {
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify(searchCache.get(q)),
        };
      }

      const params = new URLSearchParams({
        q: raw,
        limit: '5',
        bbox: '144.40,-38.50,145.55,-37.40',
      });

      const response = await fetch(
        `https://photon.komoot.io/api/?${params.toString()}`
      );
      const data = await response.json() as any;

      const mapped = data.features.map((f: any) => {
        const p = f.properties;
        const nameParts = [p.name, p.street, p.city, p.state].filter(Boolean);
        const uniqueParts = [...new Set(nameParts)];
        return {
          display_name: uniqueParts.join(', '),
          lat: f.geometry.coordinates[1].toString(),
          lon: f.geometry.coordinates[0].toString(),
        };
      });

      if (searchCache.size > 1000) searchCache.clear();
      searchCache.set(q, mapped);

      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(mapped),
      };
    }

    // ── GET /users ───────────────────────────────────────────────────────────
    if (routePath === '/users' && httpMethod === 'GET') {
      const result = await pool.query(
        'SELECT id, email, created_at FROM users ORDER BY created_at DESC'
      );
      return {
        statusCode: 200,
        headers: corsHeaders,
        body: JSON.stringify(result.rows),
      };
    }

    // ── POST /users ──────────────────────────────────────────────────────────
    if (routePath === '/users' && httpMethod === 'POST') {
      const body = JSON.parse(event.body || '{}');
      if (!body.email) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'email is required' }),
        };
      }
      const result = await pool.query(
        'INSERT INTO users (email) VALUES ($1) RETURNING *',
        [body.email]
      );
      return {
        statusCode: 201,
        headers: corsHeaders,
        body: JSON.stringify(result.rows[0]),
      };
    }

    // ── 404 ──────────────────────────────────────────────────────────────────
    return {
      statusCode: 404,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Route not found' }),
    };

  } catch (err) {
    console.error('Handler error:', err);
    return {
      statusCode: 500,
      headers: corsHeaders,
      body: JSON.stringify({ error: 'Internal server error' }),
    };
  }
};
