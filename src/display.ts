// Turns state into plot-ready series, shared by charts and the marker table.
import { C } from "./lib/complex";
import type { SweepPoint } from "./lib/litevna";
import { FORMAT_BY_ID, impedance, reactanceComponent, traceValues, type FormatId } from "./lib/formats";
import { timeDomain } from "./lib/tdr";
import { niceStep, si } from "./lib/units";
import type { State, Trace, TraceScale } from "./store";
import { tr } from "./i18n";

/** SWR above this is "fully mismatched" (|Γ| > 0.935); auto scale doesn't zoom out further. */
export const SWR_AUTO_CAP = 30;

export interface Series {
  traceIndex: number;
  label: string;
  color: string;
  x: Float64Array;
  y: Float64Array;
  unit: string;
  dashed?: boolean;
  scale: TraceScale;
  primary: boolean;
}

/** data/memory: subtract dB for magnitude formats, degrees for phase; ratio for linear. */
function mathSubtract(a: SweepPoint[], b: SweepPoint[]): SweepPoint[] {
  const n = Math.min(a.length, b.length);
  const out: SweepPoint[] = [];
  for (let i = 0; i < n; i++) out.push({ f: a[i].f, s11: C.div(a[i].s11, b[i].s11), s21: C.div(a[i].s21, b[i].s21) });
  return out;
}

export function traceData(s: State, t: Trace): SweepPoint[] {
  if (t.math === "subtract" && t.memory && s.memories[t.memory]) return mathSubtract(s.data, s.memories[t.memory]!);
  return s.data;
}

