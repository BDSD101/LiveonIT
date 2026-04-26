// --- Scoring Configuration & Types ---
export type RequestedItem = {
  key: string;
  catId: string;
  type: string;
  // filter is an optional function that takes a raw API result and returns true if it should be included for scoring
  filter?: (result: any) => boolean;
  // For text search capability
  useTextSearch?: boolean;
  textQuery?: string;
  // to limit the number of candidates sent to Distance Matrix API for scoring
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

export type CategoryBreakdown = {
  id: string;
  label: string;
  weight: number;
  status: 'met' | 'partial' | 'missing';
  nearestService: { name: string; type: string } | null;
  walkingDistanceMeters: number | null;
  walkingDurationMinutes: number | null;
  score: number;
};

export type ScoreBreakdown = {
  walkableThresholdMeters: number;
  methodology: string;
  categories: CategoryBreakdown[];
  summary: {
    categoriesMetWithin800m: number;
    totalCategories: number;
    missingCategories: string[];
    partialCategories: string[];
  };
};

export type LocationAnalysis = {
  services: CandidateService[];
  index: number;
  breakdown: ScoreBreakdown;
};

export type SuburbSeedPoint = {
  name: string;
  ring: 'inner' | 'middle' | 'outer';
  lat: number;
  lng: number;
};

export type SeedAnalysis = SuburbSeedPoint & {
  index: number;
};

export const WALKABLE_THRESHOLD_METERS = 800; // Legacy reference for status
export const MAX_WALKING_MINUTES = 20;
export const IDEAL_WALKING_MINUTES = 5;

export const CATEGORY_CONFIG: Record<string, { label: string; weight: number }> = {
  health: { label: 'Health Services', weight: 3 },
  food: { label: 'Food and Essentials', weight: 3 },
  connectivity: { label: 'Connectivity', weight: 2 },
  parks: { label: 'Parks and Nature', weight: 2 },
  dining: { label: 'Dining and Social', weight: 2 },
  education: { label: 'Education and Learning', weight: 2 },
  fitness: { label: 'Fitness and Recreation', weight: 1 },
  community: { label: 'Community Services', weight: 1 },
};

export const CORE_CATEGORY_TYPES: Record<string, string[]> = {
  health: ['doctor', 'pharmacy', 'hospital','dentist'],
  food: ['supermarket', 'convenience_store'],
  connectivity: ['train_station', 'transit_station', 'post_office', 'bank','atm'], // bus_station and bus_stops removed because too noisy
  parks: ['park'], // playground removed for now as creates too much noise
  dining: ['cafe', 'restaurant', 'bar'],
  education: ['childcare', 'kindergarten', 'primary_school', 'secondary_school', 'library'], // note kindergarten is not an official type but is handled with a text query
  fitness: ['gym'], // 'sports_complex' removed too much noise
  community: ['community'],
};

// Blocklist for certain pinlet icons that are misleading for specific categories (e.g., 'school_pinlet' for gyms)
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
  // doctor: ['pathology', 'radiology', 'audiology', 'podiatry', 'dust mite', 'fun time', 'hearing', 'foot', 'allergy', 'skin', 'dental', 'optometrist', 'eye', 'vet', 'veterinary'],
  school: ['scuba', 'guitar', 'music', 'tennis', 'dance', 'yoga', 'pilates', 'flow with'],
  supermarket: ['spices', 'convenience', 'smoke', 'liquor', 'bottle shop', 'petrol', 'fuel', 'bakery', 'butcher', 'seafood', 'organic'],
  cafe: ['health', 'nutrition', 'office', 'crew'],
};

export const PLACE_TYPE_NAME_ALLOWLIST: Record<string, string[]> = {
  supermarket: ['woolworths', 'coles', 'aldi', 'iga', 'foodworks', 'safeway'],
  secondary_school: ['secondary', 'high', 'college'],
};

