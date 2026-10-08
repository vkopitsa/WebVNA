// Application state (zustand). Device I/O lives in controller.ts; this file only holds data and pure setters.
import { create } from "zustand";
import type { SweepPoint } from "./lib/litevna";
import type { DeviceInfo } from "./lib/protocol";
import type { DriverCapabilities } from "./lib/driver";
import { IDEAL_KIT, NO_CORRECTION, type CalData, type CalKit, type Correction, type ErrorTerms, type Standard } from "./lib/calibration";
import type { Channel, FormatId } from "./lib/formats";
import { FORMAT_BY_ID } from "./lib/formats";
import type { SearchMode } from "./lib/analysis";
import { DEFAULT_TDR, type TdrSettings } from "./lib/tdr";
import { DEFAULT_GATE, type GateSettings } from "./lib/gating";
import { DEFAULT_CORE, type CoreParams } from "./lib/permeability";
import type { LimitSegment } from "./lib/limits";
import { NO_FIXTURE, type FixtureSettings } from "./lib/deembed";
import type { Dut } from "./lib/mock";
import type { Complex } from "./lib/complex";
import type { SmithReadout } from "./display";
import { tr, type Lang } from "./i18n";
import { sanitizePersisted } from "./validate";

export type ConnStatus = "disconnected" | "connecting" | "connected";
export type SweepMode = "linear" | "log" | "cw";
export type MeasureMode = "off" | "lcmatch" | "cable" | "serieslc" | "shuntlc" | "xtal" | "filter" | "resonance" | "stats";
export type SimModel = "litevna" | "nanovna-h" | "nanovna-h4" | "nanovna-stock" | "librevna";
export const SIM_MODELS: SimModel[] = ["litevna", "nanovna-h", "nanovna-h4", "nanovna-stock", "librevna"];
export type MemorySlot = "A" | "B" | "C" | "D";
export const MEMORY_SLOTS: MemorySlot[] = ["A", "B", "C", "D"];

export interface TraceScale { auto: boolean; perDiv: number; ref: number; refPos: number }

export interface Trace {
  enabled: boolean;
  channel: Channel;
  format: FormatId;
  color: string;
  scale: TraceScale;
  /** Overlay a stored memory (A–D) or an imported reference file (index into refs). */
  memory: MemorySlot | null;
  /** Show data/memory (dB subtraction) instead of the live data. */
  math: "off" | "subtract";
  /** Pass/fail limit lines in the trace's display units (frequency domain). */
  limits: LimitSegment[];
}

export interface Marker { enabled: boolean; f: number; trace: number; tracking: SearchMode | null }

export interface RefFile { name: string; data: SweepPoint[]; ports: number; visible: boolean; color: string }

export interface LogEntry { t: number; msg: string; level: "info" | "error" | "comms" }

export const TRACE_COLORS = ["#e8c547", "#3fb7e8", "#e8579b", "#6ae86a"];
export const MARKER_COUNT = 8;

const scaleFor = (format: FormatId): TraceScale => {
  const d = FORMAT_BY_ID[format];
  return { auto: format !== "logmag" && format !== "phase" && format !== "swr", perDiv: d.perDiv, ref: d.ref, refPos: d.refPos };
};

export const newTrace = (channel: Channel, format: FormatId, color: string, enabled = true): Trace =>
  ({ enabled, channel, format, color, scale: scaleFor(format), memory: null, math: "off", limits: [] });

export interface CalWork {
  freqs: number[] | null;
  meas: Partial<Record<Standard, Complex[]>>;
  thru11: Complex[] | null;
}

/** Full 2-port by flipping the DUT: raw forward/reversed sweeps and the combined result (not persisted). */
export interface TwoPortState { fwd: SweepPoint[] | null; rev: SweepPoint[] | null; result: SweepPoint[] | null }

export interface State {
  lang: Lang;
  // connection
  status: ConnStatus;
  linkKind: string;
  info: DeviceInfo | null;
  /** What the connected driver supports (not persisted); null when disconnected. */
  capabilities: DriverCapabilities | null;
  serial: string;
  vbat: number | null;
  simDut: Dut;
  simModel: SimModel;
  // stimulus
  start: number;
  stop: number;
  points: number;
  sweepMode: SweepMode;
  cwFreq: number;
  swAverage: number;
  /** Sweeps dropped (furthest from the mean) per point when software-averaging. */
  swDiscard: number;
  ifAverage: number;
  powerHf: number;
  powerLf: number;
  channelsMode: number;
  deviceCal: boolean;
  // sweep state
  running: boolean;
  continuous: boolean;
  progress: number;
  sweepCount: number;
  lastSweepMs: number;
  raw: SweepPoint[];
  data: SweepPoint[];
  frozen: boolean;
  // calibration
  calWork: CalWork;
  cal: CalData | null;
  terms: ErrorTerms | null;
  calEnabled: boolean;
  kit: CalKit;
  enhancedResponse: boolean;
  correction: Correction;
  fixture: FixtureSettings;
  twoPort: TwoPortState;
  // display
  traces: Trace[];
  activeTrace: number;
  memories: Partial<Record<MemorySlot, SweepPoint[]>>;
  refs: RefFile[];
  markers: Marker[];
  activeMarker: number;
  deltaRef: number | null;
  tdr: TdrSettings;
  gate: GateSettings;
  core: CoreParams;
  smithAdmittance: boolean;
  smithReadout: SmithReadout;
  showSmith: boolean;
  showRect: boolean;
  measure: MeasureMode;
  measureVf: number;
  // misc
  log: LogEntry[];
  commsMonitor: boolean;
  autoSave: boolean;
  autoSaveName: string;
  screenshot: { width: number; height: number; url: string } | null;
}

