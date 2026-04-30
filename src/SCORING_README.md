# Scoring

## Composite Score

Five components, each 0–10, combined in WEIGHTS inside analyzeLocation (api.ts). Must sum to 1.0.

```typescript
const WEIGHTS = {
  errandTrip: 0.25,  // shortest walking route through high/medium frequency services
  abundance:  0.20,  // count of walkable options weighted by frequency + proximity
  nearest:    0.20,  // how close the nearest of each service type is
  housePrice: 0.20,  // suburb affordability (-3→+3 normalised to 0–10)
  crime:      0.15,  // suburb safety (-3→+3 normalised to 0–10)
};
```

Two scores produced per search: **neighbourhood** (all services) and **selection** (user-picked only). If house price or crime data is missing, weight redistributes across the rest.

## Key Tunables (scoring.ts)

WALKABLE_THRESHOLD_METERS: Distance at which score decays to 0 (default 800m)
MAX_WALKING_MINUTES: Above this = zero score (default 20 min)
SERVICE_FREQUENCY: Assign each service type a tier: high/medium/low/rare
FREQUENCY_WEIGHTS: Numeric weight per tier (high=1.0, medium=0.5, low=0.1, rare=0.02)
TSP_FREQUENCY_THRESHOLD: Which tiers are included in the errand trip route (default: high + medium)
CATEGORY_CONFIG: Weights for the legacy 20-min neighbourhood index

## Errand Trip Notes

Uses crow-flies distances × 1.3 circuity factor — no routing API calls. Brute-forces all candidate combinations and path permutations. Falls back to greedy nearest-neighbour above 500,000 checks (complexityCap). Missing services incur a 5000m penalty (MISSING_PENALTY).

## House Price / Crime

Sourced from backend/melbourne_housing_crime_data.json. House price cascades through postcode → LGA siblings if the suburb has no data. Crime has no nulls.

Errand Trip — TSP and Greedy Fallback
The errand trip score models a single walk from home visiting one instance of each TSP-eligible service. The problem is to find the best combination of candidates (e.g. which of 3 nearby supermarkets) and the best order to visit them.
Exact TSP (scoreErrandTripExact) — brute-forces every combination of one candidate per category, then every permutation of the resulting stops. Guarantees the optimal path. Complexity grows fast: 5 services × 3 candidates each = 3,125 combinations × 120 permutations = 375,000 checks. Fine in practice for typical selection sizes.
Greedy fallback (scoreErrandTripGreedy) — when checks would exceed complexityCap (default 500,000), switches to nearest-neighbour: from the current position, always visit the closest remaining service next. Still tries all candidate combinations but uses the greedy heuristic for path ordering. Typically within 10–15% of optimal.
Score is derived from mean leg length (total distance ÷ stops) normalised against 800m. Missing services incur a 5000m penalty. All distances are crow-flies × 1.3 circuity factor — no routing API calls.