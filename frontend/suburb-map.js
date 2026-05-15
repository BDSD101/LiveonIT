let map;
let csvData = {};
let regions = {};
let currentRegion = 'Inner Metro';
let infoWindow;

// Determine map styling based on rating and exact region hex colors
const regionColors = {
    'Inner Metro': '#378ADD',
    'Inner South East': '#7F77DD',
    'Western': '#D4537E',
    'Northern': '#639922',
    'Eastern': '#D85A30',
    'Southern': '#EF9F27'
};

function hexToRgb(hex) {
    const bigint = parseInt(hex.replace('#', ''), 16);
    return [(bigint >> 16) & 255, (bigint >> 8) & 255, bigint & 255];
}

function getColor(region, rating) {
    const hex = regionColors[region] || '#888780';
    const rgb = hexToRgb(hex);

    // Rating range 4 to 10
    const n = Math.max(0, Math.min(1, (rating - 4) / 6));

    // Interpolate towards white for lower ratings
    // At n=0 (rating 4), mix with 70% white. At n=1 (rating 10), mix with 0% white.
    const whiteFactor = 0.7 - (n * 0.7);

    const r = Math.round(rgb[0] * (1 - whiteFactor) + 255 * whiteFactor);
    const g = Math.round(rgb[1] * (1 - whiteFactor) + 255 * whiteFactor);
    const b = Math.round(rgb[2] * (1 - whiteFactor) + 255 * whiteFactor);

    return `rgb(${r}, ${g}, ${b})`;
}

