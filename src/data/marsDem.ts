/**
 * Real NASA MGS MOLA elevation (meters above the Mars areoid).
 *
 * Data is baked by scripts/bakeMola.mjs into public/data/mola/:
 *  - global.bin: whole planet, 4 px/deg (~14.8 km/px)
 *  - <site>.bin: 128 px/deg (~463 m/px) windows around the named sites
 * Everything in the app that needs terrain height (3D visor, tactical map, minimap,
 * slope telemetry, globe) samples through `sampleMolaMeters` so they all agree.
 */

interface DemGrid {
  data: Int16Array;
  width: number;
  height: number;
  ppd: number;
  latTop: number;
  lngWest: number; // degrees east, 0..360
  /** meters = raw * scale + offset (defaults 1 and 0). Used by the HiRISE grid for cm precision. */
  scale?: number;
  offset?: number;
  /** Width in pixels of the blend zone into the coarser data at the window edge. */
  featherPx?: number;
}

interface DemRegion extends DemGrid {
  id: string;
  name: string;
}

interface DemManifest {
  global: DemGrid & { file: string };
  regions: Array<Omit<DemRegion, 'data'> & { file: string }>;
}

let globalGrid: DemGrid | null = null;
let regions: DemRegion[] = [];
let demVersion = 0;
let loadPromise: Promise<void> | null = null;

export function isMarsDemReady(): boolean {
  return globalGrid !== null;
}

/** Bumps when new DEM data arrives so caches keyed on terrain can invalidate. */
export function getMarsDemVersion(): number {
  return demVersion;
}

export function getMarsDemRegionIds(): string[] {
  return regions.map((r) => r.id);
}

async function fetchInt16(url: string): Promise<Int16Array> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`MOLA fetch failed ${res.status}: ${url}`);
  const buf = await res.arrayBuffer();
  // Files are little-endian Int16; every supported browser/CPU here is little-endian.
  return new Int16Array(buf);
}

/** Loads the baked NASA MOLA grids. Safe to call repeatedly. */
export function loadMarsDem(baseUrl = import.meta.env.BASE_URL ?? '/'): Promise<void> {
  if (loadPromise) return loadPromise;
  const root = `${baseUrl}data/mola/`;
  loadPromise = (async () => {
    const manifest = (await (await fetch(`${root}manifest.json`)).json()) as DemManifest;
    const [globalData, ...regionData] = await Promise.all([
      fetchInt16(root + manifest.global.file),
      ...manifest.regions.map((r) => fetchInt16(root + r.file)),
    ]);
    // Coarse windows first, finer ones (e.g. HiRISE) last so they layer on top.
    regions = manifest.regions
      .map((r, i) => ({ ...r, data: regionData[i] }))
      .sort((a, b) => a.ppd - b.ppd);
    globalGrid = { ...manifest.global, data: globalData };
    demVersion++;
  })().catch((err) => {
    loadPromise = null; // allow a retry; the app falls back to procedural terrain meanwhile
    console.warn('[marsDem] real MOLA elevation unavailable, using procedural fallback', err);
  });
  return loadPromise;
}

const wrap360 = (l: number) => ((l % 360) + 360) % 360;

function cubic(p0: number, p1: number, p2: number, p3: number, t: number): number {
  // Catmull-Rom: smooth slopes instead of bilinear faceting
  return (
    p1 +
    0.5 *
      t *
      (p2 - p0 + t * (2 * p0 - 5 * p1 + 4 * p2 - p3 + t * (3 * (p1 - p2) + p3 - p0)))
  );
}

/** Bicubic sample of a grid at (u,v) in pixel-center coordinates. wrapX wraps columns. */
function bicubic(g: DemGrid, u: number, v: number, wrapX: boolean): number {
  const { data, width: w, height: h } = g;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  const tx = u - x0;
  const ty = v - y0;
  const col = (x: number) => (wrapX ? ((x % w) + w) % w : x < 0 ? 0 : x >= w ? w - 1 : x);
  const row = (y: number) => (y < 0 ? 0 : y >= h ? h - 1 : y);
  const c0 = col(x0 - 1);
  const c1 = col(x0);
  const c2 = col(x0 + 1);
  const c3 = col(x0 + 2);
  let out = 0;
  const rows = [0, 0, 0, 0];
  for (let j = 0; j < 4; j++) {
    const o = row(y0 - 1 + j) * w;
    rows[j] = cubic(data[o + c0], data[o + c1], data[o + c2], data[o + c3], tx);
  }
  out = cubic(rows[0], rows[1], rows[2], rows[3], ty);
  return out;
}

function smooth01(t: number): number {
  const c = t < 0 ? 0 : t > 1 ? 1 : t;
  return c * c * (3 - 2 * c);
}

const FEATHER_PX = 28;

/**
 * Real MOLA elevation in meters at a planetary coordinate. Uses the 463 m site
 * windows when the point is inside one (feathered into the global grid at the edges),
 * otherwise the global grid. Returns NaN until the DEM has loaded.
 */
export function sampleMolaMeters(lat: number, lng: number): number {
  const g = globalGrid;
  if (!g) return NaN;
  const lng360 = wrap360(lng);
  const clat = lat > 90 ? 90 : lat < -90 ? -90 : lat;

  let value = bicubic(g, lng360 * g.ppd - 0.5, (g.latTop - clat) * g.ppd - 0.5, true);

  // Layer each window that contains the point, coarse -> fine, feathered at its edges.
  for (let i = 0; i < regions.length; i++) {
    const r = regions[i];
    let dl = lng360 - r.lngWest;
    if (dl < 0) dl += 360;
    const u = dl * r.ppd - 0.5;
    const v = (r.latTop - clat) * r.ppd - 0.5;
    if (u < 1 || v < 1 || u > r.width - 3 || v > r.height - 3) continue;
    const edge = Math.min(u - 1, v - 1, r.width - 3 - u, r.height - 3 - v);
    const wgt = smooth01(edge / (r.featherPx ?? FEATHER_PX));
    if (wgt <= 0) continue;
    const fine = bicubic(r, u, v, false) * (r.scale ?? 1) + (r.offset ?? 0);
    value += (fine - value) * wgt;
  }
  return value;
}
