let map = null; // Holds the one big map instance
let marker = null; // For the red pin - user selected address - global variable so pins don't accumulate
let debounceTimer = null; // User stops typing in the search box - this makes it so every keystroke doesn't fire a network request
let currentResults = []; // Stores address suggestions in the dropdown
let selectedIndex = -1; // Tracks which search dropdown suggestion is currently highlighted - starts at -1
let serviceMarkers = []; // To store and then see the services in the map
let serviceRouteGeojson = null; // For the actual routes to services from the red pin
let mapReady = false; // Tracks whether the map style has fully loaded (was soliving a timing glitch)
let activeLoadController = null; // If the user picks another address while network requests are happening, this helps cancel those requests

// Guarantees all the elements exist and can be referenced safely (loads everything essentially)
document.addEventListener('DOMContentLoaded', () => {
    // Creates the actual map instance around Melbourne
    map = new maplibregl.Map({
        container: 'map',
        style: 'https://tiles.openfreemap.org/styles/bright',
        center: [144.9631, -37.8136],
        zoom: 12
    });

    // Needed for a timing glitch that was happening - layers can be added onto the map after the map is loaded and ready
    map.once('load', () => {
        mapReady = true;
    });

    // Everytime the search box changes with input, this fires
    // Search fires once the user stops typing for 400ms
    document.getElementById('query').addEventListener('input', () => {
        clearTimeout(debounceTimer);
        const q = document.getElementById('query').value.trim();
        if (q.length < 3) {
            // Hide results if query is too short
            document.getElementById('results').style.display = 'none';
            return;
        }
        debounceTimer = setTimeout(() => search(q), 400);
    });

    // Keyboard navigation within the search dropdown (Up/Down/Enter/Escape) - stops browser from doing its own movements
    document.getElementById('query').addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            document.getElementById('results').style.display = 'none';
        } else if (e.key === 'ArrowDown') {
            e.preventDefault(); // Prevent cursor from moving in input
            if (selectedIndex < currentResults.length - 1) {
                selectedIndex++;
                updateSelectionUI();
            }
        } else if (e.key === 'ArrowUp') {
            e.preventDefault(); // Prevent cursor from moving in input
            if (selectedIndex > 0) {
                selectedIndex--;
                updateSelectionUI();
            }
        // Enter selects highlighted item only and does not reload thd page
        } else if (e.key === 'Enter') {
            e.preventDefault(); // Prevent form submit if there was one
            if (selectedIndex >= 0 && selectedIndex < currentResults.length) {
                select(currentResults[selectedIndex]);
            }
        }
    });

    // Swap the button icon when fullscreen state changes (covers different browsers)
    document.addEventListener('fullscreenchange', onFullscreenChange);
    document.addEventListener('webkitfullscreenchange', onFullscreenChange);
    document.addEventListener('mozfullscreenchange', onFullscreenChange);
});

// Toggles the map wrapper in and out of fullscreen - MapLibre automatically resizes the canvas 
function toggleFullscreen() {
    const wrapper = document.querySelector('.map-wrapper');
    // Checks if we are in fullscreen first
    if (!document.fullscreenElement && !document.webkitFullscreenElement) {
        // If not in fullscreen, enter fullscreen here — use vendor prefix for Safari
        if (wrapper.requestFullscreen) {
            wrapper.requestFullscreen();
        } else if (wrapper.webkitRequestFullscreen) {
            wrapper.webkitRequestFullscreen();
        }
    } else {
        // Otherwise exit fullscreen here
        if (document.exitFullscreen) {
            document.exitFullscreen();
        } else if (document.webkitExitFullscreen) {
            document.webkitExitFullscreen();
        }
    }
}

// Swaps the expand/collapse icon to reflect the current fullscreen state
function onFullscreenChange() {
    // Are we in fullscreen now?
    const isFullscreen = !!(document.fullscreenElement || document.webkitFullscreenElement);
    // If in fullscreen, expand icon gets hidden
    document.getElementById('fs-expand-icon').style.display  = isFullscreen ? 'none'  : 'block';
    // If not in fullscreen, collapse icon gets hidden
    document.getElementById('fs-collapse-icon').style.display = isFullscreen ? 'block' : 'none';
    // Tell MapLibre the container has resized so it redraws at the correct dimensions
    map.resize();
}

// This function highlights what is selected in the dropdown via mouse hover
function updateSelectionUI() {
    // First grab ever list item
    const listItems = document.querySelectorAll('#results li');
    // Loop through each list item, with 'i' being its position (0, 1, 2, etc.)
    listItems.forEach((li, i) => {
        // If this item's index matches the currently selected index, highlight it
        if (i === selectedIndex) {
            li.classList.add('selected');
        // Otherwise make sure it's not highlighted (remove the class if it was there)
        } else {
            li.classList.remove('selected');
        }
    });
}

// We clear the shown services - and routes - when a user types a new address
function clearServiceMarkers() {
    serviceMarkers.forEach(marker => marker.remove());
    serviceMarkers = [];
    clearServiceRoute();
}

// Clears all route layers and sources 
function clearServiceRoute() {
    const style = map.getStyle();
    if (!style) return;

    // Removes 'service-route-line' layers which are those route lines on the map
    style.layers
        .filter(l => l.id.startsWith('service-route-line-'))
        .forEach(l => map.removeLayer(l.id));

    // Removes source layers which are essentially the coordinates for those route lines to be drawn
    Object.keys(style.sources)
        .filter(s => s.startsWith('service-route-'))
        .forEach(s => map.removeSource(s));
}

