// Analysis: marker search, bandwidth, resonances, filter analysis, L/C matching, cable, crystal and LC resonators.
import { C, type Complex } from "./complex";
import type { SweepPoint } from "./litevna";
import { Z0 } from "./calibration";
import { groupDelay, impedance, swr, reactanceComponent } from "./formats";
import { SPEED_OF_LIGHT } from "./units";

export type SearchMode = "max" | "min" | "peak_left" | "peak_right" | "valley_left" | "valley_right";

/** Index search on a value array (marker SEARCH menu). */
export function search(values: ArrayLike<number>, mode: SearchMode, from = 0): number {
  const n = values.length;
  if (!n) return 0;
  if (mode === "max" || mode === "min") {
    let best = 0;
    for (let i = 1; i < n; i++) if (mode === "max" ? values[i] > values[best] : values[i] < values[best]) best = i;
    return best;
  }
  const peak = mode.startsWith("peak");
  const dir = mode.endsWith("left") ? -1 : 1;
  const better = (a: number, b: number) => (peak ? a > b : a < b);
  for (let i = from + dir; i > 0 && i < n - 1; i += dir)
    if (better(values[i], values[i - 1]) && better(values[i], values[i + 1])) return i;
  return from;
}

export function nearestIndex(data: SweepPoint[], f: number): number {
  if (!data.length) return 0;
  let lo = 0, hi = data.length - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (data[m].f <= f) lo = m; else hi = m; }
  return Math.abs(data[lo].f - f) <= Math.abs(data[hi].f - f) ? lo : hi;
}

/** Linear interpolated crossing frequency between points i and i+1 where values cross `level`. */
function crossing(data: SweepPoint[], v: ArrayLike<number>, i: number, level: number): number {
  const t = (level - v[i]) / (v[i + 1] - v[i] || 1e-30);
  return data[i].f + t * (data[i + 1].f - data[i].f);
}

export interface SwrBand { best: number; bestSwr: number; low: number | null; high: number | null; bw: number | null; pct: number | null }

/** Band where VSWR < threshold around the best match (antenna bandwidth). */
export function swrBandwidth(data: SweepPoint[], threshold = 2): SwrBand | null {
  if (data.length < 2) return null;
  const v = data.map((p) => swr(p.s11));
  const best = search(v, "min");
  if (v[best] >= threshold) return { best, bestSwr: v[best], low: null, high: null, bw: null, pct: null };
  let a = best, b = best;
  while (a > 0 && v[a - 1] < threshold) a--;
  while (b < v.length - 1 && v[b + 1] < threshold) b++;
  const low = a > 0 ? crossing(data, v, a - 1, threshold) : data[0].f;
  const high = b < v.length - 1 ? crossing(data, v, b, threshold) : data[v.length - 1].f;
  return { best, bestSwr: v[best], low, high, bw: high - low, pct: (100 * (high - low)) / data[best].f };
}

/** Frequencies where reactance crosses zero (series/parallel resonances). */
export function resonances(data: SweepPoint[]): { f: number; r: number; kind: "series" | "parallel" }[] {
  const out: { f: number; r: number; kind: "series" | "parallel" }[] = [];
  const z = data.map((p) => impedance(p.s11, "s11"));
  for (let i = 0; i < z.length - 1; i++) {
    if ((z[i][1] < 0 && z[i + 1][1] >= 0) || (z[i][1] > 0 && z[i + 1][1] <= 0)) {
      const t = -z[i][1] / (z[i + 1][1] - z[i][1] || 1e-30);
      out.push({ f: data[i].f + t * (data[i + 1].f - data[i].f), r: z[i][0] + t * (z[i + 1][0] - z[i][0]), kind: z[i][1] < 0 ? "series" : "parallel" });
    }
  }
  return out;
}

export interface FilterResult {
  type: "bandpass" | "bandstop" | "lowpass" | "highpass";
  peakF: number; peakDb: number;
  insertionLoss: number;
  center: number | null;
  bw3: number | null; low3: number | null; high3: number | null;
  bw6: number | null;
  bw60: number | null;
  q: number | null;
  shapeFactor: number | null;
}

