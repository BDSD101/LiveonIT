// Determine API URL based on environment
const API_URL = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:3000'
  : 'https://qchhoyc9a9.execute-api.ap-southeast-2.amazonaws.com/prod';

const root = getComputedStyle(document.body);

const CONFIG = {
  categories: [
    {
      id: 'health', label: 'Health Services', color: root.getPropertyValue('--colour-health'), icon: 'heart-pulse', services: [
        { id: 'doctor', label: 'Doctor / GP', type: 'doctor', icon: 'stethoscope' },
        { id: 'pharmacy', label: 'Pharmacy', type: 'pharmacy', icon: 'pill' },
        { id: 'dentist', label: 'Dentist', type: 'dentist', icon: 'smile' },
        { id: 'gym', label: 'Gym / Fitness', type: 'gym', icon: 'dumbbell' },
      ]
    },
    {
      id: 'food', label: 'Food and Essentials', color: root.getPropertyValue('--colour-food'), icon: 'shopping-basket', services: [
        { id: 'supermarket', label: 'Supermarket', type: 'supermarket', icon: 'shopping-cart' },
        { id: 'bakery', label: 'Bakery', type: 'bakery', icon: 'croissant' },
        { id: 'convenience', label: 'Convenience', type: 'convenience_store', icon: 'store' },
        { id: 'shopping', label: 'General Shopping', type: 'shopping_mall', icon: 'shopping-bag' },
      ]
    },
    {
      id: 'connectivity', label: 'Connectivity', color: root.getPropertyValue('--colour-connectivity'), icon: 'bus-front', services: [
        { id: 'train', label: 'Train Station', type: 'train_station', icon: 'train-front' },
        { id: 'bus', label: 'Bus / Tram Stop', type: 'transit_station', icon: 'bus-front' },
      ]
    },
    {
      id: 'parks', label: 'Parks and Nature', color: root.getPropertyValue('--colour-parks'), icon: 'trees', services: [
        { id: 'park', label: 'Parks', type: 'park', icon: 'trees' },
      ]
    },
    {
      id: 'dining', label: 'Dining and Social', color: root.getPropertyValue('--colour-dining'), icon: 'utensils', services: [
        { id: 'cafe', label: 'Cafe', type: 'cafe', icon: 'coffee' },
        { id: 'restaurant', label: 'Restaurant', type: 'restaurant', icon: 'utensils' },
        { id: 'bar', label: 'Bar / Pub', type: 'bar', icon: 'beer' },
      ]
    },
    {
      id: 'education', label: 'Education', color: root.getPropertyValue('--colour-education'), icon: 'school', services: [
        { id: 'childcare', label: 'Childcare', type: 'childcare', icon: 'baby' },
        { id: 'kindergarten', label: 'Kindergarten', type: 'kindergarten', icon: 'blocks' },
        { id: 'primary', label: 'Primary School', type: 'primary_school', icon: 'school' },
        { id: 'secondary', label: 'Secondary School', type: 'secondary_school', icon: 'school' },
        { id: 'library', label: 'Library', type: 'library', icon: 'book' },
      ]
    },
    {
      id: 'other', label: 'Other Services', color: root.getPropertyValue('--colour-other'), icon: 'users', services: [
        { id: 'community', label: 'Community Centre', type: 'community', icon: 'users' },
        { id: 'post', label: 'Post Office', type: 'post_office', icon: 'mail' },
        { id: 'bank', label: 'Bank', type: 'bank', icon: 'landmark' },
        { id: 'atm', label: 'ATM', type: 'atm', icon: 'credit-card' },
      ]
    }
  ]
};

// ── State ──
let map, marker, radiusCircle, debounceTimer, serviceDebounce, currentPos, currentAddress = '';
let serviceMarkers = [], servicePolylines = [];
let selectedServices = new Set(['doctor', 'supermarket', 'train', 'bus', 'park']);
let openCategories = new Set(['health', 'food', 'connectivity', 'parks']);
let history = JSON.parse(sessionStorage.getItem('history') || '[]');
let lastScore = null;
let _loadSeq = 0; // incremented each call; stale responses are dropped
let _rescoring = false;
let lastTypes = [];