// Removes the "no services" banner if it exists - used when user types new address, selects address, etc.
function clearServiceBanner() {
    const existing = document.getElementById('service-banner');
    if (existing) existing.remove();
}

// Shows a user-facing message above the legend when services fail to load (usually due to too many network requests)
function showServiceBanner(message, isError) {
    clearServiceBanner();
    const banner = document.createElement('div');
    banner.id = 'service-banner';
    banner.style.fontFamily = 'Inter, sans-serif';
    banner.style.fontSize = '13px';
    banner.style.padding = '10px 16px';
    banner.style.marginTop = '12px';
    banner.style.borderRadius = 'var(--radius)';
    banner.style.border = '1px solid';
    if (isError) {
        banner.style.background = '#FEF2F2';
        banner.style.borderColor = '#FECACA';
        banner.style.color = '#991B1B';
    } else {
        banner.style.background = '#FFFBEB';
        banner.style.borderColor = '#FDE68A';
        banner.style.color = '#92400E';
    }
    banner.textContent = message;
    // Insert between map wrapper and legend
    const legend = document.querySelector('.legend');
    legend.parentNode.insertBefore(banner, legend);
}

// We can't launch all the network requests at once, so we need a pause or 'sleep' between batches of requests
function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

// If a service is within 200m just choose it regardless of if there are closer services of that type - for efficiency
const EARLY_ACCEPT_DISTANCE = 200;

// No services estimated - Valhalla does walking path to each service - use this only if straight path to service is wanted
const ESTIMATE_ONLY_CATEGORIES = new Set();

// Walking speed assumption - 4.8km/h
const WALK_SPEED_M_PER_MIN = 80; // ~4.8 km/h
const ROUTE_DETOUR_FACTOR = 1.3; // Assumes walking distance is 30% longer than straight line path, due to street corners, etc.

// Function to get the walking route and time to each service through Valhalla
// Retries up to 2 times if server returns error
// Accepts an 'AbortSignal' so in-flight requests can be cancelled when the user picks a new address
// async function getWalkingRouteAndTime(fromLat, fromLon, toLat, toLon, retries = 2, signal = null) {
//     // Build the Valhalla request - two locations, pedestrian for walking route, and meters unit
//     const body = {
//         locations: [
//             { lon: fromLon, lat: fromLat },
//             { lon: toLon,   lat: toLat   }
//         ],
//         costing: "pedestrian",
//         directions_options: { units: "meters" }
//     };

//     // Try up to (retries + 1) times — so with 2 retries, that's 3 attempts max
//     for (let attempt = 0; attempt <= retries; attempt++) {
//         try {
//             // Sends routing request to Valhalla server - 'signal' var is an AbortSignal if new address is selected
//             const res = await fetch("https://valhalla1.openstreetmap.de/route", {
//                 method: "POST",
//                 headers: { "Content-Type": "application/json" },
//                 body: JSON.stringify(body),
//                 signal
//             });

//             // If rate-limited (429) or server error (5**), retry after backoff
//             // The delay doubles each time - first retry waits 300ms, second waits 600ms - "exponential backoff"
//             if (res.status === 429 || res.status >= 500) {
//                 if (attempt < retries) {
//                     await sleep(300 * Math.pow(2, attempt)); // 300ms, 600ms
//                     continue;
//                 }
//                 // If we've exhausted all retries, give up with an error
//                 throw new Error(`Valhalla returned ${res.status} after ${retries + 1} attempts`);
//             }

//             // Parse the JSON response from Valhalla
//             const data = await res.json();

//             // Safety check — if the response doesn't contain a valid route, bail out
//             if (!data.trip?.legs?.length) throw new Error("No walking route found");

//             // Extract the first (and only) leg of the route - a leg is from A to B
//             const leg = data.trip.legs[0];
//             // Valhalla returns distance in km - convert to meters and round
//             const distanceMeters = Math.round(leg.summary.length * 1000); // km -> m
//             // Valhalla returns time in seconds — convert to minutes, minimum 1 minute, so never "0" minutes
//             const durationMinutes = Math.max(1, Math.round(leg.summary.time / 60));

//             // Decode the route which comes as an encoded polyline shape
//             const geometry = {
//                 type: "LineString",
//                 coordinates: decodePolyline(leg.shape)
//             };

//             // Return all three pieces of info that we need
//             return { durationMinutes, distanceMeters, geometry };
//         } catch (e) {
//             // If the request was intentionally aborted (user picked a new address), stop immediately
//             if (e.name === 'AbortError') throw e;
//             // For any other error, retry if we have attempts still remaining
//             if (attempt < retries) {
//                 await sleep(300 * Math.pow(2, attempt));
//                 continue;
//             }
//             throw e;
//         }
//     }
// }

// // Updated getWalkingRouteAndTime function with AWS OSRM
// async function getWalkingRouteAndTime(fromLat, fromLon, toLat, toLon, retries = 2, signal = null) {
//     // Build the Valhalla request - two locations, pedestrian for walking route, and meters unit
//     // Build OSRM request URL - coordinates in lon,lat order
//     const osrmBase = window.location.hostname === 'localhost'
//         ? 'http://localhost:5000'
//         : 'http://10.0.0.47:5000';

//     const osrmUrl = `${osrmBase}/route/v1/foot/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson`;

