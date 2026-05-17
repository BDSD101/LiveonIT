// Imports
import housingCrimeData from '../backend/melbourne_housing_crime_data.json';

// --- Scoring Configuration & Types ---
export type RequestedItem = {
  key: string;
  catId: string;
  type: string;
  filter?: (result: any) => boolean;
  useTextSearch?: boolean;
  textQuery?: string;
  searchRadius?: number;
  upgradeCount?: number;
};

export type CandidateService = {
  key: string;
  catId: string;
  type: string;
  name: string;
  lat: number;
  lon: number;
  walkingDistanceMeters: number | null;
  walkingDurationMinutes: number | null;
  withinThreshold: boolean;
};

// export type CategoryBreakdown = {
//   id: string;
//   label: string;
//   weight: number;
//   status: 'met' | 'partial' | 'missing';
//   nearestService: { name: string; type: string } | null;
//   walkingDistanceMeters: number | null;
//   walkingDurationMinutes: number | null;
//   score: number;
// };

// export type ScoreBreakdown = {
//   walkableThresholdMeters: number;
//   methodology: string;
//   categories: CategoryBreakdown[];
//   summary: {
//     categoriesMetWithin800m: number;
//     totalCategories: number;
//     missingCategories: string[];
//     partialCategories: string[];
//   };
// };


export type WalkabilityComponent = {
  score: number;
  errandTrip: { score: number; totalDistanceMeters: number; meanEdgeMeters: number; optimalPath: ErrandNode[]; missingCategories: string[] };
  abundance:  { score: number; totalWeightedOptions: number };
  nearest:    { score: number; perType: Array<{ type: string; frequencyWeight: number; distanceFactor: number; contribution: number }> };
};

export type LocationAnalysis = {
  services: CandidateService[];
  // index: number;
  // breakdown: ScoreBreakdown;
  walkability?: {
    neighbourhood: WalkabilityComponent;
    selection: WalkabilityComponent;
    suburb: {
      name: string | null;
      housePriceScore: number | null;
      crimeScore: number | null;
      rawHousePriceScore: number | null;
      rawCrimeScore: number | null;
      housePriceResolvedFrom: 'suburb' | 'postcode' | 'lga' | null;
      housePriceResolvedSuburb: string | null;
    };
  };
};




// export type SuburbSeedPoint = {
//   name: string;
//   ring: 'inner' | 'middle' | 'outer';
//   lat: number;
//   lng: number;
// };

// export type SeedAnalysis = SuburbSeedPoint & {
//   index: number;
// };

export const WALKABLE_THRESHOLD_METERS = 800;
export const ERRAND_TRIP_THRESHOLD_METERS = 2 * WALKABLE_THRESHOLD_METERS;
export const MAX_WALKING_MINUTES = 20;
export const IDEAL_WALKING_MINUTES = 5;

// export const CATEGORY_CONFIG: Record<string, { label: string; weight: number }> = {
//   health: { label: 'Health Services', weight: 3 },
//   food: { label: 'Food and Essentials', weight: 3 },
//   connectivity: { label: 'Connectivity', weight: 2 },
//   parks: { label: 'Parks and Nature', weight: 2 },
//   dining: { label: 'Dining and Social', weight: 2 },
//   education: { label: 'Education and Learning', weight: 2 },
//   fitness: { label: 'Fitness and Recreation', weight: 1 },
//   community: { label: 'Community Services', weight: 1 },
// };

export const CORE_CATEGORY_TYPES: Record<string, string[]> = {
  health: ['doctor', 'pharmacy','dentist'],
  food: ['supermarket', 'convenience_store'],
  connectivity: ['train_station', 'transit_station', 'post_office', 'bank','atm'],
  parks: ['park'],
  dining: ['cafe', 'restaurant', 'bar'],
  education: ['childcare', 'kindergarten', 'primary_school', 'secondary_school', 'library'],
  fitness: ['gym'],
  community: ['community'],
};