export const defaultTraces = (): Trace[] => [
  newTrace("s11", "logmag", TRACE_COLORS[0]),
  newTrace("s11", "swr", TRACE_COLORS[1]),
  newTrace("s11", "smith", TRACE_COLORS[2]),
  newTrace("s21", "logmag", TRACE_COLORS[3], false),
];

const defaultMarkers = (): Marker[] =>
  Array.from({ length: MARKER_COUNT }, (_, i) => ({ enabled: i === 0, f: 0, trace: 0, tracking: i === 0 ? "min" : null }));

export const initialState: State = {
  lang: "en",
  status: "disconnected", linkKind: "", info: null, capabilities: null, serial: "", vbat: null, simDut: "antenna", simModel: "litevna",
  start: 300e6, stop: 600e6, points: 201, sweepMode: "linear", cwFreq: 435e6, swAverage: 1, swDiscard: 0, ifAverage: 1, powerHf: 3, powerLf: 1, channelsMode: 0, deviceCal: false,
  running: false, continuous: false, progress: 0, sweepCount: 0, lastSweepMs: 0, raw: [], data: [], frozen: false,
  calWork: { freqs: null, meas: {}, thru11: null }, cal: null, terms: null, calEnabled: true, kit: IDEAL_KIT, enhancedResponse: false, correction: NO_CORRECTION, fixture: NO_FIXTURE, twoPort: { fwd: null, rev: null, result: null },
  traces: defaultTraces(), activeTrace: 0, memories: {}, refs: [], markers: defaultMarkers(), activeMarker: 0, deltaRef: null,
  tdr: DEFAULT_TDR, gate: DEFAULT_GATE, core: DEFAULT_CORE, smithAdmittance: false, smithReadout: "rlc", showSmith: true, showRect: true, measure: "off", measureVf: 0.66,
  log: [], commsMonitor: false, autoSave: false, autoSaveName: "sweep", screenshot: null,
};

/** Keys persisted to localStorage (user settings, not data). */
const PERSIST: (keyof State)[] = [
  "start", "stop", "points", "sweepMode", "cwFreq", "swAverage", "swDiscard", "ifAverage", "powerHf", "powerLf", "channelsMode", "deviceCal",
  "kit", "enhancedResponse", "correction", "fixture", "traces", "markers", "tdr", "gate", "core", "smithAdmittance", "smithReadout", "showSmith", "showRect", "measure", "measureVf", "simDut", "simModel",
  "calEnabled", "autoSaveName", "lang",
];
const STORAGE_KEY = "webvna.settings.v1";

/** The persisted settings of a state snapshot (for session files). */
export function persistedSettings(s: State): Record<string, unknown> {
  const o: Record<string, unknown> = {};
  for (const k of PERSIST) o[k] = s[k];
  return o;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);

/** Fill fields missing from a persisted object with defaults (recursively; arrays and unknown extra keys are kept). */
export function mergeDefaults<T>(def: T, val: unknown): T {
  if (!isObj(def) || !isObj(val)) return (val === undefined || val === null ? def : val) as T;
  const out: Record<string, unknown> = { ...val };
  for (const k of Object.keys(def)) out[k] = mergeDefaults(def[k], val[k]);
  return out as T;
}

/** Persisted settings → state patch: only known keys with valid values (old files get defaults for missing fields). */
export function mergePersisted(o: Record<string, unknown>): Partial<State> {
  if (!isObj(o)) return {};
  return sanitizePersisted(o, {
    keys: PERSIST, def: initialState, markerCount: MARKER_COUNT, markerDefaults: defaultMarkers,
    traceDefault: (i) => initialState.traces[i] ?? newTrace("s11", "logmag", TRACE_COLORS[i % 4], false),
  });
}

function loadPersisted(): Partial<State> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? mergePersisted(JSON.parse(raw)) : {};
  } catch { return {}; }
}

export const useStore = create<State>()(() => ({ ...initialState, ...loadPersisted() }));

let saveTimer: ReturnType<typeof setTimeout> | null = null;
let saveFailed = false;
useStore.subscribe((s) => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const o: Record<string, unknown> = {};
      for (const k of PERSIST) o[k] = s[k];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(o));
      saveFailed = false;
    } catch (e) {
      // e.g. quota exceeded by calibration-standard data in the kit; warn once (log() re-enters this subscriber)
      if (!saveFailed) { saveFailed = true; log(tr("Couldn't save settings: {0}", e instanceof Error ? e.message : String(e)), "error"); }
    }
  }, 400);
});

export const set = useStore.setState;
export const get = useStore.getState;

export function log(msg: string, level: LogEntry["level"] = "info") {
  set((s) => ({ log: [...s.log.slice(-499), { t: Date.now(), msg, level }] }));
}

export function updateTrace(i: number, patch: Partial<Trace>) {
  set((s) => ({ traces: s.traces.map((t, k) => (k === i ? { ...t, ...patch } : t)) }));
}

export function updateMarker(i: number, patch: Partial<Marker>) {
  set((s) => ({ markers: s.markers.map((m, k) => (k === i ? { ...m, ...patch } : m)) }));
}

export function setTraceFormat(i: number, format: FormatId) {
  updateTrace(i, { format, scale: scaleFor(format) });
}

export function resetSettings() {
  try { localStorage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
  set({ ...initialState, lang: get().lang, status: get().status, info: get().info, capabilities: get().capabilities, linkKind: get().linkKind });
}