//     // Try up to (retries + 1) times — so with 2 retries, that's 3 attempts max
//     for (let attempt = 0; attempt <= retries; attempt++) {
//         try {
//             // Sends routing request to OSRM server - 'signal' var is an AbortSignal if new address is selected
//             const res = await fetch(osrmUrl, { signal });

//             // If rate-limited (429) or server error (5**), retry after backoff
//             // The delay doubles each time - first retry waits 300ms, second waits 600ms - "exponential backoff"
//             if (res.status === 429 || res.status >= 500) {
//                 if (attempt < retries) {
//                     await sleep(300 * Math.pow(2, attempt)); // 300ms, 600ms
//                     continue;
//                 }
//                 // If we've exhausted all retries, give up with an error
//                 throw new Error(`OSRM returned ${res.status} after ${retries + 1} attempts`);
//             }

//             // Parse the JSON response from OSRM
//             const data = await res.json();

//             // Safety check — if the response doesn't contain a valid route, bail out
//             if (!data.routes?.length) throw new Error("No walking route found");

//             // Extract the first route
//             const route = data.routes[0];
//             // OSRM returns distance in meters directly
//             const distanceMeters = Math.round(route.distance);
//             // OSRM returns duration in seconds — convert to minutes, minimum 1 minute
//             const durationMinutes = Math.max(1, Math.round(route.duration / 60));

//             // OSRM returns GeoJSON geometry directly when geometries=geojson
//             const geometry = route.geometry;

//             // Return all three pieces of info that we need
//             return { durationMinutes, distanceMeters, geometry };

//         } catch (e) {
//             // If the request was intentionally aborted (user picked a new address), stop immediately
//             if (e.name === 'AbortError') throw e;
//             // For any other error, retry if we have attempts still remaining
//             if (attempt < retries) {
//                 await sleep(300 * Math.pow(2, attempt));
//                 continue;
//             }
//             throw e;
//         }
//     }
// }

async function getWalkingRouteAndTime(fromLat, fromLon, toLat, toLon, retries = 2, signal = null) {
    // Build OSRM request URL - locally hit OSRM directly, in production go via Lambda proxy
    const isLocal = window.location.hostname === 'localhost';
    const fetchUrl = isLocal
        ? `http://localhost:5000/route/v1/foot/${fromLon},${fromLat};${toLon},${toLat}?overview=full&geometries=geojson`
        : `https://qchhoyc9a9.execute-api.ap-southeast-2.amazonaws.com/prod/api/route?fromLon=${fromLon}&fromLat=${fromLat}&toLon=${toLon}&toLat=${toLat}`;

    // Try up to (retries + 1) times — so with 2 retries, that's 3 attempts max
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            // Sends routing request - 'signal' var is an AbortSignal if new address is selected
            const res = await fetch(fetchUrl, { signal });

            // If rate-limited (429) or server error (5**), retry after backoff
            // The delay doubles each time - first retry waits 300ms, second waits 600ms - "exponential backoff"
            if (res.status === 429 || res.status >= 500) {
                if (attempt < retries) {
                    await sleep(300 * Math.pow(2, attempt)); // 300ms, 600ms
                    continue;
                }
                // If we've exhausted all retries, give up with an error
                throw new Error(`OSRM returned ${res.status} after ${retries + 1} attempts`);
            }

            // Parse the JSON response from OSRM
            const data = await res.json();

            // Safety check — if the response doesn't contain a valid route, bail out
            if (!data.routes?.length) throw new Error("No walking route found");

            // Extract the first route
            const route = data.routes[0];
            // OSRM returns distance in meters directly
            const distanceMeters = Math.round(route.distance);
            // OSRM returns duration in seconds — convert to minutes, minimum 1 minute
            const durationMinutes = Math.max(1, Math.round(route.duration / 60));

            // OSRM returns GeoJSON geometry directly when geometries=geojson
            const geometry = route.geometry;

            // Return all three pieces of info that we need
            return { durationMinutes, distanceMeters, geometry };

        } catch (e) {
            // If the request was intentionally aborted (user picked a new address), stop immediately
            if (e.name === 'AbortError') throw e;
            // For any other error, retry if we have attempts still remaining
            if (attempt < retries) {
                await sleep(300 * Math.pow(2, attempt));
                continue;
            }
            throw e;
        }
    }
}

// This function is not used for now - ignore it - only for straight point-to-point route lines
function estimateWalkingResult(fromLat, fromLon, toLat, toLon, straightLineMeters) {
    const adjustedDistance = Math.round(straightLineMeters * ROUTE_DETOUR_FACTOR);
    const durationMinutes = Math.max(1, Math.round(adjustedDistance / WALK_SPEED_M_PER_MIN));
    const geometry = {
        type: "LineString",
        coordinates: [[fromLon, fromLat], [toLon, toLat]]
    };
    return { durationMinutes, distanceMeters: adjustedDistance, geometry };
}

// Decodes Valhalla's encoded polyline string into an array of [lng, lat] coordinates
// function decodePolyline(encoded) {
//     const coords = []; // Will hold the decoded [lng, lat] pairs
//     let index = 0; // Current position in the encoded string
//     let lat = 0; // Running latitude total (values are deltas, not absolute)
//     let lng = 0; // Running longitude total

//     // Each iteration of this loop decodes one coordinate pair (lat + lng)
//     while (index < encoded.length) {

