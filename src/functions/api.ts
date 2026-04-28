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
  search: 1000 * 60 * 60 * 8,
  place: 1000 * 60 * 60 * 8,
  route: 1000 * 60 * 60 * 8,
  analysis: 1000 * 60 * 15,
  seedAnalytics: 1000 * 60 * 60 * 8,
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

// --- API Call Tracking (for monitoring usage and debugging) ---
const apiCallCounts: Record<string, number> = {
  places: 0,
  distanceMatrix: 0,
  geocoding: 0,
  directions: 0,
};

function trackApiCall(type: keyof typeof apiCallCounts) {
  apiCallCounts[type]++;
  console.log(`[API Call] ${type} | totals:`, apiCallCounts);
}


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
    // parsed.push({ key, catId, type });
    const existingItem = CORE_ANALYSIS_ITEMS.find(i => i.type === type);
    // console.log(`[PARSE] type:${type} existingItem:`, existingItem?.key, 'hasFilter:', !!existingItem?.filter);
    // parsed.push({ key, catId, type, filter: existingItem?.filter });
    parsed.push({ 
      key: existingItem?.key ?? key,  // ← use canonical key, not frontend key
      catId: existingItem?.catId ?? catId, 
      type, 
      filter: existingItem?.filter,
      useTextSearch: existingItem?.useTextSearch,
      textQuery: existingItem?.textQuery,
      upgradeCount: existingItem?.upgradeCount,  
    });
    
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

// function distanceToFactor(distanceMeters: number | null): number {
//   if (distanceMeters === null) return 0;
//   if (distanceMeters <= WALKABLE_THRESHOLD_METERS) return 1;
//   return 0; // Simplified legacy version if still used, but we should use scoring.ts
// }

async function findPlacesByType(originLat: number, originLon: number, item: RequestedItem): Promise<CandidateService[]> {
  const cacheKey = [
    'places',
    toCoordKey(originLat),
    toCoordKey(originLon),
    item.type,
  ].join('_');

  const cached = getCached<CandidateService[]>(cacheKey);
  if (cached !== undefined) return cached;

  try {
    trackApiCall('places');
    // Places API (New) — searchNearby uses POST with JSON body
    const response = await axios.post(
      'https://places.googleapis.com/v1/places:searchNearby',
      {
        includedTypes: [item.type],
        maxResultCount: item.upgradeCount ?? 5,
        rankPreference: 'DISTANCE',
        locationRestriction: {
          circle: {
            center: { latitude: originLat, longitude: originLon },
            radius: 2000.0,
          },
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': getGoogleMapsApiKey(),
          'X-Goog-FieldMask': 'places.displayName,places.location,places.types,places.iconMaskBaseUri',
        },
      }
    );

    const rawResults = response.data?.places || [];
    // Map to legacy-compatible shape for the filter function
    const mapped = rawResults.map((p: any) => ({
      name: p.displayName?.text || item.type,
      geometry: { location: { lat: p.location?.latitude, lng: p.location?.longitude } },
      icon_mask_base_uri: p.iconMaskBaseUri || '',
      types: p.types || [],
    }));

    const filtered = item.filter ? mapped.filter(item.filter) : mapped;
    console.log(`[FILTER] ${item.type} raw:${rawResults.length} filtered:${filtered.length}`, filtered.map((r: any) => r.name));
    const results = filtered.slice(0, item.upgradeCount ?? 5);

    const seen = new Set<string>();
    const deduped = results.filter((r: any) => {
      if (seen.has(r.name)) return false;
      seen.add(r.name);
      return true;
    });

    if (deduped.length === 0) {
      setCached(cacheKey, [], CACHE_TTL_MS.place);
      return [];
    }

    const candidates: CandidateService[] = deduped.map((r: any) => ({
      key: item.key,
      catId: item.catId,
      type: item.type,
      name: r.name,
      lat: Number(r.geometry.location.lat),
      lon: Number(r.geometry.location.lng),
      walkingDistanceMeters: null,
      walkingDurationMinutes: null,
      withinThreshold: false,
    }));

    setCached(cacheKey, candidates, CACHE_TTL_MS.place);
    return candidates;
  } catch (err: any) {
    console.error(`Failed places search for ${item.key}`, err?.response?.data || err.message);
    setCached(cacheKey, [], CACHE_TTL_MS.place);
    return [];
  }
}

