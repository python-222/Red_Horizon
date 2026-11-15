// Bakes the HiRISE Jezero DTM (PDS3 DTEEC_045994_1985_046060_1985_U01.IMG, ~1 m/px, 32-bit float
// meters above the Mars areoid) into a ~4 m/px Int16 window layered over the MOLA data.
//
//   node scripts/bakeHirise.mjs <path-to-DTEEC...IMG>
//
// Source: https://hirise-pds.lpl.arizona.edu/PDS/DTM/ESP/ORB_045900_045999/ESP_045994_1985_ESP_046060_1985/
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const src = process.argv[2];
if (!src) throw new Error('usage: node scripts/bakeHirise.mjs <DTEEC...IMG>');

const OUT = path.resolve('public/data/mola');
const buf = await readFile(src);

// --- PDS3 label (values verified against the file's own label) ---
const label = buf.subarray(0, 26692).toString('latin1');
const num = (key) => {
  const m = label.match(new RegExp(`^\\s*${key}\\s*=\\s*([-0-9.eE+]+)`, 'm'));
  if (!m) throw new Error(`label key missing: ${key}`);
  return Number(m[1]);
};
const RECORD_BYTES = num('RECORD_BYTES');
const IMAGE_START = (num('\\^IMAGE') - 1) * RECORD_BYTES;
const LINES = num('LINES');
const SAMPLES = num('LINE_SAMPLES');
const RES = num('MAP_RESOLUTION'); // pixels per degree at the center latitude
const CENTER_LAT = num('CENTER_LATITUDE');
const CENTER_LON = num('CENTER_LONGITUDE');
const LINE_OFF = num('LINE_PROJECTION_OFFSET');
const SAMPLE_OFF = num('SAMPLE_PROJECTION_OFFSET');
const cosC = Math.cos((CENTER_LAT * Math.PI) / 180);
if (SAMPLES * 4 !== RECORD_BYTES) throw new Error('unexpected record layout');
if ((buf.byteOffset + IMAGE_START) % 4 !== 0) throw new Error('unaligned float data');
const dem = new Float32Array(buf.buffer, buf.byteOffset + IMAGE_START, LINES * SAMPLES);
const valid = (v) => Number.isFinite(v) && v > -1e30;

// Equirectangular: 1-based line L / sample S  <->  lat / lng
// LINE_PROJECTION_OFFSET is the line of the equator (checked: line 1 -> 18.548 = MAXIMUM_LATITUDE).
const latOfLine = (L) => (LINE_OFF - L) / RES;
const lngOfSample = (S) => CENTER_LON + (S - SAMPLE_OFF) / (RES * cosC);
const latTopSrc = latOfLine(1);
const latBotSrc = latOfLine(LINES);
const lngWestSrc = lngOfSample(1);
const lngEastSrc = lngOfSample(SAMPLES);
console.log(`source ${SAMPLES}x${LINES}  lat ${latBotSrc.toFixed(4)}..${latTopSrc.toFixed(4)}  lng ${lngWestSrc.toFixed(4)}..${lngEastSrc.toFixed(4)}`);

// --- Output grid: equirect at PPD px/deg (~4 m/px) ---
const PPD = 14700;
const margin = 2 / PPD;
const latTop = Math.floor((latTopSrc - margin) * PPD) / PPD;
const latBot = Math.ceil((latBotSrc + margin) * PPD) / PPD;
const lngWest = Math.ceil((lngWestSrc + margin) * PPD) / PPD;
const lngEast = Math.floor((lngEastSrc - margin) * PPD) / PPD;
const H = Math.round((latTop - latBot) * PPD);
const W = Math.round((lngEast - lngWest) * PPD);
const out = new Float32Array(W * H).fill(NaN);