export const LEADERBOARD_PLACE_TYPES: Record<string, string[]> = {
  // health:       ['doctor', 'clinic', 'pharmacy'],
  food:         ['supermarket'],
  // connectivity: ['train_station', 'transit_station'],
  // parks:        ['park'],
  // dining:       ['cafe', 'restaurant'],
  // education:    ['childcare', 'kindergarten', 'primary_school', 'secondary_school'],
  // education:    ['childcare', 'kindergarten', 'school'],
  // fitness:      ['gym'],
  // community:    ['community'],
};

export const PLACE_TYPE_ICON_BLOCKLIST: Record<string, string[]> = {
  gym: ['school_pinlet'],
};

export const PLACE_TYPE_PINLET_ALLOWLIST: Record<string, string[]> = {
  cafe: ['cafe_pinlet'],
  restaurant: ['restaurant_pinlet'],
  bar: ['bar_pinlet'],
  library: ['school_pinlet'],
  primary_school: ['school_pinlet'],
  secondary_school: ['school_pinlet'],
  kindergarten: ['school_pinlet'],
  childcare: ['school_pinlet'],
};

export const PLACE_TYPE_NAME_BLOCKLIST: Record<string, string[]> = {
  gym: ['physio', 'physiotherapy', 'spinal', 'coaching', 'chiropractic'],
  school: ['scuba', 'guitar', 'music', 'tennis', 'dance', 'yoga', 'pilates', 'flow with'],
  supermarket: ['spices', 'convenience', 'smoke', 'liquor', 'bottle shop', 'petrol', 'fuel', 'bakery', 'butcher', 'seafood', 'organic'],
  cafe: ['health', 'nutrition', 'office', 'crew'],
};

export const PLACE_TYPE_NAME_ALLOWLIST: Record<string, string[]> = {
  supermarket: ['woolworths', 'coles', 'aldi', 'iga', 'foodworks', 'safeway'],
  secondary_school: ['secondary', 'high', 'college'],
};


// --- Errand Trip & Walkability Scoring ---
export type VisitFrequency = 'high' | 'medium' | 'low' | 'rare';

export const SERVICE_FREQUENCY: Record<string, VisitFrequency> = {
  supermarket:        'high',
  convenience_store:  'high',
  train_station:      'high',
  transit_station:    'high',
  atm:                'high',
  cafe:               'high',
  restaurant:         'medium',
  bar:                'medium',
  gym:                'medium',
  park:               'medium',
  community:          'medium',
  library:            'low',
  childcare:          'low',
  kindergarten:       'low',
  primary_school:     'low',
  secondary_school:   'low',
  post_office:        'low',
  bank:               'low',
  pharmacy:           'low',
  dentist:            'rare',
  doctor:             'rare',
  // hospital:           'rare',
};

export const FREQUENCY_WEIGHTS: Record<VisitFrequency, number> = {
  high:   1.00,
  medium: 0.50,
  low:    0.10,
  rare:   0.02,
};

export const TSP_FREQUENCY_THRESHOLD: Set<VisitFrequency> = new Set(['high', 'medium']);

export type ErrandNode = {
  catId: string;
  type: string;
  name: string;
  lat: number;
  lon: number;
};

export type ErrandTripResult = {
  score: number;
  totalDistanceMeters: number;
  meanEdgeMeters: number;
  optimalPath: ErrandNode[];
  selectedCandidates: ErrandNode[];
  missingCategories: string[];
  excludedCategories: string[];
};


