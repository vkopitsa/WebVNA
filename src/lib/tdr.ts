// Time-domain transform (docs/05 §TDR): low-pass impulse/step, band-pass, Kaiser windows, distance axis.
import { C, type Complex } from "./complex";
import type { SweepPoint } from "./litevna";
import { channelValue, type Channel } from "./formats";
import { SPEED_OF_LIGHT } from "./units";
import { Z0 } from "./calibration";

export type TdrMode = "lowpass_impulse" | "lowpass_step" | "bandpass";
export type TdrWindow = "minimum" | "normal" | "maximum";
export const WINDOW_BETA: Record<TdrWindow, number> = { minimum: 0, normal: 6, maximum: 13 };

export interface TdrSettings {
  enabled: boolean;
  mode: TdrMode;
  window: TdrWindow;
  velocityFactor: number;
  /** Plot y-axis: linear reflection coefficient, dB, or impedance (step only). */
  yAxis: "linear" | "db" | "impedance";
  /** X axis in distance (m) or time (s). */
  xAxis: "distance" | "time";
  maxDistance: number; // meters, 0 = full range
  /** FFT size multiplier (zero padding / interpolation): 1, 2, 4, 8 or 16. */
  padding: number;
}

export const PADDINGS = [1, 2, 4, 8, 16];

export const DEFAULT_TDR: TdrSettings = {
  enabled: false, mode: "lowpass_impulse", window: "normal", velocityFactor: 0.66, yAxis: "linear", xAxis: "distance", maxDistance: 0, padding: 1,
};

/** In-place radix-2 complex FFT. inverse=true computes the unnormalised inverse. */
export function fft(re: Float64Array, im: Float64Array, inverse = false): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let j = 0; j < len / 2; j++) {
        const a = i + j, b = a + len / 2;
        const tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr;
        re[b] = re[a] - tr; im[b] = im[a] - ti;
        re[a] += tr; im[a] += ti;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr; cr = ncr;
      }
    }
  }
}

function besselI0(x: number): number {
  let sum = 1, term = 1;
  for (let k = 1; k < 50; k++) { term *= (x / (2 * k)) ** 2; sum += term; if (term < 1e-12 * sum) break; }
  return sum;
}

/** Kaiser window value for position t ∈ [−1, 1]. */
export function kaiser(t: number, beta: number): number {
  if (beta === 0) return 1;
  return besselI0(beta * Math.sqrt(Math.max(0, 1 - t * t))) / besselI0(beta);
}

export interface TdrResult {
  /** Time of each output sample, seconds (one-way for distance computation already handled). */
  time: Float64Array;
  distance: Float64Array;
  /** Real-valued response (impulse/step real part, or band-pass magnitude). */
  value: Float64Array;
  resolution: number; // m
  range: number; // m
}

function interpAt(data: SweepPoint[], ch: Channel, f: number): Complex {
  const n = data.length;
  if (f <= data[0].f) return channelValue(data[0], ch);
  if (f >= data[n - 1].f) return channelValue(data[n - 1], ch);
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (data[m].f <= f) lo = m; else hi = m; }
  const t = (f - data[lo].f) / (data[hi].f - data[lo].f || 1);
  return C.lerp(channelValue(data[lo], ch), channelValue(data[hi], ch), t);
}

export function timeDomain(data: SweepPoint[], ch: Channel, s: TdrSettings): TdrResult | null {
  if (data.length < 4) return null;
  const N = data.length;
  const beta = WINDOW_BETA[s.window];
  const fStop = data[N - 1].f, fStart = data[0].f;
  const lowpass = s.mode !== "bandpass";
  const pad = PADDINGS.includes(s.padding) ? s.padding : 1; // old persisted settings lack the field
  const nfft = Math.max(1024, 1 << Math.ceil(Math.log2(N * 4))) * pad;
  const re = new Float64Array(nfft), im = new Float64Array(nfft);
  let df: number;
  if (lowpass) {
    // Harmonic grid f_k = k·Δf, k = 1..N; DC extrapolated from the first points (real).
    df = fStop / N;
    for (let k = 1; k <= N; k++) {
      const v = C.scale(interpAt(data, ch, k * df), kaiser(k / (N + 1), beta));
      re[k] = v[0]; im[k] = v[1];
      re[nfft - k] = v[0]; im[nfft - k] = -v[1];
    }
    const g1 = interpAt(data, ch, df), g2 = interpAt(data, ch, 2 * df);
    // DC is real: linear extrapolation of the real part from the two lowest harmonics.
    re[0] = Math.max(-1, Math.min(1, 2 * g1[0] - g2[0]));
    if (fStart > 2 * df) re[0] = channelValue(data[0], ch)[0]; // sweep starts high: no better information
  } else {
    df = (fStop - fStart) / (N - 1);
    for (let k = 0; k < N; k++) {
      const v = C.scale(channelValue(data[k], ch), kaiser((2 * k) / (N - 1) - 1, beta));
      re[k] = v[0]; im[k] = v[1];
    }
  }
  fft(re, im, true);
  const norm = lowpass ? 1 / (N + 1) : 1 / N;
  const tStep = 1 / (nfft * df);
  const roundTrip = ch === "s11" ? 2 : 1;
  const vel = SPEED_OF_LIGHT * s.velocityFactor;
  const outLen = nfft / 2;
  const value = new Float64Array(outLen), time = new Float64Array(outLen), distance = new Float64Array(outLen);
  let acc = 0;
  for (let i = 0; i < outLen; i++) {
    time[i] = i * tStep;
    distance[i] = (time[i] * vel) / roundTrip;
    if (s.mode === "lowpass_impulse") value[i] = re[i] * norm * 2;
    else if (s.mode === "lowpass_step") { acc += re[i] * norm * 2; value[i] = acc; }
    else value[i] = Math.hypot(re[i], im[i]) * norm * 2;
  }
  if (s.mode === "lowpass_step" && s.yAxis === "impedance")
    for (let i = 0; i < outLen; i++) { const r = Math.max(-0.999, Math.min(0.999, value[i])); value[i] = (Z0 * (1 + r)) / (1 - r); }
  else if (s.yAxis === "db") for (let i = 0; i < outLen; i++) value[i] = 20 * Math.log10(Math.max(Math.abs(value[i]), 1e-9));
  const span = lowpass ? fStop : fStop - fStart;
  return { time, distance, value, resolution: vel / (roundTrip * span), range: vel / (roundTrip * df) };
}

/** Distance to the strongest reflection (for cable fault finding). */
export function strongestPeak(r: TdrResult, minIndex = 2): number {
  let best = minIndex;
  for (let i = minIndex; i < r.value.length; i++) if (Math.abs(r.value[i]) > Math.abs(r.value[best])) best = i;
  return best;
}
