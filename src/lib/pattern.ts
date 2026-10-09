// Radiation pattern: |S21| at one frequency captured per rotation angle, with peak, −3 dB beamwidth and front-to-back.
import type { SweepPoint } from "./litevna";
import { s21Db } from "./rftests";

export interface PatternPoint { deg: number; db: number }
/** One capture, for undo: the angle and frequency before it, and the point it replaced. */
export interface PatternUndo { angle: number; freq: number | null; deg: number; replaced: PatternPoint | null }
/** freq null = the active marker's frequency (locked on the first capture). `angle` is the next angle to capture. */
export interface PatternState { freq: number | null; step: number; angle: number; points: PatternPoint[]; history: PatternUndo[] }
export const DEFAULT_PATTERN: PatternState = { freq: null, step: 10, angle: 0, points: [], history: [] };
const MAX_HISTORY = 720;

/** Gaps wider than this are not interpolated (partial arcs). */
const MAX_GAP = 90;

export const normDeg = (d: number) => ((d % 360) + 360) % 360;

/** Insert a point (angle normalised to [0, 360)), replacing one at the same angle; result sorted by angle. */
export function addPatternPoint(points: PatternPoint[], p: PatternPoint): PatternPoint[] {
  const deg = normDeg(p.deg);
  const close = (a: number) => Math.min(Math.abs(a - deg), 360 - Math.abs(a - deg)) < 0.01;
  return [...points.filter((q) => !close(q.deg)), { deg, db: p.db }].sort((a, b) => a.deg - b.deg);
}

/** |S21| dB at f, linearly interpolated in dB; null outside the sweep or for non-finite values. */
export function s21DbAt(data: SweepPoint[], f: number): number | null {
  if (!data.length || f < data[0].f || f > data[data.length - 1].f) return null;
  let i = 0;
  while (i < data.length - 2 && data[i + 1].f < f) i++;
  const a = data[i], b = data[Math.min(i + 1, data.length - 1)];
  const t = b.f === a.f ? 0 : (f - a.f) / (b.f - a.f);
  const v = s21Db(a.s21) + t * (s21Db(b.s21) - s21Db(a.s21));
  return Number.isFinite(v) ? v : null;
}

const sameAngle = (a: number, b: number) => Math.min(Math.abs(a - b), 360 - Math.abs(a - b)) < 0.01;

/**
 * Add a point at the current angle from the sweep and advance by `step`. Null if nothing can be read at the frequency.
 * The first capture locks the marker frequency, so a tracking or dragged marker can't mix frequencies into the pattern.
 */
export function capturePoint(st: PatternState, data: SweepPoint[], markerF: number): PatternState | null {
  const f = st.freq ?? markerF;
  const db = s21DbAt(data, f);
  if (db == null) return null;
  const deg = normDeg(st.angle);
  const undo: PatternUndo = { angle: st.angle, freq: st.freq, deg, replaced: st.points.find((p) => sameAngle(p.deg, deg)) ?? null };
  return { ...st, freq: f, points: addPatternPoint(st.points, { deg, db }), angle: normDeg(st.angle + st.step), history: [...st.history, undo].slice(-MAX_HISTORY) };
}

/** Revert the last capture (point, angle and frequency). Returns `st` unchanged when there is nothing to undo. */
export function undoCapture(st: PatternState): PatternState {
  const h = st.history[st.history.length - 1];
  if (!h) return st;
  const rest = st.points.filter((p) => !sameAngle(p.deg, h.deg));
  return { ...st, angle: h.angle, freq: h.freq, points: h.replaced ? addPatternPoint(rest, h.replaced) : rest, history: st.history.slice(0, -1) };
}

/** Neighbours of `deg` on the circle: [before, after, gap from before to after]. Points must be sorted. */
function bracket(points: PatternPoint[], deg: number): [PatternPoint, PatternPoint, number] {
  const n = points.length;
  let j = points.findIndex((p) => p.deg > deg);
  if (j < 0) j = 0;
  const a = points[(j - 1 + n) % n], b = points[j];
  return [a, b, normDeg(b.deg - a.deg) || 360];
}

/** Pattern value at an angle, interpolated around the circle; NaN with fewer than 2 points or across a > 90° gap. */
export function patternValueAt(points: PatternPoint[], deg: number): number {
  if (points.length < 2) return NaN;
  const d = normDeg(deg);
  const exact = points.find((p) => Math.abs(p.deg - d) < 1e-9);
  if (exact) return exact.db;
  const [a, b, gap] = bracket(points, d);
  if (gap > MAX_GAP) return NaN;
  return a.db + ((b.db - a.db) * normDeg(d - a.deg)) / gap;
}

export interface PatternMetrics { peakDeg: number; peakDb: number; beamwidth: number | null; frontToBack: number | null }

/** Walk from the peak in one direction until the value drops 3 dB; the angular distance, or null (no crossing / gap). */
function halfPower(points: PatternPoint[], ip: number, dir: 1 | -1): number | null {
  const n = points.length, level = points[ip].db - 3;
  let dist = 0;
  for (let k = 1; k < n; k++) {
    const prev = points[(ip + (k - 1) * dir + n * k) % n], cur = points[(ip + k * dir + n * k) % n];
    const span = normDeg(dir * (cur.deg - prev.deg));
    if (span > MAX_GAP) return null;
    if (cur.db <= level) return dist + (span * (prev.db - level)) / (prev.db - cur.db);
    dist += span;
  }
  return null;
}

export function patternMetrics(points: PatternPoint[]): PatternMetrics | null {
  if (!points.length) return null;
  let ip = 0;
  for (let i = 1; i < points.length; i++) if (points[i].db > points[ip].db) ip = i;
  const { deg: peakDeg, db: peakDb } = points[ip];
  const l = halfPower(points, ip, -1), r = halfPower(points, ip, 1);
  const back = patternValueAt(points, peakDeg + 180);
  return { peakDeg, peakDb, beamwidth: l != null && r != null ? l + r : null, frontToBack: Number.isFinite(back) ? peakDb - back : null };
}

export function patternCsv(points: PatternPoint[], f: number): string {
  return `# frequency_hz,${Math.round(f)}\nangle_deg,s21_db\n${points.map((p) => `${p.deg},${p.db}`).join("\n")}\n`;
}
