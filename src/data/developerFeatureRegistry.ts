import type { ExcursionState, HudDisplayMode } from '../types/telemetry';
import type { DualSenseLiveState } from '../utils/dualsenseController';

export type FeatureInventoryCategory =
  | 'Controls & Input'
  | 'Physics & AI'
  | 'HUD & Visor'
  | 'Telemetry & Climate'
  | 'Notifications & Audio'
  | 'Map & Cartography';

export type FeatureAuditStatus = 'Active' | 'Configured' | 'Standby' | 'Deprecated';

export interface DeveloperFeatureEntry {
  id: string;
  name: string;
  category: FeatureInventoryCategory;
  filePaths: string[];
  symbols: string;
  summary: string;
  resolveStatus: (ctx: {
    state: ExcursionState;
    hudMode: HudDisplayMode;
    dualsenseConnected: boolean;
    dualsenseCursorMode: boolean;
    isMuted: boolean;
    globalOverrideActive: boolean;
  }) => { status: FeatureAuditStatus; detail: string };
  debugAction?: {
    id:
      | 'toggle_ai_pilot'
      | 'toggle_autopilot_on_select'
      | 'toggle_locomotion'
      | 'cycle_torque'
      | 'toggle_solar_wings'
      | 'toggle_headlights'
      | 'toggle_sensors'
      | 'cycle_o2_mode'
      | 'toggle_frost_mode'
      | 'toggle_blackout'
      | 'cycle_spe'
      | 'inject_worst_case'
      | 'engage_rtb'
      | 'hazard_override'
      | 'reset_pose'
      | 'test_notif_info'
      | 'test_notif_warn'
      | 'test_notif_danger'
      | 'test_notif_ack'
      | 'test_audio_chirp'
      | 'test_audio_alarm'
      | 'toggle_mute'
      | 'cycle_hud_mode'
      | 'goto_hud'
      | 'goto_visor'
      | 'goto_console';
    label: string;
    tone?: 'cyan' | 'amber' | 'rose' | 'emerald';
  };
}

