// Scripting / automation API: `window.webvna` (all builds). Plain JSON-friendly values only (arrays and objects, no typed arrays).
// Nothing here leaves the page: scripts run locally in the browser and drive the same controller the UI uses.
import * as controller from "./controller";
import { get, set, updateMarker, SIM_MODELS, type SimModel, type SweepMode, type State } from "./store";
import type { Dut } from "./lib/mock";
import { DUTS } from "./lib/mock";
import type { SweepPoint } from "./lib/litevna";
import { FORMAT_BY_ID, traceValues } from "./lib/formats";
import { nearestIndex } from "./lib/analysis";
import { evalLimits } from "./lib/limits";
import { writeCsv, writeTouchstone } from "./lib/touchstone";
import { limitsOf } from "./caps";
import { limitReports, traceData } from "./display";

/*
 * Type declarations for the `window.webvna` object (also see README, "Scripting API").
 *
 *   interface Point { f: number; s11: [re, im]; s21: [re, im]; s12?: [re, im]; s22?: [re, im] }
 *
 *   webvna.version                         API version string
 *   webvna.connectSimulator({model?, dut?}) -> Promise<void>   model: "litevna" | "nanovna-h" | "nanovna-h4" | "nanovna-stock"
 *   webvna.connect()                       -> Promise<boolean>  opens the browser's serial chooser (needs a user gesture)
 *   webvna.disconnect()                    -> Promise<void>
 *   webvna.setStimulus({start, stop, points?, mode?, cwFreq?}) -> Stimulus   Hz; mode: "linear" | "log" | "cw"
 *   webvna.sweep()                         -> Promise<Point[]>  one new sweep, calibrated (as shown in the charts)
 *   webvna.run() / webvna.stop()           continuous sweeping
 *   webvna.raw() / webvna.data()           last raw / calibrated sweep
 *   webvna.markers()                       -> [{index, f, trace, value, unit, s11, s21}] enabled markers
 *   webvna.setMarker(i, f)                 place marker i (0-7) at frequency f
 *   webvna.trace(i)                        -> {format, channel, unit, freqs, values}  display values of trace i (0-3)
 *   webvna.limits(i?)                      -> pass/fail result of trace i, or a summary of all traces with limits
 *   webvna.exportTouchstone(ports, fmt)    -> string  ports 1|2, fmt "RI"|"MA"|"DB"
 *   webvna.exportCsv()                     -> string
 *   webvna.on("sweep", cb)                 -> unsubscribe   cb({count, points, ms}) after every completed sweep
 *   webvna.state()                         -> JSON-safe snapshot
 *   webvna.setState(partial)               -> Promise<void>   only the keys in SETTABLE_KEYS; anything else throws
 */

export const API_VERSION = "1.0.0";

/** Settings a script may change through setState(). Everything else (data, calibration, files) is deliberately off limits. */
export const SETTABLE_KEYS = [
  "start", "stop", "points", "sweepMode", "cwFreq", "swAverage", "swDiscard", "ifAverage", "powerHf", "powerLf", "channelsMode",
  "deviceCal", "calEnabled", "simDut", "simModel", "smithAdmittance", "showSmith", "showRect", "measureVf", "autoSaveName",
] as const;
type SettableKey = (typeof SETTABLE_KEYS)[number];
const NUMERIC: SettableKey[] = ["start", "stop", "points", "cwFreq", "swAverage", "swDiscard", "ifAverage", "powerHf", "powerLf", "channelsMode", "measureVf"];
const BOOLEAN: SettableKey[] = ["deviceCal", "calEnabled", "smithAdmittance", "showSmith", "showRect"];

export interface Stimulus { start: number; stop: number; points: number; mode: SweepMode; cwFreq: number }
export interface MarkerInfo { index: number; f: number; trace: number; value: number; unit: string; s11: [number, number]; s21: [number, number] }
export interface TraceInfo { format: string; channel: string; unit: string; freqs: number[]; values: number[] }
export interface SweepEvent { count: number; points: number; ms: number }

