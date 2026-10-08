// Application state (zustand). Device I/O lives in controller.ts; this file only holds data and pure setters.
import { create } from "zustand";
import type { SweepPoint } from "./lib/litevna";
import type { DeviceInfo } from "./lib/protocol";
import { IDEAL_KIT, NO_CORRECTION, type CalData, type CalKit, type Correction, type ErrorTerms, type Standard } from "./lib/calibration";
import type { Channel, FormatId } from "./lib/formats";
import { FORMAT_BY_ID } from "./lib/formats";
import type { SearchMode } from "./lib/analysis";
import { DEFAULT_TDR, type TdrSettings } from "./lib/tdr";
import type { Dut } from "./lib/mock";
import type { Complex } from "./lib/complex";
import type { SmithReadout } from "./display";
import type { Lang } from "./i18n";

export type ConnStatus = "disconnected" | "connecting" | "connected";
export type SweepMode = "linear" | "log" | "cw";
export type MeasureMode = "off" | "lcmatch" | "cable" | "serieslc" | "shuntlc" | "xtal" | "filter" | "resonance";
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
  ({ enabled, channel, format, color, scale: scaleFor(format), memory: null, math: "off" });

export interface CalWork {
  freqs: number[] | null;
  meas: Partial<Record<Standard, Complex[]>>;
  thru11: Complex[] | null;
}

export interface State {
  lang: Lang;
  // connection
  status: ConnStatus;
  linkKind: string;
  info: DeviceInfo | null;
  serial: string;
  vbat: number | null;
  simDut: Dut;
  // stimulus
  start: number;
  stop: number;
  points: number;
  sweepMode: SweepMode;
  cwFreq: number;
  swAverage: number;
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
  // display
  traces: Trace[];
  activeTrace: number;
  memories: Partial<Record<MemorySlot, SweepPoint[]>>;
  refs: RefFile[];
  markers: Marker[];
  activeMarker: number;
  deltaRef: number | null;
  tdr: TdrSettings;
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
  status: "disconnected", linkKind: "", info: null, serial: "", vbat: null, simDut: "antenna",
  start: 300e6, stop: 600e6, points: 201, sweepMode: "linear", cwFreq: 435e6, swAverage: 1, ifAverage: 1, powerHf: 3, powerLf: 1, channelsMode: 0, deviceCal: false,
  running: false, continuous: false, progress: 0, sweepCount: 0, lastSweepMs: 0, raw: [], data: [], frozen: false,
  calWork: { freqs: null, meas: {}, thru11: null }, cal: null, terms: null, calEnabled: true, kit: IDEAL_KIT, enhancedResponse: false, correction: NO_CORRECTION,
  traces: defaultTraces(), activeTrace: 0, memories: {}, refs: [], markers: defaultMarkers(), activeMarker: 0, deltaRef: null,
  tdr: DEFAULT_TDR, smithAdmittance: false, smithReadout: "rlc", showSmith: true, showRect: true, measure: "off", measureVf: 0.66,
  log: [], commsMonitor: false, autoSave: false, autoSaveName: "sweep", screenshot: null,
};

/** Keys persisted to localStorage (user settings, not data). */
const PERSIST: (keyof State)[] = [
  "start", "stop", "points", "sweepMode", "cwFreq", "swAverage", "ifAverage", "powerHf", "powerLf", "channelsMode", "deviceCal",
  "kit", "enhancedResponse", "correction", "traces", "markers", "tdr", "smithAdmittance", "smithReadout", "showSmith", "showRect", "measure", "measureVf", "simDut",
  "calEnabled", "autoSaveName", "lang",
];
const STORAGE_KEY = "webvna.settings.v1";
/** The last applied calibration (written by the controller, cleared by resetSettings). */
export const ACTIVE_CAL_KEY = "webvna.activecal";

/**
 * A persisted value coerced to the shape of its default, field by field: anything missing or of the wrong type takes the
 * default, so a settings file from an older (or newer) version keeps every field that still fits. Arrays keep the default's length.
 */
function sanitize<T>(v: unknown, d: T): T {
  if (Array.isArray(d)) return (Array.isArray(v) ? d.map((x, i) => (i < v.length ? sanitize(v[i], x) : x)) : d) as T;
  if (d === null || typeof d === "string") return (v === null || typeof v === "string" ? v : d) as T; // Trace.memory, Marker.tracking are string | null either way
  if (typeof d === "object") {
    if (v === null || typeof v !== "object" || Array.isArray(v)) return d;
    return Object.fromEntries(Object.entries(d).map(([k, dv]) => [k, sanitize((v as Record<string, unknown>)[k], dv)])) as T;
  }
  if (typeof d === "number") return (typeof v === "number" && Number.isFinite(v) ? v : d) as T;
  return (typeof v === typeof d ? v : d) as T;
}

function loadPersisted(): Partial<State> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const o = JSON.parse(raw);
    if (o === null || typeof o !== "object") return {};
    const out: Partial<State> = {};
    for (const k of PERSIST) if (k in o) (out as Record<string, unknown>)[k] = sanitize(o[k], initialState[k]); // malformed fields fall back to the defaults
    if (out.traces) out.traces = out.traces.map((t, i) => (t.format in FORMAT_BY_ID ? t : initialState.traces[i]));
    return out;
  } catch { return {}; }
}

export const useStore = create<State>()(() => ({ ...initialState, ...loadPersisted() }));

let saveTimer: ReturnType<typeof setTimeout> | null = null;
useStore.subscribe((s) => {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      const o: Record<string, unknown> = {};
      for (const k of PERSIST) o[k] = s[k];
      localStorage.setItem(STORAGE_KEY, JSON.stringify(o));
    } catch { /* storage unavailable */ }
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
  try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(ACTIVE_CAL_KEY); } catch { /* ignore */ } // the cal is reset too; keep storage in step
  set({ ...initialState, lang: get().lang, status: get().status, info: get().info, linkKind: get().linkKind });
}
