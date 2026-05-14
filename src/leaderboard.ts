import { Pool } from 'pg';
import fs from 'fs';
import path from 'path';
import axios from 'axios';

import {
  CandidateService,
  WALKABLE_THRESHOLD_METERS,
  buildErrandCandidateMap,
  scoreErrandTripExact,
  scoreAbundance,
  scoreNearestServices,
  LEADERBOARD_PLACE_TYPES,
} from './scoring';

// ---------------------------------------------------------------------------
// Config — all values come from env vars so swapping local ↔ AWS is just .env
// ---------------------------------------------------------------------------

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

function getOsrmUrl(): string {
  return process.env.OSRM_URL || 'http://localhost:5000';
}

export const LEADERBOARD_FILE = path.join(__dirname, '../leaderboard.json');

// ---------------------------------------------------------------------------
// OSM tag → scoring type mapping
// Only covers LEADERBOARD_PLACE_TYPES — expand here when you add more types
// ---------------------------------------------------------------------------

type OsmWhereClause = {
  column: string;
  value: string;
};

const OSM_TYPE_MAP: Record<string, OsmWhereClause> = {
  supermarket:     { column: 'shop',    value: 'supermarket' },
  // Extend as you uncomment more LEADERBOARD_PLACE_TYPES:
  // doctor:          { column: 'amenity', value: 'doctors' },
  // train_station:   { column: 'railway', value: 'station' },
  // transit_station: { column: 'highway', value: 'bus_stop' },
  // park:            { column: 'leisure', value: 'park' },
  // pharmacy:        { column: 'amenity', value: 'pharmacy' },
  // cafe:            { column: 'amenity', value: 'cafe' },
  // restaurant:      { column: 'amenity', value: 'restaurant' },
  // bar:             { column: 'amenity', value: 'bar' },
  // gym:             { column: 'leisure', value: 'fitness_centre' },
  // childcare:       { column: 'amenity', value: 'childcare' },
  // kindergarten:    { column: 'amenity', value: 'kindergarten' },
  // primary_school:  { column: 'amenity', value: 'school' },
  // secondary_school:{ column: 'amenity', value: 'school' },
  // library:         { column: 'amenity', value: 'library' },
  // post_office:     { column: 'amenity', value: 'post_office' },
  // bank:            { column: 'amenity', value: 'bank' },
  // atm:             { column: 'amenity', value: 'atm' },
};

// Name-based allowlist filters (mirrors scoring.ts PLACE_TYPE_NAME_ALLOWLIST)
const NAME_ALLOWLIST: Record<string, string[]> = {
  supermarket: ['woolworths', 'coles', 'aldi', 'iga', 'foodworks', 'safeway'],
};

// Name-based blocklist filters (mirrors scoring.ts PLACE_TYPE_NAME_BLOCKLIST)
const NAME_BLOCKLIST: Record<string, string[]> = {
  supermarket: ['spices', 'convenience', 'smoke', 'liquor', 'bottle shop', 'petrol', 'fuel', 'bakery', 'butcher', 'seafood', 'organic'],
};

// ---------------------------------------------------------------------------
// Flatten LEADERBOARD_PLACE_TYPES into a list of { catId, type } pairs
// ---------------------------------------------------------------------------

type LeaderboardItem = { catId: string; type: string; key: string };

function getLeaderboardItems(): LeaderboardItem[] {
  return Object.entries(LEADERBOARD_PLACE_TYPES).flatMap(([catId, types]) =>
    types.map(type => ({ catId, type, key: `${catId}:${type}` }))
  );
}

// ---------------------------------------------------------------------------
// PostGIS query — find amenities near a point
// ---------------------------------------------------------------------------

async function findNearbyOsm(
  pool: Pool,
  lat: number,
  lon: number,
  item: LeaderboardItem,
  radiusMeters = WALKABLE_THRESHOLD_METERS,
  limit = 5,
): Promise<Array<{ name: string; lat: number; lon: number }>> {
  const osm = OSM_TYPE_MAP[item.type];
  if (!osm) {
    console.warn(`[OSM] No tag mapping for type: ${item.type}`);
    return [];
  }

  try {
    const result = await pool.query(
      `SELECT
         name,
         ST_Y(ST_Transform(way, 4326)) AS lat,
         ST_X(ST_Transform(way, 4326)) AS lon
       FROM planet_osm_point
       WHERE ${osm.column} = $1
         AND name IS NOT NULL
         AND ST_DWithin(
           ST_Transform(way, 4326)::geography,
           ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography,
           $4
         )
       ORDER BY ST_Distance(
         ST_Transform(way, 4326)::geography,
         ST_SetSRID(ST_MakePoint($2, $3), 4326)::geography
       )
       LIMIT $5`,
      [osm.value, lon, lat, radiusMeters, limit]
    );

    const allowlist = NAME_ALLOWLIST[item.type];
    const blocklist = NAME_BLOCKLIST[item.type] ?? [];

    return result.rows
      .filter(r => {
        const name = (r.name ?? '').toLowerCase();
        if (blocklist.some(w => name.includes(w))) return false;
        if (allowlist && allowlist.length > 0 && !allowlist.some(w => name.includes(w))) return false;
        return true;
      })
      .map(r => ({ name: r.name, lat: Number(r.lat), lon: Number(r.lon) }));

  } catch (err: any) {
    console.error(`[OSM ERROR] ${item.type}:`, err.message);
    return [];
  }
}

