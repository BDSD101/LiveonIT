function showView(view) {
  if (view === 'home') {
    document.getElementById('view-home').classList.remove('hidden-view');
    document.getElementById('view-about').classList.add('hidden-view');
  } else {
    document.getElementById('view-home').classList.add('hidden-view');
    document.getElementById('view-about').classList.remove('hidden-view');
    window.scrollTo(0, 0);
  }
  lucide.createIcons();
}

const CONFIG = {
  categories: [
    {
      id: 'health', label: 'Health Services', color: '#89bee8', icon: 'heart-pulse', services: [
        { id: 'doctor', label: 'Doctor / GP', type: 'doctor', icon: 'stethoscope' },
        { id: 'pharmacy', label: 'Pharmacy', type: 'pharmacy', icon: 'pill' },
        { id: 'hospital', label: 'Hospital', type: 'hospital', icon: 'hospital' },
        { id: 'gym', label: 'Gym / Fitness', type: 'gym', icon: 'dumbbell' },
        { id: 'dentist', label: 'Dentist', type: 'dentist', icon: 'smile' }
      ]
    },
    {
      id: 'food', label: 'Food and Essentials', color: '#b39dcb', icon: 'shopping-basket', services: [
        { id: 'supermarket', label: 'Supermarket', type: 'supermarket', icon: 'shopping-cart' },
        { id: 'bakery', label: 'Bakery', type: 'bakery', icon: 'croissant' },
        { id: 'convenience', label: 'Convenience', type: 'convenience_store', icon: 'store' },
        { id: 'shopping', label: 'General Shopping', type: 'shopping_mall', icon: 'shopping-bag' } // replaced bag-shopping to shopping-bag
      ]
    },
    {
      id: 'connectivity', label: 'Connectivity', color: '#f07f9d', icon: 'bus-front', services: [
        { id: 'train', label: 'Train Station', type: 'train_station', icon: 'train-front' },
        { id: 'bus', label: 'Bus / Tram Stop', type: 'transit_station', icon: 'bus-front' }, // bus_stop and bus_station removed because too noisy
        { id: 'post', label: 'Post Office', type: 'mailing_service', icon: 'mail' }, // post_office -> mailing_service
        { id: 'bank', label: 'Bank', type: 'bank', icon: 'landmark' }
      ]
    },
    {
      id: 'parks', label: 'Parks and Nature', color: '#a5d17c', icon: 'trees', services: [
        { id: 'park', label: 'Parks', type: 'park', icon: 'trees' },
        { id: 'cafe', label: 'Cafe', type: 'cafe', icon: 'coffee' },
        { id: 'restaurant', label: 'Restaurant', type: 'restaurant', icon: 'utensils' },
        { id: 'community', label: 'Community Centre', type: 'community_center', icon: 'users' },
        { id: 'school', label: 'Education', type: 'school', icon: 'graduation-cap' }
      ]
    }
  ]
};

let map, marker, radiusCircle, debounceTimer, currentPos;
let serviceMarkers = [], servicePolylines = [];
let selectedServices = new Set(['doctor', 'supermarket', 'train', 'park']);
let openCategories = new Set();
let history = JSON.parse(sessionStorage.getItem('history') || '[]');
let leaderboardData = null;

