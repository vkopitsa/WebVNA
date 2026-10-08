// Validation of untrusted persisted settings (localStorage, session files, shared links).
// Every value is checked on its own; an invalid one falls back to the default instead of throwing, so a damaged or
// hostile file can neither crash rendering nor push out-of-range values to the instrument.
import { FORMAT_BY_ID } from "./lib/formats";
import { MIN_HZ } from "./lib/protocol";
import { checkLimits } from "./lib/limits";
import { IDEAL_KIT, validateKitData, type CalKit } from "./lib/calibration";
import { PADDINGS, WINDOW_BETA, type TdrSettings } from "./lib/tdr";
import { type GateSettings } from "./lib/gating";
import type { CoreParams } from "./lib/permeability";
import type { Correction } from "./lib/calibration";
import type { FixtureSettings, FixtureStage } from "./lib/deembed";
import { DUTS } from "./lib/mock";
import { LANGS } from "./i18n";
import type { Marker, MeasureMode, State, Trace } from "./store";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isInt = (v: unknown, lo: number, hi: number): v is number => isNum(v) && Number.isInteger(v) && v >= lo && v <= hi;
const inRange = (v: unknown, lo: number, hi: number): v is number => isNum(v) && v >= lo && v <= hi;
const isBool = (v: unknown): v is boolean => typeof v === "boolean";
const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T => typeof v === "string" && (list as readonly string[]).includes(v);
const isComplex = (v: unknown): boolean => Array.isArray(v) && v.length === 2 && isNum(v[0]) && isNum(v[1]);
/** Hex colour only (the value reaches canvas/CSS). */
const isColor = (v: unknown): v is string => typeof v === "string" && /^#[0-9a-fA-F]{3,8}$/.test(v);

export const MAX_HZ = 10e9;
export const MAX_POINTS = 65535;
const MAX_TRACES = 8;
const MAX_STAGES = 32;
const MAX_FILE_POINTS = 100000;

export const MEASURE_MODES: MeasureMode[] = ["off", "lcmatch", "cable", "serieslc", "shuntlc", "xtal", "filter", "resonance", "stats"];
export const SMITH_READOUT_IDS = ["rlc", "rx", "gb", "rpxp", "rplc", "lin", "log", "reim"] as const;
export const SEARCH_MODES = ["max", "min", "peak_left", "peak_right", "valley_left", "valley_right"] as const;
const CHANNELS = ["s11", "s21", "s12", "s22"] as const;
const MEMORY = ["A", "B", "C", "D"] as const;
const SIM_MODEL_IDS = ["litevna", "nanovna-h", "nanovna-h4", "nanovna-stock", "librevna"] as const;

/** Pick `v[k]` when it passes `ok`, else the default. */
function field<T>(v: Obj, k: string, def: T, ok: (x: unknown) => boolean): T { return ok(v[k]) ? (v[k] as T) : def; }

export function sanitizeTdr(v: unknown, def: TdrSettings): TdrSettings {
  const o = isObj(v) ? v : {};
  return {
    enabled: field(o, "enabled", def.enabled, isBool),
    mode: field(o, "mode", def.mode, (x) => oneOf(["lowpass_impulse", "lowpass_step", "bandpass"], x)),
    window: field(o, "window", def.window, (x) => oneOf(Object.keys(WINDOW_BETA), x)),
    velocityFactor: field(o, "velocityFactor", def.velocityFactor, (x) => inRange(x, 0.01, 1)),
    yAxis: field(o, "yAxis", def.yAxis, (x) => oneOf(["linear", "db", "impedance"], x)),
    xAxis: field(o, "xAxis", def.xAxis, (x) => oneOf(["distance", "time"], x)),
    maxDistance: field(o, "maxDistance", def.maxDistance, (x) => inRange(x, 0, 1e6)),
    padding: field(o, "padding", def.padding, (x) => isNum(x) && PADDINGS.includes(x)),
  };
}

export function sanitizeGate(v: unknown, def: GateSettings): GateSettings {
  const o = isObj(v) ? v : {};
  return {
    enabled: field(o, "enabled", def.enabled, isBool),
    channel: field(o, "channel", def.channel, (x) => oneOf(["s11", "s21", "both"], x)),
    type: field(o, "type", def.type, (x) => oneOf(["bandpass", "notch"], x)),
    center: field(o, "center", def.center, (x) => inRange(x, -1e-3, 1e-3)),
    span: field(o, "span", def.span, (x) => inRange(x, 0, 1e-3)),
    window: field(o, "window", def.window, (x) => oneOf(Object.keys(WINDOW_BETA), x)),
  };
}

export function sanitizeCore(v: unknown, def: CoreParams): CoreParams {
  const o = isObj(v) ? v : {};
  const pos = (x: unknown) => isNum(x) && x > 0 && x < 1e6;
  return { turns: field(o, "turns", def.turns, pos), areaMm2: field(o, "areaMm2", def.areaMm2, pos), pathMm: field(o, "pathMm", def.pathMm, pos) };
}

