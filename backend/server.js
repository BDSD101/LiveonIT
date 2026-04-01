// Web framework for Node.js which listens for HTTP requests and defines routes
const express = require('express');
// Middleware to enable Cross-Origin Resource Sharing (CORS) so our frontend can talk to this backend without issues
const cors = require('cors'); 
// Promise-based HTTP client for making requests to external APIs (like our geocoding service)
const axios = require('axios'); 

// Node's build in modules for HTTPS and file path handling
// HTTPS is used to create a keep-alive agent for better performance
const https = require('https');
// Path is used to correctly serve our frontend static files
const path = require('path'); 

// Create an Express application and define the port to listen on
const app = express();
const PORT = 3000;

// Mapping of full state names to their abbreviations for cleaner display in search results
const stateMap = {
  'Victoria': 'VIC',
  'New South Wales': 'NSW',
  'Queensland': 'QLD',
  'Western Australia': 'WA',
  'South Australia': 'SA',
  'Tasmania': 'TAS',
  'Australian Capital Territory': 'ACT',
  'Northern Territory': 'NT'
};

// Mount CORS middleware and serve static files from the frontend directory
// so we can load our React app when we visit the root URL.
app.use(cors());

// Serve the React frontend from the 'frontend' directory. 
// This allows us to access the React app at http://localhost:3000/ and 
// have it make API calls to the same origin 
// (http://localhost:3000/api/search) without CORS issues.
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Keep-Alive agent to reuse TLS connections (Speeds up repeated requests)
// Reduces the need for TLS handshakes.
const keepAliveAgent = new https.Agent({ keepAlive: true });

// Simple in-memory cache for past search queries avoiding redundant API calls.
// Key: normalized search query (lowercase, trimmed)
// Value: array of geocoding results from Photon
const cache = new Map();

// Search Query
// Geocoding Proxy (Switched from Nominatim to Photon)
app.get('/api/search', async (req, res) => {
  // Input Validation: Ensure we have a query parameter 'q', normalized
  const rawQuery = req.query.q || '';
  const q = rawQuery.trim().toLowerCase();

  if (!q) return res.status(400).json({ error: 'Missing query param q' });

  // 1. Cache Check: Return INSTANTLY if we have this exact search cached
  if (cache.has(q)) {
    return res.json(cache.get(q));
  }

  try {
    // 2. Request to Photon (OSM-based) with Autcomplete and Melbourne bounding box
    const response = await axios.get('https://photon.komoot.io/api/', {
      params: {
        q: rawQuery, // query
        limit: 5, // limit results
        // Melbourne bounding box: minLon, minLat, maxLon, maxLat
        bbox: '144.40,-38.50,145.55,-37.40'
      },
      httpsAgent: keepAliveAgent, // Reuse existing TCP connection
      timeout: 3000 // Don't hang forever
    });

    // 3. Map Photon's GeoJSON to the format the frontend expects
    const mapped = response.data.features.map(f => {
      const p = f.properties;
      // Compile a nice display name from available data pieces
      const nameParts = [
        p.housenumber, 
        p.street, 
        p.district.toUpperCase(), 
        stateMap[p.state] || p.state, 
        p.postcode
      ].filter(Boolean);

      // Remove duplicates (e.g., "Melbourne, Melbourne")
      const uniqueParts = [...new Set(nameParts)];
      
      return {
        display_name: uniqueParts.join(', '),
        lat: f.geometry.coordinates[1].toString(),
        lon: f.geometry.coordinates[0].toString()
      };
    });

    // 4. Save to cache (Flush if over 1000 items to save memory)
    if (cache.size > 1000) cache.clear();
    cache.set(q, mapped);

    res.json(mapped);
  } catch (err) {
    console.error('Search proxy error:', err.message);
    res.status(500).json({ error: 'Search failed' });
  }
});

app.listen(PORT, () => {
  console.log(`Server running → http://localhost:${PORT}`);
});