async function loadGoogleMaps() {
  try {
    const res = await fetch('/api/config');
    if (!res.ok) throw new Error('Google Maps configuration unavailable');
    const { key } = await res.json();
    if (!key) throw new Error('Google Maps key missing');
    const script = document.createElement('script');

    // script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=geometry,places,visualization`;
    // script.onload = initApp;
    script.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=geometry,places,visualization&loading=async&callback=initApp`;
    script.async = true;
    script.defer = true;

    document.head.appendChild(script);
  } catch (e) {
    console.error('Failed to load config', e);
    document.getElementById('score-desc').textContent = 'Unable to initialize maps. Please check API configuration.';
  }
}

function initApp() {
  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: -37.8136, lng: 144.9631 },
    zoom: 12,
    disableDefaultUI: true,
    zoomControl: true,
    styles: [{ featureType: "poi", elementType: "labels", stylers: [{ visibility: "off" }] }]
  });
  renderFilters();
  renderHistory();
  // fetchLeaderboard();
  lucide.createIcons();
}

async function fetchLeaderboard() {
  try {
    const res = await fetch('/api/leaderboard');
    if (!res.ok) throw new Error('Failed to fetch leaderboard');
    leaderboardData = await res.json();
    switchLeaderboard('inner');
  } catch (e) { console.error('Failed to load leaderboard', e); }
}

function switchLeaderboard(category) {
  if (!leaderboardData) return;

  ['inner', 'middle', 'outer'].forEach(id => {
    const btn = document.getElementById(`tab-${id}`);
    if (id === category) {
      btn.className = "px-3 py-2 text-[10px] font-bold uppercase tracking-tighter border-b-2 border-[#004071] text-[#004071] whitespace-nowrap";
    } else {
      btn.className = "px-3 py-2 text-[10px] font-bold uppercase tracking-tighter border-b-2 border-transparent text-slate-400 hover:text-slate-600 whitespace-nowrap";
    }
  });

  const container = document.getElementById('leaderboard-list');
  container.innerHTML = '';
  const rows = Array.isArray(leaderboardData[category]) ? leaderboardData[category] : [];
  if (!rows.length) {
    container.innerHTML = '<p class="text-center py-4 text-slate-400 text-xs font-inter">No rankings available</p>';
    return;
  }

  rows.forEach(suburb => {
    const div = document.createElement('div');
    div.className = "flex items-center justify-between p-2 rounded-lg bg-slate-50 border border-slate-100 transition-all hover:border-[#004071]";
    div.innerHTML = `
      <div class="flex items-center gap-3">
        <span class="w-5 h-5 rounded-full bg-slate-200 text-slate-600 flex items-center justify-center text-[10px] font-black font-inter">${suburb.rank}</span>
        <span class="text-xs font-bold text-slate-700">${suburb.name}</span>
      </div>
      <span class="text-[11px] font-black text-[#004071] font-inter bg-blue-50 px-2 py-0.5 rounded-full">${suburb.score.toFixed(1)}</span>
    `;
    container.appendChild(div);
  });
}

function formatDistance(meters) {
  if (typeof meters !== 'number' || !Number.isFinite(meters)) return 'n/a';
  if (meters >= 1000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters)} m`;
}

function getScoreDescription(index, breakdown) {
  const met = breakdown?.summary?.categoriesMetWithin800m;
  const total = breakdown?.summary?.totalCategories;
  if (typeof met === 'number' && typeof total === 'number') {
    return `${met}/${total} core categories are within 800m walking distance.`;
  }
  if (index >= 8) return 'Exceptional 20-min neighbourhood.';
  if (index >= 5) return 'Strong liveability with minor gaps.';
  return 'Developing infrastructure area.';
}

function renderScoreBreakdown(breakdown) {
  const container = document.getElementById('score-breakdown');
  const thresholdNote = document.getElementById('score-threshold-note');
  if (!breakdown || !Array.isArray(breakdown.categories)) {
    container.innerHTML = '<p class="text-xs text-slate-400 text-center">Score breakdown unavailable.</p>';
    thresholdNote.textContent = 'Threshold: 800m walking distance';
    return;
  }

  thresholdNote.textContent = `Threshold: ${breakdown.walkableThresholdMeters || 800}m walking distance`;
  container.innerHTML = '';

  breakdown.categories
    .sort((a, b) => b.weight - a.weight)
    .slice(0, 3)
    .forEach(cat => {
      const statusLabel = cat.status === 'met' ? 'Within 800m' : (cat.status === 'partial' ? 'Over limit' : 'Missing');
      const nearest = cat.nearestService?.name || 'No nearby match';
      const distance = cat.walkingDistanceMeters == null ? '—' : formatDistance(cat.walkingDistanceMeters);
      const duration = cat.walkingDurationMinutes == null ? '' : ` • ${cat.walkingDurationMinutes} min`;

      const statusClass = cat.status === 'met'
        ? 'text-emerald-700 bg-emerald-50 border-emerald-100'
        : (cat.status === 'partial'
          ? 'text-amber-700 bg-amber-50 border-amber-100'
          : 'text-rose-700 bg-rose-50 border-rose-100');

      const row = document.createElement('div');
      row.className = 'p-2 rounded-lg border border-slate-100 bg-slate-50';
      row.innerHTML = `
      <div class="flex items-center justify-between gap-2">
        <span class="text-[11px] font-bold text-slate-700">${cat.label}</span>
        <span class="text-[10px] px-1.5 py-0.5 rounded-full border font-bold ${statusClass}">${statusLabel}</span>
      </div>
      <div class="mt-1 text-[11px] text-slate-500 leading-tight">${nearest}</div>
      <div class="text-[10px] text-slate-400">${distance}${duration}</div>
    `;
      container.appendChild(row);
    });
}

function showAlert(serviceName, distance) {
  const container = document.getElementById('alert-container');
  const div = document.createElement('div');
  div.className = "bg-white/95 backdrop-blur-sm border-l-4 border-amber-500 p-3 rounded-lg shadow-xl flex items-start gap-3 pointer-events-auto transform translate-x-8 opacity-0 transition-all duration-300";
  div.innerHTML = `
    <div class="mt-0.5"><i data-lucide="alert-triangle" class="w-4 h-4 text-amber-500"></i></div>
    <div class="flex-1">
      <div class="text-[9px] font-black text-amber-600 uppercase tracking-widest mb-0.5">Limit Exceeded</div>
      <div class="text-[11px] font-bold text-slate-800 leading-tight">${serviceName} is ${formatDistance(distance)} away</div>
    </div>
    <button onclick="this.parentElement.remove()" class="text-slate-300 hover:text-slate-500 transition-colors"><i data-lucide="x" class="w-3 h-3"></i></button>
  `;
  container.appendChild(div);
  lucide.createIcons();

  setTimeout(() => {
    div.classList.remove('translate-x-8', 'opacity-0');
  }, 10);

  setTimeout(() => {
    if (div.parentElement) {
      div.classList.add('opacity-0', 'scale-95');
      setTimeout(() => div.remove(), 300);
    }
  }, 6000);
}

function renderFilters() {
  const container = document.getElementById('filter-container');
  container.innerHTML = '';
  CONFIG.categories.forEach(cat => {
    const isOpen = openCategories.has(cat.id);
    const group = document.createElement('div');
    group.className = "border border-slate-100 rounded-lg overflow-hidden mb-1";
    const header = document.createElement('div');
    header.className = "flex items-center justify-between p-3 bg-slate-50 cursor-pointer hover:bg-slate-100 transition-colors";
    header.innerHTML = `
      <div class="flex items-center gap-2">
        <i data-lucide="${cat.icon}" class="w-4 h-4" style="color:${cat.color}"></i>
        <span class="text-xs font-bold uppercase tracking-tight text-slate-700">${cat.label}</span>
      </div>
      <i data-lucide="chevron-down" class="w-3 h-3 text-slate-400 transition-transform duration-200" style="transform: ${isOpen ? 'rotate(180deg)' : 'rotate(0deg)'}"></i>
    `;

    const list = document.createElement('div');
    list.className = `${isOpen ? '' : 'hidden'} p-2 space-y-1 bg-white border-t border-slate-50`;
    header.onclick = () => {
      if (openCategories.has(cat.id)) openCategories.delete(cat.id);
      else openCategories.add(cat.id);
      renderFilters();
    };

    cat.services.forEach(svc => {
      const item = document.createElement('div');
      item.className = "flex items-center justify-between p-2 rounded-md cursor-pointer hover:bg-slate-50 transition-colors group";
      const isChecked = selectedServices.has(svc.id);
      item.innerHTML = `<div class="flex items-center gap-2"><i data-lucide="${svc.icon}" class="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600"></i><span class="text-[13px] font-medium text-slate-600">${svc.label}</span></div><div id="check-${svc.id}" class="w-4 h-4 rounded border transition-all flex items-center justify-center ${isChecked ? 'border-transparent' : 'border-slate-300'}" style="background:${isChecked ? cat.color : 'transparent'}"><i data-lucide="check" class="w-2.5 h-2.5 text-white ${isChecked ? '' : 'hidden'}"></i></div>`;
      item.onclick = (e) => {
        e.stopPropagation();
        if (selectedServices.has(svc.id)) selectedServices.delete(svc.id);
        else selectedServices.add(svc.id);
        renderFilters();
        if (currentPos) loadServices(currentPos.lat, currentPos.lng);
      };
      list.appendChild(item);
    });
    group.appendChild(header);
    group.appendChild(list);
    container.appendChild(group);
  });
  lucide.createIcons();
}

function renderHistory() {
  const list = document.getElementById('history-list');
  if (!history.length) return;
  list.innerHTML = '';
  history.forEach(item => {
    const div = document.createElement('div');
    div.className = "p-3 bg-slate-50 border border-slate-100 rounded-lg cursor-pointer hover:border-[#004071] hover:bg-white transition-all group flex items-center gap-3";
    div.innerHTML = `<i data-lucide="map-pin" class="w-4 h-4 text-slate-400 group-hover:text-[#004071]"></i><span class="text-xs font-semibold text-slate-600 truncate">${item.display_name}</span>`;
    div.onclick = () => select(item, false);
    list.appendChild(div);
  });
  lucide.createIcons();
}

document.getElementById('query').addEventListener('input', (e) => {
  clearTimeout(debounceTimer);
  const q = e.target.value.trim();
  if (q.length < 3) { document.getElementById('results').classList.add('hidden'); return; }
  debounceTimer = setTimeout(() => search(q), 400);
});

async function search(q) {
  const list = document.getElementById('results');
  list.classList.remove('hidden');
  list.innerHTML = '<li class="p-4 text-slate-400 text-sm italic">Searching...</li>';
  const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  list.innerHTML = '';
  if (!data.length) { list.innerHTML = '<li class="p-4 text-slate-400 text-sm">No results found</li>'; return; }
  data.forEach(item => {
    const li = document.createElement('li');
    li.textContent = item.display_name;
    li.className = "p-4 cursor-pointer hover:bg-slate-50 text-sm font-medium transition-colors";
    li.onclick = () => select(item);
    list.appendChild(li);
  });
}

function select(item, updateHistory = true) {
  currentPos = { lat: parseFloat(item.lat), lng: parseFloat(item.lon) };
  document.getElementById('query').value = item.display_name;
  document.getElementById('results').classList.add('hidden');
  map.panTo(currentPos);
  map.setZoom(15);
  if (marker) marker.setMap(null);
  marker = new google.maps.Marker({ position: currentPos, map: map, icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: '#c0392b', fillOpacity: 1, strokeWeight: 2, strokeColor: '#fff', scale: 8 } });
  if (radiusCircle) radiusCircle.setMap(null);
  radiusCircle = new google.maps.Circle({ strokeColor: '#004071', strokeOpacity: 0.1, strokeWeight: 1, fillColor: '#004071', fillOpacity: 0.05, map: map, center: currentPos, radius: 800 });
  if (updateHistory) {
    history = [item, ...history.filter(i => i.display_name !== item.display_name)].slice(0, 5);
    sessionStorage.setItem('history', JSON.stringify(history));
    renderHistory();
  }
  loadServices(currentPos.lat, currentPos.lng);
}