/** Auto scale over finite values; `floor` anchors the bottom (SWR = 1), `cap` limits the top. */
export function autoScale(y: ArrayLike<number>, divisions = 8, opt: { floor?: number; cap?: number } = {}): TraceScale {
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < y.length; i++) { const v = y[i]; if (isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
  if (!isFinite(lo)) {
    if (opt.floor == null) return { auto: true, perDiv: 1, ref: 0, refPos: 0 };
    lo = opt.floor; hi = opt.cap ?? lo + divisions; // no finite value (e.g. SWR all ∞): keep the floor
  } else if (opt.floor != null) lo = opt.floor;
  if (opt.cap != null) hi = Math.min(hi, opt.cap);
  if (hi - lo < 1e-15) { const d = Math.abs(hi) * 0.1 || 1; lo -= d; hi += d; }
  let perDiv = niceStep((hi - lo) / divisions);
  let ref = Math.floor(lo / perDiv) * perDiv;
  if (ref + perDiv * divisions < hi) { perDiv = niceStep((hi - ref) / divisions); ref = Math.floor(lo / perDiv) * perDiv; }
  return { auto: true, perDiv, ref, refPos: 0 };
}

/** Rectangular series for every enabled non-circular trace (+ memory and reference overlays). */
export function rectSeries(s: State): { series: Series[]; xKind: "freq" | "distance" | "time"; xUnit: string } {
  const series: Series[] = [];
  const tdr = s.tdr.enabled;
  const xKind = tdr ? s.tdr.xAxis : "freq";
  const tdrChannels = new Set<string>();
  s.traces.forEach((t, ti) => {
    if (!t.enabled || FORMAT_BY_ID[t.format].circular) return;
    if (tdr) { if (tdrChannels.has(t.channel)) return; tdrChannels.add(t.channel); } // one transform per channel
    const sets: { data: SweepPoint[]; label: string; dashed: boolean; color: string; primary: boolean }[] = [];
    const d = traceData(s, t);
    if (d.length) sets.push({ data: d, label: "", dashed: false, color: t.color, primary: true });
    if (t.memory && t.math === "off" && s.memories[t.memory]) sets.push({ data: s.memories[t.memory]!, label: ` ${tr("mem {0}", t.memory)}`, dashed: true, color: t.color, primary: false });
    if (ti === s.activeTrace)
      for (const r of s.refs) if (r.visible && (t.channel === "s11" || r.ports === 2)) sets.push({ data: r.data, label: ` ${r.name}`, dashed: true, color: r.color, primary: false });
    for (const set of sets) {
      if (tdr) {
        const r = timeDomain(set.data, t.channel, s.tdr);
        if (!r) continue;
        let n = r.value.length;
        if (s.tdr.maxDistance > 0) { n = 0; while (n < r.distance.length && r.distance[n] <= s.tdr.maxDistance) n++; }
        const x = (s.tdr.xAxis === "distance" ? r.distance : r.time).slice(0, n);
        const unit = s.tdr.yAxis === "impedance" && s.tdr.mode === "lowpass_step" ? "Ω" : s.tdr.yAxis === "db" ? "dB" : "";
        series.push({ traceIndex: ti, label: `${t.channel.toUpperCase()} ${s.tdr.mode.replace("_", " ")}${set.label}`, color: set.color, x, y: r.value.slice(0, n), unit, dashed: set.dashed, scale: autoScale(r.value.slice(0, n)), primary: set.primary });
      } else {
        const y = traceValues(set.data, t.channel, t.format);
        const x = Float64Array.from(set.data, (p) => p.f);
        const fd = FORMAT_BY_ID[t.format];
        const scale = t.scale.auto ? (t.format === "swr" ? autoScale(y, 8, { floor: 1, cap: SWR_AUTO_CAP }) : autoScale(y)) : t.scale;
        series.push({ traceIndex: ti, label: `${t.channel.toUpperCase()} ${tr(fd.label)}${t.math === "subtract" ? ` /${t.memory}` : ""}${set.label}`, color: set.color, x, y, unit: fd.unit, dashed: set.dashed, scale, primary: set.primary });
      }
    }
  });
  return { series, xKind, xUnit: xKind === "distance" ? "m" : xKind === "time" ? "s" : "Hz" };
}

export function valueText(fmt: FormatId, v: number): string {
  const d = FORMAT_BY_ID[fmt];
  if (Number.isNaN(v) || (!isFinite(v) && fmt !== "swr")) return "—";
  switch (fmt) {
    case "logmag": case "s21gain": case "rl": case "mismatch": return `${v.toFixed(2)} dB`;
    case "phase": case "uphase": case "zphase": return `${v.toFixed(2)}°`;
    case "swr": return isFinite(v) ? v.toFixed(3) : "∞ (|Γ| ≥ 1)";
    case "linear": case "real": case "imag": return v.toFixed(4);
    case "q": return v.toFixed(2);
    default: return si(v, d.unit);
  }
}

export type SmithReadout = "rlc" | "rx" | "gb" | "rpxp" | "rplc" | "lin" | "log" | "reim";
export const SMITH_READOUTS: [SmithReadout, string][] = [
  ["rlc", "R + L/C"], ["rx", "R + jX"], ["gb", "G + jB"], ["rpxp", "Rp + jXp"], ["rplc", "Rp + L/C"], ["lin", "Lin ∠"], ["log", "Log ∠"], ["reim", "Re + Im"],
];

const sgn = (v: number) => (v >= 0 ? "+" : "−");

/** Smith marker readout in the device's formats (default "R + jX Ω (L/C)"). */
export function zText(s: SweepPoint, ch: "s11" | "s21", mode: SmithReadout = "rlc"): string {
  const g = s[ch];
  const z = impedance(g, ch);
  const deg = (C.arg(g) * 180) / Math.PI;
  const open = z[0] === Infinity; // exact open: Z = ∞, Y = 0 (NaN stays NaN)
  if (open && (mode === "rx" || mode === "rlc" || mode === "rpxp" || mode === "rplc")) return "∞ Ω";
  switch (mode) {
    case "rx": return `${z[0].toFixed(2)} ${sgn(z[1])} j${Math.abs(z[1]).toFixed(2)} Ω`;
    case "lin": return `${C.abs(g).toFixed(4)} ∠ ${deg.toFixed(2)}°`;
    case "log": return `${(20 * Math.log10(Math.max(C.abs(g), 1e-12))).toFixed(2)} dB ∠ ${deg.toFixed(2)}°`;
    case "reim": return `${g[0].toFixed(4)} ${sgn(g[1])} j${Math.abs(g[1]).toFixed(4)}`;
    case "gb": { const y = C.inv(z); return `${si(y[0], "S", 3)} ${sgn(y[1])} j${si(Math.abs(y[1]), "S", 3)}`; }
    case "rpxp": case "rplc": {
      const y = C.inv(z);
      const rp = 1 / (y[0] || 1e-30), xp = -1 / (y[1] || 1e-30);
      if (mode === "rpxp") return `${rp.toFixed(2)} ∥ ${sgn(xp)}j${Math.abs(xp).toFixed(2)} Ω`;
      const c = reactanceComponent(xp, s.f);
      return `${rp.toFixed(2)} Ω ∥ ${si(c.value, c.kind === "L" ? "H" : "F", 3)}`;
    }
    default: {
      const c = reactanceComponent(z[1], s.f);
      return `${z[0].toFixed(2)} ${sgn(z[1])} j${Math.abs(z[1]).toFixed(2)} Ω (${si(c.value, c.kind === "L" ? "H" : "F", 3)})`;
    }
  }
}

/** Readout for one trace at a point index. */
export function traceReadout(s: State, t: Trace, i: number): string {
  const d = traceData(s, t);
  const p = d[i];
  if (!p) return "—";
  if (FORMAT_BY_ID[t.format].circular) {
    if (t.format === "polar") return zText(p, t.channel, "lin");
    return zText(p, t.channel, s.smithReadout);
  }
  if (t.format === "delay") return valueText(t.format, traceValues(d.slice(Math.max(0, i - 1), i + 2), t.channel, t.format)[i > 0 ? 1 : 0]);
  if (t.format === "uphase") return valueText(t.format, traceValues(d, t.channel, t.format)[i]);
  return valueText(t.format, traceValues([p], t.channel, t.format)[0]);
}

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || "#888";
}