// ── Google Maps bootstrap ──
async function loadGoogleMaps() {
  try {
    const res = await fetch(`${API_URL}/api/config`);
    if (!res.ok) throw new Error('Config unavailable');
    const { key } = await res.json();
    if (!key) throw new Error('Key missing');
    const s = document.createElement('script');
    s.src = `https://maps.googleapis.com/maps/api/js?key=${key}&libraries=geometry,places,visualization,marker&loading=async&callback=initApp`;
    s.async = true;
    s.defer = true;
    document.head.appendChild(s);
  } catch (e) {
    console.error('Failed to load config', e);
    document.getElementById('score-desc').textContent = 'Unable to initialise maps.';
  }
}

function initApp() {
  map = new google.maps.Map(document.getElementById('map'), {
    center: { lat: -37.8136, lng: 144.9631 },
    zoom: 12,
    disableDefaultUI: true,
    zoomControl: true,
    styles: [{ featureType: 'poi', elementType: 'labels', stylers: [{ visibility: 'off' }] }]
  });
  renderFilters();
  renderHistory();
  document.getElementById('select-all-btn').addEventListener('click', selectAllServices);
  document.getElementById('clear-all-btn').addEventListener('click', clearAllServices);
  lucide.createIcons();
  checkUrlParams();
}

// ── Helpers ──
function formatDistance(m) {
  if (typeof m !== 'number' || !Number.isFinite(m)) return 'n/a';
  return m >= 1000 ? `${(m / 1000).toFixed(1)} km` : `${Math.round(m)} m`;
}

function getScoreColor(score) {
  if (score >= 7.5) return { text: 'text-emerald-600', barBg: 'bg-emerald-500', light: 'bg-emerald-50', border: 'border-emerald-100' };
  if (score >= 5.0) return { text: 'text-amber-600', barBg: 'bg-amber-500', light: 'bg-amber-50', border: 'border-amber-100' };
  return { text: 'text-rose-600', barBg: 'bg-rose-500', light: 'bg-rose-50', border: 'border-rose-100' };
}

function getScoreLabel(score) {
  if (score >= 8.5) return 'Excellent';
  if (score >= 7.0) return 'Very Good';
  if (score >= 5.5) return 'Good';
  if (score >= 4.0) return 'Fair';
  if (score >= 2.5) return 'Below Average';
  return 'Poor';
}

function getScoreDescription(score, walkability) {
  if (!walkability) {
    if (score >= 8) return 'Exceptional walkable neighbourhood.';
    if (score >= 5) return 'Good liveability with some gaps.';
    return 'Limited walkable services.';
  }
  const s = walkability.selection;
  const suburb = walkability.suburb;
  const parts = [];

  if (s.nearest.score >= 7) parts.push('most selected services are close by');
  else if (s.nearest.score >= 4) parts.push('some services within walking distance');
  else parts.push('key services are hard to reach on foot');

  if (s.abundance.score >= 7) parts.push('good variety');
  else if (s.abundance.score < 3) parts.push('limited choice');

  if (suburb?.crimeScore !== null && suburb.crimeScore >= 7) parts.push('safe area');
  if (suburb?.housePriceScore !== null && suburb.housePriceScore >= 7) parts.push('affordable');

  return `${getScoreLabel(score)} - ${parts.join(', ')}.`;
}

