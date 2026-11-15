import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Database, GraduationCap, X } from 'lucide-react';

type TabId = 'hud' | 'visor' | 'console' | 'sensors';

interface TourStep {
  /** View the step is shown on; the tour switches to it automatically. */
  tab: TabId;
  /** Value of the `data-tour` attribute to spotlight. Omit for a centred card. */
  target?: string;
  title: string;
  body: string[];
  /** NASA / USGS data behind what is being shown. */
  data?: string;
  /** Extra bullet list (used by the closing step). */
  list?: { label: string; text: string }[];
}

const TOUR_STEPS: TourStep[] = [
  {
    tab: 'hud',
    title: 'Welcome, Space Apps judges',
    body: [
      'Mars Walk · EVA is a mission-rehearsal simulator. You drive a rover or walk an astronaut across Jezero Crater while a spacesuit HUD combines terrain, weather, radiation and life-support data into guidance.',
      'This tour takes about two minutes. It shows how to play and which NASA data sits behind each screen.',
    ],
  },
  {
    tab: 'hud',
    target: 'nav',
    title: 'Four views',
    body: [
      'EVA HUD is the tactical map you are on now. 3D Visor is the first-person terrain view. Console is the engineering report. Datasets lists the data sources and scenarios.',
      'The tour switches views for you as it goes.',
    ],
  },
  {
    tab: 'hud',
    target: 'astronaut',
    title: 'Move the astronaut',
    body: [
      'Drive with W A S D or the arrow keys, or use the on-screen arrows in this panel. Heading, pace and distance update live.',
      'A PS5 DualSense controller also works when connected: left stick steers, L2 / R2 drive.',
    ],
  },
  {
    tab: 'hud',
    target: 'layers',
    title: 'Map layers',
    body: [
      'Switch the base map and overlays here. Overlays mark Jezero sector markers, named landforms and the Tharsis volcanoes, ravines and troughs.',
      'Atlas & Routes opens a planet-wide landmark atlas and route planner.',
    ],
    data: 'USGS Viking MDIM 2.1 colour mosaic · MGS MOLA shaded relief via NASA Trek',
  },
  {
    tab: 'hud',
    target: 'traverse',
    title: 'Plan a traverse',
    body: [
      'Press Add waypoint, then click the map to drop checkpoints. You can also click any Jezero marker to make it the target.',
      'Turn on AI Pilot in the Life support panel and the vehicle follows the route by itself.',
    ],
  },
  {
    tab: 'hud',
    target: 'life',
    title: 'Life support and equipment',
    body: [
      'Oxygen, battery, CO₂ and thermal status change as you travel.',
      'Switch between Rover and EVA walking, deploy the solar wings or turn on the lights. Each choice trades power against safety.',
    ],
  },
  {
    tab: 'hud',
    target: 'environment',
    title: 'Local environment',
    body: [
      'Temperature, pressure, wind, dust and radiation dose depend on where you are standing on Mars.',
      'These values are modelled on published instrument ranges. They are not a live feed.',
    ],
    data: 'Modelled on Mars 2020 MEDA weather and MSL RAD dosimetry',
  },
  {
    tab: 'hud',
    target: 'status',
    title: 'Hazards and emergencies',
    body: [
      'Test Hazard injects an emergency so you can see the alarms and return-to-base guidance. Engage Emergency RTB locks guidance onto the HAB-01 base.',
      'Hazard Override clears every active alert. Use it if an alarm interrupts your evaluation.',
    ],
  },
  {
    tab: 'visor',
    title: '3D Visor: real Mars terrain',
    body: [
      'The ground you drive on is built from real elevation data, with a higher-resolution model layered over the Jezero delta. The same driving controls apply.',
      'Camera presets along the bottom switch between overview, first-person MastCam, orbit and orbital views.',
    ],
    data: 'NASA MGS MOLA MEGDR elevation · MRO HiRISE stereo DTM over Jezero',
  },
  {
    tab: 'visor',
    target: 'visor-map',
    title: 'Tactical map',
    body: [
      'Switch between MOLA, THEMIS and MDIM layers, and zoom from the local sector out to the whole globe.',
      'Waypoints and hazard zones stay in step with the EVA HUD.',
    ],
    data: 'MGS MOLA · Mars Odyssey THEMIS · Viking MDIM',
  },
  {
    tab: 'sensors',
    target: 'datasets-env',
    title: 'NASA Datasets view',
    body: [
      'This view shows what is driving the simulation at your current position: elevation, surface type, pressure, visibility and weather.',
      'Everything below it changes the mission conditions.',
    ],
    data: 'Elevation read from MGS MOLA at your coordinates',
  },
  {
    tab: 'sensors',
    target: 'datasets-challenges',
    title: 'Mission rehearsal challenges',
    body: [
      'Three timed scenarios: an oxygen-depletion return, a dust-storm traverse and a communications-blackout extraction. Launch one to play under pressure.',
      'The latency slider sets the Earth–Mars light-time delay, from 4 to 24 minutes.',
    ],
  },
  {
    tab: 'sensors',
    target: 'datasets-cartography',
    title: 'Global landmark database',
    body: [
      'Landmarks across Mars, from Jezero to Olympus Mons and Valles Marineris. Select one to route there or send the autopilot.',
      'The major sites load their own regional elevation tiles.',
    ],
    data: 'Regional MGS MOLA MEGDR tiles',
  },
  {
    tab: 'console',
    target: 'console-header',
    title: 'Engineering Console',
    body: [
      'The console turns current telemetry into a written report: HUD layout, a data table and prioritised EVA command recommendations.',
      'You can acknowledge or execute each recommendation, and copy the full report.',
    ],
  },
  {
    tab: 'hud',
    title: 'You are ready to explore',
    body: ['Where to look for each Space Apps judging criterion:'],
    list: [
      { label: 'Impact', text: 'rehearsal challenges and hazard handling for crew safety' },
      { label: 'Creativity', text: 'a suit HUD that joins map, 3D visor and AI pilot' },
      { label: 'Validity', text: 'real MOLA and HiRISE elevation; sources in Datasets' },
      { label: 'Relevance', text: 'Jezero Crater and Mars 2020 surface operations' },
      { label: 'Presentation', text: 'the Console report and this tour' },
    ],
  },
];

