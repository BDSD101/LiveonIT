const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const port = Number(process.env.PORT) || 3000;

const MELBOURNE_BBOX = {
  west: 144.40,
  south: -38.50,
  east: 145.55,
  north: -37.40,
};

const poolConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 5435,
  database: process.env.DB_NAME || 'app_db',
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD || 'password',
};

const pool = new Pool(poolConfig);
const searchCache = new Map();

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
};

// --- Local Routing Helpers ---

function getDistance(p1, p2) {
  const dx = p1[0] - p2[0], dy = p1[1] - p2[1];
  return Math.sqrt(dx * dx + dy * dy);
}

async function findLocalPath(startLon, startLat, endLon, endLat) {
  // 1. Fetch all roads in a small box around the start/end points
  const pad = 0.02; // ~2km
  const bbox = [
    Math.min(startLon, endLon) - pad, Math.min(startLat, endLat) - pad,
    Math.max(startLon, endLon) + pad, Math.max(startLat, endLat) + pad
  ];

  const sql = `
    SELECT ST_AsGeoJSON(ST_Transform(way, 4326)) as geojson, highway
    FROM planet_osm_line
    WHERE way && ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, 4326), 3857)
      AND highway IS NOT NULL
      AND highway NOT IN ('trunk', 'motorway', 'motorway_link', 'trunk_link');
  `;

  const res = await pool.query(sql, bbox);
  const segments = res.rows.map(r => JSON.parse(r.geojson).coordinates);

  // 2. Build Adjacency Graph
  const graph = new Map();
  const allNodes = [];

  const addEdge = (u, v) => {
    const keyU = u.join(','), keyV = v.join(',');
    const dist = getDistance(u, v);
    if (!graph.has(keyU)) graph.set(keyU, []);
    if (!graph.has(keyV)) graph.set(keyV, []);
    graph.get(keyU).push({ node: keyV, dist, coords: v });
    graph.get(keyV).push({ node: keyU, dist, coords: u });
    allNodes.push({ key: keyU, coords: u }, { key: keyV, coords: v });
  };

  segments.forEach(seg => {
    for (let i = 0; i < seg.length - 1; i++) addEdge(seg[i], seg[i + 1]);
  });

  // 3. Find closest nodes in graph to Start and End
  const findNearest = (lon, lat) => {
    let best = null, minDist = Infinity;
    for (const [key, _] of graph) {
      const [nLon, nLat] = key.split(',').map(Number);
      const d = getDistance([lon, lat], [nLon, nLat]);
      if (d < minDist) { minDist = d; best = key; }
    }
    return best;
  };

  const startKey = findNearest(startLon, startLat);
  const endKey = findNearest(endLon, endLat);

  if (!startKey || !endKey) return [[startLon, startLat], [endLon, endLat]];

  // 4. Dijkstra
  const distances = new Map(), prev = new Map(), pq = new Set();
  for (const key of graph.keys()) { distances.set(key, Infinity); pq.add(key); }
  distances.set(startKey, 0);

  while (pq.size > 0) {
    let minNode = null, minDist = Infinity;
    for (const node of pq) {
      if (distances.get(node) < minDist) { minDist = distances.get(node); minNode = node; }
    }
    if (!minNode || minNode === endKey) break;
    pq.delete(minNode);

    for (const neighbor of graph.get(minNode)) {
      const alt = distances.get(minNode) + neighbor.dist;
      if (alt < distances.get(neighbor.node)) {
        distances.set(neighbor.node, alt);
        prev.set(neighbor.node, minNode);
      }
    }
  }

  // 5. Reconstruct path
  const path = [];
  let curr = endKey;
  while (curr) {
    path.unshift(curr.split(',').map(Number));
    curr = prev.get(curr);
  }

  if (path.length < 2) return [[startLon, startLat], [endLon, endLat]];
  // Add actual start/end points to snap to the line
  path.unshift([startLon, startLat]);
  path.push([endLon, endLat]);
  return path;
}

// --- Server Implementation ---

