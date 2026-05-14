// ─────────────────────────────────────────────────────────────────────────────
// ADD THESE IMPORTS to the top of api.ts (alongside existing imports)
// ─────────────────────────────────────────────────────────────────────────────

import path from 'path';
import {
  leaderboardFileExists,
  readLeaderboardFile,
  generateLeaderboard,
  scorePoint,
  LEADERBOARD_FILE,
} from '../leaderboard';

// Also add Pool import if not already present:
import { Pool } from 'pg';

// ─────────────────────────────────────────────────────────────────────────────
// ADD THIS HELPER near the top of api.ts (after getGoogleMapsApiKey etc.)
// ─────────────────────────────────────────────────────────────────────────────

function getOsmPool(): Pool {
  return new Pool({
    host:     process.env.OSM_DB_HOST     || process.env.DB_HOST     || 'localhost',
    port:     Number(process.env.OSM_DB_PORT  || process.env.DB_PORT  || 5432),
    database: process.env.OSM_DB_NAME     || 'postgres',
    user:     process.env.OSM_DB_USER     || process.env.DB_USER     || 'localuser',
    password: process.env.OSM_DB_PASSWORD || process.env.DB_PASSWORD || 'localpassword',
    ssl:      process.env.OSM_DB_SSL === 'true' ? { rejectUnauthorized: false } : false,
    max: 4,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 10000,
  });
}

const GEOJSON_PATH = path.join(__dirname, '../melbourne_suburbs_rings.geojson');

// ─────────────────────────────────────────────────────────────────────────────
// ADD THESE ROUTES inside the main handler try block in api.ts,
// before the final `return jsonResponse(404, ...)` line
// ─────────────────────────────────────────────────────────────────────────────

    // ── GET /api/leaderboard — return saved file or not-generated status ──────
    if (routePath === '/api/leaderboard' && httpMethod === 'GET') {
      if (!leaderboardFileExists()) {
        return jsonResponse(200, { status: 'not_generated' });
      }
      const data = readLeaderboardFile();
      if (!data) return jsonResponse(500, { error: 'Failed to read leaderboard file' });
      return jsonResponse(200, { status: 'ready', data });
    }

    // ── POST /api/leaderboard/generate — run full generation, stream progress ─
    if (routePath === '/api/leaderboard/generate' && httpMethod === 'POST') {
      const body = event.body ? JSON.parse(event.body) : {};
      const samplesPerSuburb = Math.min(Number(body.samplesPerSuburb) || 10, 20);

      // Track progress in memory so /api/leaderboard/progress can poll it
      leaderboardProgress.running = true;
      leaderboardProgress.done = 0;
      leaderboardProgress.total = 0;
      leaderboardProgress.currentSuburb = '';
      leaderboardProgress.error = null;

      // Run async — don't await so the HTTP response returns immediately
      generateLeaderboard(
        GEOJSON_PATH,
        samplesPerSuburb,
        (done, total, suburb) => {
          leaderboardProgress.done = done;
          leaderboardProgress.total = total;
          leaderboardProgress.currentSuburb = suburb;
        },
      )
        .then(() => {
          leaderboardProgress.running = false;
        })
        .catch(err => {
          console.error('[LEADERBOARD GENERATE ERROR]', err);
          leaderboardProgress.running = false;
          leaderboardProgress.error = err.message;
        });

      return jsonResponse(202, { status: 'started', samplesPerSuburb });
    }

    // ── GET /api/leaderboard/progress — poll generation progress ─────────────
    if (routePath === '/api/leaderboard/progress' && httpMethod === 'GET') {
      return jsonResponse(200, { ...leaderboardProgress });
    }

    // ── GET /api/leaderboard/score — score a single point via OSM + OSRM ──────
    // Used by suburb_osm.html during live per-point generation
    if (routePath === '/api/leaderboard/score' && httpMethod === 'GET') {
      const lat = parseCoordinate(event.queryStringParameters?.lat, 'lat');
      const lon = parseCoordinate(event.queryStringParameters?.lon, 'lon');

      const pool = getOsmPool();
      try {
        const score = await scorePoint(pool, lat, lon);
        return jsonResponse(200, { score });
      } finally {
        await pool.end();
      }
    }

// ─────────────────────────────────────────────────────────────────────────────
// ADD THIS STATE OBJECT near the top of api.ts (module-level, outside handler)
// ─────────────────────────────────────────────────────────────────────────────

const leaderboardProgress = {
  running: false,
  done: 0,
  total: 0,
  currentSuburb: '',
  error: null as string | null,
};