const pt = (p: SweepPoint): SweepPoint => {
  const o: SweepPoint = { f: p.f, s11: [p.s11[0], p.s11[1]], s21: [p.s21[0], p.s21[1]] };
  if (p.s12) o.s12 = [p.s12[0], p.s12[1]];
  if (p.s22) o.s22 = [p.s22[0], p.s22[1]];
  return o;
};

function requireConnected() {
  if (get().status !== "connected") throw new Error("Not connected. Call webvna.connectSimulator() or webvna.connect() first.");
}

async function nextSweepCount(before: number, ms = 120000): Promise<void> {
  const t0 = Date.now();
  while (get().sweepCount === before) {
    if (get().status !== "connected") throw new Error("Disconnected while waiting for a sweep.");
    if (Date.now() - t0 > ms) throw new Error("Timed out waiting for a sweep.");
    await new Promise((r) => setTimeout(r, 5));
  }
}

export function createApi() {
  const api = {
    version: API_VERSION,

    async connectSimulator(opts: { model?: SimModel; dut?: Dut } = {}): Promise<void> {
      if (opts.model !== undefined && !SIM_MODELS.includes(opts.model)) throw new Error(`Unknown model "${opts.model}"; use one of ${SIM_MODELS.join(", ")}.`);
      if (opts.dut !== undefined && !DUTS.includes(opts.dut)) throw new Error(`Unknown DUT "${opts.dut}"; use one of ${DUTS.join(", ")}.`);
      set({ ...(opts.model ? { simModel: opts.model } : {}), ...(opts.dut ? { simDut: opts.dut } : {}) });
      await controller.connectSimulator();
      requireConnected();
    },

    /** Opens the browser's serial port chooser; call it from a click handler. Resolves true when connected. */
    async connect(): Promise<boolean> {
      await controller.connectSerial();
      return get().status === "connected";
    },

    async disconnect(): Promise<void> { await controller.disconnect(); },

    setStimulus(p: { start?: number; stop?: number; points?: number; mode?: SweepMode; cwFreq?: number }): Stimulus {
      const s = get();
      const lim = limitsOf(s.capabilities);
      const fin = (v: unknown, name: string) => { if (typeof v !== "number" || !Number.isFinite(v)) throw new Error(`${name} must be a finite number`); return v; };
      let start = p.start !== undefined ? fin(p.start, "start") : s.start;
      let stop = p.stop !== undefined ? fin(p.stop, "stop") : s.stop;
      const points = p.points !== undefined ? Math.round(fin(p.points, "points")) : s.points;
      const mode = p.mode ?? s.sweepMode;
      if (!["linear", "log", "cw"].includes(mode)) throw new Error(`mode must be "linear", "log" or "cw"`);
      if (points < 2) throw new Error("points must be at least 2");
      start = Math.max(lim.minHz, Math.min(start, lim.maxHz));
      stop = Math.max(lim.minHz, Math.min(stop, lim.maxHz));
      if (stop < start) [start, stop] = [stop, start];
      const cwFreq = p.cwFreq !== undefined ? Math.max(lim.minHz, Math.min(fin(p.cwFreq, "cwFreq"), lim.maxHz)) : s.cwFreq;
      set({ start: Math.round(start), stop: Math.round(stop), points: Math.min(points, lim.maxPoints), sweepMode: mode, cwFreq });
      controller.restartIfRunning();
      const n = get();
      return { start: n.start, stop: n.stop, points: n.points, mode: n.sweepMode, cwFreq: n.cwFreq };
    },

    /** Acquire one new sweep and return the corrected data. Waits for a running sweep to finish first. */
    async sweep(): Promise<SweepPoint[]> {
      requireConnected();
      if (get().frozen) throw new Error("Display is frozen; unfreeze before sweeping.");
      if (get().continuous) {
        const c = get().sweepCount;
        await nextSweepCount(c);
        await nextSweepCount(c + 1); // the first one may have used the previous stimulus
        return api.data();
      }
      while (get().running) await new Promise((r) => setTimeout(r, 5));
      const before = get().sweepCount;
      await controller.sweepOnce();
      if (get().sweepCount === before) throw new Error("Sweep failed; see the log in the app.");
      return api.data();
    },

    run(): void { requireConnected(); void controller.startContinuous(); },
    stop(): void { controller.stop(); },

    raw(): SweepPoint[] { return get().raw.map(pt); },
    data(): SweepPoint[] { return get().data.map(pt); },

    markers(): MarkerInfo[] {
      const s = get();
      const out: MarkerInfo[] = [];
      s.markers.forEach((m, index) => {
        if (!m.enabled || !s.data.length) return;
        const t = s.traces[m.trace] ?? s.traces[0];
        const d = traceData(s, t);
        const i = nearestIndex(d, m.f);
        const fmt = FORMAT_BY_ID[t.format].circular ? "logmag" : t.format;
        const value = traceValues(d, t.channel, fmt, { core: s.core })[i];
        out.push({ index, f: d[i].f, trace: m.trace, value, unit: FORMAT_BY_ID[fmt].unit, s11: [...d[i].s11], s21: [...d[i].s21] });
      });
      return out;
    },

    setMarker(i: number, f: number): void {
      if (!Number.isInteger(i) || i < 0 || i >= get().markers.length) throw new Error(`marker index must be 0..${get().markers.length - 1}`);
      if (typeof f !== "number" || !Number.isFinite(f)) throw new Error("frequency must be a finite number");
      updateMarker(i, { enabled: true, f, tracking: null });
      if (get().data.length) controller.updateMarkers();
    },

    trace(i: number): TraceInfo {
      const s = get();
      const t = s.traces[i];
      if (!t) throw new Error(`trace index must be 0..${s.traces.length - 1}`);
      const d = traceData(s, t);
      const fmt = FORMAT_BY_ID[t.format].circular ? "logmag" : t.format;
      return { format: fmt, channel: t.channel, unit: FORMAT_BY_ID[fmt].unit, freqs: d.map((p) => p.f), values: Array.from(traceValues(d, t.channel, fmt, { core: s.core })) };
    },

    /** Pass/fail of trace i against its limit lines, or (no argument) a summary of every trace that has limits. */
    limits(i?: number) {
      const s = get();
      if (i === undefined) {
        const reports = limitReports(s);
        return {
          pass: reports.every((r) => r.status !== "fail"),
          traces: reports.map((r) => ({ trace: r.index, status: r.status, checked: r.result.checked, failures: r.result.failures, worst: r.result.worst })),
        };
      }
      const t = s.traces[i];
      if (!t) throw new Error(`trace index must be 0..${s.traces.length - 1}`);
      const d = traceData(s, t);
      const r = evalLimits(d.map((p) => p.f), traceValues(d, t.channel, FORMAT_BY_ID[t.format].circular ? "logmag" : t.format, { core: s.core }), t.limits);
      return { pass: r.pass, checked: r.checked, failures: r.failures, worst: r.worst, failIndex: [...r.failIndex] };
    },

    exportTouchstone(ports: 1 | 2 = 2, fmt: "RI" | "MA" | "DB" = "RI"): string {
      if (ports !== 1 && ports !== 2) throw new Error("ports must be 1 or 2");
      if (!["RI", "MA", "DB"].includes(fmt)) throw new Error('fmt must be "RI", "MA" or "DB"');
      const d = get().data;
      if (!d.length) throw new Error("No data yet: call webvna.sweep() first.");
      return writeTouchstone(d, ports, `WebVNA ${get().info?.model ?? ""} ${get().cal ? "calibrated" : "raw"}`, fmt);
    },

    exportCsv(): string {
      const d = get().data;
      if (!d.length) throw new Error("No data yet: call webvna.sweep() first.");
      return writeCsv(d);
    },

    on(event: "sweep", cb: (e: SweepEvent) => void): () => void {
      if (event !== "sweep") throw new Error('Only the "sweep" event exists.');
      return controller.onSweepComplete(() => { const s = get(); cb({ count: s.sweepCount, points: s.data.length, ms: s.lastSweepMs }); });
    },

    state() {
      const s = get();
      return {
        status: s.status, link: s.linkKind, model: s.info?.model ?? null, firmware: s.info?.firmware ?? (s.info ? `${s.info.fwMajor}.${s.info.fwMinor}` : null),
        capabilities: s.capabilities ? { ...s.capabilities } : null,
        start: s.start, stop: s.stop, points: s.points, sweepMode: s.sweepMode, cwFreq: s.cwFreq,
        swAverage: s.swAverage, swDiscard: s.swDiscard, ifAverage: s.ifAverage, powerHf: s.powerHf, powerLf: s.powerLf, channelsMode: s.channelsMode,
        deviceCal: s.deviceCal, calEnabled: s.calEnabled, calibrated: !!s.cal, running: s.running, continuous: s.continuous,
        sweepCount: s.sweepCount, lastSweepMs: s.lastSweepMs, simModel: s.simModel, simDut: s.simDut,
        traces: s.traces.map((t) => ({ enabled: t.enabled, channel: t.channel, format: t.format })),
        markers: s.markers.map((m, index) => ({ index, enabled: m.enabled, f: m.f, trace: m.trace })),
        activeTrace: s.activeTrace, lang: s.lang,
      };
    },

    /** Change settings. Only SETTABLE_KEYS are accepted; anything else throws and nothing is applied. */
    async setState(partial: Partial<Pick<State, SettableKey>>): Promise<void> {
      if (!partial || typeof partial !== "object") throw new Error("setState expects an object");
      const keys = Object.keys(partial);
      const bad = keys.filter((k) => !(SETTABLE_KEYS as readonly string[]).includes(k));
      if (bad.length) throw new Error(`Not allowed in setState: ${bad.join(", ")}. Allowed: ${SETTABLE_KEYS.join(", ")}.`);
      const rec = partial as Record<string, unknown>;
      for (const k of keys) {
        const v = rec[k];
        if ((NUMERIC as string[]).includes(k) && !(typeof v === "number" && Number.isFinite(v))) throw new Error(`${k} must be a finite number`);
        if ((BOOLEAN as string[]).includes(k) && typeof v !== "boolean") throw new Error(`${k} must be true or false`);
      }
      if (partial.sweepMode !== undefined && !["linear", "log", "cw"].includes(partial.sweepMode)) throw new Error("sweepMode must be linear, log or cw");
      if (partial.simDut !== undefined && !DUTS.includes(partial.simDut)) throw new Error("unknown simDut");
      if (partial.simModel !== undefined && !SIM_MODELS.includes(partial.simModel)) throw new Error("unknown simModel");
      if (partial.autoSaveName !== undefined && typeof partial.autoSaveName !== "string") throw new Error("autoSaveName must be a string");

      const { start, stop, points, sweepMode, cwFreq, ifAverage, powerHf, powerLf, channelsMode, deviceCal, simDut, simModel, calEnabled, ...rest } = partial;
      if (start !== undefined || stop !== undefined || points !== undefined || sweepMode !== undefined || cwFreq !== undefined)
        api.setStimulus({ start, stop, points, mode: sweepMode, cwFreq });
      if (simDut !== undefined) controller.setSimDut(simDut);
      if (simModel !== undefined) controller.setSimModel(simModel);
      if (ifAverage !== undefined) await controller.setIfAverage(ifAverage);
      if (powerHf !== undefined || powerLf !== undefined) await controller.setPower({ hf: powerHf, lf: powerLf });
      if (channelsMode !== undefined) await controller.setChannelsMode(channelsMode);
      if (deviceCal !== undefined) await controller.setDeviceCal(deviceCal);
      if (calEnabled !== undefined) { set({ calEnabled }); controller.recompute(); }
      if (Object.keys(rest).length) { set(rest as Partial<State>); if ("swAverage" in rest || "swDiscard" in rest) controller.restartIfRunning(); }
    },
  };
  return api;
}

export type WebvnaApi = ReturnType<typeof createApi>;

declare global { interface Window { webvna: WebvnaApi } }

/** Publish `window.webvna` (no-op outside a browser). */
export function installApi(): WebvnaApi {
  const api = createApi();
  if (typeof window !== "undefined") window.webvna = api;
  return api;
}