const server = http.createServer(async (req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  if (pathname === '/health') {
    try {
      const result = await pool.query('SELECT NOW() as time');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', db: 'connected', time: result.rows[0].time }));
    } catch (err) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Database health check failed' }));
    }
    return;
  }

  // UPDATED: Local Routing API using real OSM lines
  if (pathname === '/api/route') {
    const sLat = parseFloat(parsedUrl.query.sLat), sLon = parseFloat(parsedUrl.query.sLon);
    const eLat = parseFloat(parsedUrl.query.eLat), eLon = parseFloat(parsedUrl.query.eLon);

    if ([sLat, sLon, eLat, eLon].some(isNaN)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing coordinates' }));
      return;
    }

    try {
      const coordinates = await findLocalPath(sLon, sLat, eLon, eLat);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ coordinates }));
    } catch (err) {
      console.error('Local routing failed:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Local routing failed' }));
    }
    return;
  }

  if (pathname === '/api/nearby-services') {
    const lat = parseFloat(parsedUrl.query.lat);
    const lon = parseFloat(parsedUrl.query.lon);

    if (isNaN(lat) || isNaN(lon)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Invalid lat/lon parameters' }));
      return;
    }

    const sql = `
      WITH center AS (
        SELECT ST_Transform(ST_SetSRID(ST_Point($1, $2), 4326), 3857) as geom
      ),
      service_types AS (
        SELECT 'Supermarket' as category, '#E67E22' as color, 'shop' as tag_key, 'supermarket' as tag_val UNION ALL
        SELECT 'GP Service' as category, '#E74C3C' as color, 'amenity' as tag_key, 'doctors' as tag_val UNION ALL
        SELECT 'Pharmacy' as category, '#9B59B6' as color, 'amenity' as tag_key, 'pharmacy' as tag_val UNION ALL
        SELECT 'Post Office' as category, '#F1C40F' as color, 'amenity' as tag_key, 'post_office' as tag_val UNION ALL
        SELECT 'Transport' as category, '#3498DB' as color, 'highway' as tag_key, 'bus_stop' as tag_val UNION ALL
        SELECT 'Transport' as category, '#3498DB' as color, 'railway' as tag_key, 'station' as tag_val UNION ALL
        SELECT 'Transport' as category, '#3498DB' as color, 'railway' as tag_key, 'tram_stop' as tag_val
      ),
      all_nearby AS (
        SELECT 
          st.category, st.color, p.name,
          ST_Y(ST_Transform(p.way, 4326)) as lat,
          ST_X(ST_Transform(p.way, 4326)) as lon,
          ST_Distance(p.way, c.geom) as dist_meters
        FROM planet_osm_point p, center c, service_types st
        WHERE p.way && ST_Expand(c.geom, 2000)
          AND (
            (st.tag_key = 'shop' AND p.shop = st.tag_val) OR
            (st.tag_key = 'amenity' AND p.amenity = st.tag_val) OR
            (st.tag_key = 'highway' AND p.highway = st.tag_val) OR
            (st.tag_key = 'railway' AND p.railway = st.tag_val)
          )
        UNION ALL
        SELECT 
          st.category, st.color, p.name,
          ST_Y(ST_Transform(ST_Centroid(p.way), 4326)) as lat,
          ST_X(ST_Transform(ST_Centroid(p.way), 4326)) as lon,
          ST_Distance(p.way, c.geom) as dist_meters
        FROM planet_osm_polygon p, center c, service_types st
        WHERE p.way && ST_Expand(c.geom, 2000)
          AND (
            (st.tag_key = 'shop' AND p.shop = st.tag_val) OR
            (st.tag_key = 'amenity' AND p.amenity = st.tag_val) OR
            (st.tag_key = 'highway' AND p.highway = st.tag_val) OR
            (st.tag_key = 'railway' AND p.railway = st.tag_val)
          )
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER(PARTITION BY category ORDER BY dist_meters) as rank
        FROM all_nearby
      )
      SELECT category, color, name, lat, lon, dist_meters FROM ranked WHERE rank = 1;
    `;

    try {
      const result = await pool.query(sql, [lon, lat]);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(result.rows));
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Database query failed' }));
    }
    return;
  }

  if (pathname === '/api/local-search') {
    let q = String(parsedUrl.query.q || '').trim();
    if (!q || q.length < 3) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Missing or short query param q' }));
      return;
    }

    const cacheKey = `local_melbourne_${q.toLowerCase()}`;
    if (searchCache.has(cacheKey)) {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(searchCache.get(cacheKey)));
      return;
    }

    const normalizedQ = q.replace(/\bSt\b\.?/gi, 'Street').replace(/\bRd\b\.?/gi, 'Road').replace(/\bAve\b\.?/gi, 'Avenue').replace(/\bCl\b\.?/gi, 'Close').replace(/\bCres\b\.?/gi, 'Crescent').replace(/\bDr\b\.?/gi, 'Drive').replace(/\bPl\b\.?/gi, 'Place');
    const words = normalizedQ.split(/\s+/).filter(w => w.length > 0);
    const searchPatterns = words.map(w => `%${w}%`);
    const numberWords = words.filter(w => /^\d+/.test(w)).map(w => `${w}%`);
    const textWords = words.filter(w => !/^\d+/.test(w)).map(w => `%${w}%`);
    
    const sql = `
      WITH melbourne AS (SELECT ST_Transform(ST_MakeEnvelope($1, $2, $3, $4, 4326), 3857) AS geom),
      candidates AS (
        SELECT p.name, p."addr:housenumber" as house_number, p.tags->'addr:street' as street, p.tags->'addr:suburb' as tag_suburb, p.tags->'addr:city' as tag_city, p.way, ST_Y(ST_Transform(p.way, 4326)) as lat, ST_X(ST_Transform(p.way, 4326)) as lon
        FROM planet_osm_point p, melbourne m WHERE p.way && m.geom AND (p."addr:housenumber" IS NOT NULL OR p.tags->'addr:street' IS NOT NULL) AND (($7::text[] <> '{}' AND p."addr:housenumber" ILIKE ANY($7) AND (p.tags->'addr:street' ILIKE ANY($8) OR $8::text[] = '{}')) OR ($7::text[] = '{}' AND (p.tags->'addr:street' ILIKE ANY($5) OR p.name ILIKE ANY($5))))
        UNION ALL
        SELECT p.name, p."addr:housenumber" as house_number, p.tags->'addr:street' as street, p.tags->'addr:suburb' as tag_suburb, p.tags->'addr:city' as tag_city, p.way, ST_Y(ST_Transform(ST_Centroid(p.way), 4326)) as lat, ST_X(ST_Transform(ST_Centroid(p.way), 4326)) as lon
        FROM planet_osm_polygon p, melbourne m WHERE p.way && m.geom AND (p."addr:housenumber" IS NOT NULL OR p.tags->'addr:street' IS NOT NULL) AND (($7::text[] <> '{}' AND p."addr:housenumber" ILIKE ANY($7) AND (p.tags->'addr:street' ILIKE ANY($8) OR $8::text[] = '{}')) OR ($7::text[] = '{}' AND (p.tags->'addr:street' ILIKE ANY($5) OR p.name ILIKE ANY($5))))
      ),
      resolved AS (
        SELECT *, COALESCE(tag_suburb, tag_city, (SELECT name FROM planet_osm_polygon s WHERE ST_Intersects(candidates.way, s.way) AND s.boundary = 'administrative' AND s.admin_level IN ('9', '8', '10') ORDER BY s.admin_level DESC LIMIT 1)) as suburb
        FROM candidates
      ),
      final AS (SELECT *, CONCAT_WS(' ', house_number, street, suburb, name) as addr_full FROM resolved)
      SELECT * FROM final ORDER BY ((SELECT COUNT(*) FROM unnest($5) w WHERE addr_full ILIKE w)) DESC, (CASE WHEN addr_full ILIKE '%' || $6 || '%' THEN 1000 ELSE 0 END) DESC, (CASE WHEN house_number ILIKE ANY($7) THEN 50 ELSE 0 END) DESC LIMIT 10;
    `;

    try {
      const result = await pool.query(sql, [MELBOURNE_BBOX.west, MELBOURNE_BBOX.south, MELBOURNE_BBOX.east, MELBOURNE_BBOX.north, searchPatterns, normalizedQ, numberWords, textWords]);
      const mapped = result.rows.map((row) => {
        const addressLine = [row.house_number, row.street].filter(Boolean).join(' ').trim();
        const locality = [row.suburb, 'Melbourne'].filter(Boolean).join(', ');
        return { display_name: [...new Set([addressLine || row.name, row.name, locality].filter(Boolean))].join(', '), lat: String(row.lat), lon: String(row.lon) };
      });
      searchCache.set(cacheKey, mapped);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(mapped));
    } catch (err) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Local database search failed' }));
    }
    return;
  }

  let filePath = path.join(__dirname, '../frontend', pathname === '/' ? 'local-search.html' : pathname);
  const extname = path.extname(filePath);
  let contentType = MIME_TYPES[extname] || 'application/octet-stream';

  fs.readFile(filePath, (error, content) => {
    if (error) { res.writeHead(error.code === 'ENOENT' ? 404 : 500); res.end(error.code === 'ENOENT' ? 'File not found' : 'Server error'); }
    else { res.writeHead(200, { 'Content-Type': contentType }); res.end(content, 'utf-8'); }
  });
});

server.listen(port, () => { console.log(`Local backend listening on http://localhost:${port}`); });
const shutdown = async () => { server.close(async () => { await pool.end(); process.exit(0); }); };
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