const SEEN_KEY = 'marswalk.judgeTutorial.v1.seen';

export function hasSeenJudgeTutorial(): boolean {
  try {
    return window.localStorage.getItem(SEEN_KEY) === '1';
  } catch {
    return false;
  }
}

function markJudgeTutorialSeen(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, '1');
  } catch {
    // Storage unavailable (private window): the tour simply shows again next load.
  }
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const PAD = 6;
const GAP = 14;
const EDGE = 12;

function sameBox(a: Box | null, b: Box | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h;
}

/** Visible, padded rectangle of the element, clamped to the viewport. */
function measure(el: Element): Box | null {
  const r = el.getBoundingClientRect();
  if (r.width < 4 || r.height < 4) return null;
  const x1 = Math.max(EDGE / 2, r.left - PAD);
  const y1 = Math.max(EDGE / 2, r.top - PAD);
  const x2 = Math.min(window.innerWidth - EDGE / 2, r.right + PAD);
  const y2 = Math.min(window.innerHeight - EDGE / 2, r.bottom + PAD);
  if (x2 - x1 < 8 || y2 - y1 < 8) return null;
  return { x: Math.round(x1), y: Math.round(y1), w: Math.round(x2 - x1), h: Math.round(y2 - y1) };
}

function placeCard(box: Box | null, cardW: number, cardH: number): { left: number; top: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const clampX = (x: number) => Math.max(EDGE, Math.min(vw - cardW - EDGE, x));
  const clampY = (y: number) => Math.max(EDGE, Math.min(vh - cardH - EDGE, y));
  if (!box) return { left: clampX((vw - cardW) / 2), top: clampY((vh - cardH) / 2) };

  const room = {
    right: vw - (box.x + box.w) - GAP - EDGE,
    left: box.x - GAP - EDGE,
    below: vh - (box.y + box.h) - GAP - EDGE,
    above: box.y - GAP - EDGE,
  };
  if (room.right >= cardW) return { left: box.x + box.w + GAP, top: clampY(box.y) };
  if (room.left >= cardW) return { left: box.x - GAP - cardW, top: clampY(box.y) };
  if (room.below >= cardH) return { left: clampX(box.x + box.w / 2 - cardW / 2), top: box.y + box.h + GAP };
  if (room.above >= cardH) return { left: clampX(box.x + box.w / 2 - cardW / 2), top: box.y - GAP - cardH };
  // No side fits: hug the screen edge with more room so the overlap is as small as possible.
  return {
    left: clampX(box.x + box.w / 2 - cardW / 2),
    top: room.below >= room.above ? vh - cardH - EDGE : EDGE,
  };
}

