// RF component tests on S11/S21 data: antenna Q, stability factors, splitter balance, isolation, coupler directivity,
// antenna gain (Friis), passband ripple and filter masks. Multi-sweep tests compare stored sweeps on the same grid.
import { C, type Complex } from "./complex";
import type { SweepPoint } from "./litevna";
import type { LimitSegment } from "./limits";
import { SPEED_OF_LIGHT } from "./units";
import type { SwrBand } from "./analysis";

/** |z| in dB; -Infinity for 0. */
export const s21Db = (z: Complex) => 20 * Math.log10(C.abs(z));
const wrap180 = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Antenna Q from the fractional VSWR < s bandwidth (Yaghjian & Best 2005): Q ≈ (s − 1) / (√s · FBW). */
export function antennaQ(fbw: number, s = 2): number {
  if (!(fbw > 0) || !(s > 1)) return NaN;
  return (s - 1) / (Math.sqrt(s) * fbw);
}

export interface Stability { k: number; delta: number; mu: number; muPrime: number }

/** Rollett K, |Δ| and Edwards–Sinsky μ (load side) / μ′ (source side). μ > 1 ⇔ unconditionally stable. */
export function stability(s11: Complex, s21: Complex, s12: Complex, s22: Complex): Stability {
  const d = C.sub(C.mul(s11, s22), C.mul(s12, s21));
  const a11 = C.abs(s11) ** 2, a22 = C.abs(s22) ** 2, ad = C.abs(d) ** 2, p = C.abs(C.mul(s12, s21));
  return {
    k: (1 - a11 - a22 + ad) / (2 * p),
    delta: Math.sqrt(ad),
    mu: (1 - a11) / (C.abs(C.sub(s22, C.mul(d, C.conj(s11)))) + p),
    muPrime: (1 - a22) / (C.abs(C.sub(s11, C.mul(d, C.conj(s22)))) + p),
  };
}

export interface StabilitySummary { n: number; kMin: number; kMinF: number; muMin: number; muMinF: number; deltaMax: number; unconditional: boolean }

/** Worst-case stability over the points that have S12 and S22 (flip-DUT result). Null if there are none. */
export function stabilitySummary(d: SweepPoint[]): StabilitySummary | null {
  let n = 0, kMin = Infinity, kMinF = NaN, muMin = Infinity, muMinF = NaN, deltaMax = 0;
  for (const p of d) {
    if (!p.s12 || !p.s22) continue;
    const s = stability(p.s11, p.s21, p.s12, p.s22);
    n++;
    if (s.k < kMin || Number.isNaN(kMinF)) { kMin = s.k; kMinF = p.f; }
    const mu = Math.min(s.mu, s.muPrime);
    if (mu < muMin || Number.isNaN(muMinF)) { muMin = mu; muMinF = p.f; }
    deltaMax = Math.max(deltaMax, s.delta);
  }
  return n ? { n, kMin, kMinF, muMin, muMinF, deltaMax, unconditional: muMin > 1 } : null;
}

/** Same frequency grid (same length, every frequency within 1 Hz). */
export function sameGrid(a: SweepPoint[], b: SweepPoint[]): boolean {
  return a.length > 0 && a.length === b.length && a.every((p, i) => Math.abs(p.f - b[i].f) < 1);
}

/** Clamp an index range to [0, n-1] and order it. */
function range(n: number, i0 = 0, i1 = n - 1): [number, number] {
  const a = Math.max(0, Math.min(i0, i1)), b = Math.min(n - 1, Math.max(i0, i1));
  return [a, b];
}

export interface Balance { maxAbsDb: number; maxAbsDbF: number; maxAbsDeg: number; maxAbsDegF: number; meanDbA: number; meanDbB: number }