async function loadServices(lat, lon) {
  serviceMarkers.forEach(m => m.setMap(null));
  servicePolylines.forEach(p => p.setMap(null));
  serviceMarkers = []; servicePolylines = [];
  document.getElementById('alert-container').innerHTML = '';

  const bar = document.getElementById('progress-bar');
  bar.style.opacity = '1'; bar.style.width = '30%';
  const allSvc = CONFIG.categories.flatMap(c => c.services.map(s => ({ ...s, catColor: c.color, catId: c.id })));
  const types = Array.from(selectedServices).map(id => {
    const s = allSvc.find(s => s.id === id);
    return s ? `${s.catId}:${s.type}` : null;
  }).filter(Boolean);

  if (!types.length) {
    document.getElementById('score-value').textContent = '--';
    document.getElementById('score-bar').style.width = '0%';
    document.getElementById('score-desc').textContent = 'Select at least one service filter to run analysis.';
    renderScoreBreakdown(null);
    bar.style.opacity = '0';
    return;
  }
  try {
    const res = await fetch(`/api/nearby-services?lat=${lat}&lon=${lon}&types=${types.join(',')}`);
    if (!res.ok) throw new Error('Failed to load nearby services');
    const data = await res.json();
    const services = Array.isArray(data.services) ? data.services : [];
    const index = Number(data.index || 0);
    document.getElementById('score-value').textContent = index.toFixed(1);
    document.getElementById('score-bar').style.width = (index * 10) + '%';
    document.getElementById('score-desc').textContent = getScoreDescription(index, data.breakdown);
    renderScoreBreakdown(data.breakdown);
    bar.style.width = '70%';
    // Only draw route to nearest service per type
    const nearestPerType = Object.values(
      services.reduce((acc, s) => {
        if (!acc[s.type] || s.walkingDistanceMeters < acc[s.type].walkingDistanceMeters) {
          acc[s.type] = s;
        }
        return acc;
      }, {})
    );

    nearestPerType.forEach(async (s) => {
      const svcConf = allSvc.find(conf => conf.type === s.type && conf.catId === s.catId) || { catColor: '#64748b', label: s.type };
      if (typeof s.walkingDistanceMeters === 'number' && s.walkingDistanceMeters > 800) {
        showAlert(svcConf.label, s.walkingDistanceMeters);
      }
      const m = new google.maps.Marker({ position: { lat: s.lat, lng: s.lon }, map: map, icon: { path: "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z", fillColor: svcConf.catColor, fillOpacity: 1, strokeWeight: 2, strokeColor: "#FFFFFF", scale: 1.5, anchor: new google.maps.Point(12, 22) }, title: s.name });
      const distanceLabel = typeof s.walkingDistanceMeters === 'number' ? `${formatDistance(s.walkingDistanceMeters)} walk` : 'Walk distance unavailable';
      const durationLabel = typeof s.walkingDurationMinutes === 'number' ? `${s.walkingDurationMinutes} min` : '';
      const infoWindow = new google.maps.InfoWindow({ content: `<div class="p-2 font-inter"><div class="text-[10px] font-bold uppercase tracking-widest mb-1" style="color:${svcConf.catColor}">${svcConf.label}</div><div class="text-sm font-bold">${s.name}</div><div class="text-[11px] text-slate-500 mt-1">${distanceLabel}${durationLabel ? ` • ${durationLabel}` : ''}</div></div>` });
      m.addListener('click', () => infoWindow.open(map, m));
      serviceMarkers.push(m);

      try {
        const rRes = await fetch(`/api/route?sLat=${lat}&sLon=${lon}&eLat=${s.lat}&eLon=${s.lon}`);
        if (!rRes.ok) return;
        const rData = await rRes.json();
        if (!rData.polyline) return;

        const path = google.maps.geometry.encoding.decodePath(rData.polyline);
        // Debugging logs for route decoding
        // console.log('path length:', path.length);
        // console.log('decoded path:', path);
        const polyline = new google.maps.Polyline({ path: [], geodesic: true, strokeColor: svcConf.catColor, strokeOpacity: 0.7, strokeWeight: 4, map: map });
        // testing a fixed color for all routes to rule out styling issues
        servicePolylines.push(polyline);
        let step = 0; const numSteps = 40;
        const interval = setInterval(() => { step++; const fraction = step / numSteps; polyline.setPath(path.slice(0, Math.ceil(fraction * path.length))); if (step >= numSteps) clearInterval(interval); }, 25);
      } catch (routeError) {
        console.error('Failed to load route', routeError);
      }
    });

    bar.style.width = '100%'; setTimeout(() => { bar.style.opacity = '0'; bar.style.width = '0'; }, 600);
  } catch (e) {
    console.error(e);
    bar.style.opacity = '0';
    document.getElementById('score-desc').textContent = 'Liveability analysis failed. Please try again.';
    renderScoreBreakdown(null);
  }
}

window.onload = loadGoogleMaps;
