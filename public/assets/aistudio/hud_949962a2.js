/* Mars Walk EVA HUD — global Mars map + astronaut panels.
 * Map tiles come from the USGS/Esri-hosted Mars services. Change them in LAYERS below. */

const MARS_RADIUS_KM = 3389.5;
const EVA_BUDGET_S = 7 * 3600;             // mock EVA length: 7 hours

// ---- TILE CONFIG -------------------------------------------------------
// NOT yet tested in a live browser. If the base map stays blank, the tile
// scheme (url pattern / zoom offset / CRS) needs adjusting here.
const LAYERS = [
  {
    id: 'mdim', name: 'Viking MDIM 2.1 color', on: true,
    url: 'https://astro.arcgis.com/arcgis/rest/services/OnMars/MDIM/MapServer/tile/{z}/{y}/{x}',
    opts: { maxNativeZoom: 7, maxZoom: 9, tileSize: 256, noWrap: true }
  },
  {
    id: 'hillshade', name: 'MOLA shaded relief (NASA Trek)', on: false,
    url: 'https://trek.nasa.gov/tiles/Mars/EQ/Mars_MGS_MOLA_ClrShade_merge_global_463m/1.0.0/default/default028mm/{z}/{y}/{x}.jpg',
    opts: { opacity: 0.55, noWrap: true, maxNativeZoom: 6, maxZoom: 9 }
  }
];

// ---- MAP (whole planet) ------------------------------------------------
const GLOBAL_VIEW = { center: [0, 0], zoom: 1 };
const map = L.map('map', {
  crs: L.CRS.EPSG4326, center: GLOBAL_VIEW.center, zoom: GLOBAL_VIEW.zoom, minZoom: 0, maxZoom: 9,
  zoomControl: false, attributionControl: false, worldCopyJump: false,
  maxBounds: [[-90, -180], [90, 180]], maxBoundsViscosity: 1
});

const $ = id => document.getElementById(id);
const notice = msg => { $('notice').textContent = msg || ''; };
let tileErrors = 0;

LAYERS.forEach(cfg => {
  const row = document.createElement('label');
  row.className = 'toggle';
  row.innerHTML = `<input type="checkbox" ${cfg.on ? 'checked' : ''} ${cfg.url ? '' : 'disabled'}><span>${cfg.name}</span>` +
                  (cfg.url ? '' : '<small>URL not set</small>');
  $('layerList').appendChild(row);
  if (!cfg.url) return;

  const layer = L.tileLayer(cfg.url, cfg.opts);
  layer.on('tileerror', () => {
    if (++tileErrors === 6) notice('Tiles failing to load — check tile URL / scheme in hud.js (LAYERS).');
  });
  layer.on('tileload', () => { if (tileErrors) { tileErrors = 0; notice(''); } });
  if (cfg.on) layer.addTo(map);

  row.querySelector('input').addEventListener('change', e => {
    e.target.checked ? layer.addTo(map) : map.removeLayer(layer);
  });
});

$('btnHome').onclick = () => map.setView(GLOBAL_VIEW.center, GLOBAL_VIEW.zoom);

// ---- COORDINATES -------------------------------------------------------
const fmtLat = v => Math.abs(v).toFixed(3) + '° ' + (v < 0 ? 'S' : 'N');
const fmtLon = v => (((v % 360) + 360) % 360).toFixed(3) + '° E';

function haversineKm(a, b) {
  const r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lng - a.lng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * MARS_RADIUS_KM * Math.asin(Math.sqrt(h));
}
const fmtDist = km => km < 1 ? (km * 1000).toFixed(0) + ' m' : km.toFixed(1) + ' km';

map.on('mousemove', e => {
  $('lat').textContent = fmtLat(e.latlng.lat);
  $('lon').textContent = fmtLon(e.latlng.lng);
});
map.on('zoomend', () => { $('zoom').textContent = map.getZoom(); });
$('zoom').textContent = map.getZoom();

// ---- ASTRONAUT POSITION + WAYPOINTS ------------------------------------
let astronaut = null, astroMarker = null;
const waypoints = [], markers = [];
let mode = null;                            // null | 'place' | 'waypoint'
const routeLine = L.polyline([], { color: '#ffb347', weight: 2, dashArray: '6 6' }).addTo(map);

function setMode(m) {
  mode = (mode === m) ? null : m;
  $('btnPlace').classList.toggle('on', mode === 'place');
  $('btnAdd').classList.toggle('on', mode === 'waypoint');
  $('btnPlace').textContent = mode === 'place' ? 'Click map…' : 'Set position';
  $('btnAdd').textContent = mode === 'waypoint' ? 'Click map…' : 'Add waypoint';
}
$('btnPlace').onclick = () => setMode('place');
$('btnAdd').onclick = () => setMode('waypoint');

function setAstronaut(latlng) {
  astronaut = latlng;
  if (astroMarker) astroMarker.setLatLng(latlng);
  else astroMarker = L.marker(latlng, { icon: L.divIcon({ className: '', html: '<div class="astro-marker"></div>', iconSize: [18, 18] }) }).addTo(map);
  $('pos').textContent = fmtLat(latlng.lat) + ', ' + fmtLon(latlng.lng);
  while (waypoints.length && haversineKm(astronaut, waypoints[0]) * 1000 <= 25) {
    waypoints.shift();
    map.removeLayer(markers.shift());
  }
  renderWaypoints();
}