/** Filter analysis on S21 (NanoVNA-Saver style). */
export function filterAnalysis(data: SweepPoint[]): FilterResult | null {
  if (data.length < 3) return null;
  const db = data.map((p) => 20 * Math.log10(Math.max(C.abs(p.s21), 1e-12)));
  const pk = search(db, "max"), mn = search(db, "min");
  const peakDb = db[pk];
  const edge = (level: number, dir: -1 | 1, from: number): number | null => {
    for (let i = from; i + dir >= 0 && i + dir < db.length; i += dir) {
      if (db[i + dir] < level) return dir < 0 ? crossing(data, db, i - 1, level) : crossing(data, db, i, level);
    }
    return null;
  };
  const l3 = edge(peakDb - 3, -1, pk), h3 = edge(peakDb - 3, 1, pk);
  const l6 = edge(peakDb - 6, -1, pk), h6 = edge(peakDb - 6, 1, pk);
  const l60 = edge(peakDb - 60, -1, pk), h60 = edge(peakDb - 60, 1, pk);
  let type: FilterResult["type"] = "bandpass";
  if (l3 === null && h3 !== null) type = "lowpass";
  else if (h3 === null && l3 !== null) type = "highpass";
  else if (l3 === null && h3 === null && peakDb - db[mn] > 10 && mn > 0 && mn < db.length - 1) type = "bandstop";
  const center = l3 !== null && h3 !== null ? Math.sqrt(l3 * h3) : null;
  const bw3 = l3 !== null && h3 !== null ? h3 - l3 : null;
  const bw6 = l6 !== null && h6 !== null ? h6 - l6 : null;
  const bw60 = l60 !== null && h60 !== null ? h60 - l60 : null;
  return {
    type, peakF: data[pk].f, peakDb, insertionLoss: -peakDb, center, bw3, low3: type === "lowpass" ? null : l3, high3: h3, bw6, bw60,
    q: center && bw3 ? center / bw3 : null, shapeFactor: bw60 && bw6 ? bw60 / bw6 : null,
  };
}

export interface LcSolution { topology: string; source: string; series: string; load: string }

const xToPart = (x: number, f: number) => {
  if (Math.abs(x) < 1e-9) return "—";
  const c = reactanceComponent(x, f);
  return c.kind === "L" ? `L ${fmt(c.value, "H")}` : `C ${fmt(c.value, "F")}`;
};
const bToPart = (b: number, f: number) => (Math.abs(b) < 1e-12 ? "—" : xToPart(-1 / b, f));
function fmt(v: number, u: string) {
  const p: [number, string][] = [[1e-3, "m"], [1e-6, "µ"], [1e-9, "n"], [1e-12, "p"], [1e-15, "f"]];
  for (const [k, s] of p) if (Math.abs(v) >= k) return `${(v / k).toPrecision(4)} ${s}${u}`;
  return `${v.toExponential(3)} ${u}`;
}

/** L-network solutions that match load impedance z to Z0 at frequency f (device MEASURE → L/C MATCH). */
export function lcMatch(z: Complex, f: number, z0 = Z0): LcSolution[] {
  const out: LcSolution[] = [];
  const [R, X] = z;
  if (!(R > 0) || !isFinite(R)) return out; // lossless, NaN or an exact open: nothing to match
  const y = C.inv(z), G = y[0], B = y[1];
  // Shunt element at the load, series element towards the source (needs G ≤ 1/Z0).
  if (G <= 1 / z0 + 1e-12) {
    const bt = Math.sqrt(Math.max(0, G / z0 - G * G));
    for (const s of [bt, -bt]) {
      const bShunt = s - B;
      const zp = C.inv([G, s]);
      out.push({ topology: "load‖shunt → series", source: "—", series: xToPart(-zp[1], f), load: bToPart(bShunt, f) });
    }
  }
  // Series element at the load, shunt element at the source side (needs R ≤ Z0).
  if (R <= z0 + 1e-12) {
    const xt = Math.sqrt(Math.max(0, R * z0 - R * R));
    for (const s of [xt, -xt]) {
      const xSeries = s - X;
      const yp = C.inv([R, s]);
      out.push({ topology: "series → source shunt", source: bToPart(-yp[1], f), series: xToPart(xSeries, f), load: "—" });
    }
  }
  return out;
}

export interface CableResult { electricalLength: number; physicalLength: number; delay: number; lossDb: number; lossDbPer100m: number }