export function sanitizeCorrection(v: unknown, def: Correction): Correction {
  const o = isObj(v) ? v : {};
  const d = (x: unknown) => inRange(x, -1, 1);
  return { s11Delay: field(o, "s11Delay", def.s11Delay, d), s21Delay: field(o, "s21Delay", def.s21Delay, d), s21OffsetDb: field(o, "s21OffsetDb", def.s21OffsetDb, (x) => inRange(x, -1000, 1000)) };
}

export function sanitizeKit(v: unknown, def: CalKit = IDEAL_KIT): CalKit {
  const o = isObj(v) ? v : {};
  const sub = <K extends "open" | "short" | "load" | "thru">(key: K): CalKit[K] => {
    const s = isObj(o[key]) ? (o[key] as Obj) : {};
    const out: Obj = {};
    for (const [k, dv] of Object.entries(def[key])) out[k] = isNum(s[k]) ? s[k] : dv;
    return out as CalKit[K];
  };
  const kit: CalKit = { name: typeof o.name === "string" ? o.name.slice(0, 200) : def.name, open: sub("open"), short: sub("short"), load: sub("load"), thru: sub("thru") };
  if (o.data !== undefined) {
    try {
      validateKitData(o.data);
      const d = o.data as Obj, data: NonNullable<CalKit["data"]> = {};
      for (const std of ["open", "short", "load"] as const) if (d[std] !== undefined) data[std] = d[std] as never;
      kit.data = data;
    } catch { /* malformed measured-standard data: ignore it */ }
  }
  return kit;
}

const OPS = ["deembed", "embed"] as const;

function checkStage(st: unknown): FixtureStage | null {
  if (!isObj(st) || !oneOf(OPS, st.op)) return null;
  if (st.type === "lumped") {
    if (!oneOf(["series", "shunt"], st.kind) || !oneOf(["R", "L", "C"], st.element) || !isNum(st.value)) return null;
    return { type: "lumped", op: st.op, kind: st.kind, element: st.element, value: st.value };
  }
  if (st.type === "line") {
    if (!isNum(st.z0) || st.z0 <= 0 || !isNum(st.lengthM) || !isNum(st.vf) || st.vf <= 0 || st.vf > 1) return null;
    if (st.lossDbPerM !== undefined && !isNum(st.lossDbPerM)) return null;
    return { type: "line", op: st.op, z0: st.z0, lengthM: st.lengthM, vf: st.vf, ...(st.lossDbPerM !== undefined ? { lossDbPerM: st.lossDbPerM } : {}) };
  }
  if (st.type === "file") {
    if (typeof st.name !== "string" || !Array.isArray(st.points) || !st.points.length || st.points.length > MAX_FILE_POINTS) return null;
    let last = -Infinity;
    for (const p of st.points) {
      if (!isObj(p) || !isNum(p.f) || p.f <= last || !Array.isArray(p.s) || p.s.length !== 4 || !p.s.every(isComplex)) return null;
      last = p.f;
    }
    return { type: "file", op: st.op, name: st.name, points: st.points as never };
  }
  return null;
}

export function sanitizeFixture(v: unknown, def: FixtureSettings): FixtureSettings {
  if (!isObj(v)) return def;
  const list = (x: unknown): FixtureStage[] | null => {
    if (!Array.isArray(x) || x.length > MAX_STAGES) return null;
    const out = x.map(checkStage);
    return out.every((s) => s) ? (out as FixtureStage[]) : null;
  };
  const port1 = list(v.port1), port2 = list(v.port2);
  if (!port1 || !port2) return def; // a damaged stage list would silently change the result: drop the whole fixture
  const out: FixtureSettings = { enabled: field(v, "enabled", false, isBool), port1, port2 };
  if (isNum(v.z0) && v.z0 > 0 && v.z0 < 1e6) out.z0 = v.z0;
  return out;
}

function sanitizeTrace(v: unknown, def: Trace): Trace {
  const o = isObj(v) ? v : {};
  const formatOk = typeof o.format === "string" && Object.hasOwn(FORMAT_BY_ID, o.format);
  const sc = isObj(o.scale) ? o.scale : null;
  const defScale = def.scale;
  const scale = {
    auto: sc ? field(sc, "auto", defScale.auto, isBool) : defScale.auto,
    perDiv: sc ? field(sc, "perDiv", defScale.perDiv, (x) => isNum(x) && x > 0) : defScale.perDiv,
    ref: sc ? field(sc, "ref", defScale.ref, isNum) : defScale.ref,
    refPos: sc ? field(sc, "refPos", defScale.refPos, (x) => inRange(x, 0, 8)) : defScale.refPos,
  };
  return {
    enabled: field(o, "enabled", def.enabled, isBool),
    channel: field(o, "channel", def.channel, (x) => oneOf(CHANNELS, x)),
    format: formatOk ? (o.format as Trace["format"]) : def.format,
    color: field(o, "color", def.color, isColor),
    scale,
    memory: o.memory === null || oneOf(MEMORY, o.memory) ? (o.memory as Trace["memory"]) : def.memory,
    math: field(o, "math", def.math, (x) => oneOf(["off", "subtract"], x)),
    limits: checkLimits(o.limits) ?? def.limits,
  };
}

