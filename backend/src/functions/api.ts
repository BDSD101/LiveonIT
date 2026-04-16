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
const MELBOURNE_BBOX = {
  west: 144.40,
  south: -38.50,
  east: 145.55,
  north: -37.40,
};

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

    // ── GET /api/local-search (Using Postgres/OSM) ───────────────────────────
    if (routePath === '/api/local-search' && httpMethod === 'GET') {
      const raw = event.queryStringParameters?.q || '';
      const q = raw.trim();
      const cacheKey = `local_melbourne_${q.toLowerCase()}`;

      if (!q || q.length < 3) {
        return {
          statusCode: 400,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Missing or short query param q' }),
        };
      }
      if (searchCache.has(cacheKey)) {
        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify(searchCache.get(cacheKey)),
        };
      }

      // Local-only lookup against imported OSM tables in the Melbourne metro bounding box.
      // Way column is in EPSG:3857, so we transform to EPSG:4326 for output coordinates.
      const sql = `
        WITH melbourne AS (
          SELECT ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, 4326), 3857) AS geom
        ),
        point_matches AS (
          SELECT
            p.name,
            p.tags->'addr:housenumber' AS house_number,
            p.tags->'addr:street' AS street,
            COALESCE(p.tags->'addr:suburb', p.tags->'addr:city') AS suburb,
            ST_Y(ST_Transform(p.way, 4326)) AS lat,
            ST_X(ST_Transform(p.way, 4326)) AS lon,
            CASE
              WHEN CONCAT_WS(' ', p.tags->'addr:housenumber', p.tags->'addr:street') ILIKE $6 THEN 0
              WHEN p.tags->'addr:street' ILIKE $6 THEN 1
              WHEN p.name ILIKE $6 THEN 2
              ELSE 3
            END AS rank
          FROM planet_osm_point p, melbourne m
          WHERE p.way && m.geom
            AND (
              p.name ILIKE $5
              OR p.tags->'addr:street' ILIKE $5
              OR CONCAT_WS(' ', p.tags->'addr:housenumber', p.tags->'addr:street') ILIKE $5
            )
          ORDER BY rank, p.name NULLS LAST
          LIMIT 30
        ),
        polygon_matches AS (
          SELECT
            p.name,
            p.tags->'addr:housenumber' AS house_number,
            p.tags->'addr:street' AS street,
            COALESCE(p.tags->'addr:suburb', p.tags->'addr:city') AS suburb,
            ST_Y(ST_Transform(ST_Centroid(p.way), 4326)) AS lat,
            ST_X(ST_Transform(ST_Centroid(p.way), 4326)) AS lon,
            CASE
              WHEN CONCAT_WS(' ', p.tags->'addr:housenumber', p.tags->'addr:street') ILIKE $6 THEN 0
              WHEN p.tags->'addr:street' ILIKE $6 THEN 1
              WHEN p.name ILIKE $6 THEN 2
              ELSE 3
            END AS rank
          FROM planet_osm_polygon p, melbourne m
          WHERE p.way && m.geom
            AND (
              p.name ILIKE $5
              OR p.tags->'addr:street' ILIKE $5
              OR CONCAT_WS(' ', p.tags->'addr:housenumber', p.tags->'addr:street') ILIKE $5
            )
          ORDER BY rank, p.name NULLS LAST
          LIMIT 30
        )
        SELECT *
        FROM (
          SELECT * FROM point_matches
          UNION ALL
          SELECT * FROM polygon_matches
        ) combined
        ORDER BY rank, street NULLS LAST, name NULLS LAST
        LIMIT 10;
      `;

      try {
        const containsMatch = `%${q}%`;
        const startsWithMatch = `${q}%`;
        const result = await pool.query(sql, [
          MELBOURNE_BBOX.west,
          MELBOURNE_BBOX.south,
          MELBOURNE_BBOX.east,
          MELBOURNE_BBOX.north,
          containsMatch,
          startsWithMatch,
        ]);
        const mapped = result.rows.map(r => {
          const addressLine = [r.house_number, r.street].filter(Boolean).join(' ').trim();
          const locality = [r.suburb, 'Melbourne'].filter(Boolean).join(', ');
          const parts = [addressLine || r.name, r.name, locality].filter(Boolean);
          return {
            display_name: [...new Set(parts)].join(', '),
            lat: String(r.lat),
            lon: String(r.lon),
          };
        });

        if (searchCache.size > 1000) searchCache.clear();
        searchCache.set(cacheKey, mapped);

        return {
          statusCode: 200,
          headers: corsHeaders,
          body: JSON.stringify(mapped),
        };
      } catch (err: any) {
        console.error('Local search error (probably importing):', err.message);
        return {
          statusCode: 503,
          headers: corsHeaders,
          body: JSON.stringify({ error: 'Database map search failed or still importing.' }),
        };
      }
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
