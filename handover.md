# LiveonIT - Handover Document
## 20-Minute Neighbourhood Explorer

---

## 1. Project Overview

LiveonIT is a web application that helps users evaluate how liveable a location in Melbourne is, based on the **20-minute neighbourhood** concept - the idea that residents should be able to meet most of their daily needs within a 20-minute walk from home.

The application has two main features:

1. **Address Search Dashboard** (`/dashboard.html`) - A user searches for a specific Melbourne address and receives a real-time liveability score based on nearby services (powered by live Google Maps API calls).
2. **Suburb Overview Map** (`/suburb.html`) - A heatmap of all ~542 Melbourne suburbs, each pre-scored and stored in a PostgreSQL database (powered by a one-off batch script that should be re-run annually).

---

## 2. Architecture

### System Diagram

```
┌──────────────────┐        ┌──────────────────────┐        ┌────────────────────┐
│   User Browser   │───────▶│   Node.js Server     │───────▶│  Google Maps APIs   │
│                  │        │   (src/server.ts)     │        │  (Geocoding,        │
│  - dashboard.html│◀───────│                      │        │   Places,           │
│  - suburb.html   │        │   Endpoints:         │        │   Distance Matrix)  │
│  - index.html    │        │   /api/search        │        └────────────────────┘
│  - about.html    │        │   /api/nearby-services│
│                  │        │   /api/ratings        │───────▶┌────────────────────┐
│                  │        │   /api/config         │        │  PostgreSQL (Render)│
│                  │        │   /health             │◀───────│  suburb_ratings     │
└──────────────────┘        └──────────────────────┘        └────────────────────┘
```

### Tech Stack

| Layer | Technology |
|-------|-----------|
| **Frontend** | HTML, Vanilla JS, Tailwind CSS |
| **Backend** | Node.js + TypeScript (`ts-node`) |
| **Database** | PostgreSQL (hosted on Render) |
| **External API** | Google Maps Platform (Geocoding, Places, Distance Matrix) |
| **Hosting** | Render Web Service |
| **Deploy Branch** | `added_suburb_overview` |

### Key Files

| File | Purpose |
|------|---------|
| `src/server.ts` | HTTP server, static file serving, routes requests to handler |
| `src/functions/api.ts` | Core API handler - all endpoints, Google Maps integration, scoring |
| `src/scoring.ts` | Scoring algorithms, category weights, service type definitions |
| `frontend/suburb-map.js` | Frontend JS for the suburb overview heatmap |
| `frontend/script.js` | Frontend JS for the address search dashboard |
| `scripts/generate_suburb_ratings.js` | Batch script to generate suburb ratings (run annually) |
| `scripts/migrate_to_postgres.js` | One-off script to upload CSV ratings into PostgreSQL |
| `backend/melbourne_housing_crime_data.json` | Static dataset for house prices and crime rates by suburb |

---

## 3. How the Address Search Rating is Calculated

When a user searches for a specific address on the **Dashboard**, the system calculates a liveability score **in real-time**. This involves **live Google Maps API calls** for every search.

### Process Flow

1. **Geocoding** - The user's search query is sent to the Google Maps Geocoding API to resolve it to latitude/longitude coordinates.
2. **Service Discovery** - The Google Maps Places API (Nearby Search + Text Search) is used to find all essential services within a **2 km radius** of the address. Services are searched across **8 categories** containing **21 service types**.
3. **Walking Distance Enrichment** - The Google Maps Distance Matrix API calculates actual walking distances and durations from the address to each discovered service.
4. **Composite Scoring** - Three walkability sub-scores plus two suburb-level scores are calculated and combined into a final **weighted composite score out of 10**.

### The 8 Service Categories

| Category | Weight | Service Types Searched |
|----------|--------|----------------------|
| Health Services | 3 | Doctor (GP), Pharmacy, Hospital, Dentist |
| Food and Essentials | 3 | Supermarket, Convenience Store |
| Connectivity | 2 | Train Station, Transit Station |
| Parks and Nature | 2 | Park |
| Dining and Social | 2 | Cafe, Restaurant, Bar |
| Education and Learning | 2 | Childcare, Kindergarten, Primary School, Secondary School, Library |
| Fitness and Recreation | 1 | Gym |
| Community and Errands | 1 | Community Centre, Post Office, Bank, ATM |