export function buildPlaceFilter(type: string): ((r: any) => boolean) | undefined {
  const iconBlocklist = PLACE_TYPE_ICON_BLOCKLIST[type] ?? [];
  const nameBlocklist = PLACE_TYPE_NAME_BLOCKLIST[type] ?? [];
  const nameAllowlist = PLACE_TYPE_NAME_ALLOWLIST[type] ?? [];
  const pinletAllowlist = PLACE_TYPE_PINLET_ALLOWLIST[type] ?? [];

  if (iconBlocklist.length === 0 && nameBlocklist.length === 0 && nameAllowlist.length === 0 && pinletAllowlist.length === 0) return undefined;

  return (r: any) => {
    const pinlet = r.icon_mask_base_uri ?? '';
    const name = (r.name ?? '').toLowerCase();

    if (iconBlocklist.some(icon => pinlet.includes(icon))) return false;
    if (nameBlocklist.some(word => name.includes(word))) return false;
    if (nameAllowlist.length > 0 && !nameAllowlist.some(word => name.includes(word))) return false;
    if (pinletAllowlist.length > 0 && !pinletAllowlist.some(p => pinlet.includes(p))) return false;
    return true;
  };
}

export const PLACE_TYPE_UPGRADE_COUNT: Record<string, number> = {
  // hospital: 20,
  doctor:   10,
  gym:      10,
  park:     20,
};

export const CORE_ANALYSIS_ITEMS: RequestedItem[] = Object.entries(CORE_CATEGORY_TYPES).flatMap(([catId, types]) =>
  types.map((type) => ({
    key: `${catId}:${type}`,
    catId,
    type,
    filter: buildPlaceFilter(type),
    upgradeCount: PLACE_TYPE_UPGRADE_COUNT[type] ?? 5,
    ...(type === 'doctor' ? {
      useTextSearch: true,
      textQuery: 'GP',
    } : {}),
    // ...(type === 'hospital' ? {
    //   useTextSearch: true,
    //   textQuery: 'hospital',
    // } : {}),
    ...(type === 'post_office' ? {
      useTextSearch: true,
      textQuery: 'LPO',
    } : {}),
    ...(type === 'kindergarten' ? {
      useTextSearch: true,
      textQuery: 'kindergarten',
    } : {}),
    ...(type === 'childcare' ? {
      useTextSearch: true,
      textQuery: 'child care centre',
    } : {}),
    ...(type === 'community' ? {
      useTextSearch: true,
      textQuery: 'community neighbourhood centre house',
    } : {}),
  }))
);


// export const SUBURB_SEED_POINTS: SuburbSeedPoint[] = [
//   { name: 'Carlton', ring: 'inner', lat: -37.7983, lng: 144.9671 },
//   { name: 'Fitzroy', ring: 'inner', lat: -37.7980, lng: 144.9780 },
//   { name: 'South Yarra', ring: 'inner', lat: -37.8390, lng: 144.9920 },
//   { name: 'Camberwell', ring: 'middle', lat: -37.8260, lng: 145.0580 },
//   { name: 'Essendon', ring: 'middle', lat: -37.7560, lng: 144.9180 },
//   { name: 'Glen Iris', ring: 'middle', lat: -37.8580, lng: 145.0620 },
//   { name: 'Dandenong', ring: 'outer', lat: -37.9870, lng: 145.2140 },
//   { name: 'Cranbourne', ring: 'outer', lat: -38.1090, lng: 145.2830 },
//   { name: 'Craigieburn', ring: 'outer', lat: -37.6010, lng: 144.9430 },
// ];

// --- Improved Scoring Algorithms ---

export function calculateDistanceFactor(minutes: number | null): number {
  if (minutes === null) return 0;
  if (minutes <= IDEAL_WALKING_MINUTES) return 1;
  if (minutes >= MAX_WALKING_MINUTES) return 0;
  return Number((1 - (minutes - IDEAL_WALKING_MINUTES) / (MAX_WALKING_MINUTES - IDEAL_WALKING_MINUTES)).toFixed(2));
}

// export function calculateCategoryScore(candidates: CandidateService[], weight: number): number {
//   const sorted = candidates
//     .filter((c) => c.walkingDurationMinutes !== null)
//     .sort((a, b) => (a.walkingDurationMinutes as number) - (b.walkingDurationMinutes as number));

//   if (sorted.length === 0) return 0;