// ── Score breakdown ──
function renderWalkabilityBreakdown(walkability) {
  const container = document.getElementById('score-breakdown');
  const note = document.getElementById('score-threshold-note');

  if (!walkability) {
    container.innerHTML = '<p class="text-xs text-slate-400 text-center">Search an address to see breakdown.</p>';
    note.textContent = 'Based on your selected services';
    return;
  }

  const s = walkability.selection;
  const suburb = walkability.suburb;
  note.textContent = 'Based on your selected services · 800 m threshold';
  container.innerHTML = '';

  function tag(score, thresholds) {
    if (score === null || score === undefined) return 'No data available';
    for (const [min, label] of thresholds) { if (score >= min) return label; }
    return thresholds[thresholds.length - 1][1];
  }

  const components = [
    {
      label: 'Closest Services',
      icon: 'map-pin',
      score: s.nearest.score,
      weight: 85,
      tagText: tag(s.nearest.score, [[8, 'Almost everything nearby'], [6, 'Most essentials within reach'], [4, 'Some services nearby'], [2, 'Limited access'], [0, 'Most services too far']]),
      tooltip: 'How close is the nearest of each selected service? Services within 800 m add to your score; services outside the circle subtract from it.',
    },
    {
      label: 'Errand Walk',
      icon: 'route',
      score: s.errandTrip.score,
      weight: 5,
      tagText: tag(s.errandTrip.score, [[8, 'Quick loop on foot'], [5, 'Walkable with some effort'], [2, 'Long walk needed'], [0, 'Not practical on foot']]),
      tooltip: 'Could you walk a single loop from home through your regular services and back? Shorter, more efficient loops score higher.',
    },
    {
      label: 'Choice & Variety',
      icon: 'layers',
      score: s.abundance.score,
      weight: 5,
      tagText: tag(s.abundance.score, [[8, 'Lots of choice'], [5, 'Decent variety'], [2, 'Limited options'], [0, 'Very few options']]),
      tooltip: 'Are there multiple options nearby? Having 3 or more of a selected service within walking distance means great choice.',
    },
    {
      label: 'Housing Cost',
      icon: 'home',
      score: suburb?.housePriceScore ?? null,
      weight: 2.5,
      tagText: suburb?.housePriceScore != null
        ? `${tag(suburb.housePriceScore, [[8, 'Very affordable'], [6, 'Reasonably priced'], [4, 'Moderate pricing'], [0, 'Expensive area']])} · ${suburb.name}`
        : 'No data available',
      tooltip: 'How affordable is housing in this suburb compared to Greater Melbourne? Based on median house and unit prices.',
    },
    {
      label: 'Safety',
      icon: 'shield',
      score: suburb?.crimeScore ?? null,
      weight: 2.5,
      tagText: suburb?.crimeScore != null
        ? `${tag(suburb.crimeScore, [[8, 'Very safe area'], [6, 'Generally safe'], [4, 'Average safety'], [0, 'Higher crime rates']])} · ${suburb.name}`
        : 'No data available',
      tooltip: 'How does this suburb compare on reported crime? Based on Crime Statistics Agency data for the local government area.',
    },
  ];

  components.forEach(comp => {
    const sc = comp.score;
    const has = sc !== null && sc !== undefined;
    const c = has ? getScoreColor(sc) : { text: 'text-slate-400', barBg: 'bg-slate-200', light: 'bg-slate-50', border: 'border-slate-100' };
    const display = has ? sc.toFixed(1) : '-';
    const bar = has ? (sc * 10) : 0;

    const row = document.createElement('div');
    row.className = `p-3 rounded-lg border ${c.border} ${c.light}`;
    row.innerHTML = `
      <div class="flex items-center justify-between gap-2 mb-1.5">
        <div class="flex items-center gap-1.5">
          <i data-lucide="${comp.icon}" class="w-3.5 h-3.5 ${c.text}"></i>
          <span class="text-[11px] font-bold text-slate-700">${comp.label}</span>
          <span class="text-[9px] font-medium text-slate-400">${comp.weight}%</span>
          <span class="tip-wrap relative cursor-help">
            <i data-lucide="info" class="w-3 h-3 text-slate-300 hover:text-slate-500 transition-colors"></i>
            <span class="tip-box absolute z-50 left-1/2 -translate-x-1/2 bottom-full mb-2 w-52 px-3 py-2 text-[10px] leading-relaxed text-white bg-slate-800 rounded-lg shadow-xl font-normal pointer-events-none">
              ${comp.tooltip}
              <span class="absolute left-1/2 -translate-x-1/2 top-full w-0 h-0 border-l-4 border-r-4 border-t-4 border-transparent border-t-slate-800"></span>
            </span>
          </span>
        </div>
        <span class="text-[12px] font-black ${c.text} font-inter">${display}</span>
      </div>
      <div class="h-1 w-full bg-white/60 rounded-full overflow-hidden mb-1.5">
        <div class="h-full ${c.barBg} rounded-full transition-all duration-700" style="width:${bar}%"></div>
      </div>
      <div class="text-[10px] text-slate-500 leading-tight font-medium">${comp.tagText}</div>
    `;
    container.appendChild(row);
  });

  lucide.createIcons();
}

