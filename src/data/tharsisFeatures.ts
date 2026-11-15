/**
 * Olympus Mons feature set and the regional Mons / Ravines / Troughs topographic layer.
 *
 * Positions and dimensions are approximate (rounded from published USGS/MOLA planetary
 * nomenclature figures) and are meant for navigation, hazard context and map overlays, not
 * survey-grade work. Longitudes are signed (-180..180, east positive).
 */
import { marsDistanceKm, marsStepGreatCircle } from './marsCartography';

export type RegionalFeatureKind = 'MONS' | 'RAVINE' | 'TROUGH' | 'CALDERA' | 'ESCARPMENT' | 'AUREOLE';

export interface RegionalFeature {
  id: string;
  name: string;
  kind: RegionalFeatureKind;
  /** Representative point (summit / centre / midpoint). */
  lat: number;
  lng: number;
  /** Centreline (ravines, troughs, escarpment ring) or outline (aureole) as [lat, lng]. */
  points?: Array<[number, number]>;
  elevationMeters?: number; // summit or rim elevation (MOLA datum)
  reliefMeters?: number; // depth of ravines/troughs/calderas, scarp height, edifice height
  widthKm?: number;
  description: string;
}

/** The Olympus Mons red marker (selectable landmark LF-OLYMPUS-MONS) and the summit. */
export const OLYMPUS_MARKER = { lat: 22.17, lng: -138.16, id: 'LF-OLYMPUS-MONS' } as const;
export const OLYMPUS_SUMMIT = { lat: 18.65, lng: -133.8, id: 'LF-OLYMPUS-SUMMIT' } as const;
export const OLYMPUS_SUMMIT_ELEVATION_M = 21_229;
/** Average height of the surrounding Amazonis/Tharsis plains the shield rises from. */
export const OLYMPUS_PLAINS_ELEVATION_M = -2_600;
export const OLYMPUS_ESCARPMENT_INNER_KM = 285;
export const OLYMPUS_ESCARPMENT_OUTER_KM = 315;

function offsetKm(origin: { lat: number; lng: number }, eastKm: number, northKm: number) {
  const dist = Math.hypot(eastKm, northKm) * 1000;
  if (dist < 1) return { lat: origin.lat, lng: origin.lng };
  const bearing = ((Math.atan2(eastKm, northKm) * 180) / Math.PI + 360) % 360;
  return marsStepGreatCircle(origin, bearing, dist);
}

/** Six nested collapse craters of the summit caldera complex (approx. 60 x 80 km overall). */
export interface CalderaCrater {
  id: string;
  name: string;
  lat: number;
  lng: number;
  diameterKm: number;
  depthMeters: number;
}

const CALDERA_SPEC: Array<[string, number, number, number, number]> = [
  // name, east km, north km (from summit), diameter km, depth m
  ['Caldera Crater 1 (oldest, NE)', 8, 6, 32, 2400],
  ['Caldera Crater 2 (NW)', -10, 4, 22, 2800],
  ['Caldera Crater 3 (central, deepest)', -2, -7, 28, 3200],
  ['Caldera Crater 4 (SE)', 12, -6, 17, 2200],
  ['Caldera Crater 5 (W)', -14, -3, 12, 1600],
  ['Caldera Crater 6 (youngest, N)', 3, 12, 9, 1200],
];

export const OLYMPUS_CALDERA_CRATERS: CalderaCrater[] = CALDERA_SPEC.map(
  ([name, e, n, dia, depth], i) => {
    const p = offsetKm(OLYMPUS_SUMMIT, e, n);
    return { id: `OLY-CALDERA-${i + 1}`, name, lat: p.lat, lng: p.lng, diameterKm: dia, depthMeters: depth };
  }
);

/** Basal escarpment relief (m) by compass bearing from the summit: highest on the NW/N sector. */
export function olympusEscarpmentReliefAt(bearingDeg: number): number {
  const d = ((bearingDeg - 330 + 540) % 360) - 180; // angular distance from the tallest sector
  return Math.round(2000 + 6000 * Math.pow(Math.max(0, Math.cos((d * Math.PI) / 180)), 1.2));
}