### Composite Score Formula

The final score is a **weighted average** of five components:

```typescript
const WEIGHTS = {
  errandTrip: 0.05,   // 5%   - shortest walking route through services
  abundance:  0.05,   // 5%   - count of walkable options
  nearest:    0.85,   // 85%  - how close the nearest of each type is
  housePrice: 0.025,  // 2.5% - suburb affordability
  crime:      0.025,  // 2.5% - suburb safety
};
```

| Component | Weight | Description |
|-----------|--------|-------------|
| **Nearest Service Score** | **85%** | How close the nearest service of each type is. Uses a continuous decay model: full score if ≤5 min walk, decays linearly to 0 at 20 min walk. Penalises missing or distant services. |
| **Errand Trip Score** | **5%** | Simulates a multi-stop walking errand trip (TSP-style optimisation). Measures how efficiently a resident can visit multiple high-frequency services in one outing. Uses crow-flies distances × 1.3 circuity factor. Falls back to greedy nearest-neighbour above 500,000 checks. |
| **Abundance Score** | **5%** | Rewards locations with multiple options per service type (e.g., 3 cafes vs 1 cafe), weighted by visit frequency. Benchmarked against a reference neighbourhood. |
| **House Price Score** | **2.5%** | Derived from static housing data (`melbourne_housing_crime_data.json`). Inverted so that lower house prices = higher score (affordability bonus). Cascades through postcode → LGA siblings if the suburb has no data. |
| **Crime Score** | **2.5%** | Derived from static LGA-level crime data. Lower crime = higher score. |

> **Note:** The **Nearest Service Score** (85% weight) is by far the dominant factor. It determines whether the final score is high or low. The other components act as minor adjustments.

### Service Visit Frequency Weights

Services are weighted by how often a typical resident visits them:

| Frequency | Weight | Examples |
|-----------|--------|----------|
| High | 1.00 | Supermarket, Train Station, Cafe, ATM |
| Medium | 0.50 | Restaurant, Bar, Gym, Park |
| Low | 0.10 | Library, School, Post Office, Pharmacy |
| Rare | 0.02 | Doctor, Dentist, Hospital |

### Two Scores Per Search

Each search produces **two** scores:
- **Neighbourhood Score** - scored against all 21 service types (full picture of the area).
- **Selection Score** - scored only against the services the user selected in the dashboard filter.

If house price or crime data is missing for the suburb, those weights are redistributed across the remaining components.

---

## 4. How the Suburb Overview Rating is Calculated

The **Suburb Overview** heatmap displays pre-calculated scores for all ~542 Melbourne suburbs. These scores are **not calculated in real-time** - they were generated via a batch script and stored in PostgreSQL.

### How the Suburb Scores Were Generated

1. **Geocoding** - For each suburb, the script sends a query like `"Abbotsford, Victoria"` to the `/api/search` endpoint, which resolves the suburb's geographic centre via Google Maps Geocoding.
2. **Service Analysis** - The script calls `/api/nearby-services` with those centre coordinates. This triggers the full analysis pipeline: Places API → Distance Matrix → composite scoring.
3. **Score Extraction** - The `walkability.neighbourhood.score` value (the composite score using **all** service categories) is extracted as the suburb's rating.
4. **Storage** - Ratings are saved to a CSV, then migrated into PostgreSQL.

### Key Difference from Address Search

| Aspect | Address Search | Suburb Overview |
|--------|---------------|-----------------|
| **When calculated** | Real-time, on every search | Pre-calculated once, stored in DB |
| **Location** | Exact address coordinates | Suburb geographic centre |
| **Services scored** | User-selected subset + full neighbourhood | All 21 service types |
| **API calls** | Every search costs API credits | No API calls at runtime (reads from DB) |
| **Update frequency** | Always current | Should be refreshed **once per year** |

---

## 5. Database

### PostgreSQL on Render

The suburb ratings are stored in a PostgreSQL database hosted on Render.