/** Cable measurement from S11 of an open or shorted line (group delay → length, |S11| → loss). */
export function cableAnalysis(data: SweepPoint[], vf: number): CableResult | null {
  if (data.length < 3) return null;
  const gd = groupDelay(data, "s11");
  const sorted = gd.slice(1, -1).sort((a, b) => a - b);
  const delay = sorted[Math.floor(sorted.length / 2)] / 2; // one-way, median
  const electricalLength = delay * SPEED_OF_LIGHT;
  const physicalLength = electricalLength * vf;
  const mid = data[Math.floor(data.length / 2)];
  const lossDb = -10 * Math.log10(Math.max(C.abs2(mid.s11), 1e-12)) / 2;
  return { electricalLength, physicalLength, delay, lossDb, lossDbPer100m: physicalLength > 0 ? (lossDb / physicalLength) * 100 : 0 };
}

export interface CrystalResult { fs: number; fp: number | null; rm: number; lm: number; cm: number; cp: number | null; q: number }

/** Series crystal in a through fixture (S21): motional parameters (device MEASURE → SERIES XTAL). */
export function crystalAnalysis(data: SweepPoint[], z0 = Z0): CrystalResult | null {
  if (data.length < 5) return null;
  const mag = data.map((p) => C.abs(p.s21));
  const pk = search(mag, "max");
  const fs = data[pk].f;
  const smax = Math.min(mag[pk], 0.999999);
  const rm = 2 * z0 * (1 / smax - 1);
  const lvl = smax / Math.SQRT2;
  let a = pk, b = pk;
  while (a > 0 && mag[a] > lvl) a--;
  while (b < mag.length - 1 && mag[b] > lvl) b++;
  if (a === 0 || b === mag.length - 1) return null;
  const fl = data[a].f + ((lvl - mag[a]) / (mag[a + 1] - mag[a] || 1e-30)) * (data[a + 1].f - data[a].f);
  const fh = data[b - 1].f + ((lvl - mag[b - 1]) / (mag[b] - mag[b - 1] || 1e-30)) * (data[b].f - data[b - 1].f);
  const bw = fh - fl;
  const lm = (rm + 2 * z0) / (2 * Math.PI * bw);
  const cm = 1 / ((2 * Math.PI * fs) ** 2 * lm);
  let fp: number | null = null;
  let mn = pk;
  for (let i = pk + 1; i < mag.length; i++) if (mag[i] < mag[mn]) mn = i;
  if (mn > pk && mn < mag.length - 1) fp = data[mn].f;
  const cp = fp ? cm / ((fp / fs) ** 2 - 1) : null;
  return { fs, fp, rm, lm, cm, cp, q: (2 * Math.PI * fs * lm) / Math.max(rm, 1e-6) };
}

export interface LcResonatorResult { f0: number; r: number; l: number; c: number; q: number; bw: number }

/** Series LC in the through path (S21 peak) or series LC shunted to ground (S21 notch). */
export function lcResonator(data: SweepPoint[], kind: "series" | "shunt", z0 = Z0): LcResonatorResult | null {
  if (data.length < 5) return null;
  const mag = data.map((p) => C.abs(p.s21));
  const i0 = search(mag, kind === "series" ? "max" : "min");
  const f0 = data[i0].f, s0 = Math.min(Math.max(mag[i0], 1e-6), 0.999999);
  const r = kind === "series" ? 2 * z0 * (1 / s0 - 1) : (z0 * s0) / (2 * (1 - s0));
  // −3 dB points relative to the extreme (peak) or between the notch and the passband (notch).
  const lvl = kind === "series" ? s0 / Math.SQRT2 : Math.sqrt((s0 * s0 + 1) / 2);
  let a = i0, b = i0;
  const inside = (m: number) => (kind === "series" ? m > lvl : m < lvl);
  while (a > 0 && inside(mag[a])) a--;
  while (b < mag.length - 1 && inside(mag[b])) b++;
  if (a === 0 || b === mag.length - 1) return null;
  const bw = data[b].f - data[a].f;
  const rl = kind === "series" ? r + 2 * z0 : r + z0 / 2;
  const l = rl / (2 * Math.PI * bw);
  const c = 1 / ((2 * Math.PI * f0) ** 2 * l);
  return { f0, r, l, c, q: (2 * Math.PI * f0 * l) / Math.max(r, 1e-6), bw };
}