export function buildPlaceFilter(type: string): ((r: any) => boolean) | undefined {
  const iconBlocklist = PLACE_TYPE_ICON_BLOCKLIST[type] ?? [];
  const nameBlocklist = PLACE_TYPE_NAME_BLOCKLIST[type] ?? [];
  const nameAllowlist = PLACE_TYPE_NAME_ALLOWLIST[type] ?? [];
  const pinletAllowlist = PLACE_TYPE_PINLET_ALLOWLIST[type] ?? [];

  // if (iconBlocklist.length === 0 && nameBlocklist.length === 0) return undefined;
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
  hospital: 20,
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
    ...(type === 'hospital' ? {
      useTextSearch: true,
      textQuery: 'hospital',
    } : {}),
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


export const SUBURB_SEED_POINTS: SuburbSeedPoint[] = [
  { name: 'Carlton', ring: 'inner', lat: -37.7983, lng: 144.9671 },
  { name: 'Fitzroy', ring: 'inner', lat: -37.7980, lng: 144.9780 },
  { name: 'South Yarra', ring: 'inner', lat: -37.8390, lng: 144.9920 },
  { name: 'Camberwell', ring: 'middle', lat: -37.8260, lng: 145.0580 },
  { name: 'Essendon', ring: 'middle', lat: -37.7560, lng: 144.9180 },
  { name: 'Glen Iris', ring: 'middle', lat: -37.8580, lng: 145.0620 },
  { name: 'Dandenong', ring: 'outer', lat: -37.9870, lng: 145.2140 },
  { name: 'Cranbourne', ring: 'outer', lat: -38.1090, lng: 145.2830 },
  { name: 'Craigieburn', ring: 'outer', lat: -37.6010, lng: 144.9430 },
];

// --- Improved Scoring Algorithms ---

/**
 * Calculates a decay factor based on walking minutes.
 * 1.0 (full score) if <= 5 minutes.
 * Decays linearly to 0.0 at 20 minutes.
 */
export function calculateDistanceFactor(minutes: number | null): number {
  if (minutes === null) return 0;
  if (minutes <= IDEAL_WALKING_MINUTES) return 1;
  if (minutes >= MAX_WALKING_MINUTES) return 0;
  return Number((1 - (minutes - IDEAL_WALKING_MINUTES) / (MAX_WALKING_MINUTES - IDEAL_WALKING_MINUTES)).toFixed(2));
}

/**
 * Calculates the score for a single category based on all nearby candidates.
 * Implements a density bonus for multiple nearby options.
 * 1st option: 100% of its distance factor
 * 2nd option: 30% bonus factor
 * 3rd option: 10% bonus factor
 */
export function calculateCategoryScore(candidates: CandidateService[], weight: number): number {
  const sorted = candidates
    .filter((c) => c.walkingDurationMinutes !== null)
    .sort((a, b) => (a.walkingDurationMinutes as number) - (b.walkingDurationMinutes as number));

  if (sorted.length === 0) return 0;

  const firstFactor = calculateDistanceFactor(sorted[0].walkingDurationMinutes);
  const secondFactor = sorted[1] ? calculateDistanceFactor(sorted[1].walkingDurationMinutes) * 0.3 : 0;
  const thirdFactor = sorted[2] ? calculateDistanceFactor(sorted[2].walkingDurationMinutes) * 0.1 : 0;

  const rawScore = weight * (firstFactor + secondFactor + thirdFactor);
  return Number(Math.min(weight * 1.4, rawScore).toFixed(2)); // Cap density bonus at 1.4x weight
}

export function buildScoreBreakdown(byKey: Map<string, CandidateService[]>): { breakdown: ScoreBreakdown; index: number } {
  const categories = Object.entries(CATEGORY_CONFIG).map(([catId, meta]) => {
    const coreTypes = CORE_CATEGORY_TYPES[catId] || [];
    const candidates = coreTypes
      .flatMap((type) => byKey.get(`${catId}:${type}`) || [])
      .filter((c): c is CandidateService => Boolean(c));

    const withDistance = candidates
      .filter((c) => c.walkingDistanceMeters !== null)
      .sort((a, b) => (a.walkingDistanceMeters as number) - (b.walkingDistanceMeters as number));

    const nearest = withDistance[0] || null;
    const status: CategoryBreakdown['status'] = !nearest
      ? 'missing'
      : (nearest.walkingDistanceMeters || 0) <= WALKABLE_THRESHOLD_METERS
      ? 'met'
      : 'partial';

    const categoryScore = calculateCategoryScore(candidates, meta.weight);

    return {
      id: catId,
      label: meta.label,
      weight: meta.weight,
      status,
      nearestService: nearest ? { name: nearest.name, type: nearest.type } : null,
      walkingDistanceMeters: nearest?.walkingDistanceMeters ?? null,
      walkingDurationMinutes: nearest?.walkingDurationMinutes ?? null,
      score: categoryScore,
    };
  });

  const totalWeight = categories.reduce((sum, c) => sum + c.weight, 0);
  const rawScore = categories.reduce((sum, c) => sum + c.score, 0);
  // Normalize index to 0-10 scale (where totalWeight * 1.0 is ~10, though density can push it higher)
  const index = Math.min(10.0, Number(((rawScore / totalWeight) * 10).toFixed(1)));

  const missingCategories = categories.filter((c) => c.status === 'missing').map((c) => c.label);
  const partialCategories = categories.filter((c) => c.status === 'partial').map((c) => c.label);
  const metCount = categories.filter((c) => c.status === 'met').length;

  const breakdown: ScoreBreakdown = {
    walkableThresholdMeters: WALKABLE_THRESHOLD_METERS,
    methodology:
      'Liveability score based on a continuous decay model (ideal < 5m, decays to 0 at 20m) and density bonuses for multiple nearby services across 7 categories.',
    categories,
    summary: {
      categoriesMetWithin800m: metCount,
      totalCategories: categories.length,
      missingCategories,
      partialCategories,
    },
  };

  return { breakdown, index };
}

export function buildLeaderboard(analyses: SeedAnalysis[]) {
  const rings: Array<'inner' | 'middle' | 'outer'> = ['inner', 'middle', 'outer'];
  const result: Record<'inner' | 'middle' | 'outer', Array<{ name: string; score: number; rank: number }>> = {
    inner: [],
    middle: [],
    outer: [],
  };

  for (const ring of rings) {
    result[ring] = analyses
      .filter((a) => a.ring === ring)
      .sort((a, b) => b.index - a.index)
      .slice(0, 3)
      .map((a, idx) => ({
        name: a.name,
        score: a.index,
        rank: idx + 1,
      }));
  }

  return {
    ...result,
    updatedAt: new Date().toISOString(),
  };
}

export function buildHeatmap(analyses: SeedAnalysis[]) {
  return analyses.map((a) => ({
    lat: a.lat,
    lng: a.lng,
    weight: Number(a.index.toFixed(1)),
    name: a.name,
    ring: a.ring,
  }));
}