//         // Read characters one at a time, extract 5 bits from each, and assemble them into a single integer
//         // The loop continues until a character signals "end of this number" (< 0x20) (32 hexadecimal - 5 bits - below 32 is last character)
//         let b, shift = 0, result = 0;
//         do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
//         // If the last bit is 1, the number is negative — apply two's complement
//         lat += (result & 1) ? ~(result >> 1) : (result >> 1);

//         // Decode longitude (same process) 
//         shift = 0; result = 0;
//         do { b = encoded.charCodeAt(index++) - 63; result |= (b & 0x1f) << shift; shift += 5; } while (b >= 0x20);
//         lng += (result & 1) ? ~(result >> 1) : (result >> 1);

//         // Divide by 1,000,000 to convert back to decimal degrees
//         // Push as [lng, lat] since that's what GeoJSON/MapLibre expects
//         coords.push([lng / 1e6, lat / 1e6]);
//     }

//     return coords;
// }

// Creates line from address pin to service marker
function drawServiceRoute(geometry, routeId) {
    // Create unique IDs for this route's source and layer so multiple routes can exist on the map at the same time 
    // Otherwise would just overwrite routes drawn to services
    const sourceId = `service-route-${routeId}`;
    const layerId  = `service-route-line-${routeId}`;

    // If this route was already drawn (from a previous load), clean it up before redrawing
    // Layer must be removed before its source
    if (map.getLayer(layerId))  map.removeLayer(layerId);
    if (map.getSource(sourceId)) map.removeSource(sourceId);

    // The full list of coordinates that make up the walking path
    const allCoords = geometry.coordinates;

    // Adds to the map - start the source with just the first two coordinates so the layer exists
    map.addSource(sourceId, {
        type: 'geojson',
        data: {
            type: 'Feature',
            geometry: { type: 'LineString', coordinates: allCoords.slice(0, 2) }
        }
    });

    // Single solid line layer — no dasharray, so MapLibre never drops it (was dropping dashed lines for some reason)
    map.addLayer({
        id: layerId,
        type: 'line',
        source: sourceId,
        paint: {
            'line-color': '#004071',
            'line-width': 3,
            'line-opacity': 0.85
        }
    });

    // Time (ms) for the full route to draw — slow reveal (wanted an animation)
    const duration = 2000; 
    const start = performance.now(); 
    const total = allCoords.length;

    // This function runs on every animation frame (~60 times per second)
    function animateRoute(timestamp) {
        // How many milliseconds have passed since the animation started
        const elapsed  = timestamp - start;
        // Linear progress from 0 to 1 (clamped so it never exceeds 1)
        const progress = Math.min(elapsed / duration, 1);

        // Line starts fast then slows down as it approaches the destination
        // Natural "arriving" feel rather than a constant speed
        const eased = 1 - Math.pow(1 - progress, 3);

        // How many coordinate points to reveal — always at least 2
        const revealed = Math.max(2, Math.round(eased * total));

        // Update the source data - line visually grows on map as more points included
        const source = map.getSource(sourceId);
        if (source) {
            source.setData({
                type: 'Feature',
                geometry: { type: 'LineString', coordinates: allCoords.slice(0, revealed) }
            });
        }

        // If we haven't reached the end, request another frame
        if (progress < 1) {
            requestAnimationFrame(animateRoute);
        } else {
            // Animation complete — write the full geometry once and stop
            if (source) {
                source.setData({ type: 'Feature', geometry });
            }
        }
    }

    // Kick off the animation loop — the browser will call the animateRoute function on the next available frame 
    requestAnimationFrame(animateRoute);
}

// Progress bar helpers — controls the thin red bar at the top of the map
function showProgress() {
    // Grab the progress bar element from the DOM
    const bar = document.getElementById('progress-bar');
    // Turn off CSS transitions temporarily so the reset to 0% happens instantly
    // Without this, the bar would animate backwards to zero before going forward
    bar.style.transition = 'none';
    // Reset the bar to its starting state: zero width and fully visible
    bar.style.width = '0%';
    bar.style.opacity = '1';
    // Small delay so the browser registers the reset before animating
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            // Progress bar movement to give a natural 'loading' feeling
            bar.style.transition = 'width 2.5s cubic-bezier(0.1, 0.6, 0.4, 1)';
            // Progress bar goes to 85% and then 100% once services and routes load
            bar.style.width = '85%';
        });
    });
}

// Completes the progress loading bar (continuation of function above)
function completeProgress() {
    // Grab the progress bar element again
    const bar = document.getElementById('progress-bar');
    // Quick 0.3s transition to jump from wherever it is (up to 85%) to 100% - looks natural
    bar.style.transition = 'width 0.3s ease';
    bar.style.width = '100%';
    // Wait 350ms (just after the width animation finishes) then fade the bar out over 0.4s so it doesn't just disappear
    setTimeout(() => {
        bar.style.transition = 'opacity 0.4s ease';
        bar.style.opacity = '0';
    }, 350);
}