export const DEVELOPER_FEATURE_INVENTORY: DeveloperFeatureEntry[] = [
  {
    id: 'DEV-CTRL-01',
    name: 'DualSense Left Stick X Steering (Inverted Yaw Fix)',
    category: 'Controls & Input',
    filePaths: ['src/utils/dualsenseController.ts', 'src/utils/vehicleController.ts'],
    symbols: 'AXIS_LEFT_X · shapeAxis · steerX',
    summary: 'Inverts W3C Gamepad axes[0] with 0.13 deadzone and exponential smoothing so stick left turns rover/astronaut left natively.',
    resolveStatus: ({ dualsenseConnected }) => ({
      status: dualsenseConnected ? 'Active' : 'Standby',
      detail: dualsenseConnected ? 'PS5 DualSense linked' : 'Awaiting Gamepad API connection',
    }),
  },
  {
    id: 'DEV-CTRL-02',
    name: 'DualSense L2/R2 Analog Throttle Curve',
    category: 'Controls & Input',
    filePaths: ['src/utils/dualsenseController.ts'],
    symbols: 'BTN_R2 · BTN_L2 · shapeTrigger · throttle',
    summary: 'Maps analog L2/R2 trigger depression (0..1) into bidirectional smooth forward/reverse throttle (-1..+1).',
    resolveStatus: ({ dualsenseConnected }) => ({
      status: dualsenseConnected ? 'Active' : 'Standby',
      detail: dualsenseConnected ? 'Analog triggers polling 60Hz' : 'Controller offline',
    }),
  },
  {
    id: 'DEV-CTRL-03',
    name: 'DualSense Right Stick Camera & Virtual DOM Cursor',
    category: 'Controls & Input',
    filePaths: ['src/utils/dualsenseController.ts', 'src/components/VirtualControllerCursor.tsx'],
    symbols: 'cursorMode · cameraX/Y · L1 Precision · Cross Click',
    summary: 'Orbits 3D camera normally; Square toggles virtual pointer cursor with L1 precision damping and Cross synthetic clicks.',
    resolveStatus: ({ dualsenseConnected, dualsenseCursorMode }) => ({
      status: dualsenseCursorMode ? 'Active' : dualsenseConnected ? 'Configured' : 'Standby',
      detail: dualsenseCursorMode ? 'Virtual DOM cursor active' : 'Camera orbit mode ready',
    }),
  },
  {
    id: 'DEV-CTRL-04',
    name: 'DualSense Discrete Action Bindings',
    category: 'Controls & Input',
    filePaths: ['src/utils/dualsenseController.ts', 'src/App.tsx'],
    symbols: 'Triangle · Touchpad · Options · R3 Recenter',
    summary: 'Edge-debounced bindings for AI Co-Pilot (Triangle), Mini-Map/Visor (Touchpad), HUD Switch (Options), and Camera Recenter (R3).',
    resolveStatus: () => ({
      status: 'Configured',
      detail: 'Action callback hooks bound in App.tsx',
    }),
    debugAction: { id: 'toggle_ai_pilot', label: 'Trigger △ AI Pilot', tone: 'cyan' },
  },
  {
    id: 'DEV-CTRL-05',
    name: 'Keyboard WASD / Arrow Drive Controller',
    category: 'Controls & Input',
    filePaths: ['src/App.tsx', 'src/utils/vehicleController.ts'],
    symbols: 'setKeyHeld · digitalSteer (left - right)',
    summary: 'Zero-rerender Set-based key hold tracker for W/A/S/D and Arrow keys with native left/right turn parity.',
    resolveStatus: () => ({
      status: 'Active',
      detail: 'Global keydown/keyup active on HUD & Visor tabs',
    }),
    debugAction: { id: 'reset_pose', label: 'Reset Rover Pose', tone: 'amber' },
  },
  {
    id: 'DEV-PHYS-01',
    name: '60Hz Fixed-Timestep Vehicle Physics & 10Hz Telemetry Sync',
    category: 'Physics & AI',
    filePaths: ['src/utils/vehicleController.ts', 'src/App.tsx'],
    symbols: 'VehiclePhysicsController · VehicleSimulationEngine · vehicleSim',
    summary: 'Runs 60Hz fixed-dt wheel slip, slope drag, and momentum physics while throttling React commits to 10Hz.',
    resolveStatus: ({ state }) => ({
      status: 'Active',
      detail: `Slip ${state.consequences.wheelSlipPercent}% · Integrity ${state.equipment.suitRoverIntegrityPercent}%`,
    }),
    debugAction: { id: 'reset_pose', label: 'Teleport Base', tone: 'cyan' },
  },
  {
    id: 'DEV-AI-01',
    name: 'Autonomous AI Co-Pilot & Hotspot/Cliff Avoidance',
    category: 'Physics & AI',
    filePaths: ['src/utils/vehicleController.ts', 'src/data/marsCartography.ts'],
    symbols: 'stepAutopilotFixed · computePlanetaryRoute · watchdog',
    summary: 'Steers around Jezero radiation hotspots & Olympus Mons 8km scarp using Dijkstra corridors and stall watchdog recovery.',
    resolveStatus: ({ state }) => ({
      status: state.equipment.autonomousAiPilot ? 'Active' : 'Standby',
      detail: state.equipment.autonomousAiPilot
        ? `Locked onto ${state.navigation.targetWaypointId}`
        : 'Manual helm control',
    }),
    debugAction: { id: 'toggle_ai_pilot', label: 'Toggle AI Pilot', tone: 'cyan' },
  },
  {
    id: 'DEV-AI-02',
    name: 'Autopilot-on-Select Guidance Toggle',
    category: 'Physics & AI',
    filePaths: ['src/App.tsx', 'src/components/Mars3DViewport.tsx', 'src/components/NasaDatasetMatrix.tsx'],
    symbols: 'enableAutopilotTravel · handleSetNavTarget',
    summary: 'Automatically engages Autonomous AI Pilot and #52e0ff guidance trail whenever a landmark or beacon is selected.',
    resolveStatus: ({ state }) => ({
      status: state.equipment.enableAutopilotTravel ? 'Active' : 'Configured',
      detail: state.equipment.enableAutopilotTravel ? 'Auto-engage enabled' : 'Manual lock only',
    }),
    debugAction: { id: 'toggle_autopilot_on_select', label: 'Toggle Auto-Select', tone: 'cyan' },
  },
  {
    id: 'DEV-EQ-01',
    name: 'Locomotion Mode Switch (Rover vs 0.38g EVA Walk)',
    category: 'Physics & AI',
    filePaths: ['src/App.tsx', 'src/components/Mars3DViewport.tsx', 'src/utils/vehicleController.ts'],
    symbols: 'equipment.locomotionMode (rover | eva_walk)',
    summary: 'Switches between 6-wheel pressurized rover (22 m/s, 35% rad shielding) and unshielded EVA suit walk (8.5 m/s).',
    resolveStatus: ({ state }) => ({
      status: 'Active',
      detail: state.equipment.locomotionMode === 'rover' ? 'Pressurized Rover' : 'EVA Suit Walk (0.38g)',
    }),
    debugAction: { id: 'toggle_locomotion', label: 'Switch Rover/EVA', tone: 'cyan' },
  },
  {
    id: 'DEV-EQ-02',
    name: 'Drive Speed & Torque Multiplier',
    category: 'Physics & AI',
    filePaths: ['src/App.tsx', 'src/utils/vehicleController.ts'],
    symbols: 'equipment.speedTorqueSetting (0.5x – 2.5x)',
    summary: 'Scales actuator torque, top velocity, motor heating, and regolith wheel slip penalty.',
    resolveStatus: ({ state }) => ({
      status: state.equipment.speedTorqueSetting > 1.4 ? 'Configured' : 'Active',
      detail: `${state.equipment.speedTorqueSetting.toFixed(2)}x torque`,
    }),
    debugAction: { id: 'cycle_torque', label: 'Cycle Torque', tone: 'amber' },
  },
  {
    id: 'DEV-EQ-03',
    name: 'Solar Wing Arrays & Wind-Shear Hinge Physics',
    category: 'Telemetry & Climate',
    filePaths: ['src/App.tsx', 'src/components/Mars3DViewport.tsx'],
    symbols: 'solarPanelsDeployed · solarDustCoatingPercent · solarWingStressPercent',
    summary: 'Calculates Beer-Lambert irradiance harvest, dust coating degradation, and >13.5 m/s wind-shear hinge damage.',
    resolveStatus: ({ state }) => ({
      status: state.equipment.solarPanelsDeployed ? 'Active' : 'Standby',
      detail: state.equipment.solarPanelsDeployed
        ? `${state.consequences.solarOutputWatts}W · Dust ${state.equipment.solarDustCoatingPercent}%`
        : 'Arrays stowed',
    }),
    debugAction: { id: 'toggle_solar_wings', label: 'Toggle Solar Wings', tone: 'amber' },
  },
  {
    id: 'DEV-EQ-04',
    name: 'High-Intensity LED Headlights',
    category: 'HUD & Visor',
    filePaths: ['src/App.tsx', 'src/components/Mars3DViewport.tsx'],
    symbols: 'equipment.headlightsEnabled · headlightSpot',
    summary: 'Controls 3D forward SpotLight beam cone (+28 W draw) and mitigates Tau > 0.85 dust storm collision wear.',
    resolveStatus: ({ state }) => ({
      status: state.equipment.headlightsEnabled ? 'Active' : 'Standby',
      detail: state.equipment.headlightsEnabled ? 'ON (+28W)' : 'OFF (0W)',
    }),
    debugAction: { id: 'toggle_headlights', label: 'Toggle Headlights', tone: 'cyan' },
  },
  {
    id: 'DEV-EQ-05',
    name: 'Science Sensor Bus & SEU Protection',
    category: 'Telemetry & Climate',
    filePaths: ['src/App.tsx'],
    symbols: 'equipment.sensorArrayEnabled · seuBitFlipsCount',
    summary: 'Toggles MEDA/RAD/SuperCam science bus (+18 W) or safes electronics (+4 W) to reduce CME SEU bit-flips.',
    resolveStatus: ({ state }) => ({
      status: state.equipment.sensorArrayEnabled ? 'Active' : 'Standby',
      detail: `${state.consequences.seuBitFlipsCount} SEU bit-flips logged`,
    }),
    debugAction: { id: 'toggle_sensors', label: 'Toggle Sensor Bus', tone: 'cyan' },
  },
  {
    id: 'DEV-EQ-06',
    name: 'O₂ Life-Support Flow Modulation',
    category: 'Telemetry & Climate',
    filePaths: ['src/App.tsx'],
    symbols: 'equipment.oxygenFlowMode (conserve | nominal | high_flow)',
    summary: 'Modulates suit/cabin O₂ bleed rate (0.55 / 0.84 / 1.25 L/min) impacting CO₂ scrubbing and reserve hours.',
    resolveStatus: ({ state }) => ({
      status: 'Active',
      detail: `${state.equipment.oxygenFlowMode.toUpperCase()} (${state.vitals.oxygenPercentage}%)`,
    }),
    debugAction: { id: 'cycle_o2_mode', label: 'Cycle O₂ Mode', tone: 'cyan' },
  },
  {
    id: 'DEV-NOTIF-01',
    name: 'Severity-Based Notification Auto-Dismissal Engine',
    category: 'Notifications & Audio',
    filePaths: ['src/utils/notificationTimers.ts', 'src/App.tsx', 'src/components/MarsWalkHud.tsx', 'src/components/VisorHUD.tsx'],
    symbols: 'NOTIFICATION_AUTO_DISMISS_MS · getSettingToastDismissMs · getHazardAlertDismissMs',
    summary: 'Auto-clears HUD/Visor alerts with 250ms fade-out: Info 3.5s, Warn/Caution 5.5s, Critical/Danger 7.5s, plus manual ACK overrides.',
    resolveStatus: ({ state }) => ({
      status: 'Active',
      detail: state.lastSettingChange
        ? `Toast active (${state.lastSettingChange.severity})`
        : '3.5s / 5.5s / 7.5s timers armed',
    }),
    debugAction: { id: 'test_notif_warn', label: 'Test Warn Toast', tone: 'amber' },
  },
  {
    id: 'DEV-AUD-01',
    name: 'Web Audio Tactical Alert Synthesizer',
    category: 'Notifications & Audio',
    filePaths: ['src/utils/audioAlerts.ts'],
    symbols: 'playChirpSound · playCautionTone · playHazardAlarm · playAckTone',
    summary: 'Generates zero-asset WebAudio telemetry chirps, dual-tone cautions, critical hazard klaxons, and ACK chimes.',
    resolveStatus: ({ isMuted }) => ({
      status: isMuted ? 'Standby' : 'Active',
      detail: isMuted ? 'Audio muted' : 'Audio synth unmuted',
    }),
    debugAction: { id: 'toggle_mute', label: 'Toggle Mute', tone: 'cyan' },
  },
  {
    id: 'DEV-OVR-01',
    name: 'Emergency RTB Override & Countdown Lock',
    category: 'Physics & AI',
    filePaths: ['src/App.tsx'],
    symbols: 'handleEngageEmergencyRtb · HZ-EMERGENCY-RTB · requiresAck',
    summary: 'Clears waypoints, locks AI Pilot onto HAB-01, activates RTB countdown, and enforces manual ACK on emergency banner.',
    resolveStatus: ({ state }) => ({
      status: state.emergencyRtbActive ? 'Active' : 'Configured',
      detail: state.emergencyRtbActive
        ? `RTB LOCKED (${state.returnToBaseTimerSeconds ?? '--'}s)`
        : 'Standby (auto-arms ≤35% integrity)',
    }),
    debugAction: { id: 'engage_rtb', label: 'Engage RTB', tone: 'rose' },
  },
  {
    id: 'DEV-OVR-02',
    name: 'Master Hazard Override & Nominal Restore',
    category: 'Notifications & Audio',
    filePaths: ['src/App.tsx', 'src/components/TopNav.tsx'],
    symbols: 'handleHazardOverride',
    summary: 'Clears dust storms, radiation alerts, comms blackout, failure modes, and RTB locks while restoring suit/rover baseline.',
    resolveStatus: ({ state }) => ({
      status: state.hazardAlert.active || state.emergencyRtbActive ? 'Standby' : 'Active',
      detail: 'Restores nominal EVA envelope',
    }),
    debugAction: { id: 'hazard_override', label: 'Hazard Override', tone: 'emerald' },
  },
  {
    id: 'DEV-3D-01',
    name: 'Three.js 3D Mars Viewport & Camera Presets',
    category: 'HUD & Visor',
    filePaths: ['src/components/Mars3DViewport.tsx', 'src/components/marsTerrain.ts'],
    symbols: 'Mars3DViewport · CameraPreset (closeup | mastcam | overview | orbit)',
    summary: 'Real-time 3D procedural/HiRISE terrain, articulated rocker-bogie rover, dust/SPE particle emitters, and 4 camera rigs.',
    resolveStatus: () => ({
      status: 'Active',
      detail: '4 camera presets + DualSense right-stick orbit',
    }),
    debugAction: { id: 'goto_visor', label: 'Open 3D Visor', tone: 'cyan' },
  },
  {
    id: 'DEV-3D-02',
    name: 'Spectral Surface Rendering Modes',
    category: 'HUD & Visor',
    filePaths: ['src/components/Mars3DViewport.tsx', 'src/utils/marsTileAtlas.ts', 'src/components/MiniMap.tsx'],
    symbols: 'MarsSpectralViewMode (optical | thermal | topographic)',
    summary: 'Switches 3D terrain & radar surfaces between Optical albedo, Thermal IR inertia, and MOLA/HiRISE topographic elevation.',
    resolveStatus: () => ({
      status: 'Configured',
      detail: 'Optical / Thermal / Topographic shaders ready',
    }),
  },
  {
    id: 'DEV-HUD-01',
    name: 'EVA Tactical Leaflet Map HUD',
    category: 'HUD & Visor',
    filePaths: ['src/components/MarsWalkHud.tsx'],
    symbols: 'MarsWalkHud · MARS_TILE_LAYERS (MDIM + MOLA Hillshade)',
    summary: 'Full-screen Leaflet EPSG:4326 Martian map with custom waypoint queue, compass rose, and live life-support gauges.',
    resolveStatus: () => ({
      status: 'Active',
      detail: 'USGS Astro MDIM + NASA Trek Hillshade',
    }),
    debugAction: { id: 'goto_hud', label: 'Open EVA HUD', tone: 'cyan' },
  },
  {
    id: 'DEV-HUD-02',
    name: '3D Optical Visor HUD & Mode Switcher',
    category: 'HUD & Visor',
    filePaths: ['src/components/VisorHUD.tsx', 'src/components/MiniMap.tsx'],
    symbols: 'VisorHUD · HudDisplayMode (minimalist | standard | verbose)',
    summary: 'Helmet visor overlay featuring wing telemetry, corner tactical radar, attitude reticle, and 3 clutter tiers.',
    resolveStatus: ({ hudMode }) => ({
      status: 'Active',
      detail: `Current Visor Mode: ${hudMode.toUpperCase()}`,
    }),
    debugAction: { id: 'cycle_hud_mode', label: 'Cycle Visor Mode', tone: 'cyan' },
  },
  {
    id: 'DEV-HUD-03',
    name: 'ASCII Engineering Telemetry Console',
    category: 'HUD & Visor',
    filePaths: ['src/components/TelemetryReport.tsx'],
    symbols: 'TelemetryReport · EVA Command Recommendations',
    summary: 'Generates live ASCII mission engineering schematic & actionable EVA safety/navigation command checklist.',
    resolveStatus: ({ state }) => ({
      status: 'Active',
      detail: `${state.recommendations.filter((r) => r.executed).length}/${state.recommendations.length} commands executed`,
    }),
    debugAction: { id: 'goto_console', label: 'Open Console', tone: 'cyan' },
  },
  {
    id: 'DEV-MAP-01',
    name: 'Planetary Atlas Drawer & Dijkstra Route Planner',
    category: 'Map & Cartography',
    filePaths: ['src/components/PlanetaryAtlasDrawer.tsx', 'src/data/marsCartography.ts', 'src/utils/marsTileAtlas.ts'],
    symbols: 'PlanetaryAtlasDrawer · computePlanetaryRoute · MARS_PLANETARY_LANDMARKS',
    summary: 'Interactive orthographic globe & azimuthal projection with great-circle arcs and hazard-bypass corridor routing.',
    resolveStatus: ({ globalOverrideActive }) => ({
      status: globalOverrideActive ? 'Active' : 'Configured',
      detail: globalOverrideActive ? 'Global coordinates active' : 'Jezero local datum active',
    }),
  },
  {
    id: 'DEV-CLIM-01',
    name: 'Regional Mars Climate & Polar CO₂ Frost Engine',
    category: 'Telemetry & Climate',
    filePaths: ['src/data/marsClimateEngine.ts', 'src/App.tsx'],
    symbols: 'resolveRegionalEnvironment · classifyMarsBiome · seasonalCo2FrostMode',
    summary: 'Resolves 11 Martian biomes with scale-height pressure, dust weather, and Polar CO₂ dry-ice deposition vs sublimation.',
    resolveStatus: ({ state }) => ({
      status: 'Active',
      detail: `${state.activeEnvironment.regionName} · ${state.activeEnvironment.seasonalCo2FrostMode}`,
    }),
    debugAction: { id: 'toggle_frost_mode', label: 'Toggle CO₂ Frost', tone: 'cyan' },
  },
  {
    id: 'DEV-TEL-01',
    name: 'MEDA / HiRISE / RAD Telemetry & SPE Storm Injector',
    category: 'Telemetry & Climate',
    filePaths: ['src/data/nasaDatasets.ts', 'src/components/NasaDatasetMatrix.tsx'],
    symbols: 'SOL_244_BASELINE_STATE · PRESET_SCENARIOS · generateProceduralWorstCase',
    summary: 'Real Sol 244 atmospheric, slope, and ionizing proton flux datasets with 4 SPE tiers and worst-case procedural faults.',
    resolveStatus: ({ state }) => ({
      status: state.environmental.solarParticleEventActive ? 'Active' : 'Configured',
      detail: `${state.environmental.radiationDoseRateMicroSvHr} µSv/h · Tau ${state.atmospheric.dustOpacityTau}`,
    }),
    debugAction: { id: 'cycle_spe', label: 'Cycle SPE Flux', tone: 'rose' },
  },
  {
    id: 'DEV-TEL-02',
    name: 'Earth-Mars UHF Latency & Blackout Simulator',
    category: 'Telemetry & Climate',
    filePaths: ['src/App.tsx', 'src/components/NasaDatasetMatrix.tsx'],
    symbols: 'comms.earthMarsDelayMinutes · comms.commBlackoutActive',
    summary: 'Simulates 4–24 minute one-way light-time lag and ionospheric UHF relay blackouts with automatic hazard alerts.',
    resolveStatus: ({ state }) => ({
      status: state.comms.commBlackoutActive ? 'Active' : 'Configured',
      detail: state.comms.commBlackoutActive
        ? 'BLACKOUT ACTIVE (0% signal)'
        : `${state.comms.earthMarsDelayMinutes.toFixed(1)}m lag · ${state.comms.signalStrengthPercent}%`,
    }),
    debugAction: { id: 'toggle_blackout', label: 'Toggle Blackout', tone: 'rose' },
  },
  {
    id: 'DEV-SCI-01',
    name: 'Jezero Science POI Scanner & Mastcam-Z Photo Archive',
    category: 'Map & Cartography',
    filePaths: ['src/data/marsTerrain.ts', 'src/components/RoverPhotoViewer.tsx', 'src/data/nasaRoverPhotos.ts'],
    symbols: 'JEZERO_SCIENCE_FEATURES · RoverPhotoViewer · NASA_ROVER_PHOTOS',
    summary: 'Proximity spectroscopy discovery logging in Jezero Crater paired with curated Perseverance Mastcam-Z imagery.',
    resolveStatus: () => ({
      status: 'Active',
      detail: 'Proximity science scan & Mastcam-Z feed ready',
    }),
  },
  {
    id: 'DEV-LEG-01',
    name: 'Legacy Fixed 7s Setting Toast Timer (Superseded)',
    category: 'Notifications & Audio',
    filePaths: ['src/components/MarsWalkHud.tsx', 'src/components/VisorHUD.tsx'],
    symbols: 'useEffect(7000ms) -> Replaced by notificationTimers.ts',
    summary: 'Previous uniform 7-second hardcoded toast timer inside HUD components; superseded by severity-tiered auto-dismissal.',
    resolveStatus: () => ({
      status: 'Deprecated',
      detail: 'Replaced by DEV-NOTIF-01 severity timers',
    }),
  },
];

export type { DualSenseLiveState };