// ── Services Found list ──
function renderServicesFound(services) {
  const container = document.getElementById('services-found-list');
  if (!services || !services.length) {
    container.innerHTML = '<p class="text-center py-6 text-slate-400 text-xs font-inter">No services found for selected filters.</p>';
    return;
  }

  const allSvc = CONFIG.categories.flatMap(c => c.services.map(s => ({ ...s, catColor: c.color, catId: c.id, catLabel: c.label, catIcon: c.icon })));
  const grouped = {};
  services.forEach(s => {
    const conf = allSvc.find(c => c.type === s.type && c.catId === s.catId);
    const catLabel = conf?.catLabel || s.catId;
    const catColor = conf?.catColor || '#64748b';
    const catIcon = conf?.catIcon || 'circle';
    if (!grouped[catLabel]) grouped[catLabel] = { color: catColor, icon: catIcon, items: [] };
    grouped[catLabel].items.push({ ...s, svcLabel: conf?.label });
  });

  container.innerHTML = '';
  const grid = document.createElement('div');
  grid.className = 'grid grid-cols-1 md:grid-cols-2 gap-4';

  Object.entries(grouped).forEach(([catLabel, group]) => {
    const card = document.createElement('div');
    card.className = 'border border-slate-100 rounded-lg p-4 bg-slate-50/50';

    const header = `
      <div class="flex items-center gap-2 mb-3">
        <i data-lucide="${group.icon}" class="w-4 h-4" style="color:${group.color}"></i>
        <span class="text-[11px] font-bold uppercase tracking-widest text-slate-600">${catLabel}</span>
        <span class="text-[10px] text-slate-400 font-inter">${group.items.length} found</span>
      </div>
    `;

    const rows = group.items
      .sort((a, b) => (a.walkingDistanceMeters ?? 99999) - (b.walkingDistanceMeters ?? 99999))
      .map(s => {
        const dist = typeof s.walkingDistanceMeters === 'number' ? formatDistance(s.walkingDistanceMeters) : '-';
        const dur = typeof s.walkingDurationMinutes === 'number' ? `${s.walkingDurationMinutes} min` : '';
        const within = s.withinThreshold;
        const dotColor = within ? 'bg-emerald-400' : (typeof s.walkingDistanceMeters === 'number' ? 'bg-amber-400' : 'bg-slate-300');
        const nameDisplay = s.svcLabel ? `${s.svcLabel} - ${s.name}` : s.name;
        return `
          <div class="flex items-center justify-between py-1.5 border-b border-slate-100 last:border-0">
            <div class="flex items-center gap-2 min-w-0">
              <span class="w-1.5 h-1.5 rounded-full ${dotColor} flex-shrink-0"></span>
              <span class="text-[12px] font-medium text-slate-700 truncate">${nameDisplay}</span>
            </div>
            <span class="text-[10px] text-slate-400 font-inter flex-shrink-0 ml-3">${dist}${dur ? ' · ' + dur : ''}</span>
          </div>
        `;
      }).join('');

    card.innerHTML = header + `<div>${rows}</div>`;
    grid.appendChild(card);
  });

  container.appendChild(grid);
  lucide.createIcons();
}

// ── Alerts ──
function showAlert(serviceName, distance) {
  const container = document.getElementById('alert-container');
  const div = document.createElement('div');
  div.className = 'bg-white/95 backdrop-blur-sm border-l-4 border-amber-500 p-3 rounded-lg shadow-xl flex items-start gap-3 pointer-events-auto transform translate-x-8 opacity-0 transition-all duration-300';
  div.innerHTML = `
    <div class="mt-0.5"><i data-lucide="alert-triangle" class="w-4 h-4 text-amber-500"></i></div>
    <div class="flex-1">
      <div class="text-[9px] font-black text-amber-600 uppercase tracking-widest mb-0.5">Over 800 m</div>
      <div class="text-[11px] font-bold text-slate-800 leading-tight">${serviceName} is ${formatDistance(distance)} away</div>
    </div>
    <button onclick="this.parentElement.remove()" class="text-slate-300 hover:text-slate-500"><i data-lucide="x" class="w-3 h-3"></i></button>
  `;
  container.appendChild(div);
  lucide.createIcons();
  setTimeout(() => div.classList.remove('translate-x-8', 'opacity-0'), 10);
  setTimeout(() => { if (div.parentElement) { div.classList.add('opacity-0', 'scale-95'); setTimeout(() => div.remove(), 300); } }, 6000);
}

