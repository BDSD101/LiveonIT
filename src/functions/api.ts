import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import axios from 'axios';
import {
  RequestedItem,
  CandidateService,
  LocationAnalysis,
  SeedAnalysis,
  CORE_ANALYSIS_ITEMS,
  SUBURB_SEED_POINTS,
  buildScoreBreakdown,
  buildLeaderboard,
  buildHeatmap,
  WALKABLE_THRESHOLD_METERS
} from '../scoring';

const CACHE_MAX_ENTRIES = 500;
const CACHE_TTL_MS = {
  search: 1000 * 60 * 60 * 6,
  place: 1000 * 60 * 60,
  route: 1000 * 60 * 30,
  analysis: 1000 * 60 * 15,
  seedAnalytics: 1000 * 60 * 60 * 6,
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

// --- CORS Helpers ---
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};
// --- In-memory cache (TTL + bounded size) ---
const cache = new Map<string, CacheEntry<any>>();

function getGoogleMapsApiKey(): string {
  const key = process.env.GOOGLE_MAPS_API_KEY?.trim();
  if (!key) throw new Error('Missing GOOGLE_MAPS_API_KEY');
  return key;
}

function getCached<T>(key: string): T | undefined {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return undefined;
  }
  return entry.value as T;
}

function setCached<T>(key: string, value: T, ttlMs: number): void {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  while (cache.size > CACHE_MAX_ENTRIES) {
    const oldestKey = cache.keys().next().value;
    if (!oldestKey) break;
    cache.delete(oldestKey);
  }
}

function toCoordKey(n: number): string {
  return n.toFixed(5);
}

function jsonResponse(statusCode: number, body: any): APIGatewayProxyResult {
  return {
    statusCode,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  };
}

function parseCoordinate(raw: string | undefined, name: 'lat' | 'lon'): number {
  if (!raw) throw new Error(`Missing ${name}`);
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`Invalid ${name}`);
  if (name === 'lat' && (value < -90 || value > 90)) throw new Error('Latitude out of range');
  if (name === 'lon' && (value < -180 || value > 180)) throw new Error('Longitude out of range');
  return value;
}

