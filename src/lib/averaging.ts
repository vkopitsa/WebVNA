// Sweep averaging with outlier rejection (NanoVNA-Saver style).
import { C, type Complex } from "./complex";
import type { SweepPoint } from "./litevna";

type Ext = SweepPoint & { s12?: Complex; s22?: Complex };
const KEYS = ["s11", "s21", "s12", "s22"] as const;

function meanReject(xs: Complex[], discard: number): Complex {
  const n = xs.length;
  let m: Complex = [0, 0];
  for (const x of xs) m = C.add(m, x);
  m = C.scale(m, 1 / n);
  const d = Math.min(Math.max(0, Math.floor(discard)), n - 1);
  if (d === 0) return m;
  const keep = xs.map((x) => ({ x, e: C.abs2(C.sub(x, m)) })).sort((a, b) => a.e - b.e).slice(0, n - d);
  let r: Complex = [0, 0];
  for (const k of keep) r = C.add(r, k.x);
  return C.scale(r, 1 / keep.length);
}

/** Per point and channel: complex mean after dropping the `discard` samples furthest from the mean. Frequencies from the first sweep. */
export function averageSweeps(sweeps: SweepPoint[][], discard = 0): SweepPoint[] {
  if (sweeps.length === 0) return [];
  const len = sweeps[0].length;
  for (const s of sweeps) if (s.length !== len) throw new Error("averageSweeps: sweeps have different lengths");
  const out: SweepPoint[] = [];
  for (let i = 0; i < len; i++) {
    const p: Ext = { f: sweeps[0][i].f, s11: [0, 0], s21: [0, 0] };
    for (const k of KEYS) {
      if (!sweeps.every((s) => (s[i] as Ext)[k])) continue;
      p[k] = meanReject(sweeps.map((s) => (s[i] as Ext)[k] as Complex), discard);
    }
    out.push(p);
  }
  return out;
}

/** Collects sweeps (keeps the last `max` if given) and averages on demand. */
export class SweepAccumulator {
  private sweeps: SweepPoint[][] = [];
  private max: number;
  constructor(max = Infinity) { this.max = max; }
  get count(): number { return this.sweeps.length; }
  add(sweep: SweepPoint[]): void {
    if (this.sweeps.length && this.sweeps[0].length !== sweep.length) throw new Error("averageSweeps: sweeps have different lengths");
    this.sweeps.push(sweep);
    while (this.sweeps.length > this.max) this.sweeps.shift();
  }
  result(discard = 0): SweepPoint[] { return averageSweeps(this.sweeps, discard); }
  reset(): void { this.sweeps = []; }
}