//   const firstFactor = calculateDistanceFactor(sorted[0].walkingDurationMinutes);
//   const secondFactor = sorted[1] ? calculateDistanceFactor(sorted[1].walkingDurationMinutes) * 0.3 : 0;
//   const thirdFactor = sorted[2] ? calculateDistanceFactor(sorted[2].walkingDurationMinutes) * 0.1 : 0;

//   const rawScore = weight * (firstFactor + secondFactor + thirdFactor);
//   return Number(Math.min(weight * 1.4, rawScore).toFixed(2));
// }

// --- Suburb & Housing/Crime Lookup Helpers ---

export function getSuburbData(suburbName: string): any | null {
  return (housingCrimeData as any)[suburbName] ?? null;
}

export function extractSuburbFromAddress(formattedAddress: string): string | null {
  const parts = formattedAddress.split(',').map(p => p.trim());
  for (const part of parts) {
    const cleaned = part.replace(/\s+(VIC|NSW|QLD|SA|WA|TAS|NT|ACT)\s+\d{4}$/i, '').trim();
    // const cleaned = part.replace(/\s+(VIC|NSW|QLD|SA|WA|TAS|NT|ACT)(\s+\d{4})?$/i, '').trim(); // This will allow the postcode to be optional in the suburb extraction
    if ((housingCrimeData as any)[cleaned]) return cleaned;
    if ((housingCrimeData as any)[part]) return part;
  }
  return null;
}

export function normaliseToTen(score: number, min = -3, max = 3): number {
  return Number(((score - min) / (max - min) * 10).toFixed(1));
}

export function resolveHousePriceScore(suburbName: string): {
  score: number | null;
  resolvedFrom: 'suburb' | 'postcode' | 'lga' | null;
  resolvedSuburb: string | null;
} {
  const data = housingCrimeData as any;
  const suburbData = data[suburbName];
  if (!suburbData) return { score: null, resolvedFrom: null, resolvedSuburb: null };

  if (suburbData.housePrices?.housePriceScore != null) {
    return { score: suburbData.housePrices.housePriceScore, resolvedFrom: 'suburb', resolvedSuburb: suburbName };
  }

  const postcode = suburbData.postcode;
  const lga = suburbData.lga;
  const allSuburbs = Object.entries(data) as [string, any][];

  const postcodeSibling = allSuburbs.find(
    ([name, d]) => name !== suburbName && d.postcode === postcode && d.housePrices?.housePriceScore != null
  );
  if (postcodeSibling) {
    return { score: postcodeSibling[1].housePrices.housePriceScore, resolvedFrom: 'postcode', resolvedSuburb: postcodeSibling[0] };
  }

  const lgaSibling = allSuburbs.find(
    ([name, d]) => name !== suburbName && d.lga === lga && d.housePrices?.housePriceScore != null
  );
  if (lgaSibling) {
    return { score: lgaSibling[1].housePrices.housePriceScore, resolvedFrom: 'lga', resolvedSuburb: lgaSibling[0] };
  }

  return { score: null, resolvedFrom: null, resolvedSuburb: null };
}

// export function buildScoreBreakdown(byKey: Map<string, CandidateService[]>): { breakdown: ScoreBreakdown; index: number } {
//   const categories = Object.entries(CATEGORY_CONFIG).map(([catId, meta]) => {
//     const coreTypes = CORE_CATEGORY_TYPES[catId] || [];
//     const candidates = coreTypes
//       .flatMap((type) => byKey.get(`${catId}:${type}`) || [])
//       .filter((c): c is CandidateService => Boolean(c));

//     const withDistance = candidates
//       .filter((c) => c.walkingDistanceMeters !== null)
//       .sort((a, b) => (a.walkingDistanceMeters as number) - (b.walkingDistanceMeters as number));

//     const nearest = withDistance[0] || null;
//     const status: CategoryBreakdown['status'] = !nearest
//       ? 'missing'
//       : (nearest.walkingDistanceMeters || 0) <= WALKABLE_THRESHOLD_METERS
//       ? 'met'
//       : 'partial';