| Parameter | Value |
|-----------|-------|
| **Service** | Render PostgreSQL |
| **Database Name** | `liveonit_db_f9qz` |
| **Region** | Singapore |

### Schema

```sql
CREATE TABLE suburb_ratings (
    id SERIAL PRIMARY KEY,
    suburb VARCHAR(255) UNIQUE NOT NULL,
    region VARCHAR(100) NOT NULL,
    rating DECIMAL(4, 2) NOT NULL
);
```

- **suburb** - The suburb name (e.g., `"Abbotsford"`), unique constraint.
- **region** - The geographic region grouping (e.g., `"Inner Metro"`, `"Western"`, `"Eastern"`, `"Northern"`, `"Southern"`, `"Inner South East"`).
- **rating** - The liveability score from 0.0 to 10.0.

### API Endpoint

The frontend fetches suburb ratings via:

```
GET /api/ratings
→ Returns JSON: [{ "Suburb": "Abbotsford", "Region": "Inner Metro", "Rating": "8.30" }, ...]
```

### Environment Variables

| Variable | Where | Value |
|----------|-------|-------|
| `DATABASE_URL` | Render Web Service (Environment tab) | **Internal Database URL** (faster, free bandwidth) |
| `DATABASE_URL` | Local `.env` file | **External Database URL** (for local dev/testing) |

> **Important:** Always use the **Internal Database URL** on Render. Only use the External URL when connecting from outside Render (e.g., running migration scripts from your laptop).

---

## 6. Google Maps API - Usage & Monitoring

> **⚠️ The Google Maps API is a paid service. Every address search by a user costs real money. Monitor usage carefully.**

### Which APIs Are Used

| API | When Used | Cost Trigger |
|-----|-----------|-------------|
| **Geocoding API** | Every address search (`/api/search`) | Per request |
| **Places API (Nearby Search)** | Every address search (`/api/nearby-services`) - multiple calls per search | Per request |
| **Places API (Text Search)** | For specific service types (GP, hospital, kindergarten, etc.) | Per request |
| **Distance Matrix API** | Walking distance calculations for discovered services | Per element (origin × destination) |

### Cost Per Address Search

A single address search triggers approximately:
- **1** Geocoding call
- **~21** Places API calls (one per service type)
- **~1–3** Distance Matrix calls (batched, up to 25 destinations each)

### How to Monitor API Usage