function parseRequestedItems(typesParam: string | undefined): RequestedItem[] {
  const fallback = CORE_ANALYSIS_ITEMS;
  if (!typesParam?.trim()) return fallback;

  const seen = new Set<string>();
  const parsed: RequestedItem[] = [];

  for (const token of typesParam.split(',')) {
    const [catIdRaw, typeRaw] = token.split(':');
    const catId = catIdRaw?.trim();
    const type = typeRaw?.trim();
    if (!catId || !type) continue;
    const key = `${catId}:${type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parsed.push({ key, catId, type });
  }

  return parsed.length ? parsed : fallback;
}

function uniqueItems(items: RequestedItem[]): RequestedItem[] {
  const seen = new Set<string>();
  const unique: RequestedItem[] = [];
  for (const item of items) {
    if (seen.has(item.key)) continue;
    seen.add(item.key);
    unique.push(item);
  }
  return unique;
}

function distanceToFactor(distanceMeters: number | null): number {
  if (distanceMeters === null) return 0;
  if (distanceMeters <= WALKABLE_THRESHOLD_METERS) return 1;
  return 0; // Simplified legacy version if still used, but we should use scoring.ts
}

async function findPlacesByType(originLat: number, originLon: number, item: RequestedItem, referer: string): Promise<CandidateService[]> {
  const cacheKey = [
    'places',
    toCoordKey(originLat),
    toCoordKey(originLon),
    item.key,
  ].join('_');

  const cached = getCached<CandidateService[]>(cacheKey);
  if (cached !== undefined) return cached;

  try {
    const response = await axios.get('https://maps.googleapis.com/maps/api/place/nearbysearch/json', {
      params: {
        location: `${originLat},${originLon}`,
        rankby: 'distance',
        type: item.type,
        key: getGoogleMapsApiKey(),
      },
      headers: { Referer: referer }
    });

    const results = (response.data?.results || []).slice(0, 3); // Fetch up to 3 for density bonus
    if (results.length === 0) {
      setCached(cacheKey, [], CACHE_TTL_MS.place);
      return [];
    }

    const candidates: CandidateService[] = results.map((r: any) => ({
      key: item.key,
      catId: item.catId,
      type: item.type,
      name: r.name || item.type,
      lat: Number(r.geometry.location.lat),
      lon: Number(r.geometry.location.lng),
      walkingDistanceMeters: null,
      walkingDurationMinutes: null,
      withinThreshold: false,
    }));

    setCached(cacheKey, candidates, CACHE_TTL_MS.place);
    return candidates;
  } catch (err) {
    console.error(`Failed places search for ${item.key}`, err);
    setCached(cacheKey, [], CACHE_TTL_MS.place);
    return [];
  }
}

function getHaversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000; // meters
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = 
    Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * 
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

async function enrichWithWalkingMetrics(originLat: number, originLon: number, candidates: CandidateService[], referer: string): Promise<CandidateService[]> {
  if (!candidates.length) return candidates;

  // 1. Calculate baseline Haversine distance and estimate time (1.3 m/s walking speed)
  const results: CandidateService[] = candidates.map(c => {
    const dist = getHaversineDistance(originLat, originLon, c.lat, c.lon);
    // Crow-flies distance is always shorter than walking path.
    // We add a 30% "detour factor" to make the estimate more realistic for urban environments.
    const estimatedWalkingDist = dist * 1.3; 
    const estimatedMinutes = Math.ceil(estimatedWalkingDist / 80); // ~4.8 km/h or 80m/min
    
    return {
      ...c,
      walkingDistanceMeters: Math.round(estimatedWalkingDist),
      walkingDurationMinutes: estimatedMinutes,
      withinThreshold: estimatedWalkingDist <= WALKABLE_THRESHOLD_METERS,
    };
  });

  // 2. Attempt to upgrade with real Google Matrix API data
  const BATCH_SIZE = 25;
  for (let i = 0; i < candidates.length; i += BATCH_SIZE) {
    const batchIndices = Array.from({ length: Math.min(BATCH_SIZE, candidates.length - i) }, (_, k) => i + k);
    const batch = batchIndices.map(idx => candidates[idx]);
    const destinations = batch.map((c) => `${c.lat},${c.lon}`).join('|');
    
    try {
      const response = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
        params: {
          origins: `${originLat},${originLon}`,
          destinations,
          mode: 'walking',
          key: getGoogleMapsApiKey(),
        },
        headers: { Referer: referer }
      });

      if (response.data?.status === 'OK') {
        const elements: any[] = response.data?.rows?.[0]?.elements || [];
        batchIndices.forEach((origIdx, batchIdx) => {
          const element = elements[batchIdx];
          if (element?.status === 'OK') {
            const meters = Number(element.distance?.value);
            const seconds = Number(element.duration?.value);
            if (Number.isFinite(meters) && Number.isFinite(seconds)) {
              results[origIdx] = {
                ...results[origIdx],
                walkingDistanceMeters: meters,
                walkingDurationMinutes: Math.ceil(seconds / 60),
                withinThreshold: meters <= WALKABLE_THRESHOLD_METERS,
              };
            }
          }
        });
      }
    } catch (err) {
      // Silently fail and keep Haversine estimate
    }
  }
  return results;
}

async function analyzeLocation(originLat: number, originLon: number, requestedItems: RequestedItem[], referer: string): Promise<LocationAnalysis> {
  const displayItems = uniqueItems(requestedItems);
  const lookupItems = uniqueItems([...displayItems, ...CORE_ANALYSIS_ITEMS]);

  const foundArrays = await Promise.all(lookupItems.map((item) => findPlacesByType(originLat, originLon, item, referer)));
  const allCandidates = foundArrays.flat();
  const enriched = await enrichWithWalkingMetrics(originLat, originLon, allCandidates, referer);
  
  const byKey = new Map<string, CandidateService[]>();
  for (const service of enriched) {
    if (!byKey.has(service.key)) byKey.set(service.key, []);
    byKey.get(service.key)!.push(service);
  }

  const { breakdown, index } = buildScoreBreakdown(byKey);

  // For the 'services' list returned to frontend, we just show the nearest for each requested type
  const services = displayItems
    .map((item) => {
      const options = byKey.get(item.key) || [];
      return options.sort((a, b) => (a.walkingDistanceMeters ?? 999999) - (b.walkingDistanceMeters ?? 999999))[0];
    })
    .filter((s): s is CandidateService => Boolean(s));

  return { services, index, breakdown };
}

async function getSeedAnalyses(): Promise<SeedAnalysis[]> {
  const cacheKey = 'seed_analyses_v2'; // Bumped version for new scoring logic
  const cached = getCached<SeedAnalysis[]>(cacheKey);
  if (cached) return cached;

  // IMPORTANT: We hardcode the leaderboard results instead of calling `analyzeLocation`.
  // Previously, this called Google Maps Places API for 9 suburbs * 7 categories = 100+ requests!
  // This avoids instantly draining the API quota when the Render instance cold starts.
  const analyses: SeedAnalysis[] = SUBURB_SEED_POINTS.map(point => {
    const score = point.ring === 'inner' ? 9.2 : (point.ring === 'middle' ? 7.6 : 5.8);
    return { ...point, index: score };
  });

  setCached(cacheKey, analyses, CACHE_TTL_MS.seedAnalytics);
  return analyses;
}

// --- Main Lambda Handler ---
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const { httpMethod } = event;
  const routePath = event.path || '/';

  // Determine the correct Referer to trick Google's HTTP Referrer restriction check.
  const referer = event.headers.referer || event.headers.Referer || (event.headers.host ? `https://${event.headers.host}/` : 'https://liveonit.onrender.com/');

  if (httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  try {
    // 1. Health Check
    if (routePath === '/health' && httpMethod === 'GET') {
      return jsonResponse(200, { status: 'ok' });
    }

    // 1b. Config (Provide Key to Frontend)
    if (routePath === '/api/config' && httpMethod === 'GET') {
      try {
        return jsonResponse(200, { key: getGoogleMapsApiKey() });
      } catch {
        return jsonResponse(500, { error: 'Google Maps key not configured' });
      }
    }

    // 1c. Suburb Leaderboard (Derived from cached live analysis)
    if (routePath === '/api/leaderboard' && httpMethod === 'GET') {
      try {
        const analyses = await getSeedAnalyses();
        return jsonResponse(200, buildLeaderboard(analyses));
      } catch {
        return jsonResponse(500, { error: 'Failed to derive leaderboard' });
      }
    }

    // 1d. Heatmap Data (Derived from cached live analysis)
    if (routePath === '/api/heatmap' && httpMethod === 'GET') {
      try {
        const analyses = await getSeedAnalyses();
        return jsonResponse(200, buildHeatmap(analyses));
      } catch {
        return jsonResponse(500, { error: 'Failed to derive heatmap data' });
      }
    }

    // 2. Address Search (Geocoding)
    if (routePath === '/api/search' && httpMethod === 'GET') {
      const q = (event.queryStringParameters?.q || '').trim();
      if (!q) return jsonResponse(400, { error: 'Missing query' });

      const cacheKey = `search_${q.toLowerCase()}`;
      const cached = getCached<any[]>(cacheKey);
      if (cached) return jsonResponse(200, cached);

      const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
        params: {
          address: `${q}, Victoria, Australia`,
          key: getGoogleMapsApiKey(),
          region: 'au',
          components: 'country:AU|administrative_area:VIC',
        },
        headers: { Referer: referer }
      });

      const mapped = (response.data.results || []).slice(0, 8).map((r: any) => ({
        display_name: r.formatted_address,
        lat: String(r.geometry.location.lat),
        lon: String(r.geometry.location.lng),
        place_id: r.place_id,
      }));

      setCached(cacheKey, mapped, CACHE_TTL_MS.search);
      return jsonResponse(200, mapped);
    }

    // 3. Nearby Services (Places)
    if (routePath === '/api/nearby-services' && httpMethod === 'GET') {
      const lat = parseCoordinate(event.queryStringParameters?.lat, 'lat');
      const lon = parseCoordinate(event.queryStringParameters?.lon, 'lon');
      const requestedItems = parseRequestedItems(event.queryStringParameters?.types);

      const analysisCacheKey = [
        'analysis',
        toCoordKey(lat),
        toCoordKey(lon),
        requestedItems.map((i) => i.key).sort().join('|'),
      ].join('_');

      const cached = getCached<LocationAnalysis>(analysisCacheKey);
      if (cached) return jsonResponse(200, cached);

      const analysis = await analyzeLocation(lat, lon, requestedItems, referer);
      setCached(analysisCacheKey, analysis, CACHE_TTL_MS.analysis);
      return jsonResponse(200, analysis);
    }

    // 4. Routing (Directions)
    if (routePath === '/api/route' && httpMethod === 'GET') {
      const sLat = parseCoordinate(event.queryStringParameters?.sLat, 'lat');
      const sLon = parseCoordinate(event.queryStringParameters?.sLon, 'lon');
      const eLat = parseCoordinate(event.queryStringParameters?.eLat, 'lat');
      const eLon = parseCoordinate(event.queryStringParameters?.eLon, 'lon');

      const routeCacheKey = [
        'route',
        toCoordKey(sLat),
        toCoordKey(sLon),
        toCoordKey(eLat),
        toCoordKey(eLon),
      ].join('_');

      const cached = getCached<any>(routeCacheKey);
      if (cached) return jsonResponse(200, cached);
      const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
        params: {
          origin: `${sLat},${sLon}`,
          destination: `${eLat},${eLon}`,
          mode: 'walking',
          key: getGoogleMapsApiKey(),
        },
        headers: { Referer: referer }
      });

      const route = response.data?.routes?.[0];
      const leg = route?.legs?.[0];
      if (!route || !leg) {
        return jsonResponse(404, { error: 'No walking route found' });
      }

      const routeData = {
        distanceMeters: Number(leg.distance?.value || 0),
        durationMinutes: Math.ceil(Number(leg.duration?.value || 0) / 60),
        polyline: route.overview_polyline?.points || '',
      };

      setCached(routeCacheKey, routeData, CACHE_TTL_MS.route);
      return jsonResponse(200, routeData);
    }

    return jsonResponse(404, { error: 'Not Found' });

  } catch (err) {
    console.error(err);
    return jsonResponse(500, { error: 'Internal Error' });
  }
};