//     const categoryScore = calculateCategoryScore(candidates, meta.weight);

//     return {
//       id: catId,
//       label: meta.label,
//       weight: meta.weight,
//       status,
//       nearestService: nearest ? { name: nearest.name, type: nearest.type } : null,
//       walkingDistanceMeters: nearest?.walkingDistanceMeters ?? null,
//       walkingDurationMinutes: nearest?.walkingDurationMinutes ?? null,
//       score: categoryScore,
//     };
//   });

//   const totalWeight = categories.reduce((sum, c) => sum + c.weight, 0);
//   const rawScore = categories.reduce((sum, c) => sum + c.score, 0);
//   const index = Math.min(10.0, Number(((rawScore / totalWeight) * 10).toFixed(1)));

//   const missingCategories = categories.filter((c) => c.status === 'missing').map((c) => c.label);
//   const partialCategories = categories.filter((c) => c.status === 'partial').map((c) => c.label);
//   const metCount = categories.filter((c) => c.status === 'met').length;

//   const breakdown: ScoreBreakdown = {
//     walkableThresholdMeters: WALKABLE_THRESHOLD_METERS,
//     methodology:
//       'Liveability score based on a continuous decay model (ideal < 5m, decays to 0 at 20m) and density bonuses for multiple nearby services across 7 categories.',
//     categories,
//     summary: {
//       categoriesMetWithin800m: metCount,
//       totalCategories: categories.length,
//       missingCategories,
//       partialCategories,
//     },
//   };

//   return { breakdown, index };
// }

// export function buildLeaderboard(analyses: SeedAnalysis[]) {
//   const rings: Array<'inner' | 'middle' | 'outer'> = ['inner', 'middle', 'outer'];
//   const result: Record<'inner' | 'middle' | 'outer', Array<{ name: string; score: number; rank: number }>> = {
//     inner: [],
//     middle: [],
//     outer: [],
//   };

//   for (const ring of rings) {
//     result[ring] = analyses
//       .filter((a) => a.ring === ring)
//       .sort((a, b) => b.index - a.index)
//       .slice(0, 3)
//       .map((a, idx) => ({
//         name: a.name,
//         score: a.index,
//         rank: idx + 1,
//       }));
//   }

//   return {
//     ...result,
//     updatedAt: new Date().toISOString(),
//   };
// }

// export function buildHeatmap(analyses: SeedAnalysis[]) {
//   return analyses.map((a) => ({
//     lat: a.lat,
//     lng: a.lng,
//     weight: Number(a.index.toFixed(1)),
//     name: a.name,
//     ring: a.ring,
//   }));
// }