const srcPerRow = RES / PPD; // ~4 source rows per output row
const srcPerCol = (RES * cosC) / PPD;
for (let i = 0; i < H; i++) {
  const lat = latTop - (i + 0.5) / PPD;
  const r = LINE_OFF - lat * RES - 1; // 0-based source row
  const r0 = Math.max(0, Math.floor(r - srcPerRow / 2 + 0.5));
  const r1 = Math.min(LINES, Math.floor(r + srcPerRow / 2 + 0.5));
  for (let j = 0; j < W; j++) {
    const lng = lngWest + (j + 0.5) / PPD;
    const c = SAMPLE_OFF + (lng - CENTER_LON) * RES * cosC - 1;
    const c0 = Math.max(0, Math.floor(c - srcPerCol / 2 + 0.5));
    const c1 = Math.min(SAMPLES, Math.floor(c + srcPerCol / 2 + 0.5));
    let sum = 0;
    let n = 0;
    for (let rr = r0; rr < r1; rr++) {
      const base = rr * SAMPLES;
      for (let cc = c0; cc < c1; cc++) {
        const v = dem[base + cc];
        if (valid(v)) {
          sum += v;
          n++;
        }
      }
    }
    if (n > 0) out[i * W + j] = sum / n;
  }
}


// --- MOLA reference (baked JEZERO window) ---
const manifest = JSON.parse(await readFile(path.join(OUT, 'manifest.json'), 'utf8'));
const jz = manifest.regions.find((r) => r.id === 'JEZERO');
const jzRaw = await readFile(path.join(OUT, jz.file));
const jzData = new Int16Array(jzRaw.buffer, jzRaw.byteOffset, jzRaw.length / 2);
const molaAt = (lat, lng) => {
  const u = (lng - jz.lngWest) * jz.ppd - 0.5;
  const v = (jz.latTop - lat) * jz.ppd - 0.5;
  const x0 = Math.floor(u);
  const y0 = Math.floor(v);
  if (x0 < 0 || y0 < 0 || x0 + 1 >= jz.width || y0 + 1 >= jz.height) return NaN;
  const tx = u - x0;
  const ty = v - y0;
  const g = (x, y) => jzData[y * jz.width + x];
  return (g(x0, y0) * (1 - tx) + g(x0 + 1, y0) * tx) * (1 - ty) + (g(x0, y0 + 1) * (1 - tx) + g(x0 + 1, y0 + 1) * tx) * ty;
};
const latOf = (i) => latTop - (i + 0.5) / PPD;
const lngOf = (j) => lngWest + (j + 0.5) / PPD;

// --- Coverage + HiRISE-vs-MOLA agreement on valid pixels ---
let validCount = 0;
let dSum = 0;
let dSq = 0;
let dN = 0;
for (let i = 0; i < H; i++) {
  for (let j = 0; j < W; j++) {
    if (Number.isNaN(out[i * W + j])) continue;
    validCount++;
    if (i % 20 === 0 && j % 20 === 0) {
      const m = molaAt(latOf(i), lngOf(j));
      if (!Number.isNaN(m)) {
        const d = out[i * W + j] - m;
        dSum += d;
        dSq += d * d;
        dN++;
      }
    }
  }
}
console.log(`output ${W}x${H} @ ${PPD} px/deg, valid HiRISE coverage ${((100 * validCount) / (W * H)).toFixed(1)}%`);
console.log(`HiRISE - MOLA: mean ${(dSum / dN).toFixed(1)} m, rms ${Math.sqrt(dSq / dN).toFixed(1)} m over ${dN} samples`);

// Coverage of the 3.6 km visor window around the Jezero origin (18.44N, 77.45E)
{
  const dLat = 1800 / 59274;
  const dLng = 1800 / (59274 * Math.cos((18.44 * Math.PI) / 180));
  let v = 0;
  let n = 0;
  for (let i = 0; i < H; i += 4) {
    for (let j = 0; j < W; j += 4) {
      if (Math.abs(latOf(i) - 18.44) > dLat || Math.abs(lngOf(j) - 77.45) > dLng) continue;
      n++;
      if (!Number.isNaN(out[i * W + j])) v++;
    }
  }
  console.log(`valid HiRISE coverage inside the 3.6 km visor window: ${((100 * v) / n).toFixed(1)}%`);
}