export function sanitizeTraces(v: unknown, defaultFor: (i: number) => Trace): Trace[] | undefined {
  if (!Array.isArray(v) || !v.length) return undefined;
  return v.slice(0, MAX_TRACES).map((t, i) => sanitizeTrace(t, defaultFor(i)));
}

export function sanitizeMarkers(v: unknown, count: number, traceCount: number, defaults: () => Marker[]): Marker[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const def = defaults();
  return def.map((d, i) => {
    const m = v[i];
    if (!isObj(m)) return d;
    return {
      enabled: field(m, "enabled", d.enabled, isBool),
      f: field(m, "f", d.f, (x) => inRange(x, 0, MAX_HZ)),
      trace: field(m, "trace", d.trace, (x) => isInt(x, 0, traceCount - 1)),
      tracking: m.tracking === null || oneOf(SEARCH_MODES, m.tracking) ? (m.tracking as Marker["tracking"]) : d.tracking,
    };
  }).slice(0, count);
}

export interface SanitizeContext {
  keys: readonly (keyof State)[];
  def: State;
  traceDefault: (i: number) => Trace;
  markerCount: number;
  markerDefaults: () => Marker[];
}

/**
 * Persisted-settings object → state patch containing only valid values. Keys not in `ctx.keys` are dropped; a key
 * whose value is invalid is left out (the default or current value stays). Nested objects are repaired field by field.
 */
export function sanitizePersisted(o: Obj, ctx: SanitizeContext): Partial<State> {
  const { def } = ctx;
  const out: Record<string, unknown> = {};
  const put = (k: keyof State, v: unknown, ok: boolean) => { if (ok && ctx.keys.includes(k) && k in o) out[k] = v; };
  const raw = (k: keyof State) => o[k];

  for (const k of ["start", "stop", "cwFreq"] as const) put(k, raw(k), inRange(raw(k), MIN_HZ, MAX_HZ));
  put("points", raw("points"), isInt(raw("points"), 2, MAX_POINTS));
  put("sweepMode", raw("sweepMode"), oneOf(["linear", "log", "cw"], raw("sweepMode")));
  put("swAverage", raw("swAverage"), isInt(raw("swAverage"), 1, 100));
  put("swDiscard", raw("swDiscard"), isInt(raw("swDiscard"), 0, 99));
  put("ifAverage", raw("ifAverage"), isInt(raw("ifAverage"), 1, 80));
  put("powerHf", raw("powerHf"), isInt(raw("powerHf"), 0, 3));
  put("powerLf", raw("powerLf"), isInt(raw("powerLf"), 0, 3));
  put("channelsMode", raw("channelsMode"), isInt(raw("channelsMode"), 0, 2));
  for (const k of ["deviceCal", "enhancedResponse", "smithAdmittance", "showSmith", "showRect", "calEnabled"] as const) put(k, raw(k), isBool(raw(k)));
  put("simDut", raw("simDut"), oneOf(DUTS, raw("simDut")));
  put("simModel", raw("simModel"), oneOf(SIM_MODEL_IDS, raw("simModel")));
  put("lang", raw("lang"), oneOf(LANGS.map(([l]) => l), raw("lang")));
  put("measure", raw("measure"), oneOf(MEASURE_MODES, raw("measure")));
  put("smithReadout", raw("smithReadout"), oneOf(SMITH_READOUT_IDS, raw("smithReadout")));
  put("measureVf", raw("measureVf"), inRange(raw("measureVf"), 0.01, 1));
  put("autoSaveName", raw("autoSaveName"), typeof raw("autoSaveName") === "string" && (raw("autoSaveName") as string).length <= 100);

  put("tdr", sanitizeTdr(o.tdr, def.tdr), "tdr" in o);
  put("gate", sanitizeGate(o.gate, def.gate), "gate" in o);
  put("core", sanitizeCore(o.core, def.core), "core" in o);
  put("correction", sanitizeCorrection(o.correction, def.correction), "correction" in o);
  put("kit", sanitizeKit(o.kit, def.kit), "kit" in o);
  put("fixture", sanitizeFixture(o.fixture, def.fixture), "fixture" in o);

  const traces = sanitizeTraces(o.traces, ctx.traceDefault);
  put("traces", traces, !!traces);
  const traceCount = traces?.length ?? def.traces.length;
  const markers = sanitizeMarkers(o.markers, ctx.markerCount, traceCount, ctx.markerDefaults);
  put("markers", markers, !!markers);

  // software-average discard must stay below the average count
  const avg = (out.swAverage as number | undefined) ?? def.swAverage;
  if (typeof out.swDiscard === "number" && out.swDiscard > avg - 1) out.swDiscard = Math.max(0, avg - 1);
  return out as Partial<State>;
}