async function findPlacesByText(originLat: number, originLon: number, item: RequestedItem): Promise<CandidateService[]> {
  const cacheKey = [
    'text',
    toCoordKey(originLat),
    toCoordKey(originLon),
    item.type,
  ].join('_');

  const cached = getCached<CandidateService[]>(cacheKey);
  if (cached !== undefined) return cached;

  try {
    trackApiCall('places');
    // Places API (New) — searchText uses POST with JSON body
    const response = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      {
        textQuery: item.textQuery,
        maxResultCount: item.upgradeCount ?? 5,
        locationBias: {
          circle: {
            center: { latitude: originLat, longitude: originLon },
            radius: 2000.0,
          },
        },
      },
      {
        headers: {
          'Content-Type': 'application/json',
          'X-Goog-Api-Key': getGoogleMapsApiKey(),
          'X-Goog-FieldMask': 'places.displayName,places.location,places.types,places.iconMaskBaseUri',
        },
      }
    );

    const rawResults = response.data?.places || [];
    // Map to legacy-compatible shape for the filter function
    const mapped = rawResults.map((p: any) => ({
      name: p.displayName?.text || item.type,
      geometry: { location: { lat: p.location?.latitude, lng: p.location?.longitude } },
      icon_mask_base_uri: p.iconMaskBaseUri || '',
      types: p.types || [],
    }));

    const filtered = item.filter ? mapped.filter(item.filter) : mapped;
    console.log(`[TEXT SEARCH] ${item.type} raw:${rawResults.length} filtered:${filtered.length}`, filtered.map((r: any) => r.name));

    const seen = new Set<string>();
    const deduped = filtered
      .slice(0, item.upgradeCount ?? 5)
      .filter((r: any) => {
        if (seen.has(r.name)) return false;
        seen.add(r.name);
        return true;
      });

    if (deduped.length === 0) {
      setCached(cacheKey, [], CACHE_TTL_MS.place);
      return [];
    }

    const candidates: CandidateService[] = deduped.map((r: any) => ({
      key: item.key,
      catId: item.catId,
      type: item.type,
      name: r.name,
      lat: Number(r.geometry.location.lat),
      lon: Number(r.geometry.location.lng),
      walkingDistanceMeters: null,
      walkingDurationMinutes: null,
      withinThreshold: false,
    }));

    setCached(cacheKey, candidates, CACHE_TTL_MS.place);
    return candidates;

  } catch (err: any) {
    console.error(`[TEXT SEARCH ERROR] ${item.type}:`, err?.response?.data || err.message);
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

async function enrichWithWalkingMetrics(originLat: number, originLon: number, candidates: CandidateService[]): Promise<CandidateService[]> {
  if (!candidates.length) return candidates;

  // 1. Calculate baseline Haversine estimates for all candidates
  const results: CandidateService[] = candidates.map(c => {
    const dist = getHaversineDistance(originLat, originLon, c.lat, c.lon);
    const estimatedWalkingDist = dist * 1.3; // 30% detour factor for urban environments
    const estimatedMinutes = Math.ceil(estimatedWalkingDist / 80); // ~4.8 km/h or 80m/min
    return {
      ...c,
      walkingDistanceMeters: Math.round(estimatedWalkingDist),
      walkingDurationMinutes: estimatedMinutes,
      withinThreshold: estimatedWalkingDist <= WALKABLE_THRESHOLD_METERS,
    };
  });

  // 2. Only upgrade candidates within 1.5x the walkable threshold to save API calls
  const worthUpgrading = results.filter(c =>
    (c.walkingDistanceMeters ?? 0) <= WALKABLE_THRESHOLD_METERS * 3
  );
  // console.log(`[WORTH UPGRADING] ${worthUpgrading.length} of ${results.length} candidates`);
  if (!worthUpgrading.length) return results;

  // 3. Upgrade with real walking distances from Distance Matrix API
  const BATCH_SIZE = 25;
  for (let i = 0; i < worthUpgrading.length; i += BATCH_SIZE) {
    const batch = worthUpgrading.slice(i, i + BATCH_SIZE);
    const destinations = batch.map(c => `${c.lat},${c.lon}`).join('|');

    try {
      trackApiCall('distanceMatrix');
      const response = await axios.get('https://maps.googleapis.com/maps/api/distancematrix/json', {
        params: {
          origins: `${originLat},${originLon}`,
          destinations,
          mode: 'walking',
          key: getGoogleMapsApiKey(),
        },
      });
      // console.log('[MATRIX RAW]', JSON.stringify(response.data).slice(0, 500));

      if (response.data?.status === 'OK') {
        const elements: any[] = response.data?.rows?.[0]?.elements || [];
        // console.log(`[MATRIX RESPONSE] ${elements.length} elements:`, 
          // elements.map((e: any, i: number) => `${batch[i]?.name}: ${e?.status} ${e?.distance?.value}m`)
        // );
        // console.log('[BATCH ORDER]', batch.map((c, i) => `${i}: ${c.name}`));
        // console.log('[ELEMENTS]', elements.map((e: any, i: number) => `${i}: ${e?.status} ${e?.distance?.value}m`));
        batch.forEach((candidate, batchIdx) => {
          const element = elements[batchIdx];
          if (element?.status === 'OK') {
            const meters = Number(element.distance?.value);
            const seconds = Number(element.duration?.value);
            if (Number.isFinite(meters) && Number.isFinite(seconds)) {
              // Find by name+key instead of reference equality
              const resultsIdx = results.findIndex(r => r.name === candidate.name && r.key === candidate.key);
              if (resultsIdx !== -1) {
                results[resultsIdx] = {
                  ...results[resultsIdx],
                  walkingDistanceMeters: meters,
                  walkingDurationMinutes: Math.ceil(seconds / 60),
                  withinThreshold: meters <= WALKABLE_THRESHOLD_METERS,
                };
                // console.log(`[MATRIX] ${candidate.name}: ${meters}m (${Math.ceil(seconds / 60)} min)`);
              }
            }
          }
        });
      }
    } catch (err) {
      console.error('[MATRIX ERROR]', err);
    }
  }
  return results;
}

async function analyzeLocation(originLat: number, originLon: number, requestedItems: RequestedItem[]): Promise<LocationAnalysis> {
  const displayItems = uniqueItems(requestedItems);
  const lookupItems = uniqueItems([...displayItems, ...CORE_ANALYSIS_ITEMS]);
  // console.log('[LOOKUP ITEMS]', lookupItems.map(i => i.key));

  // Modified for Text Search
  const foundArrays = await Promise.all(
    lookupItems.map(item =>
      item.useTextSearch
        ? findPlacesByText(originLat, originLon, item)
        : findPlacesByType(originLat, originLon, item)
    )
  );

  const allCandidates = foundArrays.flat();
  // console.log('[ALL CANDIDATES]', allCandidates.length, allCandidates.map(c => `${c.key}:${c.name}`));
  const enriched = await enrichWithWalkingMetrics(originLat, originLon, allCandidates);

  // Rerank by actual walking distance and trim to 3 per type
  const byKey = new Map<string, CandidateService[]>();
  for (const service of enriched) {
    if (!byKey.has(service.key)) byKey.set(service.key, []);
    byKey.get(service.key)!.push(service);
  }
  for (const [key, candidates] of byKey.entries()) {
    byKey.set(key, candidates
      .sort((a, b) => (a.walkingDistanceMeters ?? 999999) - (b.walkingDistanceMeters ?? 999999))
      .slice(0, 3)
    );
  }

  // Temp logging to verify the final candidates being scored
  for (const [key, candidates] of byKey.entries()) {
    console.log(`[RERANKED] ${key}:`, candidates.map(c => `${c.name} (${c.walkingDistanceMeters}m)`));
    // if (key.includes('doctor')) {
    //   console.log(`[RERANKED] ${key}:`, candidates.map(c => `${c.name} (${c.walkingDistanceMeters}m)`));
    // }
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

  const analyses: SeedAnalysis[] = [];
  for (const point of SUBURB_SEED_POINTS) {
    try {
      const analysis = await analyzeLocation(point.lat, point.lng, CORE_ANALYSIS_ITEMS);
      analyses.push({ ...point, index: analysis.index });
    } catch (err) {
      console.error(`Failed seed analysis for ${point.name}`, err);
    }
  }

  setCached(cacheKey, analyses, CACHE_TTL_MS.seedAnalytics);
  return analyses;
}

// --- Main Lambda Handler ---
export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  const { httpMethod } = event;
  const routePath = event.path || '/';

  if (httpMethod === 'OPTIONS') return { statusCode: 200, headers: corsHeaders, body: '' };

  try {
    // 0. Debug: API call stats
    if (routePath === '/api/debug/stats' && httpMethod === 'GET') {
      return jsonResponse(200, {
        apiCallCounts,
        cacheSize: cache.size,
      });
    }

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

      trackApiCall('geocoding'); // for monitoring usage
      const response = await axios.get('https://maps.googleapis.com/maps/api/geocode/json', {
        params: {
          address: `${q}, Victoria, Australia`,
          key: getGoogleMapsApiKey(),
          region: 'au',
          components: 'country:AU|administrative_area:VIC',
        },
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
      // console.log('[NEARBY] request received, types:', event.queryStringParameters?.types);  // ← add this
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

      const analysis = await analyzeLocation(lat, lon, requestedItems);
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
      trackApiCall('directions'); // for monitoring usage
      const response = await axios.get('https://maps.googleapis.com/maps/api/directions/json', {
        params: {
          origin: `${sLat},${sLon}`,
          destination: `${eLat},${eLon}`,
          mode: 'walking',
          key: getGoogleMapsApiKey(),
        },
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

    // Temporary debug endpoint to audit nearby search results for a given type and location, without affecting scoring cache
    if (routePath === '/api/debug/audit' && httpMethod === 'GET') {
      const type = event.queryStringParameters?.type;
      const lat = parseCoordinate(event.queryStringParameters?.lat, 'lat');
      const lon = parseCoordinate(event.queryStringParameters?.lon, 'lon');
      const query = event.queryStringParameters?.query;
      const radius = Number(event.queryStringParameters?.radius) || 2000;

      if (!lat || !lon) {
        return jsonResponse(400, { error: 'Missing lat or lon' });
      }
      if (!query && !type) {
        return jsonResponse(400, { error: 'Missing type or query' });
      }

      const headers = {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': getGoogleMapsApiKey(),
        'X-Goog-FieldMask': 'places.displayName,places.location,places.types,places.iconMaskBaseUri',
      };

      let response;
      if (query) {
        response = await axios.post(
          'https://places.googleapis.com/v1/places:searchText',
          {
            textQuery: query,
            maxResultCount: 20,
            locationBias: {
              circle: {
                center: { latitude: lat, longitude: lon },
                radius: radius,
              },
            },
          },
          { headers }
        );
      } else {
        response = await axios.post(
          'https://places.googleapis.com/v1/places:searchNearby',
          {
            includedTypes: [type],
            maxResultCount: 20,
            rankPreference: 'DISTANCE',
            locationRestriction: {
              circle: {
                center: { latitude: lat, longitude: lon },
                radius: radius,
              },
            },
          },
          { headers }
        );
      }

      const results = (response.data?.places || []).map((p: any) => ({
        name: p.displayName?.text,
        pinlet: p.iconMaskBaseUri?.split('/').pop(),
        types: p.types,
      }));

      return jsonResponse(200, { type, query, total: results.length, results });
    }

    return jsonResponse(404, { error: 'Not Found' });

  } catch (err) {
    console.error(err);
    return jsonResponse(500, { error: 'Internal Error' });
  }
};