// ---------------------------------------------------------------------------
// Haversine distance (metres, crow-flies)
// ---------------------------------------------------------------------------
export function haversineMeters(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const R = 6_371_000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLon = toRad(bLon - aLon);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// ---------------------------------------------------------------------------
// COMPONENT 1 — Errand Trip Score (greedy, 0–10)
// ---------------------------------------------------------------------------
export function scoreErrandTripGreedy(
  homeLat: number,
  homeLon: number,
  candidatesByCategory: Map<string, ErrandNode[]>,
  // walkableThresholdMeters = WALKABLE_THRESHOLD_METERS,
  walkableThresholdMeters = ERRAND_TRIP_THRESHOLD_METERS,
  circuityFactor = 1.3,
): ErrandTripResult {
  const MISSING_PENALTY = 5000;
  const home: ErrandNode = { catId: '__home__', type: '__home__', name: 'Home', lat: homeLat, lon: homeLon };

  const categories = [...candidatesByCategory.keys()];
  const missingCategories = categories.filter(c => (candidatesByCategory.get(c)?.length ?? 0) === 0);
  const scorableCategories = categories.filter(c => (candidatesByCategory.get(c)?.length ?? 0) > 0);

  if (scorableCategories.length === 0) {
    return { score: 0, totalDistanceMeters: 0, meanEdgeMeters: 0, optimalPath: [home], selectedCandidates: [], missingCategories, excludedCategories: [] };
  }

  const candidateLists = scorableCategories.map(c => candidatesByCategory.get(c)!);
  const counts = candidateLists.map(l => l.length);
  const totalCombinations = counts.reduce((a, b) => a * b, 1);

  let bestDistance = Infinity;
  let bestPath: ErrandNode[] = [];
  let bestSelection: ErrandNode[] = [];

  for (let combo = 0; combo < totalCombinations; combo++) {
    const selected: ErrandNode[] = [];
    let remaining = combo;
    for (let i = 0; i < candidateLists.length; i++) {
      selected.push(candidateLists[i][remaining % counts[i]]);
      remaining = Math.floor(remaining / counts[i]);
    }

    const unvisited = [...selected];
    const path: ErrandNode[] = [home];
    let current = home;
    let totalDist = 0;

    while (unvisited.length > 0) {
      let nearestIdx = 0;
      let nearestDist = Infinity;
      for (let i = 0; i < unvisited.length; i++) {
        const d = haversineMeters(current.lat, current.lon, unvisited[i].lat, unvisited[i].lon);
        if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
      }
      current = unvisited.splice(nearestIdx, 1)[0];
      path.push(current);
      totalDist += nearestDist;
    }

    if (totalDist < bestDistance) {
      bestDistance = totalDist;
      bestPath = path;
      bestSelection = selected;
    }
  }

  const walkingDistance = bestDistance * circuityFactor;
  const totalEdges = scorableCategories.length + missingCategories.length;
  const meanEdgeMeters = (walkingDistance + missingCategories.length * MISSING_PENALTY) / totalEdges;
  const score = Math.max(0, Number((10 * (1 - meanEdgeMeters / walkableThresholdMeters)).toFixed(1)));

  return { score, totalDistanceMeters: Math.round(walkingDistance), meanEdgeMeters: Math.round(meanEdgeMeters), optimalPath: bestPath, selectedCandidates: bestSelection, missingCategories, excludedCategories: [] };
}

// ---------------------------------------------------------------------------
// COMPONENT 1 (alt) — Errand Trip Score (exact TSP, 0–10)
// ---------------------------------------------------------------------------
export function scoreErrandTripExact(
  homeLat: number,
  homeLon: number,
  candidatesByCategory: Map<string, ErrandNode[]>,
  // walkableThresholdMeters = WALKABLE_THRESHOLD_METERS,
  walkableThresholdMeters = ERRAND_TRIP_THRESHOLD_METERS,
  circuityFactor = 1.3,
  complexityCap = 500_000,
): ErrandTripResult {
  const categories = [...candidatesByCategory.keys()];
  const scorableCategories = categories.filter(c => (candidatesByCategory.get(c)?.length ?? 0) > 0);
  const counts = scorableCategories.map(c => candidatesByCategory.get(c)!.length);
  const factorial = (n: number): number => n <= 1 ? 1 : n * factorial(n - 1);
  const totalCombinations = counts.reduce((a, b) => a * b, 1);
  const totalChecks = totalCombinations * factorial(scorableCategories.length);

  if (totalChecks > complexityCap) {
    console.warn(`[TSP] ${totalChecks.toLocaleString()} checks exceeds cap — falling back to greedy`);
    return scoreErrandTripGreedy(homeLat, homeLon, candidatesByCategory, walkableThresholdMeters, circuityFactor);
  }

  const MISSING_PENALTY = 5000;
  const home: ErrandNode = { catId: '__home__', type: '__home__', name: 'Home', lat: homeLat, lon: homeLon };
  const missingCategories = categories.filter(c => (candidatesByCategory.get(c)?.length ?? 0) === 0);

  if (scorableCategories.length === 0) {
    return { score: 0, totalDistanceMeters: 0, meanEdgeMeters: 0, optimalPath: [home], selectedCandidates: [], missingCategories, excludedCategories: [] };
  }

  const candidateLists = scorableCategories.map(c => candidatesByCategory.get(c)!);

  function permutations<T>(arr: T[]): T[][] {
    if (arr.length <= 1) return [arr];
    return arr.flatMap((item, i) =>
      permutations([...arr.slice(0, i), ...arr.slice(i + 1)]).map(p => [item, ...p])
    );
  }

  function pathDistance(nodes: ErrandNode[]): number {
    let total = 0;
    for (let i = 1; i < nodes.length; i++) {
      total += haversineMeters(nodes[i - 1].lat, nodes[i - 1].lon, nodes[i].lat, nodes[i].lon);
    }
    return total;
  }

  let bestDistance = Infinity;
  let bestPath: ErrandNode[] = [];
  let bestSelection: ErrandNode[] = [];

  for (let combo = 0; combo < totalCombinations; combo++) {
    const selected: ErrandNode[] = [];
    let remaining = combo;
    for (let i = 0; i < candidateLists.length; i++) {
      selected.push(candidateLists[i][remaining % counts[i]]);
      remaining = Math.floor(remaining / counts[i]);
    }
    for (const perm of permutations(selected)) {
      const dist = pathDistance([home, ...perm]);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestPath = [home, ...perm];
        bestSelection = selected;
      }
    }
  }

  const walkingDistance = bestDistance * circuityFactor;
  const totalEdges = scorableCategories.length + missingCategories.length;
  const meanEdgeMeters = (walkingDistance + missingCategories.length * MISSING_PENALTY) / totalEdges;
  const score = Math.max(0, Number((10 * (1 - meanEdgeMeters / walkableThresholdMeters)).toFixed(1)));

  return { score, totalDistanceMeters: Math.round(walkingDistance), meanEdgeMeters: Math.round(meanEdgeMeters), optimalPath: bestPath, selectedCandidates: bestSelection, missingCategories, excludedCategories: [] };
}