/** Amplitude/phase imbalance a − b of two S21 sweeps (splitter outputs). Null on different grids or no finite points. */
export function compareS21(a: SweepPoint[], b: SweepPoint[], i0?: number, i1?: number): Balance | null {
  if (!sameGrid(a, b)) return null;
  const [lo, hi] = range(a.length, i0, i1);
  let n = 0, sa = 0, sb = 0, maxAbsDb = -1, maxAbsDbF = NaN, maxAbsDeg = -1, maxAbsDegF = NaN;
  for (let i = lo; i <= hi; i++) {
    const da = s21Db(a[i].s21), db = s21Db(b[i].s21);
    if (!Number.isFinite(da) || !Number.isFinite(db)) continue;
    n++; sa += da; sb += db;
    const dDb = Math.abs(da - db);
    const dDeg = Math.abs(wrap180(((C.arg(a[i].s21) - C.arg(b[i].s21)) * 180) / Math.PI));
    if (dDb > maxAbsDb) { maxAbsDb = dDb; maxAbsDbF = a[i].f; }
    if (dDeg > maxAbsDeg) { maxAbsDeg = dDeg; maxAbsDegF = a[i].f; }
  }
  return n ? { maxAbsDb, maxAbsDbF, maxAbsDeg, maxAbsDegF, meanDbA: sa / n, meanDbB: sb / n } : null;
}

export interface Isolation { ilMin: number; ilMax: number; isoWorst: number; isoWorstF: number; marginWorst: number; marginWorstF: number }

/** Isolator/circulator: fwd = through path S21, rev = isolated path S21. Losses and isolation are positive dB. */
export function isolationTest(fwd: SweepPoint[], rev: SweepPoint[], i0?: number, i1?: number): Isolation | null {
  if (!sameGrid(fwd, rev)) return null;
  const [lo, hi] = range(fwd.length, i0, i1);
  let ilMin = Infinity, ilMax = -Infinity, isoWorst = Infinity, isoWorstF = NaN, marginWorst = Infinity, marginWorstF = NaN;
  for (let i = lo; i <= hi; i++) {
    const il = -s21Db(fwd[i].s21), iso = -s21Db(rev[i].s21);
    if (!Number.isFinite(il) || !Number.isFinite(iso)) continue;
    ilMin = Math.min(ilMin, il); ilMax = Math.max(ilMax, il);
    if (iso < isoWorst) { isoWorst = iso; isoWorstF = fwd[i].f; }
    if (iso - il < marginWorst) { marginWorst = iso - il; marginWorstF = fwd[i].f; }
  }
  return Number.isFinite(isoWorst) ? { ilMin, ilMax, isoWorst, isoWorstF, marginWorst, marginWorstF } : null;
}

export interface Directivity { couplingMean: number; dirWorst: number; dirWorstF: number; dirMean: number }

/** Coupler directivity = isolation − coupling = |coupled| dB − |isolated| dB (coupler reversed for the isolated sweep). */
export function directivityTest(coupled: SweepPoint[], isolated: SweepPoint[], i0?: number, i1?: number): Directivity | null {
  if (!sameGrid(coupled, isolated)) return null;
  const [lo, hi] = range(coupled.length, i0, i1);
  let n = 0, sc = 0, sd = 0, dirWorst = Infinity, dirWorstF = NaN;
  for (let i = lo; i <= hi; i++) {
    const c = s21Db(coupled[i].s21), iso = s21Db(isolated[i].s21);
    if (!Number.isFinite(c) || !Number.isFinite(iso)) continue;
    n++; sc += -c; sd += c - iso;
    if (c - iso < dirWorst) { dirWorst = c - iso; dirWorstF = coupled[i].f; }
  }
  return n ? { couplingMean: sc / n, dirWorst, dirWorstF, dirMean: sd / n } : null;
}

/** True when any point of `meas` is within `margin` dB of the noise-floor sweep (ports terminated). Null on different grids. */
export function floorLimited(meas: SweepPoint[], floor: SweepPoint[], i0?: number, i1?: number, margin = 10): boolean | null {
  if (!sameGrid(meas, floor)) return null;
  const [lo, hi] = range(meas.length, i0, i1);
  for (let i = lo; i <= hi; i++) if (s21Db(meas[i].s21) - s21Db(floor[i].s21) < margin) return true;
  return false;
}