// --- Fill no-data areas with MOLA + a smoothly extrapolated HiRISE-MOLA residual (no cliffs) ---
const BLK = 16;
const BW = Math.ceil(W / BLK);
const BH = Math.ceil(H / BLK);
let resid = new Float32Array(BW * BH).fill(NaN);
for (let bi = 0; bi < BH; bi++) {
  for (let bj = 0; bj < BW; bj++) {
    let s = 0;
    let n = 0;
    let tot = 0;
    for (let i = bi * BLK; i < Math.min(H, (bi + 1) * BLK); i++) {
      for (let j = bj * BLK; j < Math.min(W, (bj + 1) * BLK); j++) {
        tot++;
        const v = out[i * W + j];
        if (Number.isNaN(v)) continue;
        const m = molaAt(latOf(i), lngOf(j));
        if (Number.isNaN(m)) continue;
        s += v - m;
        n++;
      }
    }
    if (n >= tot * 0.5) resid[bi * BW + bj] = s / n;
  }
}
for (let pass = 0; pass < 2000; pass++) {
  const next = resid.slice();
  let empty = 0;
  for (let bi = 0; bi < BH; bi++) {
    for (let bj = 0; bj < BW; bj++) {
      if (!Number.isNaN(resid[bi * BW + bj])) continue;
      let s = 0;
      let n = 0;
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          const ii = bi + di;
          const jj = bj + dj;
          if ((di || dj) && ii >= 0 && jj >= 0 && ii < BH && jj < BW) {
            const v = resid[ii * BW + jj];
            if (!Number.isNaN(v)) {
              s += v;
              n++;
            }
          }
        }
      }
      if (n) next[bi * BW + bj] = (s / n) * 0.985;
      else empty++;
    }
  }
  resid = next;
  if (!empty) break;
}
const residAt = (i, j) => {
  const fy = Math.min(BH - 1.001, Math.max(0, (i + 0.5) / BLK - 0.5));
  const fx = Math.min(BW - 1.001, Math.max(0, (j + 0.5) / BLK - 0.5));
  const y0 = Math.floor(fy);
  const x0 = Math.floor(fx);
  const ty = fy - y0;
  const tx = fx - x0;
  const g = (y, x) => resid[y * BW + x];
  return (g(y0, x0) * (1 - tx) + g(y0, x0 + 1) * tx) * (1 - ty) + (g(y0 + 1, x0) * (1 - tx) + g(y0 + 1, x0 + 1) * tx) * ty;
};
let filled = 0;
for (let i = 0; i < H; i++) {
  for (let j = 0; j < W; j++) {
    if (!Number.isNaN(out[i * W + j])) continue;
    const m = molaAt(latOf(i), lngOf(j));
    if (Number.isNaN(m)) throw new Error('hole outside the MOLA window');
    out[i * W + j] = m + residAt(i, j);
    filled++;
  }
}
console.log(`filled ${filled} no-data pixels from MOLA + residual`);
// --- Quantize ---
let lo = Infinity;
let hi = -Infinity;
for (let k = 0; k < out.length; k++) {
  if (out[k] < lo) lo = out[k];
  if (out[k] > hi) hi = out[k];
}
const offset = Math.round((lo + hi) / 2);
const scale = Math.max(0.02, Math.ceil(((hi - lo) / 60000) * 100) / 100);
const q = new Int16Array(W * H);
for (let k = 0; k < out.length; k++) q[k] = Math.round((out[k] - offset) / scale);
console.log(`elevation ${lo.toFixed(1)}..${hi.toFixed(1)} m  offset ${offset} scale ${scale}`);

await writeFile(path.join(OUT, 'jezero_hirise.bin'), Buffer.from(q.buffer));
manifest.regions = manifest.regions.filter((r) => r.id !== 'JEZERO_HIRISE');
manifest.regions.push({
  id: 'JEZERO_HIRISE',
  name: 'Jezero Crater & Western Delta (HiRISE DTM ESP_045994_1985, ~4 m/px)',
  file: 'jezero_hirise.bin',
  ppd: PPD,
  width: W,
  height: H,
  latTop,
  lngWest,
  scale,
  offset,
  featherPx: 120,
});
await writeFile(path.join(OUT, 'manifest.json'), JSON.stringify(manifest, null, 1));
console.log(`wrote jezero_hirise.bin (${((W * H * 2) / 1e6).toFixed(1)} MB) and updated manifest`);
