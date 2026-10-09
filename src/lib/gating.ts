// Time-domain gating (LibreVNA style): FD → TD → gate → FD on the measured uniform linear grid, band-pass style.
import type { Complex } from "./complex";
import type { SweepPoint } from "./litevna";
import { fft, kaiser, WINDOW_BETA, type TdrWindow } from "./tdr";
import { SPEED_OF_LIGHT } from "./units";

export interface GateSettings {
  enabled: boolean;
  channel: "s11" | "s21" | "both";
  type: "bandpass" | "notch";
  /** Gate centre and span, seconds (time 0 = reference plane; round trip for s11, one-way for s21). */
  center: number;
  span: number;
  /** Edge shape: Kaiser beta from WINDOW_BETA ("minimum" = hard rectangle). */
  window: TdrWindow;
}

export const DEFAULT_GATE: GateSettings = { enabled: false, channel: "s11", type: "bandpass", center: 0, span: 1e-9, window: "normal" };

/** Kaiser beta of the frequency-domain pre-window that suppresses sidelobes (end value 1/I0(3) ≈ 0.2). */
const PRE_BETA = 3;

/** True when the grid is increasing, uniform and long enough to gate. */
export function canGate(data: SweepPoint[]): boolean {
  const n = data.length;
  if (n < 4) return false;
  const d = (data[n - 1].f - data[0].f) / (n - 1);
  if (!(d > 0)) return false;
  const tol = Math.max(2, 1e-3 * d); // device rounds frequencies to whole Hz
  for (let i = 1; i < n; i++) if (Math.abs(data[i].f - data[i - 1].f - d) > tol) return false;
  return true;
}

const fftSize = (n: number) => Math.max(1024, 1 << Math.ceil(Math.log2(n * 4)));

/** Time step of the transform grid and the largest unambiguous positive time (1/(2Δf)), seconds. */
export function gateTimeAxis(data: SweepPoint[]): { dt: number; tMax: number } {
  const n = data.length;
  const d = n > 1 ? (data[n - 1].f - data[0].f) / (n - 1) : 0;
  if (!(d > 0)) return { dt: 0, tMax: 0 };
  return { dt: 1 / (fftSize(n) * d), tMax: 1 / (2 * d) };
}

/** Time for a distance d [m]; a reflection (roundTrip) travels the path twice. */
export const distanceToTime = (d: number, vf: number, roundTrip = true): number => (d * (roundTrip ? 2 : 1)) / (SPEED_OF_LIGHT * vf);

/** Gate value at signed time t: rect over centre±span/2, edges (width span/4, centred on the span limits) shaped by a Kaiser ramp. */
function gateAt(t: number, g: GateSettings): number {
  const lo = g.center - g.span / 2, hi = g.center + g.span / 2;
  const beta = WINDOW_BETA[g.window];
  const e = beta === 0 ? 0 : g.span / 4;
  const ramp = (x: number) => (e === 0 ? (x >= 0 ? 1 : 0) : x <= -e / 2 ? 0 : x >= e / 2 ? 1 : kaiser(1 - (x + e / 2) / e, beta));
  const v = Math.min(ramp(t - lo), ramp(hi - t));
  return g.type === "notch" ? 1 - v : v;
}

/**
 * Gate one channel. Band-pass transform on f_k = f0 + kΔ: g_n = Σ X_k e^{j2πkn/M} is the time response h(t_n) times
 * e^{-j2πf0 t_n}; a real gate commutes with that phase, so f0 needs no extra handling and a delay τ peaks at t = τ
 * (time 0 = reference plane). A Kaiser(3) window precedes the transform to cut sidelobes and is divided out afterwards.
 * No separate gate-response normalisation: an all-pass gate returns the input exactly, and the window floor (≈0.2 at the
 * band edges) bounds noise amplification, so the outer ~10% of the band is less accurate.
 */
function gateChannel(data: SweepPoint[], ch: "s11" | "s21" | "s12" | "s22", g: GateSettings): Complex[] {
  const N = data.length, M = fftSize(N);
  const d = (data[N - 1].f - data[0].f) / (N - 1);
  const w = Array.from({ length: N }, (_, k) => kaiser((2 * k) / (N - 1) - 1, PRE_BETA));
  const re = new Float64Array(M), im = new Float64Array(M);
  for (let k = 0; k < N; k++) { re[k] = data[k][ch]![0] * w[k]; im[k] = data[k][ch]![1] * w[k]; }
  fft(re, im, true);
  for (let n = 0; n < M; n++) {
    const a = gateAt((n < M / 2 ? n : n - M) / (M * d), g);
    re[n] *= a; im[n] *= a;
  }
  fft(re, im, false);
  return Array.from({ length: N }, (_, k) => [re[k] / (M * w[k]), im[k] / (M * w[k])] as Complex);
}

export function applyGate(data: SweepPoint[], g: GateSettings): SweepPoint[] {
  if (!g.enabled || !(g.span > 0) || !canGate(data)) return data;
  const s11 = g.channel !== "s21" ? gateChannel(data, "s11", g) : null;
  const s21 = g.channel !== "s11" ? gateChannel(data, "s21", g) : null;
  // with both channels selected the reverse parameters are gated the same way (s22 like s11, s12 like s21), when present
  const both = g.channel === "both";
  const s22 = both && data.every((p) => p.s22) ? gateChannel(data, "s22", g) : null;
  const s12 = both && data.every((p) => p.s12) ? gateChannel(data, "s12", g) : null;
  return data.map((p, i) => ({
    ...p,
    s11: s11 ? s11[i] : p.s11, s21: s21 ? s21[i] : p.s21,
    ...(s22 ? { s22: s22[i] } : {}), ...(s12 ? { s12: s12[i] } : {}),
  }));
}