/** Free-space path loss in dB at distance d (m). */
export const fspl = (f: number, d: number) => 20 * Math.log10((4 * Math.PI * d * f) / SPEED_OF_LIGHT);
/** Two identical antennas: S21 = 2G − FSPL ⇒ G = (S21 + FSPL) / 2 (dBi). */
export const gainTwoIdentical = (s21Db: number, f: number, d: number) => (s21Db + fspl(f, d)) / 2;
/** Gain transfer: replace a reference antenna of known gain with the DUT at the same distance. */
export const gainReference = (s21Db: number, refDb: number, gRef: number) => gRef + s21Db - refDb;
/** Minimum far-field distance 2D²/λ for an antenna of largest dimension `size` (m). */
export const farFieldDistance = (f: number, size: number) => (2 * size * size * f) / SPEED_OF_LIGHT;

/** Peak-to-peak of the finite values with frequency in [f1, f2]; null if none. */
export function rippleIn(freqs: ArrayLike<number>, values: ArrayLike<number>, f1: number, f2: number): number | null {
  const lo = Math.min(f1, f2), hi = Math.max(f1, f2);
  let min = Infinity, max = -Infinity;
  for (let i = 0; i < Math.min(freqs.length, values.length); i++) {
    if (freqs[i] < lo || freqs[i] > hi || !Number.isFinite(values[i])) continue;
    min = Math.min(min, values[i]); max = Math.max(max, values[i]);
  }
  return max >= min ? max - min : null;
}

export interface FilterMaskSpec { passLo: number; passHi: number; maxIl: number; stopLo: number | null; stopHi: number | null; minRej: number; fMin: number; fMax: number }

/** Limit segments (S21 dB) for a band-pass style mask: passband ≥ −maxIl, stopbands ≤ −minRej. Ripple is checked separately. */
export function filterMask(m: FilterMaskSpec): LimitSegment[] {
  const seg = (kind: "upper" | "lower", f1: number, f2: number, v: number): LimitSegment => ({ kind, f1, f2, v1: v, v2: v, enabled: true });
  const out = [seg("lower", m.passLo, m.passHi, -m.maxIl)];
  if (m.stopLo != null && m.stopLo > m.fMin) out.push(seg("upper", m.fMin, m.stopLo, -m.minRej));
  if (m.stopHi != null && m.stopHi < m.fMax) out.push(seg("upper", m.stopHi, m.fMax, -m.minRej));
  return out;
}

/** Antenna Q from a VSWR < 2 band (`swrBandwidth`); null when the band is missing or clipped by the sweep edges. */
export function bandQ(band: SwrBand, data: SweepPoint[]): number | null {
  if (band.low == null || band.high == null || !data.length) return null;
  if (band.low <= data[0].f || band.high >= data[data.length - 1].f) return null;
  return antennaQ((band.high - band.low) / data[band.best].f);
}

/** Passband ripple without the roll-off: peak-to-peak between the first and last local maximum in [i0, i1]. 0 for one hump. */
export function interiorRipple(values: ArrayLike<number>, i0: number, i1: number): number {
  const lo = Math.max(1, Math.min(i0, i1) + 1), hi = Math.min(values.length - 2, Math.max(i0, i1) - 1);
  let first = -1, last = -1;
  for (let i = lo; i <= hi; i++) if (values[i] >= values[i - 1] && values[i] > values[i + 1]) { if (first < 0) first = i; last = i; }
  if (first < 0) return 0;
  let min = Infinity, max = -Infinity;
  for (let i = first; i <= last; i++) if (Number.isFinite(values[i])) { min = Math.min(min, values[i]); max = Math.max(max, values[i]); }
  return max - min;
}
