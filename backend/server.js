const express = require('express');
const cors = require('cors');
const axios = require('axios');
const https = require('https');
const path = require('path');

const app = express();
const PORT = 3000;

app.use(cors());
app.use(express.static(path.join(__dirname, '..', 'frontend')));

// Keep-Alive agent to reuse SSL connections (Speeds up repeated requests)
const keepAliveAgent = new https.Agent({ keepAlive: true });

// Simple in-memory cache for search queries
const cache = new Map();

// Geocoding Proxy (Switched from Nominatim to Photon)
app.get('/api/search', async (req, res) => {
  const rawQuery = req.query.q || '';
  const q = rawQuery.trim().toLowerCase();
  
  if (!q) return res.status(400).json({ error: 'Missing query param q' });

  // 1. Return INSTANTLY if we have this exact search cached
  if (cache.has(q)) {
    return res.json(cache.get(q));
  }

  try {
    // 2. Fast Autocomplete Request to Photon (OSM-based)
    const response = await axios.get('https://photon.komoot.io/api/', {
      params: {
        q: rawQuery,
        limit: 5,
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
      const nameParts = [p.name, p.street, p.city, p.state].filter(Boolean);
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
