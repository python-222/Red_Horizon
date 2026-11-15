import React, { useState, useEffect } from 'react';
import { MarsRoverPhoto, VERIFIED_NASA_ROVER_PHOTOS, fetchNasaRoverPhotos } from '../data/nasaRoverPhotos';
import { 
  Camera, 
  X, 
  ChevronLeft, 
  ChevronRight, 
  ExternalLink, 
  Database, 
  Info, 
  Compass, 
  Search,
  Sparkles,
  Layers,
  CheckCircle2
} from 'lucide-react';
import { playChirpSound, playAckTone } from '../utils/audioAlerts';

interface RoverPhotoViewerProps {
  selectedWaypointId?: string;
  onClose: () => void;
  onSetNavTarget?: (waypointId: string) => void;
}

export const RoverPhotoViewer: React.FC<RoverPhotoViewerProps> = ({
  selectedWaypointId,
  onClose,
  onSetNavTarget,
}) => {
  const [photos, setPhotos] = useState<MarsRoverPhoto[]>(VERIFIED_NASA_ROVER_PHOTOS);
  const [selectedPhotoIndex, setSelectedPhotoIndex] = useState<number>(0);
  const [selectedCameraFilter, setSelectedCameraFilter] = useState<string>('ALL');
  const [customSol, setCustomSol] = useState<number>(244);
  const [isLoadingApi, setIsLoadingApi] = useState<boolean>(false);
  const [imageError, setImageError] = useState<boolean>(false);

  // Filter or initialize based on selected waypoint
  useEffect(() => {
    if (selectedWaypointId) {
      const matchingIdx = VERIFIED_NASA_ROVER_PHOTOS.findIndex(
        (p) => p.waypointId === selectedWaypointId
      );
      if (matchingIdx !== -1) {
        setSelectedPhotoIndex(matchingIdx);
      }
    }
  }, [selectedWaypointId]);

  const activePhoto = photos[selectedPhotoIndex] || photos[0];

  const handleCameraFilter = (camera: string) => {
    playChirpSound();
    setSelectedCameraFilter(camera);
    if (camera === 'ALL') {
      setPhotos(VERIFIED_NASA_ROVER_PHOTOS);
    } else {
      const filtered = VERIFIED_NASA_ROVER_PHOTOS.filter((p) =>
        p.camera.name.toUpperCase().includes(camera.toUpperCase())
      );
      setPhotos(filtered.length > 0 ? filtered : VERIFIED_NASA_ROVER_PHOTOS);
      setSelectedPhotoIndex(0);
    }
  };

  const handleNext = () => {
    playChirpSound();
    setImageError(false);
    setSelectedPhotoIndex((prev) => (prev + 1) % photos.length);
  };

  const handlePrev = () => {
    playChirpSound();
    setImageError(false);
    setSelectedPhotoIndex((prev) => (prev - 1 + photos.length) % photos.length);
  };

  const handleQueryNasaApi = async () => {
    playChirpSound();
    setIsLoadingApi(true);
    const results = await fetchNasaRoverPhotos(customSol, selectedCameraFilter);
    setPhotos(results);
    setSelectedPhotoIndex(0);
    setImageError(false);
    setIsLoadingApi(false);
    playAckTone();
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/80 backdrop-blur-md flex items-center justify-center p-3 sm:p-6 animate-fade-in select-none">
      <div className="relative w-full max-w-4xl bg-slate-950/95 border border-cyan-500/50 rounded-2xl shadow-2xl shadow-cyan-950/50 overflow-hidden flex flex-col max-h-[90vh]">
        
        {/* HEADER BAR */}
        <div className="flex items-center justify-between px-4 py-3 bg-[#0a0f1d] border-b border-slate-800">
          <div className="flex items-center gap-2.5">
            <Camera className="w-5 h-5 text-cyan-400" />
            <div>
              <div className="flex items-center gap-2">
                <span className="font-display text-sm font-bold tracking-wide text-slate-100 uppercase">
                  NASA Mars Rover Photos Downlink
                </span>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 text-cyan-300 border border-cyan-500/30">
                  PERSEVERANCE · SOL {activePhoto?.sol || 244}
                </span>
              </div>
              <p className="text-[11px] font-mono text-slate-400">
                Calibrated JPL-Caltech Mars 2020 Telemetry Image Archive
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-slate-900 transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* CAMERA FILTER TABS & API TEST BAR */}
        <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 bg-[#060a14] border-b border-slate-800/80 text-xs font-mono">
          <div className="flex items-center gap-1 overflow-x-auto py-0.5">
            {['ALL', 'MCZ_RIGHT', 'NAVCAM_LEFT', 'FRONT_HAZCAM', 'SUPERCAM'].map((cam) => (
              <button
                key={cam}
                type="button"
                onClick={() => handleCameraFilter(cam)}
                className={`px-2.5 py-1 rounded text-[11px] font-medium whitespace-nowrap transition-colors ${
                  selectedCameraFilter === cam
                    ? 'bg-cyan-500/20 text-cyan-300 border border-cyan-500/50'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {cam === 'ALL' ? 'All Cameras' : cam.replace('_', ' ')}
              </button>
            ))}
          </div>

          {/* NASA API Sol Scrubber */}
          <div className="flex items-center gap-2">
            <span className="text-[10px] text-slate-400 hidden sm:inline">NASA API Sol:</span>
            <input
              type="number"
              min="1"
              max="1000"
              value={customSol}
              onChange={(e) => setCustomSol(parseInt(e.target.value) || 244)}
              className="w-16 px-1.5 py-0.5 bg-slate-900 border border-slate-700 rounded text-cyan-300 text-[11px] text-center"
            />
            <button
              type="button"
              onClick={handleQueryNasaApi}
              disabled={isLoadingApi}
              className="px-2.5 py-1 rounded bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-bold text-[11px] flex items-center gap-1 transition-colors"
            >
              <Search className="w-3 h-3" />
              <span>{isLoadingApi ? "Fetching..." : "Query API"}</span>
            </button>
          </div>
        </div>

        {/* MAIN PHOTO VIEWPORT & TELEMETRY */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col md:flex-row gap-5">
          
          {/* PHOTO FRAME */}
          <div className="relative flex-1 bg-black rounded-xl border border-slate-800 overflow-hidden min-h-[300px] flex items-center justify-center group">
            {/* NASA Image */}
            {!imageError ? (
              <img
                src={activePhoto.img_src}
                alt={activePhoto.targetName}
                onError={() => setImageError(true)}
                className="w-full h-full object-contain max-h-[440px]"
              />
            ) : (
              /* High-fidelity procedural fallback if NASA raw proxy times out */
              <div className="w-full h-[360px] bg-gradient-to-b from-[#2a1215] via-[#63291b] to-[#1a0c0e] flex flex-col items-center justify-center p-6 text-center space-y-3">
                <Camera className="w-12 h-12 text-cyan-400 opacity-60" />
                <div className="font-display text-sm font-bold text-amber-300 uppercase">
                  {activePhoto.targetName}
                </div>
                <p className="text-xs font-mono text-slate-300 max-w-md leading-relaxed">
                  {activePhoto.geologicalNotes}
                </p>
                <span className="text-[10px] font-mono px-2 py-0.5 rounded bg-cyan-950 border border-cyan-500/40 text-cyan-300">
                  CALIBRATED NASA ARCHIVE RECORD #{activePhoto.id}
                </span>
              </div>
            )}

            {/* Tactical HUD Crosshair Overlays on Photo */}
            <div className="absolute inset-0 pointer-events-none p-4 flex flex-col justify-between">
              <div className="flex justify-between items-start text-[10px] font-mono text-cyan-400/80 bg-slate-950/70 p-1.5 rounded backdrop-blur-sm">
                <span>ID: {activePhoto.id}</span>
                <span>TARGET: {activePhoto.waypointId}</span>
              </div>
              <div className="flex justify-between items-end text-[10px] font-mono text-cyan-400/80 bg-slate-950/70 p-1.5 rounded backdrop-blur-sm">
                <span>CAM: {activePhoto.camera.name}</span>
                <span>FOCAL: {activePhoto.focalLengthMm || 110}mm</span>
              </div>
            </div>

            {/* Prev / Next Navigation Arrows */}
            <button
              type="button"
              onClick={handlePrev}
              className="absolute left-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-slate-950/80 border border-cyan-500/40 text-slate-200 hover:text-cyan-300 hover:bg-slate-900 transition-all opacity-80 group-hover:opacity-100"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <button
              type="button"
              onClick={handleNext}
              className="absolute right-2 top-1/2 -translate-y-1/2 p-2 rounded-full bg-slate-950/80 border border-cyan-500/40 text-slate-200 hover:text-cyan-300 hover:bg-slate-900 transition-all opacity-80 group-hover:opacity-100"
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>

          {/* TELEMETRY & SCIENCE METADATA SIDEBAR */}
          <div className="w-full md:w-80 flex flex-col justify-between gap-4">
            <div className="space-y-3">
              <div>
                <span className="text-[10px] font-mono text-amber-400 uppercase tracking-widest">
                  Waypoint Observation
                </span>
                <h3 className="font-display text-base font-bold text-slate-100 mt-0.5">
                  {activePhoto.targetName}
                </h3>
              </div>

              {/* Technical Specifications */}
              <div className="bg-slate-900/80 p-3 rounded-xl border border-slate-800 space-y-2 text-xs font-mono">
                <div className="flex justify-between border-b border-slate-800 pb-1">
                  <span className="text-slate-400">Instrument:</span>
                  <span className="text-cyan-300 font-bold">{activePhoto.camera.full_name}</span>
                </div>
                <div className="flex justify-between border-b border-slate-800 pb-1">
                  <span className="text-slate-400">Sol & Earth Date:</span>
                  <span className="text-slate-200">Sol {activePhoto.sol} · {activePhoto.earth_date}</span>
                </div>
                <div className="flex justify-between border-b border-slate-800 pb-1">
                  <span className="text-slate-400">Associated Waypoint:</span>
                  <span className="text-amber-400 font-bold">{activePhoto.waypointId}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Downlink Pipeline:</span>
                  <span className="text-emerald-400 flex items-center gap-1 font-bold">
                    <CheckCircle2 className="w-3 h-3" /> VERIFIED
                  </span>
                </div>
              </div>

              {/* Science & Geology Notes */}
              <div className="bg-slate-900/50 p-3 rounded-xl border border-slate-800 text-xs text-slate-300 leading-relaxed">
                <span className="font-bold text-slate-100 block mb-1">Geological Analysis:</span>
                {activePhoto.geologicalNotes}
              </div>
            </div>

            {/* Set as Navigation Target Action */}
            {onSetNavTarget && (
              <button
                type="button"
                onClick={() => {
                  playAckTone();
                  onSetNavTarget(activePhoto.waypointId);
                  onClose();
                }}
                className="w-full py-2.5 rounded-xl bg-cyan-600 hover:bg-cyan-500 text-slate-950 font-display font-bold text-xs uppercase tracking-wider flex items-center justify-center gap-2 transition-colors shadow-lg shadow-cyan-950"
              >
                <Compass className="w-4 h-4" />
                <span>Lock Navigation Vector to {activePhoto.waypointId}</span>
              </button>
            )}
          </div>

        </div>

        {/* THUMBNAIL CAROUSEL STRIP */}
        <div className="p-3 bg-[#0a0f1d] border-t border-slate-800 flex items-center gap-2 overflow-x-auto">
          {photos.map((p, idx) => (
            <button
              key={p.id}
              type="button"
              onClick={() => {
                playChirpSound();
                setSelectedPhotoIndex(idx);
                setImageError(false);
              }}
              className={`relative w-16 h-12 rounded-lg border overflow-hidden shrink-0 transition-all ${
                idx === selectedPhotoIndex
                  ? 'border-cyan-400 ring-2 ring-cyan-500/40 scale-105'
                  : 'border-slate-800 opacity-60 hover:opacity-100'
              }`}
            >
              <img
                src={p.img_src}
                alt={p.targetName}
                onError={(e) => {
                  (e.target as HTMLElement).style.display = 'none';
                }}
                className="w-full h-full object-cover"
              />
              <span className="absolute bottom-0 inset-x-0 bg-black/80 text-[8px] font-mono text-center text-cyan-300 truncate px-0.5">
                {p.camera.name}
              </span>
            </button>
          ))}
        </div>

      </div>
    </div>
  );
};
