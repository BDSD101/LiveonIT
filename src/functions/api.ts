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
  WALKABLE_THRESHOLD_METERS,
  buildErrandCandidateMap,
  scoreErrandTripExact,
  scoreAbundance,
  scoreNearestServices,
  haversineMeters,
  extractSuburbFromAddress,
  normaliseToTen,
  resolveHousePriceScore,
  getSuburbData
} from '../scoring';


const CACHE_MAX_ENTRIES = 500;
const CACHE_TTL_MS = {
  search: 1000 * 60 * 60 * 8,
  place: 1000 * 60 * 60 * 8,
  route: 1000 * 60 * 60 * 8,
  analysis: 1000 * 60 * 15,
  neighbourhood: 1000 * 60 * 60 * 8,
  seedAnalytics: 1000 * 60 * 60 * 8,
};

type CacheEntry<T> = {
  value: T;
  expiresAt: number;
};

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type,Authorization',
  'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
};

const cache = new Map<string, CacheEntry<any>>();

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
    const existingItem = CORE_ANALYSIS_ITEMS.find(i => i.type === type);
    parsed.push({ 
      key: existingItem?.key ?? key,
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
    const response = await axios.post(
      'https://places.googleapis.com/v1/places:searchNearby',
      {
        includedTypes: [item.type],
        maxResultCount: item.upgradeCount ?? 5,
        rankPreference: 'DISTANCE',
        locationRestriction: {
          circle: {
            center: { latitude: originLat, longitude: originLon },
            radius: 5000.0,
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
    const mapped = rawResults.map((p: any) => ({
      name: p.displayName?.text || item.type,
      geometry: { location: { lat: p.location?.latitude, lng: p.location?.longitude } },
      icon_mask_base_uri: p.iconMaskBaseUri || '',
      types: p.types || [],
    }));

    const filtered = item.filter ? mapped.filter(item.filter) : mapped;
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
    const response = await axios.post(
      'https://places.googleapis.com/v1/places:searchText',
      {
        textQuery: item.textQuery,
        maxResultCount: item.upgradeCount ?? 5,
        locationBias: {
          circle: {
            center: { latitude: originLat, longitude: originLon },
            radius: 5000.0,
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
    const mapped = rawResults.map((p: any) => ({
      name: p.displayName?.text || item.type,
      geometry: { location: { lat: p.location?.latitude, lng: p.location?.longitude } },
      icon_mask_base_uri: p.iconMaskBaseUri || '',
      types: p.types || [],
    }));

    const filtered = item.filter ? mapped.filter(item.filter) : mapped;

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


async function enrichWithWalkingMetrics(originLat: number, originLon: number, candidates: CandidateService[]): Promise<CandidateService[]> {
  if (!candidates.length) return candidates;

  const results: CandidateService[] = candidates.map(c => {
    const dist = haversineMeters(originLat, originLon, c.lat, c.lon);
    const estimatedWalkingDist = dist * 1.3;
    const estimatedMinutes = Math.ceil(estimatedWalkingDist / 80);
    return {
      ...c,
      walkingDistanceMeters: Math.round(estimatedWalkingDist),
      walkingDurationMinutes: estimatedMinutes,
      withinThreshold: estimatedWalkingDist <= WALKABLE_THRESHOLD_METERS,
    };
  });

  const worthUpgrading = results.filter(c =>
    (c.walkingDistanceMeters ?? 0) <= WALKABLE_THRESHOLD_METERS * 3
  );
  if (!worthUpgrading.length) return results;

  const BATCH_SIZE = 25;
  const batches: CandidateService[][] = [];
  for (let i = 0; i < worthUpgrading.length; i += BATCH_SIZE) {
    batches.push(worthUpgrading.slice(i, i + BATCH_SIZE));
  }

  await Promise.all(batches.map(async (batch) => {
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

      if (response.data?.status === 'OK') {
        const elements: any[] = response.data?.rows?.[0]?.elements || [];
        batch.forEach((candidate, batchIdx) => {
          const element = elements[batchIdx];
          if (element?.status === 'OK') {
            const meters = Number(element.distance?.value);
            const seconds = Number(element.duration?.value);
            if (Number.isFinite(meters) && Number.isFinite(seconds)) {
              const resultsIdx = results.findIndex(r => r.name === candidate.name && r.key === candidate.key);
              if (resultsIdx !== -1) {
                results[resultsIdx] = {
                  ...results[resultsIdx],
                  walkingDistanceMeters: meters,
                  walkingDurationMinutes: Math.ceil(seconds / 60),
                  withinThreshold: meters <= WALKABLE_THRESHOLD_METERS,
                };
              }
            }
          }
        });
      }
    } catch (err) {
      console.error('[MATRIX ERROR]', err);
    }
  }));
  return results;
}

// Fetch and enrich all CORE_ANALYSIS_ITEMS for a location, cached by (lat,lon).
// This is the expensive step (Places API + Distance Matrix). Subsequent calls with
// different service selections reuse the cached enriched candidates instead of
// re-hitting the APIs.
async function getNeighbourhoodEnriched(originLat: number, originLon: number): Promise<CandidateService[]> {
  const cacheKey = `nb_${toCoordKey(originLat)}_${toCoordKey(originLon)}`;
  const cached = getCached<CandidateService[]>(cacheKey);
  if (cached) return cached;

  const foundArrays = await Promise.all(
    CORE_ANALYSIS_ITEMS.map(item =>
      item.useTextSearch
        ? findPlacesByText(originLat, originLon, item)
        : findPlacesByType(originLat, originLon, item)
    )
  );
  const allCandidates = foundArrays.flat();
  const enriched = await enrichWithWalkingMetrics(originLat, originLon, allCandidates);
  setCached(cacheKey, enriched, CACHE_TTL_MS.neighbourhood);
  return enriched;
}

async function analyzeLocation(
  originLat: number,
  originLon: number,
  requestedItems: RequestedItem[],
  formattedAddress?: string,
): Promise<LocationAnalysis> {
  const displayItems = uniqueItems(requestedItems);

  // Reuse the location-level neighbourhood cache; only fetch extra types the
  // user selected that aren't already in CORE_ANALYSIS_ITEMS (e.g. bakery).
  const coreTypes = new Set(CORE_ANALYSIS_ITEMS.map(i => i.type));
  const extraItems = displayItems.filter(di => !coreTypes.has(di.type));

  const nbEnriched = await getNeighbourhoodEnriched(originLat, originLon);

  let enriched = nbEnriched;
  if (extraItems.length > 0) {
    const extraArrays = await Promise.all(
      extraItems.map(item =>
        item.useTextSearch
          ? findPlacesByText(originLat, originLon, item)
          : findPlacesByType(originLat, originLon, item)
      )
    );
    const extraEnriched = await enrichWithWalkingMetrics(originLat, originLon, extraArrays.flat());
    enriched = [...nbEnriched, ...extraEnriched];
  }

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

  const { breakdown, index } = buildScoreBreakdown(byKey);

  // --- Walkability scores (zero extra API calls) ---

  // Full neighbourhood score — all service types
  const { candidatesByCategory: allCategories } = buildErrandCandidateMap(enriched);
  const errandTripAll = scoreErrandTripExact(originLat, originLon, allCategories);
  const abundanceAll  = scoreAbundance(enriched);
  const nearestAll    = scoreNearestServices(enriched);

  // Selected services score — only what the user picked
  // NOW passes selectedTypes so scoring only considers selected service types
  const selectedTypes = new Set(displayItems.map(i => i.type));
  const selectedCandidates = enriched.filter(c => selectedTypes.has(c.type));
  const { candidatesByCategory: selectedCategories } = buildErrandCandidateMap(selectedCandidates);
  const errandTripSel = scoreErrandTripExact(originLat, originLon, selectedCategories);
  const abundanceSel  = scoreAbundance(selectedCandidates, WALKABLE_THRESHOLD_METERS, selectedTypes);
  const nearestSel    = scoreNearestServices(selectedCandidates, WALKABLE_THRESHOLD_METERS, selectedTypes);

  // --- Housing & crime scores from static JSON (zero API calls) ---
  const suburbName = formattedAddress ? extractSuburbFromAddress(formattedAddress) : null;
  const suburbData = suburbName ? getSuburbData(suburbName) : null;

  const rawCrimeScore = suburbData?.crimeLga?.crimeScore ?? null;
  const crimeScore = rawCrimeScore !== null ? normaliseToTen(rawCrimeScore) : null;

  const priceResolution = suburbName
    ? resolveHousePriceScore(suburbName)
    : { score: null, resolvedFrom: null as null, resolvedSuburb: null };
  const rawHousePriceScore = priceResolution.score;
  const housePriceScore = rawHousePriceScore !== null ? normaliseToTen(-rawHousePriceScore) : null; // invert so that higher price = lower score

  const WEIGHTS = {
    errandTrip: 0.05,
    abundance:  0.05,
    nearest:    0.85,
    housePrice: 0.025,
    crime:      0.025,
  };

  function compositeScore(errand: number, abund: number, near: number): number {
    const components = [
      { score: errand,          weight: WEIGHTS.errandTrip },
      { score: abund,           weight: WEIGHTS.abundance  },
      { score: near,            weight: WEIGHTS.nearest    },
      { score: housePriceScore, weight: WEIGHTS.housePrice },
      { score: crimeScore,      weight: WEIGHTS.crime      },
    ].filter(c => c.score !== null) as { score: number; weight: number }[];

    const totalWeight = components.reduce((sum, c) => sum + c.weight, 0);
    return Number((components.reduce((sum, c) => sum + c.score * c.weight, 0) / totalWeight).toFixed(1));
  }

  const neighbourhoodScore = compositeScore(errandTripAll.score, abundanceAll.score, nearestAll.score);
  const selectionScore     = compositeScore(errandTripSel.score, abundanceSel.score, nearestSel.score);

  console.log(`[WALKABILITY_NEIGHOOD] errand:${errandTripAll.score} abundance:${abundanceAll.score} nearest:${nearestAll.score} crime:${crimeScore} housePrice:${housePriceScore} composite:${neighbourhoodScore}`);
  console.log(`[WALKABILITY_SELECTED] errand:${errandTripSel.score} abundance:${abundanceSel.score} nearest:${nearestSel.score} crime:${crimeScore} housePrice:${housePriceScore} composite:${selectionScore}`);

  const services = displayItems
    .map((item) => {
      const options = byKey.get(item.key) || [];
      return options.sort((a, b) => (a.walkingDistanceMeters ?? 999999) - (b.walkingDistanceMeters ?? 999999))[0];
    })
    .filter((s): s is CandidateService => Boolean(s));

  return {
    services,
    index,
    breakdown,
    walkability: {
      neighbourhood: {
        score: neighbourhoodScore,
        errandTrip: { score: errandTripAll.score, totalDistanceMeters: errandTripAll.totalDistanceMeters, meanEdgeMeters: errandTripAll.meanEdgeMeters, optimalPath: errandTripAll.optimalPath, missingCategories: errandTripAll.missingCategories },
        abundance:   { score: abundanceAll.score, totalWeightedOptions: abundanceAll.totalWeightedOptions },
        nearest:     { score: nearestAll.score, perType: nearestAll.perType },
      },
      selection: {
        score: selectionScore,
        errandTrip: { score: errandTripSel.score, totalDistanceMeters: errandTripSel.totalDistanceMeters, meanEdgeMeters: errandTripSel.meanEdgeMeters, optimalPath: errandTripSel.optimalPath, missingCategories: errandTripSel.missingCategories },
        abundance:   { score: abundanceSel.score, totalWeightedOptions: abundanceSel.totalWeightedOptions },
        nearest:     { score: nearestSel.score, perType: nearestSel.perType },
      },
      suburb: {
        name: suburbName,
        housePriceScore,
        crimeScore,
        rawHousePriceScore,
        rawCrimeScore,
        housePriceResolvedFrom: priceResolution.resolvedFrom,
        housePriceResolvedSuburb: priceResolution.resolvedSuburb,
      },
    },
  };
}

async function getSeedAnalyses(): Promise<SeedAnalysis[]> {
  const cacheKey = 'seed_analyses_v2';
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
    if (routePath === '/api/debug/stats' && httpMethod === 'GET') {
      return jsonResponse(200, {
        apiCallCounts,
        cacheSize: cache.size,
      });
    }

    if (routePath === '/health' && httpMethod === 'GET') {
      return jsonResponse(200, { status: 'ok' });
    }

    if (routePath === '/api/config' && httpMethod === 'GET') {
      try {
        return jsonResponse(200, { key: getGoogleMapsApiKey() });
      } catch {
        return jsonResponse(500, { error: 'Google Maps key not configured' });
      }
    }

    if (routePath === '/api/leaderboard' && httpMethod === 'GET') {
      try {
        const analyses = await getSeedAnalyses();
        return jsonResponse(200, buildLeaderboard(analyses));
      } catch {
        return jsonResponse(500, { error: 'Failed to derive leaderboard' });
      }
    }

    if (routePath === '/api/heatmap' && httpMethod === 'GET') {
      try {
        const analyses = await getSeedAnalyses();
        return jsonResponse(200, buildHeatmap(analyses));
      } catch {
        return jsonResponse(500, { error: 'Failed to derive heatmap data' });
      }
    }

    if (routePath === '/api/search' && httpMethod === 'GET') {
      const q = (event.queryStringParameters?.q || '').trim();
      if (!q) return jsonResponse(400, { error: 'Missing query' });

      const cacheKey = `search_${q.toLowerCase()}`;
      const cached = getCached<any[]>(cacheKey);
      if (cached) return jsonResponse(200, cached);

      trackApiCall('geocoding');
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

    if (routePath === '/api/nearby-services' && httpMethod === 'GET') {
      const lat = parseCoordinate(event.queryStringParameters?.lat, 'lat');
      const lon = parseCoordinate(event.queryStringParameters?.lon, 'lon');
      const requestedItems = parseRequestedItems(event.queryStringParameters?.types);
      const formattedAddress = event.queryStringParameters?.address
        ? decodeURIComponent(event.queryStringParameters.address)
        : undefined;

      const analysisCacheKey = [
        'analysis',
        toCoordKey(lat),
        toCoordKey(lon),
        requestedItems.map((i) => i.key).sort().join('|'),
      ].join('_');

      const cached = getCached<LocationAnalysis>(analysisCacheKey);
      if (cached) return jsonResponse(200, cached);

      const analysis = await analyzeLocation(lat, lon, requestedItems, formattedAddress);
      setCached(analysisCacheKey, analysis, CACHE_TTL_MS.analysis);
      return jsonResponse(200, analysis);
    }

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
      trackApiCall('directions');
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