// ---------------------------------------------------------------------------
// COMPONENT 2 — Abundance Score (0–10)
// Now accepts optional restrictToTypes to only score against selected services
// ---------------------------------------------------------------------------
export function scoreAbundance(
  allCandidates: CandidateService[],
  thresholdMeters = WALKABLE_THRESHOLD_METERS,
  restrictToTypes?: Set<string>,
): { score: number; totalWeightedOptions: number; referenceWeightedOptions: number } {
  const proximityDecay = (meters: number) => Math.max(0, 1 - meters / thresholdMeters);

  let totalWeightedOptions = 0;
  for (const c of allCandidates) {
    if (c.walkingDistanceMeters === null || c.walkingDistanceMeters > thresholdMeters) continue;
    const freq = SERVICE_FREQUENCY[c.type];
    if (!freq) continue;
    totalWeightedOptions += FREQUENCY_WEIGHTS[freq] * proximityDecay(c.walkingDistanceMeters);
  }

  const REFERENCE_CONFIG: Record<VisitFrequency, { count: number; distanceMeters: number }> = {
    high:   { count: 5, distanceMeters: 200 },
    medium: { count: 3, distanceMeters: 300 },
    low:    { count: 1, distanceMeters: 400 },
    rare:   { count: 1, distanceMeters: 400 },
  };

  // Only consider selected types for the reference benchmark when restrictToTypes is set
  const refTypes = restrictToTypes
    // ? Object.values(CORE_CATEGORY_TYPES).flat().filter(t => restrictToTypes.has(t))
    // : Object.values(CORE_CATEGORY_TYPES).flat();
    ? Array.from(restrictToTypes)
    : [...new Set(allCandidates.map(c => c.type))];

  let referenceWeightedOptions = 0;
  for (const type of refTypes) {
    const freq = SERVICE_FREQUENCY[type];
    if (!freq) continue;
    const ref = REFERENCE_CONFIG[freq];
    referenceWeightedOptions += ref.count * FREQUENCY_WEIGHTS[freq] * proximityDecay(ref.distanceMeters);
  }

  const score = referenceWeightedOptions > 0
    ? Math.min(10, Number(((totalWeightedOptions / referenceWeightedOptions) * 10).toFixed(1)))
    : 0;
  return { score, totalWeightedOptions, referenceWeightedOptions };
}