// Finds closest service to walk to (out of all candidates for a specific service type)
async function resolveCategory(category, label, icon, candidates, lat, lon, signal) {
    // If there are no candidates for this service (or category), nothing to do
    if (!candidates.length) return null;

    // Sort by straight-line distance so we check the closest first
    candidates.sort((a, b) => a.straightLineDistance - b.straightLineDistance);

    // Skip this as no estimates used
    if (ESTIMATE_ONLY_CATEGORIES.has(category)) {
        const { el, straightLineDistance } = candidates[0];
        const routeInfo = estimateWalkingResult(lat, lon, el.lat, el.lon, straightLineDistance);
        return { label, icon, el, routeInfo };
    }

    // Keep top 3 candidates to limit API calls
    const top = candidates.slice(0, 3);

    // Early-accept: if the closest candidate by crow-flies is very near (<200m) we route only that one (efficiency)
    const earlyAccept = top[0].straightLineDistance <= EARLY_ACCEPT_DISTANCE;
    const toRoute = earlyAccept ? [top[0]] : top;

    // Get walking routes one at a time (not in parallel) to be gentle on the public Valhalla server
    const valid = [];
    for (const { el } of toRoute) {
        // Bail immediately if user has selected a new address
        if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');

        try {
            // Ask Valhalla for the actual walking route and time
            const routeInfo = await getWalkingRouteAndTime(lat, lon, el.lat, el.lon, 2, signal);
            valid.push({ el, routeInfo });

            // In early-accept mode we only needed one route — got it, so stop
            if (earlyAccept) break;
        } catch (e) {
            // For errors or manual stops
            if (e.name === 'AbortError') throw e;
            console.error(`Failed to get walking route for ${label}:`, e);
        }
    }
    // If every candidate failed to route, this category has no result
    if (!valid.length) return null;

    // Pick the fastest walk
    valid.sort((a, b) => a.routeInfo.durationMinutes - b.routeInfo.durationMinutes);
    const { el, routeInfo } = valid[0];

    // Return the winning candidate with its label, icon, location, and route info
    return { label, icon, el, routeInfo };
}

