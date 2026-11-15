// Bakes real NASA MGS MOLA elevation data (PDS MEGDR, meters above the Mars areoid)
// into compact little-endian Int16 files the app loads at startup.
//
//   node scripts/bakeMola.mjs
//
// Source: https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x/
//  - meg004: global 4 px/deg grid (~14.8 km/px), downloaded whole (~2 MB)
//  - meg128: 128 px/deg tiles (~463 m/px). The server supports HTTP Range, so only
//    the pixel windows around each named site are fetched (a few MB in total).
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const BASE = 'https://pds-geosciences.wustl.edu/mgs/mgs-m-mola-5-megdr-l3-v1/mgsl_300x';
const OUT = path.resolve('public/data/mola');
const PPD = 128;
const TILE_W = 11520; // 90 deg * 128
const TILE_H = 5632; // 44 deg * 128
const ROW_BYTES = TILE_W * 2;
const M_PER_DEG = 59274; // Mars, 3396 km radius-ish used by the rest of the app
const CONCURRENCY = 24;

/** halfKm = half-width of the window in km (N-S); E-W widens by 1/cos(lat). */
const SITES = [
  { id: 'JEZERO', name: 'Jezero Crater & Western Delta', lat: 18.44, lng: 77.45, halfKm: 160 },
  { id: 'SYRTIS', name: 'Syrtis Major', lat: 8.4, lng: 69.5, halfKm: 200 },
  { id: 'HELLAS', name: 'Hellas Planitia', lat: -42.4, lng: 70.5, halfKm: 260 },
  { id: 'REULL', name: 'Reull Vallis', lat: -42.5, lng: 102.0, halfKm: 160 },
  { id: 'NOACHIS', name: 'Noachis Terra', lat: -42.0, lng: 12.0, halfKm: 160 },
  { id: 'GALE', name: 'Gale Crater & Mount Sharp', lat: -5.4, lng: 137.8, halfKm: 110 },
  { id: 'OLYMPUS', name: 'Olympus Mons', lat: 18.65, lng: 226.2, halfKm: 380 }, // reaches the basal scarp
  { id: 'THARSIS', name: 'Tharsis Bulge (Pavonis Mons)', lat: 1.5, lng: 247.1, halfKm: 200 },
  { id: 'VALLES', name: 'Valles Marineris (Melas/Candor)', lat: -9.5, lng: 284.5, halfKm: 220 },
  { id: 'VASTITAS', name: 'Vastitas Borealis (Phoenix region)', lat: 68.2, lng: 234.3, halfKm: 160 },
  { id: 'BOREUM', name: 'Planum Boreum', lat: 83.0, lng: 0.0, halfKm: 100 },
];

const wrap360 = (l) => ((l % 360) + 360) % 360;

function tileFor(latPx, lng360) {
  // latPx: center latitude of the pixel row; lng360 in [0,360)
  const maxLat = latPx > 44 ? 88 : latPx > 0 ? 44 : latPx > -44 ? 0 : -44;
  const west = Math.floor(lng360 / 90) * 90;
  const latName = `${String(Math.abs(maxLat)).padStart(2, '0')}${maxLat >= 0 ? 'n' : 's'}`;
  return {
    maxLat,
    west,
    url: `${BASE}/meg128/megt${latName}${String(west).padStart(3, '0')}hb.img`,
  };
}

async function fetchRange(url, start, len, tries = 5) {
  for (let t = 0; t < tries; t++) {
    try {
      const res = await fetch(url, { headers: { Range: `bytes=${start}-${start + len - 1}` } });
      if (res.status !== 206 && res.status !== 200) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      if (res.status === 200) return buf.subarray(start, start + len); // server ignored Range
      if (buf.length !== len) throw new Error(`short read ${buf.length}/${len}`);
      return buf;
    } catch (e) {
      if (t === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 400 * (t + 1)));
    }
  }
}

async function pool(items, worker) {
  let i = 0;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (i < items.length) {
        const mine = i++;
        await worker(items[mine], mine);
      }
    })
  );
}