// ---------------------------------------------------------------------------
// COMPONENT 3 — Nearest Service Score (0–10)
// Now accepts optional restrictToTypes to only score against selected services
// ---------------------------------------------------------------------------
export function scoreNearestServices(
  allCandidates: CandidateService[],
  thresholdMeters = WALKABLE_THRESHOLD_METERS,
  restrictToTypes?: Set<string>,
): { score: number; perType: Array<{ type: string; frequencyWeight: number; distanceFactor: number; contribution: number }> } {

  const nearestByType = new Map<string, CandidateService>();
  for (const c of allCandidates) {
    if (c.walkingDistanceMeters === null) continue;
    const existing = nearestByType.get(c.type);
    if (!existing || c.walkingDistanceMeters < (existing.walkingDistanceMeters ?? Infinity)) {
      nearestByType.set(c.type, c);
    }
  }

  // Only score against selected types when restrictToTypes is provided
  const allTypes = restrictToTypes
    // ? Object.values(CORE_CATEGORY_TYPES).flat().filter(t => restrictToTypes.has(t))
    // : Object.values(CORE_CATEGORY_TYPES).flat();
    ? Array.from(restrictToTypes)
    : [...new Set(allCandidates.map(c => c.type))];

  let weightedScore = 0;
  let maxPossibleScore = 0;
  const perType: Array<{ type: string; frequencyWeight: number; distanceFactor: number; contribution: number }> = [];

  for (const type of allTypes) {
    const freq = SERVICE_FREQUENCY[type];
    if (!freq) continue;
    const weight = FREQUENCY_WEIGHTS[freq];
    maxPossibleScore += weight;

    const nearest = nearestByType.get(type);
    if (!nearest) {
      perType.push({ type, frequencyWeight: weight, distanceFactor: 0, contribution: 0 });
      continue;
    }

    const distanceFactor = nearest.walkingDurationMinutes !== null
      ? calculateDistanceFactor(nearest.walkingDurationMinutes)
      : Math.max(0, 1 - (nearest.walkingDistanceMeters ?? thresholdMeters) / thresholdMeters);

    const contribution = weight * distanceFactor;
    weightedScore += contribution;
    perType.push({ type, frequencyWeight: weight, distanceFactor, contribution });
  }

  const score = maxPossibleScore > 0
    ? Math.min(10, Number(((weightedScore / maxPossibleScore) * 10).toFixed(1)))
    : 0;

  return { score, perType };
}

// ---------------------------------------------------------------------------
// buildErrandCandidateMap
// ---------------------------------------------------------------------------
export function buildErrandCandidateMap(
  allCandidates: CandidateService[],
  frequencyThreshold: Set<VisitFrequency> = TSP_FREQUENCY_THRESHOLD,
): { candidatesByCategory: Map<string, ErrandNode[]>; excludedTypes: string[] } {
  const excluded = [...new Set(
    allCandidates
      .filter(c => { const f = SERVICE_FREQUENCY[c.type]; return !f || !frequencyThreshold.has(f); })
      .map(c => c.type)
  )];

  const map = new Map<string, ErrandNode[]>();
  for (const c of allCandidates) {
    const freq = SERVICE_FREQUENCY[c.type];
    if (!freq || !frequencyThreshold.has(freq)) continue;
    if (!map.has(c.catId)) map.set(c.catId, []);
    map.get(c.catId)!.push({ catId: c.catId, type: c.type, name: c.name, lat: c.lat, lon: c.lon });
  }

  return { candidatesByCategory: map, excludedTypes: excluded };
}