// ---------------------------------------------------------------------------
// OSRM /table — batch walking durations from one origin to many destinations
// Returns durations in seconds, or null if unreachable
// ---------------------------------------------------------------------------

async function getWalkingDurations(
  originLat: number,
  originLon: number,
  destinations: Array<{ lat: number; lon: number }>,
): Promise<(number | null)[]> {
  if (!destinations.length) return [];

  // OSRM /table coord format: lng,lat
  const coords = [
    `${originLon},${originLat}`,
    ...destinations.map(d => `${d.lon},${d.lat}`),
  ].join(';');

  // sources=0 means only compute from the first coordinate (origin) to all others
  const url = `${getOsrmUrl()}/table/v1/foot/${coords}?sources=0`;

  try {
    console.log('[OSRM URL]', url);
    const res = await axios.get(url, { timeout: 10000 });
    if (res.data?.code !== 'Ok') {
      console.warn('[OSRM TABLE] Non-OK response:', res.data?.code);
      return destinations.map(() => null);
    }
    // durations[0] is the row for our origin — values are seconds
    const durations: (number | null)[] = res.data.durations[0].slice(1); // skip self (index 0)
    return durations;
  } catch (err: any) {
    console.warn('[OSRM TABLE ERROR]:', err?.message, err?.code, err?.response?.status, err?.response?.data);
    return destinations.map(() => null);
  }
}

// ---------------------------------------------------------------------------
// Score a single lat/lon point using OSM + OSRM
// ---------------------------------------------------------------------------

export async function scorePoint(
  pool: Pool,
  lat: number,
  lon: number,
): Promise<number> {
  const items = getLeaderboardItems();

  // 1. Fetch candidates from PostGIS for each type
  const candidateArrays = await Promise.all(
    items.map(item => findNearbyOsm(pool, lat, lon, item))
  );

  // 2. Flatten all candidates with their item metadata
  type RawCandidate = { catId: string; type: string; key: string; name: string; lat: number; lon: number };
  const rawCandidates: RawCandidate[] = candidateArrays.flatMap((arr, i) =>
    arr.map(c => ({ ...c, catId: items[i].catId, type: items[i].type, key: items[i].key }))
  );

  if (!rawCandidates.length) return 0;

  // 3. Batch walking durations via OSRM /table
  const durations = await getWalkingDurations(lat, lon, rawCandidates);

  // 4. Build CandidateService array with walking metrics
  const candidates: CandidateService[] = rawCandidates.map((c, i) => {
    const durationSeconds = durations[i];
    const durationMinutes = durationSeconds !== null ? Math.ceil(durationSeconds / 60) : null;
    // Estimate distance from duration (avg walking speed ~80m/min)
    const walkingDistanceMeters = durationSeconds !== null ? Math.round((durationSeconds / 60) * 80) : null;
    return {
      key: c.key,
      catId: c.catId,
      type: c.type,
      name: c.name,
      lat: c.lat,
      lon: c.lon,
      walkingDistanceMeters,
      walkingDurationMinutes: durationMinutes,
      withinThreshold: walkingDistanceMeters !== null && walkingDistanceMeters <= WALKABLE_THRESHOLD_METERS,
    };
  });

  console.log(`[SCOREPOINT] lat:${lat} lon:${lon} candidates:${candidates.length}`, 
  candidates.map(c => `${c.name} dist:${c.walkingDistanceMeters}m dur:${c.walkingDurationMinutes}min`)
  );

  // 5. Run scoring functions (same as api.ts analyzeLocation)
  const selectedTypes = new Set(items.map(i => i.type));
  const { candidatesByCategory } = buildErrandCandidateMap(candidates);
  const errandTrip = scoreErrandTripExact(lat, lon, candidatesByCategory);
  const abundance  = scoreAbundance(candidates, WALKABLE_THRESHOLD_METERS, selectedTypes);
  const nearest    = scoreNearestServices(candidates, WALKABLE_THRESHOLD_METERS, selectedTypes);

  const WEIGHTS = { errandTrip: 0.05, abundance: 0.05, nearest: 0.90 };
  const score = Number((
    errandTrip.score * WEIGHTS.errandTrip +
    abundance.score  * WEIGHTS.abundance  +
    nearest.score    * WEIGHTS.nearest
  ).toFixed(1));

  return score;
}

// ---------------------------------------------------------------------------
// Geometry helpers — sample N points inside a GeoJSON polygon
// ---------------------------------------------------------------------------

type Ring = [number, number][];

function getRings(geometry: any): Ring[] {
  if (geometry.type === 'Polygon') return geometry.coordinates;
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.reduce((best: Ring[], poly: Ring[]) =>
      poly[0].length > best[0].length ? poly : best
    );
  }
  return [];
}