function renderWaypoints() {
  const list = $('wpList');
  list.innerHTML = '';
  if (!waypoints.length) list.innerHTML = '<li class="empty">No waypoints yet.</li>';
  waypoints.forEach((p, i) => {
    const li = document.createElement('li');
    li.innerHTML = `<span>WP${i + 1}</span><span>${p.lat.toFixed(2)}, ${(((p.lng % 360) + 360) % 360).toFixed(2)}</span><button data-i="${i}">×</button>`;
    list.appendChild(li);
  });
  list.querySelectorAll('button').forEach(b => b.onclick = () => removeWaypoint(+b.dataset.i));
  $('wpCount').textContent = waypoints.length;

  const path = astronaut ? [astronaut, ...waypoints] : waypoints;
  routeLine.setLatLngs(path);
  let km = 0;
  for (let i = 1; i < path.length; i++) km += haversineKm(path[i - 1], path[i]);
  $('routeLen').textContent = fmtDist(km);
  $('toNext').textContent = (astronaut && waypoints.length) ? fmtDist(haversineKm(astronaut, waypoints[0])) : '--';
}

function addWaypoint(latlng) {
  waypoints.push(latlng);
  markers.push(L.marker(latlng, { icon: L.divIcon({ className: '', html: '<div class="wp-marker"></div>', iconSize: [12, 12] }) }).addTo(map));
  renderWaypoints();
}
function removeWaypoint(i) {
  waypoints.splice(i, 1);
  map.removeLayer(markers.splice(i, 1)[0]);
  renderWaypoints();
}
$('btnClear').onclick = () => { while (waypoints.length) removeWaypoint(0); };

map.on('click', e => {
  if (mode === 'place') { setAstronaut(e.latlng); setMode(null); }
  else if (mode === 'waypoint') addWaypoint(e.latlng);
});
renderWaypoints();

// ---- EVA CLOCK + MOCK SUIT TELEMETRY -----------------------------------
// All values are simulated. Replace tick() with your real data feed.
const t0 = Date.now();
const pad = n => String(n).padStart(2, '0');
const hms = s => `${pad(Math.floor(s / 3600))}:${pad(Math.floor(s / 60) % 60)}:${pad(Math.floor(s) % 60)}`;
const state = { o2: 100, bat: 100, co2: 0.3, tmp: 22, spr: 29.6, hdg: 40, spd: 1.1, dist: 0, hr: 88, air: -63, prs: 735, wnd: 6 };
const walk = (v, step, lo, hi) => Math.min(hi, Math.max(lo, v + (Math.random() - 0.5) * step));
const setBar = (id, pct, txt, cls) => {
  const bar = $(id + 'Bar');
  bar.firstElementChild.style.setProperty('--v', Math.max(0, Math.min(100, pct)) + '%');
  bar.className = 'bar ' + (cls || '');
  $(id + 'Txt').textContent = txt;
};

function tick() {
  const s = (Date.now() - t0) / 1000;
  $('clock').textContent = hms(s);
  $('remain').textContent = hms(Math.max(0, EVA_BUDGET_S - s));

  state.o2 = Math.max(0, state.o2 - 0.02);
  state.bat = Math.max(0, state.bat - 0.015);
  state.co2 = walk(state.co2, 0.05, 0.1, 1.5);
  state.tmp = walk(state.tmp, 0.4, 15, 32);
  state.spr = walk(state.spr, 0.1, 28.5, 30.5);
  state.hdg = (state.hdg + (Math.random() - 0.5) * 8 + 360) % 360;
  state.spd = walk(state.spd, 0.2, 0.3, 1.8);
  state.dist += state.spd / 1000;
  state.hr = walk(state.hr, 4, 70, 140);
  state.air = walk(state.air, 0.6, -90, -20);
  state.prs = walk(state.prs, 2, 700, 780);
  state.wnd = walk(state.wnd, 1, 0, 20);

  setBar('o2', state.o2, state.o2.toFixed(0) + '%', state.o2 < 20 ? 'red' : state.o2 < 40 ? 'amber' : '');
  setBar('bat', state.bat, state.bat.toFixed(0) + '%', state.bat < 20 ? 'red' : state.bat < 40 ? 'amber' : '');
  setBar('co2', (state.co2 / 3) * 100, state.co2.toFixed(2) + ' kPa', state.co2 > 1.2 ? 'red' : 'amber');
  setBar('tmp', ((state.tmp - 10) / 30) * 100, state.tmp.toFixed(0) + ' °C', state.tmp > 30 ? 'red' : 'amber');

  $('spr').textContent = state.spr.toFixed(1) + ' kPa';
  $('hdg').textContent = String(Math.round(state.hdg)).padStart(3, '0') + '°';
  $('needle').style.setProperty('--hdg', state.hdg + 'deg');
  $('spd').textContent = state.spd.toFixed(1) + ' m/s';
  $('dist').textContent = state.dist.toFixed(3) + ' km';
  $('hr').textContent = Math.round(state.hr) + ' bpm';
  $('air').textContent = state.air.toFixed(0) + ' °C';
  $('prs').textContent = state.prs.toFixed(0) + ' Pa';
  $('wnd').textContent = state.wnd.toFixed(1) + ' m/s';

  const bad = state.o2 < 20 || state.bat < 20 || state.co2 > 1.2;
  const warn = state.o2 < 40 || state.bat < 40;
  $('suitTxt').textContent = bad ? 'RED' : warn ? 'AMBER' : 'GREEN';
  $('linkDot').className = 'dot' + (bad ? ' bad' : warn ? ' warn' : '');
  $('linkTxt').textContent = bad ? 'ALERT' : warn ? 'CAUTION' : 'NOMINAL';
}
setInterval(tick, 1000);
tick();
