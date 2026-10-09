// Limit lines and pass/fail evaluation (values in the trace's display units: dB, SWR, ...).
export type LimitKind = "upper" | "lower";

export interface LimitSegment {
  kind: LimitKind;
  f1: number;
  f2: number;
  v1: number;
  v2: number;
  enabled?: boolean;
}

export interface LimitResult {
  /** True when no point violates a limit. Also true when nothing was checked (`checked === 0`). */
  pass: boolean;
  /** Number of distinct points covered by at least one enabled segment (NaN values excluded). */
  checked: number;
  /** Number of distinct points violating at least one segment. */
  failures: number;
  /** Point with the smallest margin among checked points (null when checked === 0). */
  worst: { index: number; f: number; value: number; limit: number; margin: number } | null;
  failIndex: number[];
}

/** Limit value at f (linear between the endpoints; NaN outside the segment). */
export function limitAt(seg: LimitSegment, f: number): number {
  const lo = Math.min(seg.f1, seg.f2), hi = Math.max(seg.f1, seg.f2);
  if (!(f >= lo && f <= hi)) return NaN;
  if (seg.f1 === seg.f2) return seg.v1;
  return seg.v1 + ((seg.v2 - seg.v1) * (f - seg.f1)) / (seg.f2 - seg.f1);
}

/** Flat limit over a band. */
export function limitsFromBand(f1: number, f2: number, kind: LimitKind, value: number): LimitSegment {
  return { kind, f1, f2, v1: value, v2: value, enabled: true };
}

export function evalLimits(freqs: ArrayLike<number>, values: ArrayLike<number>, segs: LimitSegment[]): LimitResult {
  const active = segs.filter((s) => s.enabled !== false);
  const n = Math.min(freqs.length, values.length);
  const failIndex: number[] = [];
  let checked = 0;
  let worst: LimitResult["worst"] = null;
  for (let i = 0; i < n; i++) {
    const v = values[i], f = freqs[i];
    if (Number.isNaN(v)) continue;
    let covered = false, failed = false;
    for (const s of active) {
      const lim = limitAt(s, f);
      if (Number.isNaN(lim)) continue;
      covered = true;
      const margin = s.kind === "upper" ? lim - v : v - lim;
      if (margin < 0) failed = true;
      if (!worst || margin < worst.margin) worst = { index: i, f, value: v, limit: lim, margin };
    }
    if (covered) checked++;
    if (failed) failIndex.push(i);
  }
  return { pass: failIndex.length === 0, checked, failures: failIndex.length, worst, failIndex };
}

export function serializeLimits(segs: LimitSegment[]): string {
  return JSON.stringify({ format: "webvna-limits", version: 1, segments: segs }, null, 2);
}

export function parseLimits(text: string): LimitSegment[] {
  let o: unknown;
  try { o = JSON.parse(text); } catch { throw new Error("Limits: invalid JSON"); }
  const r = o as { format?: unknown; version?: unknown; segments?: unknown } | null;
  if (!r || r.format !== "webvna-limits") throw new Error("Limits: not a webvna-limits file");
  if (r.version !== 1) throw new Error("Limits: unsupported version");
  if (!Array.isArray(r.segments)) throw new Error("Limits: segments missing");
  return r.segments.map((x: Record<string, unknown> | null, i) => {
    if (!x || typeof x !== "object") throw new Error(`Limits: segment ${i} invalid`);
    if (x.kind !== "upper" && x.kind !== "lower") throw new Error(`Limits: segment ${i} has unknown kind`);
    for (const k of ["f1", "f2", "v1", "v2"])
      if (typeof x[k] !== "number" || !Number.isFinite(x[k])) throw new Error(`Limits: segment ${i} ${k} is not a finite number`);
    if (x.enabled !== undefined && typeof x.enabled !== "boolean") throw new Error(`Limits: segment ${i} enabled is not boolean`);
    const seg: LimitSegment = { kind: x.kind, f1: x.f1 as number, f2: x.f2 as number, v1: x.v1 as number, v2: x.v2 as number };
    if (x.enabled !== undefined) seg.enabled = x.enabled;
    return seg;
  });
}

/** Validate untrusted limit segments (persisted settings, session files, links); null when malformed. */
export function checkLimits(v: unknown): LimitSegment[] | null {
  if (!Array.isArray(v) || v.length > 1000) return null;
  try { return parseLimits(JSON.stringify({ format: "webvna-limits", version: 1, segments: v })); } catch { return null; }
}
