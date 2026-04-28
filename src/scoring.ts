// --- Scoring Configuration & Types ---

export type RequestedItem = {
  key: string;
  catId: string;
  type: string;
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

export type ServiceBreakdown = {
  key: string;
  catId: string;
  type: string;
  label: string;
  status: 'met' | 'partial' | 'missing';
  nearestService: { name: string; type: string } | null;
  walkingDistanceMeters: number | null;
  walkingDurationMinutes: number | null;
};

export type ScoreBreakdown = {
  walkableThresholdMeters: number;
  methodology: string;
  services: ServiceBreakdown[];
  summary: {
    servicesWithin800m: number;
    totalServices: number;
    missingServices: string[];
    partialServices: string[];
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

export const WALKABLE_THRESHOLD_METERS = 800;

// The 18 essential services that match the frontend UI exactly.
// These are the services the user can filter by.
export const ALL_SERVICES: { key: string; catId: string; type: string; label: string }[] = [
  // Health Services (5)
  { key: 'health:doctor', catId: 'health', type: 'doctor', label: 'Doctor / GP' },
  { key: 'health:pharmacy', catId: 'health', type: 'pharmacy', label: 'Pharmacy' },
  { key: 'health:hospital', catId: 'health', type: 'hospital', label: 'Hospital' },
  { key: 'health:gym', catId: 'health', type: 'gym', label: 'Gym / Fitness' },
  { key: 'health:dentist', catId: 'health', type: 'dentist', label: 'Dentist' },
  // Food and Essentials (4)
  { key: 'food:supermarket', catId: 'food', type: 'supermarket', label: 'Supermarket' },
  { key: 'food:bakery', catId: 'food', type: 'bakery', label: 'Bakery' },
  { key: 'food:convenience_store', catId: 'food', type: 'convenience_store', label: 'Convenience' },
  { key: 'food:shopping_mall', catId: 'food', type: 'shopping_mall', label: 'General Shopping' },
  // Connectivity (4)
  { key: 'connectivity:train_station', catId: 'connectivity', type: 'train_station', label: 'Train Station' },
  { key: 'connectivity:bus_station', catId: 'connectivity', type: 'bus_station', label: 'Bus Station' },
  { key: 'connectivity:post_office', catId: 'connectivity', type: 'post_office', label: 'Post Office' },
  { key: 'connectivity:bank', catId: 'connectivity', type: 'bank', label: 'Bank' },
  // Parks and Nature (5)
  { key: 'parks:park', catId: 'parks', type: 'park', label: 'Parks' },
  { key: 'parks:cafe', catId: 'parks', type: 'cafe', label: 'Cafe' },
  { key: 'parks:restaurant', catId: 'parks', type: 'restaurant', label: 'Restaurant' },
  { key: 'parks:community_center', catId: 'parks', type: 'community_center', label: 'Community Centre' },
  { key: 'parks:school', catId: 'parks', type: 'school', label: 'Education' },
];

// Build CORE_ANALYSIS_ITEMS from the master list for backward compatibility
export const CORE_ANALYSIS_ITEMS: RequestedItem[] = ALL_SERVICES.map(s => ({
  key: s.key,
  catId: s.catId,
  type: s.type,
}));

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

// --- Simple, Transparent Scoring ---

/**
 * Builds a score breakdown based on the 18 essential services.
 * 
 * Score = (number of services found within 800m / total services checked) × 10
 * 
 * A perfect 10.0 is ONLY possible if ALL 18 services have at least one
 * option within 800m walking distance.
 */
export function buildScoreBreakdown(byKey: Map<string, CandidateService[]>): { breakdown: ScoreBreakdown; index: number } {
  const serviceBreakdowns: ServiceBreakdown[] = ALL_SERVICES.map(svc => {
    const candidates = byKey.get(svc.key) || [];

    // Find the nearest candidate with a valid distance
    const withDistance = candidates
      .filter(c => c.walkingDistanceMeters !== null)
      .sort((a, b) => (a.walkingDistanceMeters as number) - (b.walkingDistanceMeters as number));

    const nearest = withDistance[0] || null;

    let status: ServiceBreakdown['status'];
    if (!nearest) {
      status = 'missing';
    } else if ((nearest.walkingDistanceMeters || 0) <= WALKABLE_THRESHOLD_METERS) {
      status = 'met';
    } else {
      status = 'partial';
    }

    return {
      key: svc.key,
      catId: svc.catId,
      type: svc.type,
      label: svc.label,
      status,
      nearestService: nearest ? { name: nearest.name, type: nearest.type } : null,
      walkingDistanceMeters: nearest?.walkingDistanceMeters ?? null,
      walkingDurationMinutes: nearest?.walkingDurationMinutes ?? null,
    };
  });

  const totalServices = serviceBreakdowns.length; // Always 18
  const metCount = serviceBreakdowns.filter(s => s.status === 'met').length;
  const missingServices = serviceBreakdowns.filter(s => s.status === 'missing').map(s => s.label);
  const partialServices = serviceBreakdowns.filter(s => s.status === 'partial').map(s => s.label);

  // Simple formula: (met / total) * 10, rounded to 1 decimal place
  const index = Number(((metCount / totalServices) * 10).toFixed(1));

  const breakdown: ScoreBreakdown = {
    walkableThresholdMeters: WALKABLE_THRESHOLD_METERS,
    methodology:
      `Liveability index = (services within 800m / ${totalServices} total essential services) × 10. A perfect 10.0 requires all ${totalServices} services within walking distance.`,
    services: serviceBreakdowns,
    summary: {
      servicesWithin800m: metCount,
      totalServices,
      missingServices,
      partialServices,
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
