# Scoring

## Composite Score

Five components, each 0–10, combined in WEIGHTS inside analyzeLocation (api.ts). Must sum to 1.0.

## Description of Components making up "My Score"
- Closest Services - 85% · Distance decay score for the nearest instance of each selected service type. Ideal ≤5 min walk, zero at 20 min. → Weights in api.ts WEIGHTS.nearest; decay curve in scoring.ts calculateDistanceFactor()

- Errand Walk - 5% · Shortest loop route from home through all selected services. Scored against an 800 m walkable threshold. → WEIGHTS.errandTrip in api.ts; loop logic in scoring.ts scoreErrandTripExact()

- Choice & Variety - 5% · Weighted count of all services within 800 m, decay-adjusted by distance. Benchmarked against a reference neighbourhood. → WEIGHTS.abundance in api.ts; reference config in scoring.ts scoreAbundance()

- Housing Cost - 2.5% · Suburb median house/unit price expressed as a z-score vs Greater Melbourne, inverted so cheaper = higher score. → WEIGHTS.housePrice in api.ts; raw scores in melbourne_housing_crime_data.json (housePrices.housePriceScore); normalisation in scoring.ts normaliseToTen()

- Safety - 2.5% · LGA crime rate per 100k population, inverted so lower crime = higher score. → WEIGHTS.crime in api.ts; raw scores in melbourne_housing_crime_data.json (crimeLga.crimeScore)


```typescript
const WEIGHTS = {
  errandTrip: 0.05,  // shortest walking route through high/medium frequency services
  abundance:  0.05,  // count of walkable options weighted by frequency + proximity
  nearest:    0.85,  // how close the nearest of each service type is
  housePrice: 0.025,  // suburb affordability (-3→+3 normalised to 0–10)
  crime:      0.025,  // suburb safety (-3→+3 normalised to 0–10)
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

Uses crow-flies distances × 1.3 circuity factor - no routing API calls. Brute-forces all candidate combinations and path permutations. Falls back to greedy nearest-neighbour above 500,000 checks (complexityCap). Missing services incur a 5000m penalty (MISSING_PENALTY).

## House Price / Crime

Sourced from backend/melbourne_housing_crime_data.json. House price cascades through postcode → LGA siblings if the suburb has no data. Crime has no nulls.

Errand Trip - TSP and Greedy Fallback
The errand trip score models a single walk from home visiting one instance of each TSP-eligible service. The problem is to find the best combination of candidates (e.g. which of 3 nearby supermarkets) and the best order to visit them.
Exact TSP (scoreErrandTripExact) - brute-forces every combination of one candidate per category, then every permutation of the resulting stops. Guarantees the optimal path. Complexity grows fast: 5 services × 3 candidates each = 3,125 combinations × 120 permutations = 375,000 checks. Fine in practice for typical selection sizes.
Greedy fallback (scoreErrandTripGreedy) - when checks would exceed complexityCap (default 500,000), switches to nearest-neighbour: from the current position, always visit the closest remaining service next. Still tries all candidate combinations but uses the greedy heuristic for path ordering. Typically within 10–15% of optimal.
Score is derived from mean leg length (total distance ÷ stops) normalised against 800m. Missing services incur a 5000m penalty. All distances are crow-flies × 1.3 circuity factor - no routing API calls.