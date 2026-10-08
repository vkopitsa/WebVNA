// Trace formats (docs/05-MEASUREMENTS.md) — every format available on the LiteVNA screen and in NanoVNA-App/Saver.
import { C, type Complex } from "./complex";
import type { SweepPoint } from "./litevna";
import { Z0 } from "./calibration";
import { DEFAULT_CORE, permeability, type CoreParams } from "./permeability";

export type Channel = "s11" | "s21" | "s12" | "s22";

/** Reflection channels (S11, S22) are interpreted as impedances; transmission channels as series-through fixtures. */
export const isReflection = (ch: Channel) => ch === "s11" || ch === "s22";

/** S-parameter of a point for a channel; NaN pair when the data lacks it (S12/S22 on one-path sweeps). */
export const channelValue = (p: SweepPoint, ch: Channel): Complex => p[ch] ?? [NaN, NaN];

export type FormatId =
  | "logmag" | "phase" | "uphase" | "delay" | "smith" | "polar" | "swr" | "linear" | "real" | "imag"
  | "r" | "x" | "rw" | "xw" | "absz" | "zphase" | "q" | "l" | "c" | "mu_r" | "mu_i" | "rp" | "xp" | "lp" | "cp" | "g" | "b" | "absy"
  | "rl" | "mismatch" | "s21gain";

export interface FormatDef {
  id: FormatId;
  label: string;
  unit: string;
  /** Plotted on Smith/polar chart instead of the rectangular grid. */
  circular?: boolean;
  /** Default scale: per-division value and reference value at the reference position. */
  perDiv: number;
  ref: number;
  refPos: number; // division (0 = bottom, 8 = top)
  impedance?: boolean;
}

export const FORMATS: FormatDef[] = [
  { id: "logmag", label: "LOGMAG", unit: "dB", perDiv: 10, ref: 0, refPos: 7 },
  { id: "phase", label: "PHASE", unit: "°", perDiv: 45, ref: 0, refPos: 4 },
  { id: "uphase", label: "UNWRAPPED PHASE", unit: "°", perDiv: 360, ref: 0, refPos: 4 },
  { id: "delay", label: "DELAY", unit: "s", perDiv: 1e-9, ref: 0, refPos: 4 },
  { id: "smith", label: "SMITH", unit: "", circular: true, perDiv: 1, ref: 0, refPos: 0 },
  { id: "polar", label: "POLAR", unit: "", circular: true, perDiv: 1, ref: 0, refPos: 0 },
  { id: "swr", label: "SWR", unit: "", perDiv: 0.5, ref: 1, refPos: 0 },
  { id: "linear", label: "LINEAR", unit: "", perDiv: 0.125, ref: 0, refPos: 0 },
  { id: "real", label: "REAL", unit: "", perDiv: 0.25, ref: 0, refPos: 4 },
  { id: "imag", label: "IMAG", unit: "", perDiv: 0.25, ref: 0, refPos: 4 },
  { id: "r", label: "RESISTANCE", unit: "Ω", perDiv: 25, ref: 0, refPos: 0, impedance: true },
  { id: "x", label: "REACTANCE", unit: "Ω", perDiv: 25, ref: 0, refPos: 4, impedance: true },
  { id: "rw", label: "R/ω", unit: "Ω·s", perDiv: 1e-8, ref: 0, refPos: 0, impedance: true },
  { id: "xw", label: "X/ω", unit: "H", perDiv: 1e-8, ref: 0, refPos: 4, impedance: true },
  { id: "absz", label: "|Z|", unit: "Ω", perDiv: 25, ref: 0, refPos: 0, impedance: true },
  { id: "zphase", label: "Z PHASE", unit: "°", perDiv: 22.5, ref: 0, refPos: 4, impedance: true },
  { id: "q", label: "Q FACTOR", unit: "", perDiv: 5, ref: 0, refPos: 0, impedance: true },
  { id: "l", label: "SERIES L", unit: "H", perDiv: 1e-8, ref: 0, refPos: 4, impedance: true },
  { id: "c", label: "SERIES C", unit: "F", perDiv: 1e-11, ref: 0, refPos: 4, impedance: true },
  { id: "mu_r", label: "µ′", unit: "", perDiv: 50, ref: 0, refPos: 0, impedance: true },
  { id: "mu_i", label: "µ″", unit: "", perDiv: 50, ref: 0, refPos: 0, impedance: true },
  { id: "rp", label: "PARALLEL R", unit: "Ω", perDiv: 50, ref: 0, refPos: 0, impedance: true },
  { id: "xp", label: "PARALLEL X", unit: "Ω", perDiv: 50, ref: 0, refPos: 4, impedance: true },
  { id: "lp", label: "PARALLEL L", unit: "H", perDiv: 1e-8, ref: 0, refPos: 4, impedance: true },
  { id: "cp", label: "PARALLEL C", unit: "F", perDiv: 1e-11, ref: 0, refPos: 4, impedance: true },
  { id: "g", label: "CONDUCTANCE", unit: "S", perDiv: 0.005, ref: 0, refPos: 0, impedance: true },
  { id: "b", label: "SUSCEPTANCE", unit: "S", perDiv: 0.005, ref: 0, refPos: 4, impedance: true },
  { id: "absy", label: "|Y|", unit: "S", perDiv: 0.005, ref: 0, refPos: 0, impedance: true },
  { id: "rl", label: "RETURN LOSS", unit: "dB", perDiv: 5, ref: 0, refPos: 0 },
  { id: "mismatch", label: "MISMATCH LOSS", unit: "dB", perDiv: 1, ref: 0, refPos: 0 },
  { id: "s21gain", label: "GAIN", unit: "dB", perDiv: 10, ref: 0, refPos: 7 },
];

