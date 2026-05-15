const fs = require('fs');
const path = require('path');

const CSV_FILE = path.join(__dirname, '../backend/suburb_regions_ratings.csv');
const OUTPUT_CSV_BACKEND = path.join(__dirname, '../backend/suburb_regions_ratings_google_api_centre.csv');
const OUTPUT_CSV_FRONTEND = path.join(__dirname, '../frontend/suburb_regions_ratings.csv');
const GEOCODE_URL = 'http://localhost:3000/api/search?q=';
const API_URL = 'http://localhost:3000/api/nearby-services';

async function fetchWithTimeout(resource, options = {}) {
  const { timeout = 15000 } = options;
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeout);
  const response = await fetch(resource, { ...options, signal: controller.signal });
  clearTimeout(id);
  return response;
}

async function main() {
    console.log("Reading CSV data...");
    const csvData = fs.readFileSync(CSV_FILE, 'utf-8');
    const lines = csvData.split('\n').filter(l => l.trim() !== '');
    const header = lines[0];
    const dataLines = lines.slice(1);
    
    // Map of the original dummy ratings
    const originalRatings = new Map();
    dataLines.forEach(l => {
        const [suburb, region, rating] = l.split(',');
        originalRatings.set(suburb, rating);
    });

    // Check for already completed suburbs (only if the rating has changed from the dummy one)
    const completedSuburbs = new Map();
    if (fs.existsSync(OUTPUT_CSV_BACKEND)) {
        const completedData = fs.readFileSync(OUTPUT_CSV_BACKEND, 'utf-8');
        const compLines = completedData.split('\n').filter(l => l.trim() !== '');
        compLines.slice(1).forEach(l => {
            const [suburb, region, rating] = l.split(',');
            // If the rating in the output file is DIFFERENT from the original dummy rating,
            // or if it's a decimal (which dummy ratings weren't), we know it's a real completed score.
            if (rating !== originalRatings.get(suburb) || rating.includes('.')) {
                completedSuburbs.set(suburb, rating);
            }
        });
        console.log(`Found ${completedSuburbs.size} already completed suburbs. Resuming from the rest...`);
    }
    
    console.log(`Starting processing for ${dataLines.length} suburbs...`);
    const updatedLines = [header];
    
    for (let i = 0; i < dataLines.length; i++) {
        const line = dataLines[i];
        const [suburb, region, oldRating] = line.split(',');
        
        if (completedSuburbs.has(suburb)) {
            const existingRating = completedSuburbs.get(suburb);
            console.log(`[${i+1}/${dataLines.length}] ${suburb}: Already completed (${existingRating}/10)`);
            updatedLines.push(`${suburb},${region},${existingRating}`);
            continue;
        }
        
        try {
            const searchRes = await fetchWithTimeout(`${GEOCODE_URL}${encodeURIComponent(suburb + ', Victoria')}`, { timeout: 10000 });
            if (!searchRes.ok) throw new Error("Geocode Failed");
            
            const searchData = await searchRes.json();
            if (!searchData || searchData.length === 0) {
                console.log(`[${i+1}/${dataLines.length}] ${suburb}: Geocode not found. Keeping ${oldRating}.`);
                updatedLines.push(`${suburb},${region},${oldRating}`);
                continue;
            }
            
            const coords = { lat: searchData[0].lat, lon: searchData[0].lon };
            
            const res = await fetchWithTimeout(`${API_URL}?lat=${coords.lat}&lon=${coords.lon}`, { timeout: 15000 });
            if (!res.ok) throw new Error("API Failed");
            
            const data = await res.json();
            const score = data.walkability?.neighbourhood?.score || oldRating;
            
            console.log(`[${i+1}/${dataLines.length}] ${suburb}: Real Score is ${score}/10`);
            updatedLines.push(`${suburb},${region},${score}`);
            
            await new Promise(r => setTimeout(r, 200));
            
        } catch (err) {
            console.log(`[${i+1}/${dataLines.length}] Network Error for ${suburb}: ${err.message}. Keeping old rating.`);
            updatedLines.push(`${suburb},${region},${oldRating}`);
            await new Promise(r => setTimeout(r, 2000));
        }
        
        if ((i + 1) % 50 === 0) {
            fs.writeFileSync(OUTPUT_CSV_BACKEND, updatedLines.join('\n') + '\n');
        }
    }
    
    const finalCsvData = updatedLines.join('\n') + '\n';
    fs.writeFileSync(OUTPUT_CSV_BACKEND, finalCsvData);
    console.log(`\nDONE! Saved to ${OUTPUT_CSV_BACKEND}`);
    fs.writeFileSync(OUTPUT_CSV_FRONTEND, finalCsvData);
    console.log(`Copied to ${OUTPUT_CSV_FRONTEND} for the map.`);
}

main().catch(console.error);