const ESCARPMENT_RING: Array<[number, number]> = [];
for (let b = 0; b <= 360; b += 6) {
  const p = marsStepGreatCircle(OLYMPUS_SUMMIT, b, 300_000);
  ESCARPMENT_RING.push([p.lat, p.lng]);
}

const AUREOLE_OUTLINE: Array<[number, number]> = [];
for (let b = 250; b <= 400; b += 8) {
  const p = marsStepGreatCircle(OLYMPUS_SUMMIT, b % 360, 330_000);
  AUREOLE_OUTLINE.push([p.lat, p.lng]);
}
for (let b = 400; b >= 250; b -= 8) {
  const p = marsStepGreatCircle(OLYMPUS_SUMMIT, b % 360, 700_000);
  AUREOLE_OUTLINE.push([p.lat, p.lng]);
}

/** The Mons, Ravines and Troughs layer. */
export const THARSIS_FEATURES: RegionalFeature[] = [
  // --- Mons ---
  {
    id: 'MONS-OLYMPUS',
    name: 'Olympus Mons',
    kind: 'MONS',
    lat: OLYMPUS_SUMMIT.lat,
    lng: OLYMPUS_SUMMIT.lng,
    elevationMeters: OLYMPUS_SUMMIT_ELEVATION_M,
    reliefMeters: 24_000,
    widthKm: 600,
    description:
      'Tallest known volcano in the solar system. Shield with 2-5 degree flanks, an 80 km summit caldera complex and a 2-8 km basal escarpment.',
  },
  {
    id: 'MONS-ASCRAEUS',
    name: 'Ascraeus Mons',
    kind: 'MONS',
    lat: 11.9,
    lng: -104.1,
    elevationMeters: 18_225,
    reliefMeters: 14_900,
    widthKm: 460,
    description: 'Northernmost and tallest of the three Tharsis Montes.',
  },
  {
    id: 'MONS-PAVONIS',
    name: 'Pavonis Mons',
    kind: 'MONS',
    lat: 1.5,
    lng: -112.9,
    elevationMeters: 14_058,
    reliefMeters: 7_000,
    widthKm: 375,
    description: 'Central Tharsis Mons, straddling the equator on the crest of the Tharsis rise.',
  },
  {
    id: 'MONS-ARSIA',
    name: 'Arsia Mons',
    kind: 'MONS',
    lat: -8.3,
    lng: -120.1,
    elevationMeters: 17_761,
    reliefMeters: 11_700,
    widthKm: 435,
    description: 'Southernmost Tharsis Mons with a 110 km summit caldera.',
  },
  {
    id: 'MONS-ALBA',
    name: 'Alba Mons',
    kind: 'MONS',
    lat: 40.5,
    lng: -109.6,
    elevationMeters: 6_800,
    reliefMeters: 6_800,
    widthKm: 1_200,
    description: 'Enormous, very low-profile volcanic edifice north of Tharsis; slopes under 1 degree.',
  },
  {
    id: 'MONS-THARSIS-THOLUS',
    name: 'Tharsis Tholus',
    kind: 'MONS',
    lat: 13.4,
    lng: -90.2,
    elevationMeters: 8_000,
    reliefMeters: 8_000,
    widthKm: 155,
    description: 'Isolated eroded shield volcano on the eastern Tharsis flank.',
  },
  {
    id: 'MONS-ULYSSES-THOLUS',
    name: 'Ulysses Tholus',
    kind: 'MONS',
    lat: 2.9,
    lng: -121.1,
    elevationMeters: 5_600,
    reliefMeters: 5_000,
    widthKm: 100,
    description: 'Small steep-sided volcano between Pavonis and Arsia Mons.',
  },

  // --- Olympus Mons structure ---
  {
    id: 'OLY-CALDERA',
    name: 'Olympus Mons Summit Caldera Complex',
    kind: 'CALDERA',
    lat: OLYMPUS_SUMMIT.lat,
    lng: OLYMPUS_SUMMIT.lng,
    elevationMeters: 21_000,
    reliefMeters: 3_200,
    widthKm: 80,
    description:
      'Six nested collapse craters, 9 to 32 km across and up to 3.2 km deep, with fractured basalt ledges and terraced inner walls.',
  },
  {
    id: 'OLY-ESCARPMENT',
    name: 'Olympus Mons Basal Escarpment',
    kind: 'ESCARPMENT',
    lat: OLYMPUS_MARKER.lat,
    lng: OLYMPUS_MARKER.lng,
    points: ESCARPMENT_RING,
    reliefMeters: 8_000,
    widthKm: 30,
    description: 'Sheer cliff ring (2-8 km high) around the shield, strongest on the north-west side.',
  },
  {
    id: 'OLY-AUREOLE',
    name: 'Olympus Mons Aureole (glacial / landslide deposits)',
    kind: 'AUREOLE',
    lat: 28,
    lng: -150,
    points: AUREOLE_OUTLINE,
    reliefMeters: 1_500,
    description:
      'Ridged lobes of debris radiating from the north-west base, interpreted as landslide or cold-based glacier deposits.',
  },

  // --- Ravines: Valles Marineris chasmata network (centrelines) ---
  {
    id: 'RAV-TITHONIUM',
    name: 'Tithonium Chasma',
    kind: 'RAVINE',
    lat: -5.0,
    lng: -86.0,
    points: [[-4.7, -89.0], [-4.9, -86.0], [-5.2, -83.0]],
    reliefMeters: 5_000,
    widthKm: 110,
    description: 'Western Valles Marineris trough with steep stratified walls.',
  },
  {
    id: 'RAV-IUS',
    name: 'Ius Chasma',
    kind: 'RAVINE',
    lat: -8.0,
    lng: -82.5,
    points: [[-8.2, -85.5], [-7.9, -82.5], [-7.8, -79.5]],
    reliefMeters: 7_000,
    widthKm: 120,
    description: 'Deep western chasma with landslide aprons on both walls.',
  },
  {
    id: 'RAV-MELAS',
    name: 'Melas Chasma',
    kind: 'RAVINE',
    lat: -9.8,
    lng: -75.5,
    points: [[-9.5, -79.0], [-9.9, -75.5], [-10.4, -72.0]],
    reliefMeters: 9_000,
    widthKm: 200,
    description: 'Widest and deepest basin of central Valles Marineris.',
  },
  {
    id: 'RAV-CANDOR',
    name: 'Candor Chasma',
    kind: 'RAVINE',
    lat: -5.8,
    lng: -75.5,
    points: [[-5.6, -77.5], [-5.9, -75.5], [-6.2, -73.0]],
    reliefMeters: 7_500,
    widthKm: 150,
    description: 'Northern central chasma containing layered interior deposits.',
  },
  {
    id: 'RAV-OPHIR',
    name: 'Ophir Chasma',
    kind: 'RAVINE',
    lat: -4.0,
    lng: -73.0,
    points: [[-3.9, -74.5], [-4.0, -72.9], [-4.1, -71.0]],
    reliefMeters: 7_000,
    widthKm: 100,
    description: 'Northernmost central chasma with 5-6 km wall escarpments.',
  },
  {
    id: 'RAV-COPRATES',
    name: 'Coprates Chasma',
    kind: 'RAVINE',
    lat: -13.3,
    lng: -62.5,
    points: [[-12.8, -69.0], [-13.2, -63.0], [-13.9, -56.5]],
    reliefMeters: 8_000,
    widthKm: 90,
    description: 'Long linear trough along the Valles Marineris axis.',
  },
  {
    id: 'RAV-CAPRI',
    name: 'Capri / Eos Chasma',
    kind: 'RAVINE',
    lat: -15.0,
    lng: -49.5,
    points: [[-14.5, -54.0], [-15.0, -49.5], [-15.5, -45.0]],
    reliefMeters: 6_000,
    widthKm: 100,
    description: 'Eastern outflow-channel mouth of Valles Marineris.',
  },
  {
    id: 'RAV-GANGES',
    name: 'Ganges Chasma',
    kind: 'RAVINE',
    lat: -7.2,
    lng: -51.0,
    points: [[-7.0, -53.5], [-7.2, -51.0], [-7.5, -49.0]],
    reliefMeters: 5_500,
    widthKm: 80,
    description: 'Northern branch chasma off the eastern Valles Marineris.',
  },
  {
    id: 'RAV-NOCTIS',
    name: 'Noctis Labyrinthus',
    kind: 'RAVINE',
    lat: -7.2,
    lng: -100.0,
    points: [[-6.5, -103.0], [-7.2, -100.0], [-8.0, -97.0]],
    reliefMeters: 4_500,
    widthKm: 70,
    description: 'Maze of intersecting troughs at the western head of Valles Marineris.',
  },

  // --- Troughs (fossae): tectonic graben, several radiating from the Olympus Mons zone ---
  {
    id: 'TRG-OLYMPICA',
    name: 'Olympica Fossae',
    kind: 'TROUGH',
    lat: 26.0,
    lng: -124.0,
    points: [[25.0, -127.0], [26.0, -124.0], [27.0, -121.0]],
    reliefMeters: 1_200,
    widthKm: 14,
    description: 'Tectonic trough system north-east of Olympus Mons; possible lava-tube collapse chain.',
  },
  {
    id: 'TRG-ACHERON',
    name: 'Acheron Fossae',
    kind: 'TROUGH',
    lat: 38.5,
    lng: -135.0,
    points: [[37.5, -138.0], [38.5, -135.0], [39.5, -132.0]],
    reliefMeters: 2_500,
    widthKm: 25,
    description: 'Fractured highland graben north of Olympus Mons, with steep faulted walls.',
  },
  {
    id: 'TRG-CERAUNIUS',
    name: 'Ceraunius Fossae',
    kind: 'TROUGH',
    lat: 25.0,
    lng: -101.5,
    points: [[23.0, -105.5], [25.0, -101.5], [28.0, -99.5]],
    reliefMeters: 1_000,
    widthKm: 12,
    description: 'Radial Tharsis graben swarm running north from Ascraeus Mons.',
  },
];