1. Go to the [Google Cloud Console](https://console.cloud.google.com/).
2. Navigate to **APIs & Services → Dashboard**.
3. Check usage graphs for Geocoding, Places, and Distance Matrix APIs.
4. Set up **billing alerts** under **Billing → Budgets & alerts** to get notified if spending exceeds a threshold.

### Built-In Caching

The application includes an in-memory cache that prevents duplicate API calls for the same location within a session. Repeated searches for the same address are served from cache and cost nothing. Cache durations are configured in `CACHE_TTL_MS` in `api.ts`.

### Debug Endpoint

You can check live API usage stats at:
```
GET /api/debug/stats
→ Returns: { apiCallCounts: { geocoding: N, nearbySearch: N, ... }, cacheSize: N }
```

### The Suburb Overview Map Does NOT Use the API at Runtime

The suburb map reads from PostgreSQL via `GET /api/ratings`. It makes **zero** Google Maps API calls. The API was only used during the initial batch generation.

---

## 7. Annual Maintenance: Re-Running the Suburb Rating Script

The suburb ratings should be refreshed **once per year** to account for new developments, closures, and infrastructure changes across Melbourne.

### Prerequisites

1. The backend server must be running locally (`npm run dev`).
2. Your `.env` file must contain a valid `GOOGLE_MAPS_API_KEY`.
3. Your `.env` file must contain the **External** `DATABASE_URL` for your Render PostgreSQL database.

### Step-by-Step Process

#### Step 1: Start the Local Server

```bash
npm run dev
```

#### Step 2: Run the Rating Generation Script

```bash
node scripts/generate_suburb_ratings.js
```

This script:
- Reads the base suburb list from `backend/suburb_regions_ratings.csv`.
- Geocodes each suburb to find its geographic centre coordinates.
- Calls the local API to calculate a walkability score for each suburb.
- Saves results incrementally (every 50 suburbs) to prevent data loss.
- Has **resume logic** - if it crashes mid-way (due to memory or network issues), simply restart it and it will pick up where it left off.
- Includes a 200ms delay between suburbs to avoid rate limiting.

> **⚠️ API Cost Warning:** This script makes ~21 Google Maps API calls per suburb × 542 suburbs ≈ **11,000+ API calls**. Budget approximately **$20–50 USD** in API credits per full run.

> **⚠️ Memory Warning:** The local server may crash during long runs due to accumulated in-memory cache. If this happens, restart the server (`npm run dev`) and re-run the script - the resume logic will continue from where it left off.

#### Step 3: Review the Output CSV

After the script completes, review the generated CSV at:
```
backend/suburb_regions_ratings_google_api_centre.csv
```

Copy and finalise it:
```bash
cp backend/suburb_regions_ratings_google_api_centre.csv frontend/suburb_regions_ratings_google_api_centre_final.csv
```

#### Step 4: Upload to PostgreSQL

```bash
node scripts/migrate_to_postgres.js
```

This script:
- Connects to the Render PostgreSQL database.
- Truncates the existing `suburb_ratings` table.
- Inserts all records from the final CSV in a single transaction.

#### Step 5: Verify

Visit the live website's Suburb Overview page and confirm the map reflects the updated scores.

---

## 8. Deployment

### Current Setup

| Component | Platform | Details |
|-----------|----------|---------|
| **Web Service** | Render | Service ID: `srv-d7s7mh3rjlhs7385vg20` |
| **Database** | Render PostgreSQL | Database: `liveonit_db_f9qz` |
| **Repository** | GitHub | `BDSD101/LiveonIT` |
| **Deploy Branch** | `added_suburb_overview` |

### Environment Variables (Render Dashboard → Environment Tab)

| Key | Description |
|-----|-------------|
| `GOOGLE_MAPS_API_KEY` | Your Google Maps Platform API key |
| `DATABASE_URL` | **Internal** PostgreSQL connection URL |
| `PORT` | `3000` (Render may set this automatically) |

### Build & Start Commands (Render Settings)

| Setting | Command |
|---------|---------|
| **Build Command** | `npm install && npm run build` |
| **Start Command** | `npm start` |

The build step uses `esbuild` to bundle the TypeScript server into `dist/server.js`. The start command runs the bundled production server.

### Deploying Changes

1. Make changes locally on the `added_suburb_overview` branch.
2. Commit and push to GitHub.
3. If Auto-Deploy is enabled on Render, it will rebuild automatically.
4. If Auto-Deploy is off, click **"Manual Deploy"** in the Render dashboard.

---

## 9. Local Development

### Getting Started

```bash
git clone https://github.com/BDSD101/LiveonIT.git
cd LiveonIT
npm install
cp .env.example .env
# Fill in GOOGLE_MAPS_API_KEY and DATABASE_URL (external) in .env
npm run dev
```

The server will start at `http://localhost:3000`.

### Pages

| URL | Page |
|-----|------|
| `/` | Home / Landing Page |
| `/dashboard.html` | Address Search Dashboard |
| `/suburb.html` | Suburb Overview Heatmap |
| `/about.html` | About Page |

### Debug Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /health` | Health check - returns `{ status: "ok" }` |
| `GET /api/debug/stats` | Shows API call counts and cache size |
| `GET /api/ratings` | Returns all suburb ratings from PostgreSQL |

---

## 10. Key Tunables (in `src/scoring.ts`)

| Constant | Default | Description |
|----------|---------|-------------|
| `WALKABLE_THRESHOLD_METERS` | 2000 | Maximum walking distance considered "walkable" |
| `MAX_WALKING_MINUTES` | 20 | Above this = zero score |
| `IDEAL_WALKING_MINUTES` | 5 | Below this = perfect score |
| `SERVICE_FREQUENCY` | per type | Assigns each service type a visit frequency tier |
| `FREQUENCY_WEIGHTS` | high=1.0, medium=0.5, low=0.1, rare=0.02 | Numeric weight per tier |
| `CATEGORY_CONFIG` | per category | Weights for the 8 service categories |