interface JudgeTutorialProps {
  open: boolean;
  onClose: () => void;
  activeTab: TabId;
  setActiveTab: (tab: TabId) => void;
}

export const JudgeTutorial: React.FC<JudgeTutorialProps> = ({ open, onClose, activeTab, setActiveTab }) => {
  const [index, setIndex] = useState(0);
  const [box, setBox] = useState<Box | null>(null);
  const [cardPos, setCardPos] = useState<{ left: number; top: number } | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const nextBtnRef = useRef<HTMLButtonElement>(null);
  const scrolledForRef = useRef<number>(-1);

  const step = TOUR_STEPS[index];
  const isLast = index === TOUR_STEPS.length - 1;

  const finish = useCallback(() => {
    markJudgeTutorialSeen();
    // The tour may have scrolled the HUD side column; hand it back at the top.
    document.querySelector('.eva-hud-shell .right')?.scrollTo({ top: 0 });
    setActiveTab('hud');
    onClose();
  }, [onClose, setActiveTab]);

  const goNext = useCallback(() => {
    if (index >= TOUR_STEPS.length - 1) finish();
    else setIndex(index + 1);
  }, [index, finish]);

  const goBack = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  // Restart from the first step each time the tour is opened.
  useEffect(() => {
    if (open) {
      setIndex(0);
      scrolledForRef.current = -1;
    }
  }, [open]);

  // Bring up the view this step belongs to.
  useEffect(() => {
    if (open && step.tab !== activeTab) setActiveTab(step.tab);
  }, [open, step.tab, activeTab, setActiveTab]);

  // Track the spotlight target. Views are lazy-loaded and panels move, so keep re-measuring.
  useEffect(() => {
    if (!open) return;
    const update = () => {
      if (!step.target || step.tab !== activeTab) {
        setBox((prev) => (prev === null ? prev : null));
        return;
      }
      const el = document.querySelector(`[data-tour="${step.target}"]`);
      if (!el) {
        setBox((prev) => (prev === null ? prev : null));
        return;
      }
      if (scrolledForRef.current !== index) {
        scrolledForRef.current = index;
        el.scrollIntoView({ block: 'center', inline: 'nearest' });
      }
      const next = measure(el);
      setBox((prev) => (sameBox(prev, next) ? prev : next));
    };
    update();
    const id = window.setInterval(update, 200);
    window.addEventListener('resize', update);
    return () => {
      window.clearInterval(id);
      window.removeEventListener('resize', update);
    };
  }, [open, index, step.target, step.tab, activeTab]);

  // Position the card next to the spotlight once its own size is known.
  useLayoutEffect(() => {
    if (!open || !cardRef.current) return;
    const reposition = () => {
      if (!cardRef.current) return;
      const r = cardRef.current.getBoundingClientRect();
      const next = placeCard(box, r.width, r.height);
      setCardPos((prev) => (prev && prev.left === next.left && prev.top === next.top ? prev : next));
    };
    reposition();
    window.addEventListener('resize', reposition);
    return () => window.removeEventListener('resize', reposition);
  }, [open, box, index]);

  useEffect(() => {
    if (open) nextBtnRef.current?.focus({ preventScroll: true });
  }, [open, index]);

  // Keyboard: arrows page through the tour, Esc skips. Captured at the window so the
  // driving keys do not also move the rover underneath the overlay.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Tab') return;
      e.stopImmediatePropagation();
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        goNext();
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        goBack();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        finish();
      }
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [open, goNext, goBack, finish]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[5000] font-sans" role="dialog" aria-modal="true" aria-labelledby="judge-tour-title">
      {/* Click shield: the game underneath is not interactive while the tour is open. */}
      <div className={`absolute inset-0 ${box ? '' : 'bg-[#03060c]/70'}`} />

      {box && (
        <div
          aria-hidden="true"
          className="absolute rounded-lg border-2 border-cyan-300 pointer-events-none transition-all duration-300 ease-out"
          style={{
            left: box.x,
            top: box.y,
            width: box.w,
            height: box.h,
            boxShadow: '0 0 0 200vmax rgba(3, 6, 12, 0.74), 0 0 24px rgba(103, 232, 249, 0.45)',
          }}
        />
      )}

      <div
        ref={cardRef}
        className="absolute w-[min(380px,calc(100vw-24px))] rounded-xl border border-cyan-500/50 bg-[#0b111c] text-slate-100 shadow-2xl shadow-black/70 transition-[left,top] duration-300 ease-out"
        style={{
          left: cardPos?.left ?? 0,
          top: cardPos?.top ?? 0,
          visibility: cardPos ? 'visible' : 'hidden',
        }}
      >
        <div className="flex items-center justify-between gap-3 px-4 pt-3.5">
          <span className="flex items-center gap-2 text-[11px] font-mono uppercase tracking-wider text-cyan-300">
            <GraduationCap className="w-3.5 h-3.5" />
            Judge tour · {index + 1} / {TOUR_STEPS.length}
          </span>
          <button
            type="button"
            onClick={finish}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-mono text-slate-400 hover:text-slate-100 hover:bg-white/10"
          >
            Skip <X className="w-3 h-3" />
          </button>
        </div>

        <div className="px-4 pt-2 pb-3.5" aria-live="polite">
          <h2 id="judge-tour-title" className="font-display text-base font-bold text-slate-50">
            {step.title}
          </h2>
          {step.body.map((p) => (
            <p key={p} className="mt-2 text-[13px] leading-relaxed text-slate-300">
              {p}
            </p>
          ))}
          {step.list && (
            <dl className="mt-2.5 space-y-1.5 text-[13px] leading-snug">
              {step.list.map((item) => (
                <div key={item.label} className="flex gap-2">
                  <dt className="w-[92px] shrink-0 font-semibold text-amber-300">{item.label}</dt>
                  <dd className="text-slate-300">{item.text}</dd>
                </div>
              ))}
            </dl>
          )}
          {step.data && (
            <div className="mt-3 flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/10 px-2.5 py-2 text-[12px] leading-snug text-amber-100">
              <Database className="mt-0.5 w-3.5 h-3.5 shrink-0 text-amber-300" />
              <span>{step.data}</span>
            </div>
          )}
          {isLast && (
            <p className="mt-3 text-[12px] text-slate-400">
              Replay this tour any time with the Tutorial button in the top bar.
            </p>
          )}
        </div>

        <div className="h-0.5 bg-slate-800">
          <div
            className="h-full bg-cyan-400 transition-[width] duration-300"
            style={{ width: `${((index + 1) / TOUR_STEPS.length) * 100}%` }}
          />
        </div>

        <div className="flex items-center justify-between gap-3 px-4 py-3">
          <span className="hidden sm:inline text-[11px] font-mono text-slate-500">← → to step · Esc to skip</span>
          <div className="ml-auto flex items-center gap-2">
            {index > 0 && (
              <button
                type="button"
                onClick={goBack}
                className="flex items-center gap-1 rounded-lg border border-slate-700 bg-slate-900 px-3 py-1.5 text-xs font-medium text-slate-300 hover:border-slate-500 hover:text-slate-100"
              >
                <ChevronLeft className="w-3.5 h-3.5" /> Back
              </button>
            )}
            <button
              ref={nextBtnRef}
              type="button"
              onClick={goNext}
              className="flex items-center gap-1 rounded-lg border border-cyan-400 bg-cyan-500/25 px-3.5 py-1.5 text-xs font-semibold text-cyan-100 hover:bg-cyan-500/40 focus:outline-none focus-visible:ring-2 focus-visible:ring-cyan-300"
            >
              {isLast ? 'Start exploring' : index === 0 ? 'Start tour' : 'Next'}
              {!isLast && <ChevronRight className="w-3.5 h-3.5" />}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