export const FEATURE_KIND_STYLE: Record<RegionalFeatureKind, { color: string; label: string }> = {
  MONS: { color: '#fb7185', label: 'Mons' },
  CALDERA: { color: '#f97316', label: 'Caldera' },
  ESCARPMENT: { color: '#ef4444', label: 'Escarpment' },
  AUREOLE: { color: '#c084fc', label: 'Aureole' },
  RAVINE: { color: '#f59e0b', label: 'Ravine / Chasma' },
  TROUGH: { color: '#38bdf8', label: 'Trough / Fossa' },
};

/** Nearest approach (km) from a point to a feature's centreline / outline, or to its point. */
export function distanceToFeatureKm(lat: number, lng: number, f: RegionalFeature): number {
  const pts = f.points && f.points.length > 1 ? f.points : null;
  if (!pts) return marsDistanceKm({ lat, lng }, { lat: f.lat, lng: f.lng });
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i];
    const b = pts[i + 1];
    for (let t = 0; t <= 1; t += 0.25) {
      const d = marsDistanceKm({ lat, lng }, { lat: a[0] + (b[0] - a[0]) * t, lng: a[1] + (b[1] - a[1]) * t });
      if (d < best) best = d;
    }
  }
  return best;
}

/** Nearest ravine or trough with its distance, for hazard context. */
export function nearestRavineOrTrough(
  lat: number,
  lng: number,
  maxKm = 120
): { feature: RegionalFeature; distanceKm: number } | null {
  let best: { feature: RegionalFeature; distanceKm: number } | null = null;
  for (const f of THARSIS_FEATURES) {
    if (f.kind !== 'RAVINE' && f.kind !== 'TROUGH') continue;
    const d = distanceToFeatureKm(lat, lng, f);
    if (d <= maxKm && (!best || d < best.distanceKm)) best = { feature: f, distanceKm: d };
  }
  return best;
}