async function bakeSite(site) {
  const latHalf = site.halfKm * 1000 / M_PER_DEG;
  const lngHalf = Math.min(35, latHalf / Math.cos((site.lat * Math.PI) / 180));
  // Snap window to the 1/128 degree pixel grid.
  const latTop = Math.min(87.9, Math.ceil((site.lat + latHalf) * PPD) / PPD);
  const latBot = Math.max(-87.9, Math.floor((site.lat - latHalf) * PPD) / PPD);
  const lngWest = Math.floor(wrap360(site.lng - lngHalf) * PPD) / PPD;
  const height = Math.round((latTop - latBot) * PPD);
  const width = Math.round(2 * lngHalf * PPD);
  const out = Buffer.alloc(width * height * 2);

  const jobs = [];
  for (let y = 0; y < height; y++) {
    const latPx = latTop - (y + 0.5) / PPD;
    let x = 0;
    while (x < width) {
      const lng360 = wrap360(lngWest + (x + 0.5) / PPD);
      const tile = tileFor(latPx, lng360);
      const col0 = Math.floor((lng360 - tile.west) * PPD);
      const run = Math.min(width - x, TILE_W - col0);
      const row = Math.floor((tile.maxLat - latPx) * PPD);
      jobs.push({ y, x, run, tile, row, col0 });
      x += run;
    }
  }

  await pool(jobs, async (j) => {
    const buf = await fetchRange(j.tile.url, j.row * ROW_BYTES + j.col0 * 2, j.run * 2);
    for (let k = 0; k < j.run; k++) {
      // PDS MSB_INTEGER (big endian) -> little endian
      out.writeInt16LE(buf.readInt16BE(k * 2), (j.y * width + j.x + k) * 2);
    }
  });

  await writeFile(path.join(OUT, `${site.id.toLowerCase()}.bin`), out);
  const centerIdx = (Math.floor(height / 2) * width + Math.floor(width / 2)) * 2;
  console.log(
    `${site.id.padEnd(9)} ${width}x${height}  ${(out.length / 1e6).toFixed(2)} MB  center elev ${out.readInt16LE(centerIdx)} m`
  );
  return {
    id: site.id,
    name: site.name,
    file: `${site.id.toLowerCase()}.bin`,
    ppd: PPD,
    width,
    height,
    latTop,
    lngWest, // degrees east, 0..360
  };
}

async function bakeGlobal() {
  const url = `${BASE}/meg004/megt90n000cb.img`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`global HTTP ${res.status}`);
  const be = Buffer.from(await res.arrayBuffer());
  const width = 1440;
  const height = 720;
  if (be.length !== width * height * 2) throw new Error(`unexpected global size ${be.length}`);
  const le = Buffer.alloc(be.length);
  for (let i = 0; i < width * height; i++) le.writeInt16LE(be.readInt16BE(i * 2), i * 2);
  await writeFile(path.join(OUT, 'global.bin'), le);
  console.log(`GLOBAL    ${width}x${height}  ${(le.length / 1e6).toFixed(2)} MB`);
  return { file: 'global.bin', ppd: 4, width, height, latTop: 90, lngWest: 0 };
}

await mkdir(OUT, { recursive: true });
const onlyArg = process.argv.find((a) => a.startsWith('--only='));
const manifestPath = path.join(OUT, 'manifest.json');
if (onlyArg) {
  // Re-bake just some sites and merge into the existing manifest (keeps global + other windows).
  const ids = new Set(onlyArg.slice(7).split(',').map((s) => s.toUpperCase()));
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  for (const site of SITES.filter((s) => ids.has(s.id))) {
    const entry = await bakeSite(site);
    manifest.regions = manifest.regions.filter((r) => r.id !== site.id);
    manifest.regions.push(entry);
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 1));
  console.log('done (merged)');
} else {
  const global = await bakeGlobal();
  const regions = [];
  for (const site of SITES) regions.push(await bakeSite(site));
  await writeFile(
    manifestPath,
    JSON.stringify(
      {
        source: 'NASA MGS MOLA MEGDR (PDS Geosciences Node), elevation in meters above the Mars areoid',
        global,
        regions,
      },
      null,
      1
    )
  );
  console.log('done');
}
