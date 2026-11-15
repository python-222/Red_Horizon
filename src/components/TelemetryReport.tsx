import React, { useState } from 'react';
import { ExcursionState } from '../types/telemetry';
import { Copy, Check, Terminal, ShieldAlert, Cpu, Database, CheckCircle2 } from 'lucide-react';
import { playAckTone } from '../utils/audioAlerts';

interface TelemetryReportProps {
  state: ExcursionState;
  onAcknowledgeCommand?: (id: string) => void;
  onExecuteCommand?: (id: string) => void;
}

export const TelemetryReport: React.FC<TelemetryReportProps> = ({
  state,
  onAcknowledgeCommand,
  onExecuteCommand,
}) => {
  const [copied, setCopied] = useState(false);
  const { vitals, environmental, atmospheric, topography, navigation, hazardAlert, recommendations, mission, activeEnvironment } = state;

  const elevFormatted = `${activeEnvironment.elevationMeters >= 0 ? '+' : ''}${activeEnvironment.elevationMeters.toLocaleString()} m`;

  // Generate the formatted ASCII HUD frame dynamically matching the current telemetry state
  const generateAsciiHud = (): string => {
    const hazardLine1 = hazardAlert.active 
      ? `│  [!] HAZARD ALERT: ${hazardAlert.title.slice(0, 46).padEnd(46)} │`
      : `│  STATUS: ALL LIFE-SUPPORT & NAVIGATION PARAMETERS NOMINAL        │`;
    const hazardLine2 = hazardAlert.active 
      ? `│  CODE: ${hazardAlert.code.slice(0, 20).padEnd(20)} IMMEDIATE: ${hazardAlert.recommendedImmediateAction.slice(0, 31).padEnd(31)} │`
      : `│  MARGINS: POSITIVE // TRAFFICABILITY INDEX: ${(topography.surfaceTrafficabilityIndex * 100).toFixed(0)}% // EVA-02 TRANSECT │`;

    return `+======================================================================================================+
| MISSION: NASA MARS EXPEDITION // ${activeEnvironment.regionName.toUpperCase().slice(0, 35).padEnd(35)} TIME: SOL ${mission.currentSol}, ${mission.missionTimeUtc.padEnd(11)} |
| ACTIVE ENV: ELEV ${elevFormatted.padEnd(10)} | PRS ${`${environmental.atmosphericPressurePa} Pa`.padEnd(8)} | VIS: ${activeEnvironment.visibilityLabel.slice(0, 26).padEnd(26)} |
| SURFACE: ${activeEnvironment.surfaceType.slice(0, 89).padEnd(89)} |
| WEATHER: ${activeEnvironment.activeWeather.slice(0, 89).padEnd(89)} |
+======================================================================================================+
${hazardLine1}
${hazardLine2}
+------------------------------------+------------------------------------+----------------------------+
| [VITAL SIGNS & LIFE SUPPORT]       | [CENTRAL FIELD OF VIEW / RETICLE]  | [ENVIRONMENTAL METRICS]    |
|                                    |                                    |                            |
| O2 Level:       ${vitals.oxygenPercentage.toFixed(1).padStart(5)}% (${vitals.oxygenReserveDurationHours}h)   |          ^  [${`${navigation.bearingDegrees} deg`.padEnd(12)}]         | Ambient Temp:    ${environmental.ambientTempCelsius.toFixed(1).padStart(6)} deg C |
| O2 Flow Rate:   ${vitals.oxygenFlowRateLpm.toFixed(2).padStart(5)} L/min     |            .---.---.---.           | Surface Temp:    ${environmental.surfaceTempCelsius.toFixed(1).padStart(6)} deg C |
| Suit Pressure:  ${vitals.suitPressureKpa.toFixed(1).padStart(5)} kPa (${vitals.suitPressurePsi.toFixed(2)}psi) |           /     |     \\          | Atmo Pressure:   ${environmental.atmosphericPressurePa.toString().padStart(6)} Pa     |
| Battery Life:   ${vitals.batteryPercentage.toFixed(1).padStart(5)}% (${vitals.batteryReserveHours}h)   |          | --( + )-- |         | (MEDA Barometer: ${environmental.atmosphericPressureMbar.toFixed(2)} mbar) |
| Power Draw:     ${vitals.batteryPowerDrawWatts.toString().padStart(5)} W        |           \\     |     /          | Radiation:       ${environmental.radiationDoseRateMicroSvHr.toFixed(1).padStart(6)} uSv/h  |
| Heart Rate:     ${vitals.heartRateBpm.toString().padStart(5)} bpm      |            '---'---'---'           | Cumulative EVA:  ${environmental.cumulativeEvaDoseMilliSv.toFixed(2).padStart(6)} mSv   |
| Core Body Temp: ${vitals.coreTempCelsius.toFixed(1).padStart(5)} deg C   |                                    | SPE Status:      ${environmental.speIntensityLevel.slice(0, 10).padEnd(10)}|
| CO2 Partial P:  ${vitals.co2PartialPressureMmhg.toFixed(1).padStart(5)} mmHg     | TARGET: ${navigation.targetWaypointId.slice(0, 27).padEnd(27)}| GCR Baseline:    ${environmental.radiationGcrBaselineMicroGyDay} uGy/d|
| Suit Loop:      ${vitals.suitThermalLoopStatus.padEnd(18)} | DIST:   ${(navigation.distanceMeters + ' m').padEnd(27)}|                            |
|                                    | BRG:    ${(navigation.bearingDegrees + ' deg').padEnd(27)}| [ATMOSPHERE & WIND]        |
+------------------------------------+ ELEV:   ${(`${navigation.relativeElevationDeltaMeters >= 0 ? '+' : ''}${navigation.relativeElevationDeltaMeters} m`).padEnd(27)}| Wind Speed:      ${atmospheric.windSpeedMps.toFixed(1).padStart(6)} m/s   |
| [TOPOGRAPHY & SURFACE]             | ETA:    ${(navigation.etaMinutes + ' min').padEnd(27)}| Wind Gust:       ${atmospheric.windGustMps.toFixed(1).padStart(6)} m/s   |
| Slope Incline:  ${topography.slopePercentage.toFixed(1).padStart(5)}% (${topography.slopeAngleDegrees.toFixed(1)} deg) | LOCK:   ${'ACTIVE [RADAR LOCK]'.padEnd(27)}| Dust Opacity:    ${atmospheric.dustOpacityTau.toFixed(2).padStart(6)} tau   |
| Surface Regolith: ${topography.dominantGeology.padEnd(16)} |                                    | Thermal Trend:   ${atmospheric.thermalTrendCelsiusPerHour.toFixed(1).padStart(6)} C/hr  |
| Slip Hazard:    ${topography.slipHazardRisk.padEnd(18)} | FROST:  ${activeEnvironment.seasonalCo2FrostMode.padEnd(27)}| Storm Front:     ${atmospheric.dustStormStatus.slice(0, 10).padEnd(10)}|
+------------------------------------+------------------------------------+----------------------------+
| NASA GROUND TRUTH: MOLA Regional Profile · MEDA Atmospheric · HiRISE DTM · RAD Surface Dosimetry     |
+======================================================================================================+`;
  };

  const fullMarkdownReport = `# NASA MARS EXCURSION TELEMETRY REPORT
**Location**: ${activeEnvironment.regionName} (${activeEnvironment.lat.toFixed(2)}°N, ${activeEnvironment.lng.toFixed(2)}°E)  
**Mission Time**: Sol ${mission.currentSol}, ${mission.missionTimeUtc} (LTST: ${mission.localTrueSolarTime})  
**EVA Designation**: ${mission.evaDesignation}  

### Active Environment State
- **Elevation (MOLA Datum)**: ${elevFormatted}
- **Surface Type**: ${activeEnvironment.surfaceType}
- **Atmospheric Pressure / Visibility**: ${environmental.atmosphericPressurePa} Pa (${environmental.atmosphericPressureMbar} mbar) · ${activeEnvironment.visibilityLabel}
- **Active Weather**: ${activeEnvironment.activeWeather}
- **Seasonal CO₂ Frost State**: ${activeEnvironment.seasonalCo2FrostMode}${
    activeEnvironment.navigationBoundaryNote
      ? `\n- **Navigation Boundary**: ${activeEnvironment.navigationBoundaryNote}`
      : ''
  }

---

## 1. [HUD VISUAL LAYOUT]
\`\`\`text
${generateAsciiHud()}
\`\`\`

---

## 2. [DATA SYNTHESIS TELEMETRY]

### A. Topographic Interaction (Slope vs. Geology)
- **Slope Incline & Stability**: Traversing a **${topography.slopePercentage}% slope** (${topography.slopeAngleDegrees}° incline) across **${activeEnvironment.regionName}** (${elevFormatted}).
- **Surface Geology**: Regional profile classifies terrain as **${activeEnvironment.surfaceType}** with **${topography.regolithDepthCm} cm unconsolidated regolith** over **${topography.dominantGeology.replace(/_/g, ' ')}** (roughness ${topography.terrainRoughnessRmsMeters} m RMS).
- **Trafficability Assessment**: Surface trafficability coefficient is **${topography.surfaceTrafficabilityIndex.toFixed(2)}** (Slip Risk: **${topography.slipHazardRisk}**). ${activeEnvironment.routingAdvisory}

### B. Atmospheric Dynamics (Wind, Dust Opacity & Thermal Drop)
- **Wind Vector & Gust Factor**: MEDA wind sensor registers **${atmospheric.windSpeedMps} m/s** sustained velocity with gusts spiking to **${atmospheric.windGustMps} m/s** from ${atmospheric.windDirectionDegrees}°.
- **Dust Opacity & Visibility**: Optical depth sits at **${atmospheric.dustOpacityTau} τ** (${activeEnvironment.visibilityLabel}); active weather regime: **${activeEnvironment.activeWeather}**.
- **Thermal & Pressure Envelope**: Ambient air temperature is **${environmental.ambientTempCelsius}°C** (${atmospheric.thermalTrendCelsiusPerHour}°C/hr trend) at **${environmental.atmosphericPressurePa} Pa (${environmental.atmosphericPressureMbar} mbar)**.

### C. Radiation Dosimetry (Solar Particle Event & Excursion Budget)
- **Ionizing Dose Rate**: Mars Surface Radiation Assessment Detector (RAD) records an instantaneous dose rate of **${environmental.radiationDoseRateMicroSvHr} µSv/hr**, compared against the Galactic Cosmic Ray (GCR) background of ~8.8 µSv/hr (210 µGy/day).
- **Solar Particle Event (SPE) Status**: **${environmental.speIntensityLevel}**.
- **Cumulative EVA Exposure**: Cumulative dose for this excursion currently stands at **${environmental.cumulativeEvaDoseMilliSv} mSv** against a single-EVA flight cap of 0.60 mSv.

---

## 3. [EVA COMMAND RECOMMENDATIONS]

1. **[CRITICAL SAFETY] Abort Science Package Deployment**:
   *Command*: Immediately terminate external core sampling and secure drill hardware into suit equipment holsters.
   *Justification*: Wind gusts (${atmospheric.windGustMps} m/s) and dust opacity (tau ${atmospheric.dustOpacityTau}) risk fouling open sample tubes and mechanical seals.

2. **[HIGH-PRIORITY NAVIGATION] Regional Hazard Routing**:
   *Command*: ${activeEnvironment.routingAdvisory}
   *Justification*: ${topography.slopePercentage}% local slope and ${topography.dominantGeology.replace(/_/g, ' ')} surface mechanics require conservative torque on unstable aprons.

3. **[HIGH-PRIORITY SAFETY] Habitat Ingress & Radiation Margin**:
   *Command*: Monitor return vector toward pressurized shelter while keeping EVA dose below 0.60 mSv.
   *Justification*: Current RAD flux (${environmental.radiationDoseRateMicroSvHr} µSv/hr) requires active tracking under thin Martian atmospheric shielding (${environmental.atmosphericPressurePa} Pa).
`;

  const handleCopy = () => {
    navigator.clipboard.writeText(fullMarkdownReport);
    setCopied(true);
    playAckTone();
    setTimeout(() => setCopied(false), 2500);
  };

  return (
    <div className="w-full max-w-6xl mx-auto px-4 py-6 space-y-6">
      
      {/* Console Header Bar */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 p-4 bg-slate-900/90 rounded-xl border border-slate-800">
        <div className="flex items-center gap-3">
          <Terminal className="w-6 h-6 text-cyan-400 shrink-0" />
          <div>
            <h1 className="font-display text-lg font-bold text-slate-100 uppercase tracking-wide">
              Engineering Telemetry Console & Synthesis
            </h1>
            <p className="text-xs text-slate-400">
              NASA Mars 2020 Perseverance MEDA · HiRISE DTM · Mars Surface RAD Dosimetry
            </p>
          </div>
        </div>

        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center justify-center gap-2 px-4 py-2 text-xs font-mono font-medium rounded-lg bg-cyan-500/20 text-cyan-300 border border-cyan-500/40 hover:bg-cyan-500/30 transition-colors shadow-sm"
        >
          {copied ? <Check className="w-4 h-4 text-emerald-400" /> : <Copy className="w-4 h-4" />}
          <span>{copied ? "Copied Markdown Report!" : "Copy Full Monospace Report"}</span>
        </button>
      </div>

      {/* SECTION 1: [HUD VISUAL LAYOUT] */}
      <section className="bg-slate-950 rounded-xl border border-slate-800 overflow-hidden shadow-2xl">
        <div className="flex items-center justify-between px-5 py-3 bg-[#0c101a] border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-cyan-400" />
            <h2 className="font-display text-sm font-bold tracking-wider text-cyan-300 uppercase">
              1. [HUD VISUAL LAYOUT]
            </h2>
          </div>
          <span className="text-xs font-mono text-slate-400">Monospace ASCII Terminal View</span>
        </div>

        <div className="p-4 overflow-x-auto bg-[#05070c]">
          <pre className="font-mono text-[11px] sm:text-xs leading-tight text-cyan-300 whitespace-pre selection:bg-cyan-600/40">
            {generateAsciiHud()}
          </pre>
        </div>
      </section>

      {/* SECTION 2: [DATA SYNTHESIS TELEMETRY] */}
      <section className="bg-slate-950 rounded-xl border border-slate-800 overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-3 bg-[#0c101a] border-b border-slate-800">
          <div className="flex items-center gap-2">
            <Database className="w-4 h-4 text-amber-400" />
            <h2 className="font-display text-sm font-bold tracking-wider text-amber-300 uppercase">
              2. [DATA SYNTHESIS TELEMETRY]
            </h2>
          </div>
          <span className="text-xs font-mono text-slate-400">Multi-Sensor Compound Analysis</span>
        </div>

        <div className="p-6 grid grid-cols-1 md:grid-cols-3 gap-6">
          
          {/* Topography Synthesis */}
          <div className="bg-slate-900/60 rounded-lg p-4 border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-3">
                <span className="font-display text-xs font-bold text-slate-200 uppercase tracking-wider">
                  Topography & Mechanics
                </span>
                <span className="text-xs font-mono text-cyan-400">HiRISE DTM</span>
              </div>
              <ul className="text-xs text-slate-300 space-y-2.5 leading-relaxed">
                <li>
                  <strong className="text-slate-100">Active Region &amp; Elevation:</strong> <span className="font-mono text-cyan-300 font-bold">{activeEnvironment.regionName}</span> at <span className="font-mono text-amber-300 font-bold">{elevFormatted}</span>.
                </li>
                <li>
                  <strong className="text-slate-100">Slope &amp; Grade:</strong> Incline is at <span className="font-mono text-amber-300 font-bold">{topography.slopePercentage}%</span> ({topography.slopeAngleDegrees}°).
                </li>
                <li>
                  <strong className="text-slate-100">Surface Type &amp; Geology:</strong> {activeEnvironment.surfaceType} (<span className="font-mono text-amber-300">{topography.regolithDepthCm} cm regolith</span> over {topography.dominantGeology.replace(/_/g, ' ')}, {topography.terrainRoughnessRmsMeters} m RMS).
                </li>
                <li>
                  <strong className="text-slate-100">Trafficability Risk:</strong> Coefficient is <span className="font-mono text-rose-400 font-bold">{topography.surfaceTrafficabilityIndex.toFixed(2)}</span>; slip risk is <span className="font-mono text-rose-400 font-bold">{topography.slipHazardRisk}</span>.
                </li>
              </ul>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-800/80 text-[11px] font-mono text-slate-400">
              {activeEnvironment.navigationBoundaryNote ?? `Profile: ${activeEnvironment.profileGroup.replace(/_/g, ' ')}`}
            </div>
          </div>

          {/* Atmospheric Synthesis */}
          <div className="bg-slate-900/60 rounded-lg p-4 border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-3">
                <span className="font-display text-xs font-bold text-slate-200 uppercase tracking-wider">
                  Atmospheric Dynamics
                </span>
                <span className="text-xs font-mono text-cyan-400">MEDA Instrument</span>
              </div>
              <ul className="text-xs text-slate-300 space-y-2.5 leading-relaxed">
                <li>
                  <strong className="text-slate-100">Active Weather:</strong> <span className="text-amber-300 font-medium">{activeEnvironment.activeWeather}</span>.
                </li>
                <li>
                  <strong className="text-slate-100">Wind Vectors:</strong> Sustained speed of <span className="font-mono text-cyan-300">{atmospheric.windSpeedMps} m/s</span> with peak gusts reaching <span className="font-mono text-rose-400 font-bold">{atmospheric.windGustMps} m/s</span> from {atmospheric.windDirectionDegrees}°.
                </li>
                <li>
                  <strong className="text-slate-100">Pressure / Visibility:</strong> <span className="font-mono text-cyan-300 font-bold">{environmental.atmosphericPressurePa} Pa</span> ({environmental.atmosphericPressureMbar} mbar) · <span className="font-mono text-amber-300">{activeEnvironment.visibilityLabel}</span> ({atmospheric.dustOpacityTau} τ).
                </li>
                <li>
                  <strong className="text-slate-100">Thermal Gradient:</strong> Ambient temperature is <span className="font-mono text-cyan-300">{environmental.ambientTempCelsius}°C</span> ({atmospheric.thermalTrendCelsiusPerHour}°C/hr trend).
                </li>
              </ul>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-800/80 text-[11px] font-mono text-slate-400">
              Frost Cycle: {activeEnvironment.seasonalCo2FrostMode} · Sol {mission.currentSol}
            </div>
          </div>

          {/* Radiation Synthesis */}
          <div className="bg-slate-900/60 rounded-lg p-4 border border-slate-800 flex flex-col justify-between">
            <div>
              <div className="flex items-center justify-between border-b border-slate-800 pb-2 mb-3">
                <span className="font-display text-xs font-bold text-slate-200 uppercase tracking-wider">
                  Radiation & Dosimetry
                </span>
                <span className="text-xs font-mono text-cyan-400">RAD Sensor</span>
              </div>
              <ul className="text-xs text-slate-300 space-y-2.5 leading-relaxed">
                <li>
                  <strong className="text-slate-100">Instantaneous Flux:</strong> Surface rate of <span className="font-mono text-rose-400 font-bold">{environmental.radiationDoseRateMicroSvHr} µSv/hr</span> (3.2x nominal background).
                </li>
                <li>
                  <strong className="text-slate-100">Solar Particle Event:</strong> SPE status is <span className="font-mono text-rose-400 font-bold">{environmental.speIntensityLevel}</span> from coronal proton stream.
                </li>
                <li>
                  <strong className="text-slate-100">Cumulative Excursion:</strong> Current dose is <span className="font-mono text-amber-300 font-bold">{environmental.cumulativeEvaDoseMilliSv} mSv</span> against a single-EVA flight limit of 0.60 mSv (42 min margin).
                </li>
              </ul>
            </div>
            <div className="mt-4 pt-3 border-t border-slate-800/80 text-[11px] font-mono text-slate-400">
              NASA Ref: MSL/M2020 RAD Silicon Detector Telescopes
            </div>
          </div>

        </div>
      </section>

      {/* SECTION 3: [EVA COMMAND RECOMMENDATIONS] */}
      <section className="bg-slate-950 rounded-xl border border-slate-800 overflow-hidden shadow-xl">
        <div className="flex items-center justify-between px-5 py-3 bg-[#0c101a] border-b border-slate-800">
          <div className="flex items-center gap-2">
            <ShieldAlert className="w-4 h-4 text-rose-400" />
            <h2 className="font-display text-sm font-bold tracking-wider text-rose-300 uppercase">
              3. [EVA COMMAND RECOMMENDATIONS]
            </h2>
          </div>
          <span className="text-xs font-mono text-slate-400">3 Actionable High-Priority Directives</span>
        </div>

        <div className="p-6 space-y-4">
          {recommendations.map((rec, index) => (
            <div 
              key={rec.id}
              className={`p-4 rounded-lg border transition-all ${
                rec.executed
                  ? 'bg-emerald-950/20 border-emerald-500/30 text-slate-300'
                  : rec.priority === 'CRITICAL'
                    ? 'bg-rose-950/20 border-rose-500/40 text-slate-200'
                    : 'bg-amber-950/20 border-amber-500/40 text-slate-200'
              }`}
            >
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
                <div className="space-y-1.5 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-xs font-bold text-slate-400">
                      REC #{index + 1} [{rec.id}]
                    </span>
                    <span className={`text-[11px] font-mono font-bold px-2 py-0.5 rounded border ${
                      rec.priority === 'CRITICAL'
                        ? 'bg-rose-500/20 text-rose-300 border-rose-500/40'
                        : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                    }`}>
                      {rec.priority} {rec.category}
                    </span>
                    {rec.executed && (
                      <span className="text-[11px] font-mono text-emerald-400 flex items-center gap-1 font-bold">
                        <CheckCircle2 className="w-3.5 h-3.5" /> EXECUTED
                      </span>
                    )}
                  </div>

                  <h3 className="font-display text-base font-bold text-slate-100">
                    {rec.title}
                  </h3>

                  <p className="text-xs font-mono text-cyan-300 bg-slate-900/80 p-2.5 rounded border border-slate-800">
                    <strong>ACTION DIRECTIVE:</strong> {rec.command}
                  </p>

                  <p className="text-xs text-slate-300 leading-relaxed pt-1">
                    <strong className="text-slate-100">Data Synthesis Justification:</strong> {rec.justification}
                  </p>

                  <p className="text-[11px] font-mono text-slate-400 pt-0.5">
                    <strong>Flight Constraint:</strong> {rec.operationalConstraint}
                  </p>
                </div>

                {/* Interactive Action Controls */}
                <div className="flex sm:flex-col gap-2 shrink-0">
                  <button
                    type="button"
                    onClick={() => onAcknowledgeCommand && onAcknowledgeCommand(rec.id)}
                    disabled={rec.acknowledged}
                    className={`px-3 py-1.5 text-xs font-mono font-semibold rounded border transition-colors ${
                      rec.acknowledged
                        ? 'bg-slate-800 text-slate-500 border-slate-700 cursor-default'
                        : 'bg-slate-800 hover:bg-slate-700 text-slate-200 border-slate-600'
                    }`}
                  >
                    {rec.acknowledged ? "ACKNOWLEDGED" : "ACKNOWLEDGE"}
                  </button>

                  <button
                    type="button"
                    onClick={() => onExecuteCommand && onExecuteCommand(rec.id)}
                    disabled={rec.executed}
                    className={`px-3 py-1.5 text-xs font-mono font-bold rounded border transition-colors ${
                      rec.executed
                        ? 'bg-emerald-900/40 text-emerald-400 border-emerald-500/40 cursor-default'
                        : 'bg-cyan-600 hover:bg-cyan-500 text-white border-cyan-400 shadow-sm'
                    }`}
                  >
                    {rec.executed ? "COMPLETED" : "EXECUTE DIRECTIVE"}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </section>

    </div>
  );
};