// Main function for the whole app - finds nearby services through OSM, calculates routes, puts everything on the map
async function loadNearbyServices(lat, lon) {
    // Cancel any in-flight load from a previous address selection
    if (activeLoadController) activeLoadController.abort();
    // For more cancellation if needed
    activeLoadController = new AbortController();
    const signal = activeLoadController.signal;

    // Clean the map from previous search if needed
    clearServiceMarkers();
    clearServiceRoute();
    clearServiceBanner();
    // Start the progress bar animation at the top of the map
    showProgress();

    // // To build the Overpass API query
    // // Nodes are points and ways are shapes of multiple points (needed for some train stations)
    // const query = `
    //     [out:json];
    //     (
    //     node["shop"="supermarket"](around:800,${lat},${lon});
    //     node["amenity"="pharmacy"](around:800,${lat},${lon});
    //     node["amenity"="clinic"](around:800,${lat},${lon});
    //     node["amenity"="doctors"](around:800,${lat},${lon});
    //     node["highway"="bus_stop"](around:800,${lat},${lon});
    //     node["railway"="station"](around:800,${lat},${lon});
    //     way["railway"="station"](around:800,${lat},${lon}); 
    //     node["amenity"="post_office"](around:800,${lat},${lon});
    //     );
    //     out body center;
    // `;

    // try {
    //     // Send the query to the Overpass API - queries OSM data
    //     const res = await fetch('https://overpass-api.de/api/interpreter', {
    //         method: 'POST',
    //         body: query,
    //         signal
    //     });

    //     // Parse the JSON response containing all matching places
    //     const data = await res.json();
    //     // Create a Turf.js point for the user's address — used to calculate straight-line distances to each service
    //     const origin = turf.point([lon, lat]);

    //     // Stores up to 3 candidates per category (w/ icons for categories), sorted by straight-line distance
    //     // Walking routes are then fetched for all candidates and the fastest walk is chosen
    //     const candidateServices = {
    //         supermarket: {label: 'Supermarket', icon: '🛒', candidates: [] },
    //         pharmacy: { label: 'Pharmacy', icon: '💊', candidates: [] },
    //         clinic: { label: 'Health Clinic', icon: '🏥', candidates: [] },
    //         bus_stop: { label: 'Bus Stop', icon: '🚌', candidates: [] },
    //         train_station: { label: 'Train Station', icon: '🚆', candidates: [] },
    //         post_office: { label: 'Post Office', icon: '📮', candidates: [] },
    //     };

    //     // Loop through every place that Overpass returned and sort it into the correct category bucket
    //     data.elements.forEach((el) => {
    //         // Get the coordinates — nodes have lat/lon directly
    //         // Ways (polygons) store their center point in el.center instead
    //         const elLat = el.lat ?? el.center?.lat;
    //         const elLon = el.lon ?? el.center?.lon;
    //         // Skip elements that somehow have no coordinates
    //         if (!elLat || !elLon) return;

    //         // Calculate straight-line distance from the user's address to this service using Turf.js
    //         const point = turf.point([elLon, elLat]);
    //         const distance = turf.distance(origin, point, { units: 'meters' });
    //         // Some may still be further than the 800m radius
    //         if (distance > 800) return;

    //         // Figure out which category this place belongs to based on its OSM tags
    //         let category = null;

    //         if (el.tags?.shop === 'supermarket') category = 'supermarket';
    //         else if (el.tags?.amenity === 'pharmacy') category = 'pharmacy';
    //         else if (el.tags?.amenity === 'clinic' || el.tags?.amenity === 'doctors') category = 'clinic';
    //         else if (el.tags?.highway === 'bus_stop') category = 'bus_stop';
    //         else if (el.tags?.railway === 'station') category = 'train_station';
    //         else if (el.tags?.amenity === 'post_office') category = 'post_office';

    //          // If it doesn't match any category (shouldn't happen but just in case), skip
    //         if (!category) return;

    //         // Add this place to its category's candidate list along with its straight-line distance (used later for sorting and early-accept)
    //         candidateServices[category].candidates.push({ el: { ...el, lat: elLat, lon: elLon }, straightLineDistance: distance });
    //     });

    // AWS Hosted PostGIS for OSM data
    try {
        // Fetch nearby services from our own backend (backed by Aurora PostGIS)
        // const res = await fetch(`http://localhost:4000/api/nearby-services?lat=${lat}&lon=${lon}`, { signal });
        const API_BASE = window.location.hostname === 'localhost'
            ? 'http://localhost:4000'
            : 'https://qchhoyc9a9.execute-api.ap-southeast-2.amazonaws.com/prod';

        const res = await fetch(`${API_BASE}/api/nearby-services?lat=${lat}&lon=${lon}`, { signal });



        const rows = await res.json();

        // Create a Turf.js point for the user's address — used to calculate straight-line distances to each service
        const origin = turf.point([lon, lat]);

        // Stores up to 3 candidates per category (w/ icons for categories), sorted by straight-line distance
        // Walking routes are then fetched for all candidates and the fastest walk is chosen
        const candidateServices = {
            supermarket: { label: 'Supermarket', icon: '🛒', candidates: [] },
            pharmacy: { label: 'Pharmacy', icon: '💊', candidates: [] },
            clinic: { label: 'Health Clinic', icon: '🏥', candidates: [] },
            bus_stop: { label: 'Bus Stop', icon: '🚌', candidates: [] },
            train_station: { label: 'Train Station', icon: '🚆', candidates: [] },
            post_office: { label: 'Post Office', icon: '📮', candidates: [] },
        };

        // Loop through every row returned from PostGIS and sort into category buckets
        rows.forEach((row) => {
            const elLat = row.lat;
            const elLon = row.lon;
            if (!elLat || !elLon) return;

            const category = row.category;
            if (!category || !candidateServices[category]) return;

            // Calculate straight-line distance using Turf.js (PostGIS already filters to 800m but we keep this for sorting)
            const point = turf.point([elLon, elLat]);
            const distance = turf.distance(origin, point, { units: 'meters' });

            // Shape the row to match what the rest of the code expects
            candidateServices[category].candidates.push({
                el: {
                    lat: elLat,
                    lon: elLon,
                    tags: { name: row.name }
                },
                straightLineDistance: distance
            });
        });

        // Sort categories by candidate count ascending 
        // Categories with fewercandidates resolve faster, getting markers on the map sooner for quicker visual feedback to the user
        const categoryEntries = Object.entries(candidateServices)
            .sort((a, b) => a[1].candidates.length - b[1].candidates.length);

        // Process 3 categories at a time with an 80ms gap between batches
        // This prevents flooding the Valhalla server with too many simultaneous routing requests
        const BATCH_SIZE = 3;
        const BATCH_DELAY_MS = 80;

        // Array to store each category's result in the correct position
        const categoryResults = new Array(categoryEntries.length);

        // Process categories in batches of 3
        for (let i = 0; i < categoryEntries.length; i += BATCH_SIZE) {
            // Bail if the user has already picked a new address
            if (signal.aborted) return;

            // Grab the next batch of up to 3 categories
            const batch = categoryEntries.slice(i, i + BATCH_SIZE);

            // Resolve all categories in this batch simultaneously
            // Promise.allSettled waits for all to finish and never throws
            const batchResults = await Promise.allSettled(
                batch.map(([category, { label, icon, candidates }]) =>
                    resolveCategory(category, label, icon, candidates, lat, lon, signal)
                )
            );

            // Store each result at the right index in the master results array
            batchResults.forEach((result, j) => {
                categoryResults[i + j] = result;
            });

            // Pause 80ms before launching the next batch to spread the load on the Valhalla server
            // Skip the delay after the last batch
            if (i + BATCH_SIZE < categoryEntries.length) {
                await sleep(BATCH_DELAY_MS);
            }
        }

        // Final abort check — we don't waste resources rendering 'stale' results
        if (signal.aborted) return;

        // All routing is done — snap the progress bar to 100% and fade it out
        completeProgress();

        // Track how many categories successfully resolved for user feedback messages
        let servicesRendered = 0;
        let categoriesWithCandidates = 0;

        categoryEntries.forEach(([, { candidates }]) => {
            if (candidates.length) categoriesWithCandidates++;
        });

        // This is where we put everything on the map
        categoryResults.forEach(result => {
            // Skip failed or empty categories
            if (!result || result.status !== 'fulfilled' || !result.value) return;

            // Destructure the winning candidate for this category (get label, icon, etc.)
            const { label, icon, el, routeInfo } = result.value;
            servicesRendered++;

            // Build the custom marker element 
            const markerEl = document.createElement('div');

            // innerEl is the visible content — the emoji icon and walk time badge
            // This is the element that gets the entrance animation
            // It's nested inside markerEl so the animation is isolated from MapLibre's transforms
            const innerEl = document.createElement('div');
            innerEl.style.display = 'flex';
            innerEl.style.alignItems = 'center';
            innerEl.style.gap = '6px';

            // The emoji icon inside a white circle with a subtle border and shadow
            const pinEl = document.createElement('div');
            pinEl.textContent = icon;
            pinEl.style.fontSize = '20px';
            pinEl.style.lineHeight = '1';
            pinEl.style.display = 'flex';
            pinEl.style.alignItems = 'center';
            pinEl.style.justifyContent = 'center';
            pinEl.style.width = '24px';
            pinEl.style.height = '24px';
            pinEl.style.background = 'white';
            pinEl.style.border = '1px solid #D0D5DD';
            pinEl.style.borderRadius = '50%';
            pinEl.style.boxShadow = '0 1px 4px rgba(0,0,0,0.12)';

            // The walk time badge — a small pill showing for example "5m" next to the icon
            const badgeEl = document.createElement('div');
            badgeEl.textContent = ` ${routeInfo.durationMinutes}m `;
            badgeEl.style.fontFamily = 'Inter, sans-serif';
            badgeEl.style.fontSize = '11px';
            badgeEl.style.fontWeight = '600';
            badgeEl.style.background = 'white';
            badgeEl.style.color = '#1A1A2E';
            badgeEl.style.border = '1px solid #D0D5DD';
            badgeEl.style.borderRadius = '999px';
            badgeEl.style.padding = '2px 6px';
            badgeEl.style.boxShadow = '0 1px 4px rgba(0,0,0,0.12)';

            // Assemble the marker: icon + badge into innerEl, innerEl into markerEl
            innerEl.appendChild(pinEl);
            innerEl.appendChild(badgeEl);
            markerEl.appendChild(innerEl);

            // Entrance animation setup - start invisible and shifted down 8px 
            // The animation will fade in and slide up into place
            innerEl.style.opacity = '0';
            innerEl.style.transform = 'translateY(8px)';
            innerEl.style.transition = 'opacity 0.4s ease-out, transform 0.4s ease-out';

            // Icons appear immediately — pop up into place before routes start drawing
            setTimeout(() => {
                innerEl.style.opacity = '1';
                innerEl.style.transform = 'translateY(0)';
                // Remove the transition after it fires so pan/zoom never triggers it again (fixes a bug that was occuring)
                setTimeout(() => {
                    innerEl.style.transition = 'none';
                }, 450);
            }, 0);

            // Route drawing starts after the icon entrance has finished (500ms)
            // The user sees all destinations first then watches the paths draw toward them
            const routeId = `${el.lat}_${el.lon}`.replace(/\./g, '_');
            setTimeout(() => {
                drawServiceRoute(routeInfo.geometry, routeId);
            }, 500);

            // Register our custom element as a marker, place it at the service's coordinates, 
            // Attach a popup that shows details when clicked (like a tooltip)
            const newMarker = new maplibregl.Marker({ element: markerEl })
                .setLngLat([el.lon, el.lat])
                .setPopup(
                    new maplibregl.Popup({ offset: 25 }).setHTML(`
                        <strong>${label}</strong><br>
                        ${el.tags?.name || 'Unnamed'}<br>
                        ${routeInfo.durationMinutes} min walk<br>
                        ${routeInfo.distanceMeters} m route distance
                    `)
                )
                .addTo(map);

            // Store the marker so it can be removed later when the user picks a different address
            serviceMarkers.push(newMarker);
        });

        // User feedback when results are missing (red box text above the legend and below the map)
        if (servicesRendered === 0 && categoriesWithCandidates > 0) {
            showServiceBanner('Routes couldn\u2019t be loaded \u2014 the routing server may be busy. Try again in a few seconds.', true);
        } else if (servicesRendered === 0 && categoriesWithCandidates === 0) {
            showServiceBanner('No services found within 800\u2009m of this address.', false);
        } else if (servicesRendered < categoriesWithCandidates) {
            showServiceBanner(`Some service routes couldn\u2019t be loaded. ${servicesRendered} of ${categoriesWithCandidates} categories shown.`, false);
        }

    } catch (e) {
        // Silently ignore aborted requests — the new address load is already in progress
        if (e.name === 'AbortError') return;

        console.error('Failed to load nearby services:', e);
        // Complete the progress bar even if the Overpass fetch itself failed
        completeProgress();
        showServiceBanner('Failed to search for nearby services. Please try again.', true);
    }
}