function bbox(ring: Ring) {
  let minLng = Infinity, maxLng = -Infinity, minLat = Infinity, maxLat = -Infinity;
  for (const [lng, lat] of ring) {
    if (lng < minLng) minLng = lng;
    if (lng > maxLng) maxLng = lng;
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
  }
  return { minLng, maxLng, minLat, maxLat };
}

function pointInRing(lng: number, lat: number, ring: Ring): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersect = ((yi > lat) !== (yj > lat)) &&
      (lng < (xj - xi) * (lat - yi) / (yj - yi) + xi);
    if (intersect) inside = !inside;
  }
  return inside;
}

function pointInPolygon(lng: number, lat: number, rings: Ring[]): boolean {
  if (!pointInRing(lng, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lng, lat, rings[i])) return false;
  }
  return true;
}

export function samplePoints(geometry: any, n: number): Array<{ lat: number; lon: number }> {
  const rings = getRings(geometry);
  if (!rings.length) return [];
  const outerRing = rings[0];
  const box = bbox(outerRing);
  const points: Array<{ lat: number; lon: number }> = [];
  let attempts = 0;
  const maxAttempts = n * 200;
  while (points.length < n && attempts < maxAttempts) {
    attempts++;
    const lng = box.minLng + Math.random() * (box.maxLng - box.minLng);
    const lat = box.minLat + Math.random() * (box.maxLat - box.minLat);
    if (pointInPolygon(lng, lat, rings)) {
      points.push({ lat, lon: lng });
    }
  }
  return points;
}

// ---------------------------------------------------------------------------
// Leaderboard file helpers
// ---------------------------------------------------------------------------

export type SuburbResult = {
  suburb: string;
  ring: string;
  avg: number;
  min: number;
  max: number;
  scores: number[];
  sampledPoints: number;
};

export type LeaderboardData = {
  generatedAt: string;
  samplesPerSuburb: number;
  suburbs: SuburbResult[];
};

export function leaderboardFileExists(): boolean {
  return fs.existsSync(LEADERBOARD_FILE);
}

export function readLeaderboardFile(): LeaderboardData | null {
  try {
    const raw = fs.readFileSync(LEADERBOARD_FILE, 'utf8');
    return JSON.parse(raw) as LeaderboardData;
  } catch {
    return null;
  }
}

export function writeLeaderboardFile(data: LeaderboardData): void {
  fs.writeFileSync(LEADERBOARD_FILE, JSON.stringify(data, null, 2), 'utf8');
}

// ---------------------------------------------------------------------------
// Main generation function — called by POST /api/leaderboard/generate
// onProgress callback lets the API stream progress back to the client
// ---------------------------------------------------------------------------

export async function generateLeaderboard(
  geojsonPath: string,
  samplesPerSuburb = 10,
  onProgress?: (done: number, total: number, suburb: string, latest?: SuburbResult) => void,
): Promise<LeaderboardData> {

  const pool = getOsmPool();

  try {
    // Load GeoJSON
    const raw = fs.readFileSync(geojsonPath, 'utf8');
    const geojson = JSON.parse(raw);
    const features: any[] = geojson.features;

    const suburbs: SuburbResult[] = [];
    const total = features.length;
    let done = 0;

    for (const feature of features) {
      const suburbName: string = feature.properties.suburb;
      const ring: string       = feature.properties.bcarrRing;

      const points = samplePoints(feature.geometry, samplesPerSuburb);
      console.log(`[LEADERBOARD] ${suburbName} (${ring}): ${points.length} sample points`);

      if (!points.length) {
        done++;
        onProgress?.(done, total, suburbName, suburbs[suburbs.length - 1]);
        continue;
      }

      // Score each sample point — run concurrently but cap at 5 at a time
      // to avoid hammering OSRM/PostGIS
      const CONCURRENCY = 5;
      const scores: number[] = [];

      for (let i = 0; i < points.length; i += CONCURRENCY) {
        const batch = points.slice(i, i + CONCURRENCY);
        const batchScores = await Promise.all(
          batch.map(pt => scorePoint(pool, pt.lat, pt.lon).catch(() => null))
        );
        scores.push(...batchScores.filter((s): s is number => s !== null));
      }

      if (scores.length) {
        const avg = Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2));
        const min = Number(Math.min(...scores).toFixed(2));
        const max = Number(Math.max(...scores).toFixed(2));
        suburbs.push({ suburb: suburbName, ring, avg, min, max, scores, sampledPoints: scores.length });
      }

      done++;
      onProgress?.(done, total, suburbName, suburbs[suburbs.length - 1]);
    }

    const data: LeaderboardData = {
      generatedAt: new Date().toISOString(),
      samplesPerSuburb,
      suburbs,
    };

    writeLeaderboardFile(data);
    console.log(`[LEADERBOARD] Done — ${suburbs.length} suburbs scored, saved to ${LEADERBOARD_FILE}`);
    return data;

  } finally {
    await pool.end();
  }
}