export const FORMAT_BY_ID = Object.fromEntries(FORMATS.map((f) => [f.id, f])) as Record<FormatId, FormatDef>;

/**
 * Impedance seen by the VNA. S11: Z = Z0(1+Γ)/(1−Γ). S21: series-through fixture Z = 2·Z0·(1−S21)/S21.
 */
export function impedance(s: Complex, ch: Channel, z0 = Z0): Complex {
  if (isReflection(ch)) return C.scale(C.div(C.add([1, 0], s), C.sub([1, 0], s)), z0);
  return C.scale(C.div(C.sub([1, 0], s), s), 2 * z0);
}

export function unwrap(ph: number[]): number[] {
  const out = ph.slice();
  for (let i = 1; i < out.length; i++) {
    let d = out[i] - out[i - 1];
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d < -Math.PI) d += 2 * Math.PI;
    out[i] = out[i - 1] + d;
  }
  return out;
}

/** Group delay in seconds, central difference of unwrapped phase (same as src/core.js). */
export function groupDelay(data: SweepPoint[], key: Channel = "s21"): number[] {
  const ph = unwrap(data.map((p) => C.arg(channelValue(p, key))));
  return data.map((_, i) => {
    const a = Math.max(0, i - 1), b = Math.min(data.length - 1, i + 1);
    return -(ph[b] - ph[a]) / (2 * Math.PI * (data[b].f - data[a].f || 1));
  });
}

/** VSWR; Infinity when |Γ| ≥ 1 (possible with a calibration that doesn't fit the setup). */
export function swr(g: Complex): number {
  const m = C.abs(g);
  return m >= 1 ? Infinity : (1 + m) / (1 - m);
}

export interface FormatOptions { core?: CoreParams }

/** Scalar value of one point in a rectangular format. */
export function formatValue(fmt: FormatId, s: Complex, f: number, ch: Channel, opts?: FormatOptions): number {
  const w = 2 * Math.PI * f;
  const mag = C.abs(s);
  switch (fmt) {
    case "logmag": case "s21gain": return 20 * Math.log10(Math.max(mag, 1e-12));
    case "rl": return -20 * Math.log10(Math.max(mag, 1e-12));
    case "mismatch": return -10 * Math.log10(Math.max(1 - Math.min(mag, 0.999999) ** 2, 1e-12));
    case "phase": return (C.arg(s) * 180) / Math.PI;
    case "swr": return swr(s);
    case "linear": return mag;
    case "real": return s[0];
    case "imag": return s[1];
  }
  const z = impedance(s, ch);
  const y = C.inv(z);
  switch (fmt) {
    case "r": return z[0];
    case "x": return z[1];
    case "rw": return z[0] / w;
    case "xw": return z[1] / w;
    case "mu_r": return permeability(z, f, opts?.core ?? DEFAULT_CORE).mu1;
    case "mu_i": return permeability(z, f, opts?.core ?? DEFAULT_CORE).mu2;
    case "absz": return C.abs(z);
    case "zphase": return (C.arg(z) * 180) / Math.PI;
    case "q": return Math.abs(z[1]) / Math.max(Math.abs(z[0]), 1e-12);
    case "l": return z[1] / w;
    case "c": return -1 / (w * (z[1] || 1e-30));
    case "rp": return 1 / (y[0] || 1e-30);
    case "xp": return -1 / (y[1] || 1e-30);
    case "lp": return -1 / (w * (y[1] || 1e-30));
    case "cp": return y[1] / w;
    case "g": return y[0];
    case "b": return y[1];
    case "absy": return C.abs(y);
  }
  return NaN;
}

/** Values of a whole trace (handles formats that need the whole sweep: delay, unwrapped phase). */
export function traceValues(data: SweepPoint[], ch: Channel, fmt: FormatId, opts?: FormatOptions): Float64Array {
  const out = new Float64Array(data.length);
  if (fmt === "delay") { groupDelay(data, ch).forEach((v, i) => (out[i] = v)); return out; }
  if (fmt === "uphase") { unwrap(data.map((p) => C.arg(channelValue(p, ch)))).forEach((v, i) => (out[i] = (v * 180) / Math.PI)); return out; }
  for (let i = 0; i < data.length; i++) out[i] = formatValue(fmt, channelValue(data[i], ch), data[i].f, ch, opts);
  return out;
}

/** Equivalent component for a reactance at frequency f: "L 12.3 nH" / "C 4.7 pF". */
export function reactanceComponent(x: number, f: number): { kind: "L" | "C"; value: number } {
  const w = 2 * Math.PI * f;
  return x >= 0 ? { kind: "L", value: x / w } : { kind: "C", value: -1 / (w * x) };
}
