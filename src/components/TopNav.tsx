import React from 'react';
import { Volume2, VolumeX, ShieldAlert, ShieldCheck, Compass } from 'lucide-react';

interface TopNavProps {
  activeTab: 'hud' | 'visor' | 'console' | 'sensors';
  setActiveTab: (tab: 'hud' | 'visor' | 'console' | 'sensors') => void;
  isMuted: boolean;
  setIsMuted: (muted: boolean) => void;
  hazardActive: boolean;
  anyHazardActive?: boolean;
  onSimulateEmergency: () => void;
  onHazardOverride?: () => void;
  sol: number;
  timeUtc: string;
}

export const TopNav: React.FC<TopNavProps> = ({
  activeTab,
  setActiveTab,
  isMuted,
  setIsMuted,
  hazardActive,
  anyHazardActive = false,
  onSimulateEmergency,
  onHazardOverride,
  sol,
  timeUtc,
}) => {
  return (
    <header className="flex items-center justify-between gap-8 px-6 py-3.5 bg-[#0b0e17] border-b border-slate-800 shrink-0 sticky top-0 z-50">
      {/* Zone 1: Single text element wordmark */}
      <div className="flex items-center gap-3 shrink-0">
        <Compass className="w-5 h-5 text-cyan-400 shrink-0" />
        <span className="font-display text-sm md:text-base font-bold tracking-wider text-slate-100 uppercase whitespace-nowrap shrink-0">
          MARS <span className="text-amber-400">WALK</span> · EVA
        </span>
        <span className="hidden lg:inline text-xs font-mono text-slate-400">
          Sol {sol} · {timeUtc}
        </span>
      </div>

      {/* Zone 2: 4 clean single-line nav tabs */}
      <nav className="flex items-center gap-1.5 p-1 bg-slate-900/90 rounded-lg border border-slate-800">
        <button
          type="button"
          onClick={() => setActiveTab('hud')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'hud'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm shadow-cyan-950'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          EVA HUD
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('visor')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'visor'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm shadow-cyan-950'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          3D Visor
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('console')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'console'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm shadow-cyan-950'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          Engineering Console
        </button>
        <button
          type="button"
          onClick={() => setActiveTab('sensors')}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap shrink-0 ${
            activeTab === 'sensors'
              ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 shadow-sm shadow-cyan-950'
              : 'text-slate-400 hover:text-slate-200'
          }`}
        >
          NASA Datasets
        </button>
      </nav>

      {/* Zone 3: 1 primary action cluster */}
      <div className="flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={() => setIsMuted(!isMuted)}
          title={isMuted ? "Unmute HUD audio" : "Mute HUD audio"}
          className="p-2 rounded-lg border border-slate-800 bg-slate-900 text-slate-400 hover:text-cyan-400 hover:border-slate-700 transition-colors"
        >
          {isMuted ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4 text-cyan-400" />}
        </button>
        <button
          type="button"
          onClick={onSimulateEmergency}
          className={`px-3.5 py-1.5 text-xs font-mono font-semibold rounded-lg border transition-all whitespace-nowrap shrink-0 flex items-center gap-2 ${
            hazardActive
              ? 'bg-rose-500/20 text-rose-300 border-rose-500/50 hover:bg-rose-500/30'
              : 'bg-amber-500/20 text-amber-300 border-amber-500/50 hover:bg-amber-500/30'
          }`}
        >
          <ShieldAlert className="w-3.5 h-3.5" />
          <span>{hazardActive ? "Hazard Active" : "Trigger Test Hazard"}</span>
        </button>
        {onHazardOverride && (
          <button
            type="button"
            onClick={onHazardOverride}
            title="Clear all active hazards (storms, radiation, blackout, faults, and RTB lock)"
            className={`px-3.5 py-1.5 text-xs font-mono font-semibold rounded-lg border transition-all whitespace-nowrap shrink-0 flex items-center gap-2 ${
              anyHazardActive
                ? 'bg-emerald-500/25 text-emerald-200 border-emerald-400 hover:bg-emerald-500/35 shadow-sm shadow-emerald-500/30'
                : 'bg-slate-900 text-emerald-300 border-emerald-500/40 hover:bg-emerald-500/15'
            }`}
          >
            <ShieldCheck className="w-3.5 h-3.5" />
            <span>Hazard Override</span>
          </button>
        )}
      </div>
    </header>
  );
};