async function loadGoogleMaps() {
    try {
        const res = await fetch('/api/config');
        if (!res.ok) throw new Error('Config unavailable');
        const { key } = await res.json();
        if (!key) throw new Error('Key missing');
        const s = document.createElement('script');
        s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=geometry,visualization&loading=async&callback=initApp`;
        s.async = true;
        s.defer = true;
        document.head.appendChild(s);
    } catch (e) {
        console.error('Failed to load Google Maps', e);
        document.getElementById('map-loader').innerHTML = '<p class="text-rose-500 font-bold">Failed to load map API</p>';
    }
}

function initApp() {
    map = new google.maps.Map(document.getElementById('suburb-map'), {
        center: { lat: -37.8136, lng: 144.9631 },
        zoom: 10,
        disableDefaultUI: true,
        zoomControl: true,
        styles: [
            { elementType: "geometry", stylers: [{ color: "#f5f5f5" }] },
            { elementType: "labels.icon", stylers: [{ visibility: "off" }] },
            { elementType: "labels.text.fill", stylers: [{ color: "#616161" }] },
            { elementType: "labels.text.stroke", stylers: [{ color: "#f5f5f5" }] },
            { featureType: "administrative.land_parcel", elementType: "labels.text.fill", stylers: [{ color: "#bdbdbd" }] },
            { featureType: "poi", elementType: "geometry", stylers: [{ color: "#eeeeee" }] },
            { featureType: "poi", elementType: "labels.text.fill", stylers: [{ color: "#757575" }] },
            { featureType: "road", elementType: "geometry", stylers: [{ color: "#ffffff" }] },
            { featureType: "road.arterial", elementType: "labels.text.fill", stylers: [{ color: "#757575" }] },
            { featureType: "road.highway", elementType: "geometry", stylers: [{ color: "#dadada" }] },
            { featureType: "road.highway", elementType: "labels.text.fill", stylers: [{ color: "#616161" }] },
            { featureType: "water", elementType: "geometry", stylers: [{ color: "#e9e9e9" }] },
            { featureType: "water", elementType: "labels.text.fill", stylers: [{ color: "#9e9e9e" }] }
        ]
    });

    loadData();
}

function loadData() {
    // 1. Load CSV
    Papa.parse('suburb_regions_ratings_google_api_centre_final.csv', {
        download: true,
        header: true,
        dynamicTyping: true,
        complete: function (results) {
            const data = results.data;

            data.forEach(row => {
                if (!row.Suburb || !row.Region) return;

                const suburbUpper = row.Suburb.toUpperCase();
                csvData[suburbUpper] = {
                    region: row.Region,
                    rating: row.Rating || 0,
                    name: row.Suburb
                };

                if (!regions[row.Region]) regions[row.Region] = [];
                regions[row.Region].push(csvData[suburbUpper]);
            });

            // Load GeoJSON
            map.data.loadGeoJson('vic.geojson', null, function (features) {
                // Done loading
                document.getElementById('map-loader').style.opacity = '0';
                setTimeout(() => document.getElementById('map-loader').remove(), 300);

                renderTabs();
                setupMapStyle();
                setRegion(currentRegion);
                if (window.lucide) {
                    lucide.createIcons();
                }
            });
        }
    });
}

function renderTabs() {
    const container = document.getElementById('region-tabs');
    container.innerHTML = '';

    Object.keys(regions).sort().forEach(region => {
        const btn = document.createElement('button');
        btn.className = `px-3 py-1.5 text-[11px] font-bold rounded-full transition-colors border`;
        if (region === currentRegion) {
            btn.classList.add('bg-[#004071]', 'text-white', 'border-[#004071]');
        } else {
            btn.classList.add('bg-white', 'text-slate-600', 'border-slate-200', 'hover:bg-slate-50');
        }
        btn.innerText = region;
        btn.onclick = () => setRegion(region);
        container.appendChild(btn);
    });
}

function setRegion(region) {
    currentRegion = region;
    renderTabs();

    // Sort and render leaderboard
    const list = regions[region].sort((a, b) => b.rating - a.rating).slice(0, 10);
    const container = document.getElementById('leaderboard-list');
    container.innerHTML = '';

    list.forEach((sub, index) => {
        const div = document.createElement('div');
        div.className = 'flex items-center justify-between p-3 bg-white border border-slate-100 rounded-lg shadow-sm';
        div.innerHTML = `
            <div class="flex items-center gap-3">
                <div class="w-6 h-6 rounded-full bg-slate-100 flex items-center justify-center text-[10px] font-black text-slate-500">${index + 1}</div>
                <div class="font-bold text-sm text-slate-800">${sub.name}</div>
            </div>
            <div class="font-black text-lg" style="color: ${getColor(region, sub.rating)}">${sub.rating.toFixed(1)}</div>
        `;
        container.appendChild(div);
    });

}

function setupMapStyle() {
    infoWindow = new google.maps.InfoWindow();

    // Style the map
    map.data.setStyle(function (feature) {
        const suburbName = feature.getProperty('vic_loca_2');
        const data = csvData[suburbName];

        if (!data) {
            return {
                fillColor: '#cccccc',
                fillOpacity: 0.1,
                strokeWeight: 0.5,
                strokeColor: '#e0e0e0',
                clickable: false
            };
        }

        return {
            fillColor: getColor(data.region, data.rating),
            fillOpacity: 0.7,
            strokeWeight: 1,
            strokeColor: '#ffffff',
            clickable: true
        };
    });

    // Setup hover and click effect
    google.maps.event.clearListeners(map.data, 'mouseover');
    google.maps.event.clearListeners(map.data, 'mouseout');
    google.maps.event.clearListeners(map.data, 'click');

    map.data.addListener('mouseover', function (event) {
        const suburbName = event.feature.getProperty('vic_loca_2');
        if (csvData[suburbName]) {
            map.data.overrideStyle(event.feature, { fillOpacity: 0.9, strokeWeight: 2 });
        }
    });

    map.data.addListener('mouseout', function (event) {
        map.data.revertStyle();
    });

    map.data.addListener('click', function (event) {
        const suburbName = event.feature.getProperty('vic_loca_2');
        const data = csvData[suburbName];
        if (data) {
            const content = `
                <div style="padding: 4px; min-width: 120px; font-family: 'Inter', sans-serif;">
                    <div style="font-size: 14px; font-weight: 800; margin-bottom: 4px; color: #1e293b;">${data.name}</div>
                    <div style="font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; color: #64748b; margin-bottom: 8px;">${data.region}</div>
                    <div style="font-size: 18px; font-weight: 900; color: ${getColor(data.region, data.rating)}">
                        ${data.rating.toFixed(1)} <span style="font-size: 10px; color: #94a3b8; font-weight: 700; text-transform: uppercase;">/ 10</span>
                    </div>
                </div>
            `;
            infoWindow.setContent(content);
            infoWindow.setPosition(event.latLng);
            infoWindow.open(map);
        }
    });
}

// Start
window.onload = loadGoogleMaps;