// ── Filters ──
function renderFilters() {
  const container = document.getElementById('filter-container');
  container.innerHTML = '';
  CONFIG.categories.forEach(cat => {
    const isOpen = openCategories.has(cat.id);
    const group = document.createElement('div');
    group.className = 'border border-slate-100 rounded-lg overflow-hidden mb-1';

    const header = document.createElement('div');
    header.className = 'flex items-center justify-between p-3 bg-slate-50 cursor-pointer hover:bg-slate-100 transition-colors';
    header.innerHTML = `
      <div class="flex items-center gap-2">
        <i data-lucide="${cat.icon}" class="w-4 h-4" style="color:${cat.color}"></i>
        <span class="text-xs font-bold uppercase tracking-tight text-slate-700">${cat.label}</span>
      </div>
      <i data-lucide="chevron-down" class="w-3 h-3 text-slate-400 transition-transform duration-200" style="transform:${isOpen ? 'rotate(180deg)' : 'rotate(0deg)'}"></i>
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
      item.className = 'flex items-center justify-between p-2 rounded-md cursor-pointer hover:bg-slate-50 transition-colors group';
      const checked = selectedServices.has(svc.id);
      item.innerHTML = `
        <div class="flex items-center gap-2">
          <i data-lucide="${svc.icon}" class="w-3.5 h-3.5 text-slate-400 group-hover:text-slate-600"></i>
          <span class="text-[13px] font-medium text-slate-600">${svc.label}</span>
        </div>
        <div class="w-4 h-4 rounded border transition-all flex items-center justify-center ${checked ? 'border-transparent' : 'border-slate-300'}" style="background:${checked ? cat.color : 'transparent'}">
          <i data-lucide="check" class="w-2.5 h-2.5 text-white ${checked ? '' : 'hidden'}"></i>
        </div>
      `;
      item.onclick = (e) => {
        e.stopPropagation();
        if (selectedServices.has(svc.id)) selectedServices.delete(svc.id);
        else selectedServices.add(svc.id);
        renderFilters();
        clearTimeout(serviceDebounce);
        serviceDebounce = setTimeout(() => {
          if (currentPos) loadServices(currentPos.lat, currentPos.lng);
        }, 150);
      };
      list.appendChild(item);
    });

    group.appendChild(header);
    group.appendChild(list);
    container.appendChild(group);
  });
  lucide.createIcons();
}

// ── History (with scores) ──
function renderHistory() {
  const list = document.getElementById('history-list');
  if (!history.length) {
    list.innerHTML = '<p class="text-center py-4 text-slate-400 text-xs font-inter">No recent searches</p>';
    return;
  }
  list.innerHTML = '';
  history.forEach(item => {
    const hasScore = typeof item.score === 'number';
    const scoreColor = hasScore ? getScoreColor(item.score) : null;

    const div = document.createElement('div');
    div.className = 'p-3 bg-slate-50 border border-slate-100 rounded-lg cursor-pointer hover:border-[#004071] hover:bg-white transition-all group flex items-center gap-3';
    div.innerHTML = `
      <i data-lucide="map-pin" class="w-4 h-4 text-slate-400 group-hover:text-[#004071] flex-shrink-0"></i>
      <div class="flex-1 min-w-0">
        <div class="text-xs font-semibold text-slate-600 truncate">${item.display_name}</div>
      </div>
      ${hasScore ? `<span class="text-[11px] font-black ${scoreColor.text} font-inter flex-shrink-0">${item.score.toFixed(1)}</span>` : ''}
    `;
    div.onclick = () => select(item, false);
    list.appendChild(div);
  });
  lucide.createIcons();
}

// ── Search ──
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
  const res = await fetch(`${API_URL}/api/search?q=${encodeURIComponent(q)}`);
  const data = await res.json();
  list.innerHTML = '';
  if (!data.length) { list.innerHTML = '<li class="p-4 text-slate-400 text-sm">No results found</li>'; return; }
  data.forEach(item => {
    const li = document.createElement('li');
    li.textContent = item.display_name;
    li.className = 'p-4 cursor-pointer hover:bg-slate-50 text-sm font-medium transition-colors';
    li.onclick = () => select(item);
    list.appendChild(li);
  });
}

function select(item, updateHistory = true) {
  currentPos = { lat: parseFloat(item.lat), lng: parseFloat(item.lon) };
  currentAddress = item.display_name || '';
  document.getElementById('query').value = item.display_name;
  document.getElementById('results').classList.add('hidden');
  map.panTo(currentPos);
  map.setZoom(15);

  if (marker) marker.setMap(null);
  marker = new google.maps.Marker({
    position: currentPos, map,
    icon: { path: google.maps.SymbolPath.CIRCLE, fillColor: '#c0392b', fillOpacity: 1, strokeWeight: 2, strokeColor: '#fff', scale: 8 }
  });

  if (radiusCircle) radiusCircle.setMap(null);
  radiusCircle = new google.maps.Circle({
    strokeColor: '#004071', strokeOpacity: 0.1, strokeWeight: 1,
    fillColor: '#004071', fillOpacity: 0.05, map, center: currentPos, radius: 800
  });

  if (updateHistory) {
    lastScore = null;
    history = [{ ...item, score: null }, ...history.filter(i => i.display_name !== item.display_name)].slice(0, 5);
    sessionStorage.setItem('history', JSON.stringify(history));
    renderHistory();
  }

  loadServices(currentPos.lat, currentPos.lng);
}

// ── Progress bar animation ──
let _progressRaf = null;
let _progressVal = 0;
let _progressDone = false;

function _startProgress() {
  _progressDone = false;
  _progressVal = 0;
  const track = document.getElementById('progress-track');
  const bar = document.getElementById('progress-bar');
  const walker = document.getElementById('progress-walker');
  if (bar) { bar.style.transition = 'none'; bar.style.width = '0%'; }
  if (walker) { walker.style.transition = 'none'; walker.style.left = '0'; }
  if (track) track.style.opacity = '1';
  if (_progressRaf) cancelAnimationFrame(_progressRaf);
  function tick() {
    if (_progressDone) return;
    _progressVal += (99 - _progressVal) * 0.004;
    const pct = _progressVal;
    if (bar) bar.style.width = pct + '%';
    if (walker) walker.style.left = pct + '%';
    _progressRaf = requestAnimationFrame(tick);
  }
  _progressRaf = requestAnimationFrame(tick);
}

function _finishProgress() {
  _progressDone = true;
  if (_progressRaf) { cancelAnimationFrame(_progressRaf); _progressRaf = null; }
  const track = document.getElementById('progress-track');
  const bar = document.getElementById('progress-bar');
  const walker = document.getElementById('progress-walker');
  if (bar) { bar.style.transition = 'width 0.35s ease'; bar.style.width = '100%'; }
  if (walker) { walker.style.transition = 'left 0.35s ease'; walker.style.left = '100%'; }
  setTimeout(() => {
    if (track) track.style.opacity = '0';
    setTimeout(() => {
      if (bar) { bar.style.transition = 'none'; bar.style.width = '0%'; }
      if (walker) { walker.style.transition = 'none'; walker.style.left = '0%'; }
    }, 400);
  }, 450);
}

function _cancelProgress() {
  _progressDone = true;
  if (_progressRaf) { cancelAnimationFrame(_progressRaf); _progressRaf = null; }
  const track = document.getElementById('progress-track');
  if (track) track.style.opacity = '0';
}

function clearHistory() {
  history = [];
  sessionStorage.removeItem('history');
  renderHistory();
}

// ── Re-score other history entries (called manually via button) ──
async function _doRescoreHistory(types) {
  const others = history.filter(h => h.display_name !== currentAddress && h.lat && h.lon);
  if (!others.length) return;
  const snap = _loadSeq;
  await Promise.all(others.map(async (h) => {
    try {
      const r = await fetch(`${API_URL}/api/nearby-services?lat=${h.lat}&lon=${h.lon}&types=${types.join(',')}&address=${encodeURIComponent(h.display_name)}`);
      if (!r.ok || snap !== _loadSeq) return;
      const d = await r.json();
      if (snap !== _loadSeq) return;
      // const s = d.walkability?.selection?.score ?? Number(d.index || 0);
      const s = d.walkability?.selection?.score ?? 0;
      const idx = history.findIndex(i => i.display_name === h.display_name);
      if (idx !== -1 && typeof s === 'number' && !isNaN(s)) history[idx].score = s;
    } catch { /* silent */ }
  }));
  if (snap === _loadSeq) { sessionStorage.setItem('history', JSON.stringify(history)); renderHistory(); }
}

async function manualRescoreHistory() {
  if (_rescoring || !lastTypes.length) return;
  _rescoring = true;
  const btn = document.getElementById('history-rescore-btn');
  const spinner = document.getElementById('history-spinner-wrap');
  if (btn) btn.classList.add('hidden');
  if (spinner) spinner.classList.remove('hidden');
  await _doRescoreHistory(lastTypes);
  _rescoring = false;
  if (spinner) spinner.classList.add('hidden');
  if (btn) btn.classList.remove('hidden');
}

// ── Select All / Clear All ──
function selectAllServices() {
  const allSvc = CONFIG.categories.flatMap(c => c.services.map(s => s.id));
  allSvc.forEach(id => selectedServices.add(id));
  renderFilters();
  clearTimeout(serviceDebounce);
  serviceDebounce = setTimeout(() => { if (currentPos) loadServices(currentPos.lat, currentPos.lng); }, 150);
}

function clearAllServices() {
  selectedServices.clear();
  renderFilters();
  clearTimeout(serviceDebounce);
  serviceDebounce = setTimeout(() => { if (currentPos) loadServices(currentPos.lat, currentPos.lng); }, 150);
}

// ── Map fullscreen toggle ──
function toggleMapFullscreen() {
  const container = document.getElementById('map').parentElement;
  if (!document.fullscreenElement) {
    container.requestFullscreen().catch(() => { });
  } else {
    document.exitFullscreen();
  }
}

document.addEventListener('fullscreenchange', () => {
  const icon = document.querySelector('#fullscreen-btn i');
  if (!icon) return;
  icon.setAttribute('data-lucide', document.fullscreenElement ? 'minimize' : 'maximize');
  lucide.createIcons();
});

// ── Main analysis ──
async function loadServices(lat, lon) {
  const seq = ++_loadSeq;
  const capturedAddress = currentAddress; // snapshot before any awaits
  serviceMarkers.forEach(m => m.setMap(null));
  servicePolylines.forEach(p => p.setMap(null));
  serviceMarkers = [];
  servicePolylines = [];
  document.getElementById('alert-container').innerHTML = '';

  _startProgress();

  const allSvc = CONFIG.categories.flatMap(c => c.services.map(s => ({ ...s, catColor: c.color, catId: c.id, catLabel: c.label })));
  const types = Array.from(selectedServices).map(id => {
    const s = allSvc.find(sv => sv.id === id);
    return s ? `${s.catId}:${s.type}` : null;
  }).filter(Boolean);
  lastTypes = types;

  if (!types.length) {
    document.getElementById('score-value').textContent = '--';
    document.getElementById('score-value').className = 'text-6xl font-extrabold text-[#004071] mb-1';
    document.getElementById('score-bar').style.width = '0%';
    document.getElementById('score-desc').textContent = 'Select at least one service to see your score.';
    renderWalkabilityBreakdown(null);
    renderServicesFound([]);
    _cancelProgress();
    return;
  }

  try {
    const res = await fetch(`${API_URL}/api/nearby-services?lat=${lat}&lon=${lon}&types=${types.join(',')}&address=${encodeURIComponent(currentAddress)}`);
    if (!res.ok) throw new Error('Failed');
    if (seq !== _loadSeq) { _cancelProgress(); return; } // stale
    const data = await res.json();
    const services = Array.isArray(data.services) ? data.services : [];
    const walkability = data.walkability || null;

    // Use SELECTION score (personalised to user's chosen filters)
    // const score = walkability?.selection?.score ?? Number(data.index || 0);
    const score = walkability?.selection?.score ?? 0;
    const colors = getScoreColor(score);

    document.getElementById('score-value').textContent = score.toFixed(1);
    document.getElementById('score-value').className = `text-5xl font-extrabold mb-1 ${colors.text}`;
    document.getElementById('score-bar').style.width = (score * 10) + '%';
    document.getElementById('score-bar').className = `h-full ${colors.barBg} rounded-full w-0 transition-all duration-1000`;
    document.getElementById('score-desc').textContent = getScoreDescription(score, walkability);

    renderWalkabilityBreakdown(walkability);

    // Update the history entry for this address
    const histIdx = history.findIndex(h => h.display_name === capturedAddress);
    if (capturedAddress && histIdx !== -1) {
      history[histIdx].score = score;
      sessionStorage.setItem('history', JSON.stringify(history));
      renderHistory();
    }


    // Draw routes to nearest per type
    const nearestPerType = Object.values(
      services.reduce((acc, s) => {
        if (!acc[s.type] || s.walkingDistanceMeters < acc[s.type].walkingDistanceMeters) acc[s.type] = s;
        return acc;
      }, {})
    );

    // Render services found (only nearest per type - what's on the map)
    renderServicesFound(nearestPerType);

    nearestPerType.forEach(async (s) => {
      const conf = allSvc.find(c => c.type === s.type && c.catId === s.catId) || { catColor: '#64748b', label: s.type };
      if (typeof s.walkingDistanceMeters === 'number' && s.walkingDistanceMeters > 800) {
        showAlert(conf.label || conf.catLabel, s.walkingDistanceMeters);
      }

      const m = new google.maps.Marker({
        position: { lat: s.lat, lng: s.lon }, map,
        icon: {
          path: 'M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5a2.5 2.5 0 0 1 0-5 2.5 2.5 0 0 1 0 5z',
          fillColor: conf.catColor, fillOpacity: 1, strokeWeight: 2, strokeColor: '#FFFFFF', scale: 1.5,
          anchor: new google.maps.Point(12, 22)
        },
        title: s.name
      });

      const distLabel = typeof s.walkingDistanceMeters === 'number' ? `${formatDistance(s.walkingDistanceMeters)} walk` : '';
      const durLabel = typeof s.walkingDurationMinutes === 'number' ? `${s.walkingDurationMinutes} min` : '';
      const info = new google.maps.InfoWindow({
        content: `<div class="p-2 font-inter"><div class="text-[10px] font-bold uppercase tracking-widest mb-1" style="color:${conf.catColor}">${conf.label || conf.catLabel}</div><div class="text-sm font-bold">${s.name}</div><div class="text-[11px] text-slate-500 mt-1">${distLabel}${durLabel ? ' · ' + durLabel : ''}</div></div>`
      });
      m.addListener('click', () => info.open(map, m));
      serviceMarkers.push(m);

      try {
        const rRes = await fetch(`${API_URL}/api/route?sLat=${lat}&sLon=${lon}&eLat=${s.lat}&eLon=${s.lon}`);
        if (!rRes.ok) return;
        const rData = await rRes.json();
        if (!rData.polyline) return;
        const path = google.maps.geometry.encoding.decodePath(rData.polyline);
        const poly = new google.maps.Polyline({ path: [], geodesic: true, strokeColor: conf.catColor, strokeOpacity: 0.7, strokeWeight: 4, map });
        servicePolylines.push(poly);
        let step = 0;
        const total = 40;
        const iv = setInterval(() => {
          step++;
          poly.setPath(path.slice(0, Math.ceil((step / total) * path.length)));
          if (step >= total) clearInterval(iv);
        }, 25);
      } catch (e) { console.error('Route error', e); }
    });

    _finishProgress();

  } catch (e) {
    console.error(e);
    _cancelProgress();
    document.getElementById('score-desc').textContent = 'Analysis failed. Please try again.';
    renderWalkabilityBreakdown(null);
    renderServicesFound([]);
  }
}

// ── Boot ──
window.onload = loadGoogleMaps;

function checkUrlParams() {
  const params = new URLSearchParams(window.location.search);
  const q = params.get('q');
  const lat = params.get('lat');
  const lon = params.get('lon');
  if (q) {
    document.getElementById('query').value = q;
    if (lat && lon) select({ display_name: q, lat, lon });
    else search(q);
    window.history.replaceState({}, '', '/dashboard.html');
  }
}