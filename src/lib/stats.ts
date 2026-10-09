// Trace statistics over an index range.
export interface TraceStats {
  n: number;
  min: number;
  max: number;
  mean: number;
  std: number;
  peakToPeak: number;
  /** Least-squares slope, units per Hz (NaN when n < 2 or all frequencies are equal). */
  slope: number;
  /** Peak-to-peak of the residual after removing the least-squares line (NaN when slope is NaN). */
  flatness: number;
  fMin: number;
  fMax: number;
}

/** Statistics for indices i0..i1 (inclusive, any order, clamped); non-finite values are skipped. Null if none are finite. */
export function traceStats(freqs: ArrayLike<number>, values: ArrayLike<number>, i0: number, i1: number): TraceStats | null {
  const len = Math.min(freqs.length, values.length);
  if (len === 0) return null;
  const a = Math.max(0, Math.min(len - 1, Math.min(i0, i1))), b = Math.max(0, Math.min(len - 1, Math.max(i0, i1)));
  const xs: number[] = [], ys: number[] = [];
  let min = Infinity, max = -Infinity, fMin = NaN, fMax = NaN, sum = 0;
  for (let i = a; i <= b; i++) {
    const v = values[i], f = freqs[i];
    if (!Number.isFinite(v) || !Number.isFinite(f)) continue;
    xs.push(f); ys.push(v); sum += v;
    if (v < min) { min = v; fMin = f; }
    if (v > max) { max = v; fMax = f; }
  }
  const n = ys.length;
  if (n < 1) return null;
  const mean = sum / n;
  let ss = 0;
  for (const y of ys) ss += (y - mean) ** 2;
  const std = Math.sqrt(ss / n);
  let slope = NaN, flatness = NaN;
  if (n >= 2) {
    const xm = xs.reduce((p, x) => p + x, 0) / n;
    let sxx = 0, sxy = 0;
    for (let i = 0; i < n; i++) { sxx += (xs[i] - xm) ** 2; sxy += (xs[i] - xm) * (ys[i] - mean); }
    if (sxx > 0) {
      slope = sxy / sxx;
      let rmin = Infinity, rmax = -Infinity;
      for (let i = 0; i < n; i++) {
        const r = ys[i] - (mean + slope * (xs[i] - xm));
        if (r < rmin) rmin = r;
        if (r > rmax) rmax = r;
      }
      flatness = rmax - rmin;
    }
  }
  return { n, min, max, mean, std, peakToPeak: max - min, slope, flatness, fMin, fMax };
}

/** Passband ripple of a whole trace (e.g. insertion loss in dB). Null if no finite values. */
export function rippleAnalysis(freqs: ArrayLike<number>, values: ArrayLike<number>): { maxValue: number; minValue: number; ripple: number } | null {
  const s = traceStats(freqs, values, 0, values.length - 1);
  return s && { maxValue: s.max, minValue: s.min, ripple: s.peakToPeak };
}