// Searches for addresses using Nomantim
async function search(q) {
    // This is for actually displaying the address suggestions
    const list = document.getElementById('results');
    // For visibility of the dropdown
    list.style.display = 'block';
    // Shows a temporary loading message for the user
    list.innerHTML = '<li><span style="color:var(--text-muted)">Searching...</span></li>';

    try {
        // If the last word looks incomplete (no space after it), also try without it
        // So "xx stre" (instead of "xx street") falls back to searching "xx" while the user keeps typing
        const words = q.trim().split(/\s+/);
        const endsWithCompleteWord = /[\s,]$/.test(document.getElementById('query').value);
        const queryVariants = endsWithCompleteWord || words.length <= 2
            ? [q]
            : [q, words.slice(0, -1).join(' ')]; // Try the full query, then without the last partial word

        // Fetch the results
        let raw = [];
        for (const variant of queryVariants) {
            // If the query starts with a number, it's probably a street address -
            // Append the full "Melbourne, Victoria, Australia" to help Nominatim find it
            // Otherwise just append "Melbourne, Victoria" for suburb/landmark searches
            const searchText = /^\d+\s+/.test(variant.trim())
                ? `${variant}, Melbourne, Victoria, Australia`
                : `${variant}, Melbourne, Victoria`;

            // Call the Nominatim API with the search text
            const res = await fetch(
                `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(searchText)}&format=json&limit=5&addressdetails=1&countrycodes=au`,
                {
                    headers: {
                        'Accept': 'application/json',
                        'User-Agent': '20MinuteMap/1.0'
                    }
                }
            );
            raw = await res.json();
            if (raw.length) break; // Stop as soon as we get results
        }

        // Shorten the display name to: street number + street, suburb instead of the full (annoying) Nominatim string
        const data = raw.map((item) => {
            const a = item.address || {};
            // Build a clean short label from structured address fields
            const parts = [
                a.house_number && a.road ? `${a.house_number} ${a.road}` : (a.road || a.name || ''),
                a.suburb || a.town || a.city_district || a.village || '',
            ].filter(Boolean);
            // If we built a clean label, use it. Otherwise fall back to the first 3 comma-separated chunks of Nominatim's full display name
            const short = parts.length ? parts.join(', ') : item.display_name.split(',').slice(0, 3).join(',').trim();
            // Return a simplified object with just the short name and coordinates
            return {
                display_name: short,
                lat: item.lat,
                lon: item.lon
            };
        });

        // Save the transformed data for access later
        currentResults = data;

        // For new searches - reset the dropdown index
        selectedIndex = -1;
        // Clear the old dropdown contents before inserting new results
        list.innerHTML = '';

        // If no usable results, we show a friendly message and stop
        if (!data || !data.length) {
            list.innerHTML = '<li><span style="color:var(--text-muted)">No results found.</span></li>';
            return;
        }

        // Then we loop through each dropdown result and create a clickable dropdown item
        data.forEach((item, index) => {
            // Create a new list element for one suggestion
            const li = document.createElement('li');

            // Put the shortened address text into the list item
            li.textContent = item.display_name;

            // If the user clicks this suggestion, pass the selected item into the select function
            // That function is responsible for moving the map, dropping the marker, etc.
            li.onclick = () => select(item);

            // When the mouse hovers over this suggestion, update the selected index so the UI can visually highlight it
            li.onmouseenter = () => {
                selectedIndex = index;
                updateSelectionUI();
            };

            // Add the new list item into the dropdown list on the page
            list.appendChild(li);
        });
    } catch (e) {
        // If anything fails (network error, bad response, JSON parse error, etc.) - we print the real error to the browser console for debugging
        console.error('Search failed:', e);

        // Keep the dropdown visible so the user sees feedback rather than nothing
        list.style.display = 'block';

        // Replace the dropdown content with an error message
        list.innerHTML = '<li><span style="color:#c0392b">Search failed.</span></li>';
    }
}

