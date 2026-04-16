# LiveonIT

A web-based liveability assessment tool that helps users evaluate how well a Melbourne address supports a 20-minute neighbourhood lifestyle — where essential services are accessible within an 800 m walk.

## Prerequisites

Before setting up the project, ensure you have the following installed on your machine:
- [Node.js](https://nodejs.org/) (v16+)
- [Docker & Docker Compose](https://www.docker.com/) (required to run the local PostGIS spatial database)

## Getting Started Locally

### 1. Clone the repository
```bash
git clone https://github.com/BDSD101/LiveonIT.git
cd LiveonIT
```

### 2. Install Dependencies
Install the required Node.js packages:
```bash
npm install
```
*(If you plan to run local Typescript tools, install the local dev tools specified in `local.txt`: `npm install -D dotenv ts-node`)*

### 3. Setup PostgreSQL / PostGIS Database (Docker)
The application relies heavily on detailed spatial routing and local amenity calculations powered by OpenStreetMap and PostGIS. We bundle a `docker-compose.yml` to automatically provision this setup.

To start the database and automatically download and import the Victoria `.osm.pbf` data file:
```bash
docker-compose up -d
```

**Note on Database Import**:
- The `osm_importer` container will automatically download `victoria-latest.osm.pbf` from Geofabrik and run `osm2pgsql`. 
- This process requires computational power and **may take a few minutes** to complete. You can verify the importer's progress by running:
  ```bash
  docker logs -f osm_importer
  ```
- The database is purposefully exposed on port **5435** locally to avoid interference with any pre-existing Postgres instances you might be running on port 5432.

### 4. Configure Environment (Optional for local)
By default, the server is configured to connect to your local Docker `app_db` instance on port 5435 without needing a `.env` file. However, if you wish to connect to an external RDS or override the connection details, create a `.env` file in the root based on `.env.example`:
```bash
cp .env.example .env
```

### 5. Running the Local Server
Start the backend server (which also serves the frontend):
```bash
npm start
```
*(Alternatively: `node backend/server.js`)*

### 6. View the Application
Open your browser and navigate to:
[http://localhost:3000](http://localhost:3000)

---

## Useful Development Commands

We provide a `src/local.ts` testing harness. You can run various diagnostic scripts:

```bash
# General health check
npm run local

# Get user records
npm run local:users

# Local Search simulation 
npm run local:search

# Create a test user via POST
npm run local:post
```

To stop the database instances, simply run:
```bash
docker-compose down
```