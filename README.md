# LiveonIT | 20-Min Neighbourhood Tool

A high-performance liveability assessment tool that evaluates how well a Melbourne address supports a 20-minute neighbourhood lifestyle — where essential services are accessible within an 800m walk.

## Architecture

This application is now **fully powered by the Google Maps Platform**, eliminating the need for local OSM databases or complex spatial infrastructure:
- **Geocoding API**: Address to coordinate translation.
- **Places API**: Real-time discovery of nearby services.
- **Directions API**: Precise pedestrian routing and time estimation.

The backend acts as a stateless secure proxy to protect API keys and provide a unified scoring engine for the frontend.

---

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- A **Google Maps API Key** (with Places, Geocoding, and Directions enabled).

## Getting Started Locally

### 1. Setup
```bash
git clone https://github.com/BDSD101/LiveonIT.git
cd LiveonIT
npm install
```

### 2. Configure Environment
Create a `.env` file in the root directory:
```bash
cp .env.example .env
```
Add your API key:
```
GOOGLE_MAPS_API_KEY=AIza...
```

### 3. Run Development Server
```bash
npm run dev
```

### 4. View App
Open [http://localhost:3000](http://localhost:3000)

---

## Security Warning

> [!CAUTION]
> The `GOOGLE_MAPS_API_KEY` is fetched by the browser to initialize the map. You **must** restrict your API key to your specific domain (HTTP Referrer) in the [Google Cloud Console](https://console.cloud.google.com/google/maps-apis/credentials) before deploying to production.

## Scoring Methodology

The tool uses a **Weighted Proximity Model**:
1. **Diversity**: Services are grouped into core categories (Health, Food, Parks, etc.).
2. **Proximity**: Walking distance is calculated; points decay as distance increases from 800m.
3. **Density**: Access to multiple options within the same category provides a small density bonus to the score.