// Function for when the user picks an address - moves map, draws pin, draws shaded boundary, etc.
function select(item) {
    // Convert the coordinates from strings to numbers — Nominatim returns them as strings in the JSON response
    const lat = parseFloat(item.lat);
    const lon = parseFloat(item.lon);

    // Put the selected address text into the search box so the user can see what they picked
    document.getElementById('query').value = item.display_name;
    // Hide the dropdown since they've made their choice
    document.getElementById('results').style.display = 'none';

    // Remove any warning/error banner left over from a previous search
    clearServiceBanner();

    // Smoothly animate the map camera to the selected location at zoom 15
    map.flyTo({ center: [lon, lat], zoom: 15 });
    // Set map field of view to the selected location +/- 0.0072 degrees (roughly 800m) to give some context around the point
    map.fitBounds([[lon - 0.0072, lat - 0.0072], [lon + 0.0072, lat + 0.0072]], { padding: 20 });

    // If there's already a pin from a previous selection, remove it so we don't accumulate multiple pins on the map
    if (marker) marker.remove();

    // Drop a new red pin at the selected address
    marker = new maplibregl.Marker({ color: '#c0392b' })
        .setLngLat([lon, lat])
        .addTo(map);

    // Use Turf.js to create a GeoJSON circle with an 800m radius around the selected point
    const circle = turf.circle([lon, lat], 800, { steps: 64, units: 'meters' });

    // Helper that adds the radius circle and then kicks off service loading
    function addCircleAndLoad() {
        // Without this the shaded 800m boundary does not change with a different typed address
        if (map.getLayer('radius-circle-fill')) map.removeLayer('radius-circle-fill');
        if (map.getLayer('radius-circle-outline')) map.removeLayer('radius-circle-outline');
        if (map.getSource('radius-circle')) map.removeSource('radius-circle');

        // We register the circle polygon as a GeoJSON data source
        map.addSource('radius-circle', {
            type: 'geojson',
            data: circle
        });

        // Draw the circle as a semi-transparent blue fill — this is the shaded area showing the 800m search zone
        map.addLayer({
            id: 'radius-circle-fill',
            type: 'fill',
            source: 'radius-circle',
            maxzoom: 24,
            paint: {
                'fill-color': '#4A90E2',
                'fill-opacity': 0.15
            }
        });

        // Outline ring for the 800m circle — renders as a separate line layer so it stays visible at all zoom levels 
        if (map.getLayer('radius-circle-outline')) map.removeLayer('radius-circle-outline');
        map.addLayer({
            id: 'radius-circle-outline',
            type: 'line',
            source: 'radius-circle',
            maxzoom: 24,
            paint: {
                'line-color': '#4A90E2',
                'line-width': 1.5,
                'line-opacity': 0.4
            }
        });

        // After loading the layer we can load the services within the layer
        loadNearbyServices(lat, lon);
    }

    // Guard against a loading order bug that was occuring -
    // If the map style isn't loaded yet, wait for the 'load' event before trying to add sources and layers
    if (mapReady) {
        addCircleAndLoad();
    } else {
        map.once('load', addCircleAndLoad);
    }
}