# RF Measurements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add antenna Q, filter masks and ripple, splitter balance, isolator/circulator, coupler directivity (with a dynamic-range flag), antenna gain, K/μ stability and radiation-pattern capture to WebVNA.

**Architecture:** The maths lives in two pure, unit-tested modules (`src/lib/rftests.ts`, `src/lib/pattern.ts`). The UI extends existing places:
- the `AnalysisBox` Measure modes, which read memory slots A–D
- `LimitsSection`, which gets the mask builder
- `TwoPortSection`, which gets stability
- a new `PatternSection` + `PatternChart` in the Measure tab

The state additions are `rfTest` (persisted) and `pattern` (session only).

**Tech Stack:** React 19, TypeScript 6 (`erasableSyntaxOnly`), zustand 5, vitest, canvas via `useCanvas`.

**Spec:** `docs/superpowers/specs/2026-10-08-rf-measurements-design.md`

## Global Constraints

- `src/lib/` has no DOM, no React and no i18n.
- Complex numbers are `[re, im]`, handled with `C` from `lib/complex.ts`.
- Frequencies are in Hz.
- No enums and no constructor parameter properties.
- Every visible string goes through `t()` / `tr()`, with an entry in **each** of `src/i18n/{uk,de,pl,es}.ts`, keyed by the exact English text with `{0}` placeholders.
- Canvas `useCanvas` deps include `lang`.
- Colours come from CSS tokens (`var(--…)` in CSS; the canvas reads them with `getComputedStyle`).
- Node 22: prefix commands with `PATH=$HOME/.n/bin:$PATH`.
- Tools: `./node_modules/.bin/vitest run`, `./node_modules/.bin/tsc -b`, `./node_modules/.bin/oxlint src`.
- Commits end with the Co-Authored-By / Claude-Session trailer lines.

## Review Focus

1. **Memory sweeps on a different grid** than the other slot or the floor: compare functions return `null`, and the UI says "different frequency grids". This is tested in Task 1.
2. **|S21| = 0 or non-finite points** (`-Infinity` dB): they're skipped in min/max/worst, never shown as NaN. This is tested in Task 1.
3. **A partial pattern arc** (e.g. only 0–180° captured): beamwidth and F/B don't interpolate across gaps over 90°, and return null instead. This is tested in Task 2.
4. **Capture frequency outside the sweep** or no data yet: capture returns null and logs an error, and the angle doesn't advance. This is tested in Task 2.
5. **Old persisted settings without `rfTest`**, or a corrupted `rfTest`: defaults are filled in field by field. This is tested in Task 3.

## Deviation from spec

The spec says capture uses "Space while focused". Space is already the global single-sweep key (`Toolbar.tsx`), so capture is a button only.

---

### Task 1: `src/lib/rftests.ts`

**Files:**
- Create: `src/lib/rftests.ts`
- Test: `src/lib/rftests.test.ts`

**Interfaces:**
- Produces:
  - `antennaQ(fbw: number, s?: number): number`
  - `stability(s11, s21, s12, s22: Complex): Stability` and `stabilitySummary(d: SweepPoint[]): StabilitySummary | null`
  - `sameGrid(a, b: SweepPoint[]): boolean`
  - `compareS21(a, b, i0?, i1?): Balance | null`
  - `isolationTest(fwd, rev, i0?, i1?): Isolation | null`
  - `directivityTest(coupled, isolated, i0?, i1?): Directivity | null`
  - `floorLimited(meas, floor, i0?, i1?, margin?): boolean | null`
  - `fspl(f, d)`, `gainTwoIdentical(s21Db, f, d)`, `gainReference(s21Db, refDb, gRef)`, `farFieldDistance(f, size)`
  - `s21Db(z: Complex): number`
  - `rippleIn(freqs, values, f1, f2): number | null`
  - `filterMask(spec: FilterMaskSpec): LimitSegment[]`

- [ ] **Step 1: Write the failing tests** in `src/lib/rftests.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { SweepPoint } from "./litevna";
import type { Complex } from "./complex";
import { C } from "./complex";
import { antennaQ, compareS21, directivityTest, farFieldDistance, filterMask, floorLimited, fspl, gainReference, gainTwoIdentical, isolationTest, rippleIn, sameGrid, stability, stabilitySummary } from "./rftests";

const fromDb = (db: number, deg = 0): Complex => C.polar(10 ** (db / 20), (deg * Math.PI) / 180);
const sweep = (s21: (i: number) => Complex, n = 5, f0 = 1e9): SweepPoint[] =>
  Array.from({ length: n }, (_, i) => ({ f: f0 + i * 1e6, s11: [0, 0], s21: s21(i) }));

describe("antennaQ", () => {
  it("Yaghjian–Best at VSWR 2", () => {
    expect(antennaQ(0.1)).toBeCloseTo(1 / (Math.SQRT2 * 0.1), 6); // (2-1)/(√2·0.1) ≈ 7.07
    expect(antennaQ(0)).toBeNaN();
  });
});

describe("stability", () => {
  it("unilateral device: K infinite, mu = 1/|S22|", () => {
    const r = stability([0.5, 0], [3, 0], [0, 0], [0.5, 0]);
    expect(r.k).toBe(Infinity);
    expect(r.mu).toBeCloseTo(2, 9);
    expect(r.delta).toBeCloseTo(0.25, 9);
  });
  it("bilateral, hand-computed", () => {
    // S11=S22=0.5, S21=2, S12=0.2: Δ=0.25-0.4=-0.15, K=(1-.25-.25+.0225)/(2·0.4)=0.653
    const r = stability([0.5, 0], [2, 0], [0.2, 0], [0.5, 0]);
    expect(r.delta).toBeCloseTo(0.15, 9);
    expect(r.k).toBeCloseTo(0.5225 / 0.8, 9);
    // mu = (1-.25)/(|0.5 - (-0.15)(0.5)| + 0.4) = 0.75/0.975
    expect(r.mu).toBeCloseTo(0.75 / 0.975, 9);
    expect(r.muPrime).toBeCloseTo(0.75 / 0.975, 9);
  });
  it("summary skips one-port points and reports the worst", () => {
    const d: SweepPoint[] = [
      { f: 1, s11: [0.1, 0], s21: [0.5, 0], s12: [0.5, 0], s22: [0.1, 0] },
      { f: 2, s11: [0.5, 0], s21: [2, 0], s12: [0.2, 0], s22: [0.5, 0] },
      { f: 3, s11: [0, 0], s21: [1, 0] },
    ];
    const s = stabilitySummary(d)!;
    expect(s.n).toBe(2);
    expect(s.kMinF).toBe(2);
    expect(s.unconditional).toBe(false);
    expect(stabilitySummary([{ f: 1, s11: [0, 0], s21: [1, 0] }])).toBeNull();
  });
});

describe("compareS21 (splitter balance)", () => {
  it("amplitude and wrapped phase differences", () => {
    const a = sweep((i) => fromDb(-3.0, 179));
    const b = sweep((i) => fromDb(-3.0 - 0.1 * i, -179));
    const r = compareS21(a, b)!;
    expect(r.maxAbsDb).toBeCloseTo(0.4, 9);
    expect(r.maxAbsDbF).toBe(a[4].f);
    expect(r.maxAbsDeg).toBeCloseTo(2, 6); // 179 − (−179) wraps to −2
    expect(r.meanDbA).toBeCloseTo(-3, 9);
  });
  it("null on different grids", () => {
    expect(compareS21(sweep(() => [1, 0], 5), sweep(() => [1, 0], 4))).toBeNull();
    expect(sameGrid(sweep(() => [1, 0]), sweep(() => [1, 0], 5, 2e9))).toBe(false);
  });
  it("ignores -Infinity points", () => {
    const a = sweep((i) => (i === 2 ? [0, 0] : fromDb(-3)));
    const r = compareS21(a, sweep(() => fromDb(-3.5)))!;
    expect(r.maxAbsDb).toBeCloseTo(0.5, 9);
  });
});

describe("isolationTest", () => {
  it("IL, worst isolation and margin", () => {
    const fwd = sweep((i) => fromDb(-0.5 - 0.1 * i));
    const rev = sweep((i) => fromDb(-25 + i)); // isolation 25 → 21 dB
    const r = isolationTest(fwd, rev)!;
    expect(r.ilMin).toBeCloseTo(0.5, 9);
    expect(r.ilMax).toBeCloseTo(0.9, 9);
    expect(r.isoWorst).toBeCloseTo(21, 9);
    expect(r.isoWorstF).toBe(fwd[4].f);
    expect(r.marginWorst).toBeCloseTo(21 - 0.9, 9);
  });
});

describe("directivityTest + floor", () => {
  it("directivity = coupled − isolated", () => {
    const coupled = sweep(() => fromDb(-20));
    const isolated = sweep((i) => fromDb(-50 + 2 * i));
    const r = directivityTest(coupled, isolated)!;
    expect(r.couplingMean).toBeCloseTo(20, 9);
    expect(r.dirWorst).toBeCloseTo(22, 9);
    expect(r.dirWorstF).toBe(coupled[4].f);
  });
  it("flags readings within 10 dB of the noise floor", () => {
    const floor = sweep(() => fromDb(-85));
    expect(floorLimited(sweep(() => fromDb(-50)), floor)).toBe(false);
    expect(floorLimited(sweep((i) => fromDb(i === 3 ? -80 : -50)), floor)).toBe(true);
    expect(floorLimited(sweep(() => fromDb(-50)), sweep(() => fromDb(-85), 3))).toBeNull();
  });
});

describe("antenna gain", () => {
  it("Friis round trip", () => {
    const f = 2.4e9, d = 3, g = 8;
    const s21 = 2 * g - fspl(f, d);
    expect(gainTwoIdentical(s21, f, d)).toBeCloseTo(g, 9);
    expect(fspl(1e9, 1)).toBeCloseTo(32.44, 1);
    expect(gainReference(-40, -42, 6)).toBeCloseTo(8, 9);
    expect(farFieldDistance(3e9, 0.1)).toBeCloseTo((2 * 0.01) / (299792458 / 3e9), 9);
  });
});

describe("ripple and filter mask", () => {
  it("peak-to-peak inside [f1, f2] only", () => {
    expect(rippleIn([1, 2, 3, 4], [-10, -1, -1.5, -20], 2, 3)).toBeCloseTo(0.5, 9);
    expect(rippleIn([1, 2], [-1, -2], 5, 6)).toBeNull();
  });
  it("builds passband and stopband segments", () => {
    const m = filterMask({ passLo: 100, passHi: 200, maxIl: 2, stopLo: 50, stopHi: 300, minRej: 40, fMin: 10, fMax: 400 });
    expect(m).toEqual([
      { kind: "lower", f1: 100, f2: 200, v1: -2, v2: -2, enabled: true },
      { kind: "upper", f1: 10, f2: 50, v1: -40, v2: -40, enabled: true },
      { kind: "upper", f1: 300, f2: 400, v1: -40, v2: -40, enabled: true },
    ]);
    expect(filterMask({ passLo: 100, passHi: 200, maxIl: 2, stopLo: null, stopHi: null, minRej: 40, fMin: 10, fMax: 400 })).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `PATH=$HOME/.n/bin:$PATH ./node_modules/.bin/vitest run src/lib/rftests.test.ts`
Expected: FAIL, "Failed to resolve import ./rftests"

- [ ] **Step 3: Implement** `src/lib/rftests.ts`:

```ts
// RF component tests on S11/S21 data: antenna Q, stability factors, splitter balance, isolation, coupler directivity,
// antenna gain (Friis), passband ripple and filter masks. Multi-sweep tests compare stored sweeps on the same grid.
import { C, type Complex } from "./complex";
import type { SweepPoint } from "./litevna";
import type { LimitSegment } from "./limits";
import { SPEED_OF_LIGHT } from "./units";

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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=$HOME/.n/bin:$PATH ./node_modules/.bin/vitest run src/lib/rftests.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**: `git add src/lib/rftests.ts src/lib/rftests.test.ts && git commit -m "feat(lib): RF test maths: antenna Q, K/mu stability, balance, isolation, directivity, Friis gain, masks"`

---

### Task 2: `src/lib/pattern.ts`

**Files:**
- Create: `src/lib/pattern.ts`
- Test: `src/lib/pattern.test.ts`

**Interfaces:**
- Consumes: `s21Db` from Task 1.
- Produces:
  - `PatternPoint`, `PatternState`, `DEFAULT_PATTERN`
  - `normDeg(d)`
  - `addPatternPoint(points, p): PatternPoint[]`
  - `s21DbAt(data, f): number | null`
  - `capturePoint(st, data, markerF): PatternState | null`
  - `patternValueAt(points, deg): number`
  - `patternMetrics(points): PatternMetrics | null`
  - `patternCsv(points, f): string`

- [ ] **Step 1: Write the failing tests** in `src/lib/pattern.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { C } from "./complex";
import type { SweepPoint } from "./litevna";
import { DEFAULT_PATTERN, addPatternPoint, capturePoint, patternCsv, patternMetrics, patternValueAt, s21DbAt, type PatternPoint } from "./pattern";

const cardioid = (step: number, from = 0, to = 360): PatternPoint[] => {
  const out: PatternPoint[] = [];
  for (let d = from; d < to; d += step) out.push({ deg: d, db: -10 * (1 - Math.cos((d * Math.PI) / 180)) });
  return out;
};

describe("addPatternPoint", () => {
  it("normalises, sorts and replaces the same angle", () => {
    let p = addPatternPoint([], { deg: 370, db: -1 });
    p = addPatternPoint(p, { deg: -10, db: -2 });
    p = addPatternPoint(p, { deg: 10, db: -3 });
    expect(p).toEqual([{ deg: 10, db: -3 }, { deg: 350, db: -2 }]);
  });
});

describe("patternMetrics", () => {
  it("cardioid: peak 0°, −3 dB beamwidth ≈ 91.1°, F/B 20 dB", () => {
    const m = patternMetrics(cardioid(5))!;
    expect(m.peakDeg).toBe(0);
    expect(m.beamwidth!).toBeCloseTo(2 * (Math.acos(0.7) * 180) / Math.PI, 0);
    expect(m.frontToBack!).toBeCloseTo(20, 6);
  });
  it("peak across 0°/360°", () => {
    const pts = cardioid(5).map((p) => ({ deg: (p.deg + 350) % 360, db: p.db }));
    const m = patternMetrics(addPatternPoint(pts.slice(1), pts[0]))!;
    expect(m.peakDeg).toBe(350);
    expect(m.beamwidth!).toBeCloseTo(91.1, 0);
  });
  it("partial arc: no interpolation across a > 90° gap", () => {
    const m = patternMetrics(cardioid(10, 0, 40))!; // 0..30°, never reaches −3 dB on the right, gap on the left
    expect(m.beamwidth).toBeNull();
    expect(m.frontToBack).toBeNull();
    expect(patternValueAt(cardioid(10, 0, 40), 180)).toBeNaN();
  });
  it("empty → null", () => expect(patternMetrics([])).toBeNull());
});

describe("capture", () => {
  const data: SweepPoint[] = [1e9, 2e9, 3e9].map((f, i) => ({ f, s11: [0, 0], s21: C.polar(10 ** ((-20 - 10 * i) / 20), 0) }));
  it("interpolates |S21| dB and advances the angle", () => {
    expect(s21DbAt(data, 1.5e9)).toBeCloseTo(-25, 9);
    const st = capturePoint({ ...DEFAULT_PATTERN, step: 15, angle: 350 }, data, 2e9)!;
    expect(st.points).toEqual([{ deg: 350, db: -30 }]);
    expect(st.angle).toBe(5);
    expect(capturePoint({ ...DEFAULT_PATTERN, freq: 3e9 }, data, 1e9)!.points[0].db).toBeCloseTo(-40, 9);
  });
  it("null outside the sweep or without data", () => {
    expect(capturePoint(DEFAULT_PATTERN, data, 5e9)).toBeNull();
    expect(capturePoint(DEFAULT_PATTERN, [], 1e9)).toBeNull();
  });
  it("CSV", () => {
    expect(patternCsv([{ deg: 0, db: -1.234 }], 2.4e9)).toBe("# frequency_hz,2400000000\nangle_deg,s21_db\n0,-1.234\n");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `PATH=$HOME/.n/bin:$PATH ./node_modules/.bin/vitest run src/lib/pattern.test.ts`
Expected: FAIL, "Failed to resolve import ./pattern"

- [ ] **Step 3: Implement** `src/lib/pattern.ts`:

```ts
// Radiation pattern: |S21| at one frequency captured per rotation angle, with peak, −3 dB beamwidth and front-to-back.
import type { SweepPoint } from "./litevna";
import { s21Db } from "./rftests";

export interface PatternPoint { deg: number; db: number }
/** freq null = the active marker's frequency. `angle` is the next angle to capture. */
export interface PatternState { freq: number | null; step: number; angle: number; points: PatternPoint[] }
export const DEFAULT_PATTERN: PatternState = { freq: null, step: 10, angle: 0, points: [] };

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

/** Add a point at the current angle from the sweep and advance by `step`. Null if nothing can be read at the frequency. */
export function capturePoint(st: PatternState, data: SweepPoint[], markerF: number): PatternState | null {
  const db = s21DbAt(data, st.freq ?? markerF);
  if (db == null) return null;
  return { ...st, points: addPatternPoint(st.points, { deg: st.angle, db }), angle: normDeg(st.angle + st.step) };
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
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `PATH=$HOME/.n/bin:$PATH ./node_modules/.bin/vitest run src/lib/pattern.test.ts`
Expected: PASS. Two things to check if it fails:
- the index arithmetic in `halfPower`: `(ip + k*dir + n*k) % n` must stay non-negative
- the partial-arc case: the left walk from 0° to 30° is a 330° gap, which returns null

- [ ] **Step 5: Commit**: `git add src/lib/pattern.ts src/lib/pattern.test.ts && git commit -m "feat(lib): radiation pattern capture and metrics"`

---

### Task 3: State, validation, session

**Files:**
- Modify: `src/store.ts`: `MeasureMode`, `RfTestSettings`, `DEFAULT_RF_TEST`, the `State` fields `rfTest` and `pattern`, `initialState`, `PERSIST` (adds `"rfTest"`)
- Modify: `src/validate.ts:34`: `MEASURE_MODES`, plus a new `sanitizeRfTest` and a `put("rfTest", …)`
- Modify: `src/session.ts`: export/import `pattern`
- Test: `src/store.test.ts` (append)

**Interfaces:**
- Consumes: `PatternState`, `DEFAULT_PATTERN`, `addPatternPoint` (Task 2).
- Produces:
  - `RfTestSettings { floorSlot: boolean; gainMethod: "two" | "ref"; distance: number; refGain: number; antSize: number }`
  - `DEFAULT_RF_TEST`
  - `State.rfTest`, `State.pattern: PatternState`
  - `MeasureMode` gains `"balance" | "isolation" | "directivity" | "gain"`

- [ ] **Step 1: Write the failing tests** (append to `src/store.test.ts`; reuse that file's existing `mergePersisted` import):

```ts
describe("rfTest settings", () => {
  it("fills defaults and repairs bad fields", () => {
    const p = mergePersisted({ rfTest: { gainMethod: "ref", distance: -1, refGain: "x", floorSlot: true } });
    expect(p.rfTest).toEqual({ ...DEFAULT_RF_TEST, gainMethod: "ref", floorSlot: true });
    expect(mergePersisted({ measure: "directivity" }).measure).toBe("directivity");
  });
});
```
Add `DEFAULT_RF_TEST` to the `./store` import of that file.

- [ ] **Step 2: Run them to verify they fail**: `PATH=$HOME/.n/bin:$PATH ./node_modules/.bin/vitest run src/store.test.ts`. Expected: FAIL (DEFAULT_RF_TEST not exported).

- [ ] **Step 3: Implement.** In `src/store.ts`:

```ts
import { DEFAULT_PATTERN, type PatternState } from "./lib/pattern";
export type MeasureMode = "off" | "lcmatch" | "cable" | "serieslc" | "shuntlc" | "xtal" | "filter" | "resonance" | "stats" | "balance" | "isolation" | "directivity" | "gain";
/** Settings of the multi-sweep RF tests (Measure tab). floorSlot: memory D holds a noise-floor sweep (ports terminated). */
export interface RfTestSettings { floorSlot: boolean; gainMethod: "two" | "ref"; distance: number; refGain: number; antSize: number }
export const DEFAULT_RF_TEST: RfTestSettings = { floorSlot: false, gainMethod: "two", distance: 1, refGain: 0, antSize: 0.1 };
```
- In `State`, after `measureVf: number;`, add `rfTest: RfTestSettings;` and `/** Radiation pattern capture (session only, not persisted). */ pattern: PatternState;`.
- In `initialState`, after `measureVf: 0.66,`, add `rfTest: DEFAULT_RF_TEST, pattern: DEFAULT_PATTERN,`.
- Append `"rfTest"` to `PERSIST`.

In `src/validate.ts`, extend `MEASURE_MODES` with `"balance", "isolation", "directivity", "gain"`. Add the following, importing `DEFAULT_RF_TEST`/`RfTestSettings` from `./store` and type-only where possible. Check for an existing import cycle first: validate.ts already imports types from `./store`. If a value import creates a cycle problem, pass `def.rfTest` instead, as below, so only the type is needed:

```ts
export function sanitizeRfTest(v: unknown, def: RfTestSettings): RfTestSettings {
  const o = isObj(v) ? v : {};
  const pos = (x: unknown) => isNum(x) && x > 0 && x < 1e6;
  return {
    floorSlot: field(o, "floorSlot", def.floorSlot, isBool),
    gainMethod: field(o, "gainMethod", def.gainMethod, (x) => x === "two" || x === "ref"),
    distance: field(o, "distance", def.distance, pos),
    refGain: field(o, "refGain", def.refGain, (x) => inRange(x, -50, 100)),
    antSize: field(o, "antSize", def.antSize, pos),
  };
}
```
After the `put("core", …)` line, add `put("rfTest", sanitizeRfTest(o.rfTest, def.rfTest), "rfTest" in o);`. Before using `field` and `isBool`, check their signatures in validate.ts (`grep -n "const field\|function field\|isBool" src/validate.ts`) and adapt the generic call if needed.

In `src/session.ts`:
- `SessionFile` gets `pattern?: PatternState`.
- In `exportSession`: `if (s.pattern.points.length) out.pattern = s.pattern;`.
- In `importSession`, before `stop()`, validate:

```ts
  let pattern: PatternState = DEFAULT_PATTERN;
  if (o.pattern !== undefined) {
    const p = o.pattern;
    if (!isObj(p) || !Array.isArray(p.points) || !p.points.every((q) => isObj(q) && isNum(q.deg) && isNum(q.db)))
      throw new Error(tr("Session: the radiation pattern is malformed."));
    pattern = {
      freq: isNum(p.freq) && p.freq > 0 ? p.freq : null,
      step: isNum(p.step) && p.step > 0 && p.step <= 180 ? p.step : DEFAULT_PATTERN.step,
      angle: isNum(p.angle) ? normDeg(p.angle) : 0,
      points: (p.points as PatternPoint[]).reduce((acc, q) => addPatternPoint(acc, { deg: q.deg, db: q.db }), [] as PatternPoint[]),
    };
  }
```
Add `pattern` to the final `set({...})`, and add the import `import { DEFAULT_PATTERN, addPatternPoint, normDeg, type PatternPoint, type PatternState } from "./lib/pattern";`. Add the i18n key `"Session: the radiation pattern is malformed."` to uk/de/pl/es:
- uk: "Сеанс: діаграма спрямованості пошкоджена."
- de: "Sitzung: das Richtdiagramm ist fehlerhaft."
- pl: "Sesja: charakterystyka promieniowania jest uszkodzona."
- es: "Sesión: el diagrama de radiación está dañado."

- [ ] **Step 4: Run** `PATH=$HOME/.n/bin:$PATH ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc -b`. Expected: all pass, no type errors.

- [ ] **Step 5: Commit**: `git commit -am "feat(store): RF test settings, pattern state, session support"`

---

### Task 4: Measure modes (balance, isolation, directivity, gain), antenna Q, filter ripple

**Files:**
- Modify: `src/components/MeasurePanel.tsx`
- Modify: `src/i18n/{uk,de,pl,es}.ts`

**Interfaces:**
- Consumes: from Task 1, `antennaQ`, `compareS21`, `isolationTest`, `directivityTest`, `floorLimited`, `gainTwoIdentical`, `gainReference`, `farFieldDistance`, `fspl`, `rippleIn`, `s21Db`; from Task 3, `State.rfTest`.

- [ ] **Step 1: Add MODES entries** after `"stats"`:

```ts
  ["balance", "Splitter balance (S21)", "Store output 1 → port 2 in memory A and output 2 → port 2 in memory B (other output terminated). Shows amplitude and phase imbalance between markers 1 and 2, or over the whole sweep."],
  ["isolation", "Isolator / circulator (S21)", "Memory A: forward path (insertion loss). Memory B: the same ports reversed or the isolated port (isolation). Optional memory D: noise floor with both ports terminated."],
  ["directivity", "Coupler directivity (S21)", "Memory A: input → coupled port. Memory B: coupler reversed (output fed) → coupled port. Directivity = isolation − coupling. Optional memory D: noise floor with both ports terminated."],
  ["gain", "Antenna gain (S21)", "Two antennas facing each other at a known distance; calibrate THRU at the antenna connectors. Room reflections limit the accuracy to about ±1–2 dB."],
```

- [ ] **Step 2: Inputs in `MeasurePanel`.** Read `rf = useStore(s => s.rfTest)` and `const setRf = (p: Partial<RfTestSettings>) => set((s) => ({ rfTest: { ...s.rfTest, ...p } }));`. After the cable row, add:

```tsx
{(mode === "isolation" || mode === "directivity") && <Check checked={rf.floorSlot} onChange={(v) => setRf({ floorSlot: v })}>{t("Memory D is the noise floor")}</Check>}
{mode === "gain" && <>
  <div className="row"><label>{t("Method")}</label><Select value={rf.gainMethod} ariaLabel="Gain method" options={[["two", t("Two identical antennas")], ["ref", t("Reference antenna (memory A)")]] as ["two" | "ref", string][]} onChange={(v) => setRf({ gainMethod: v })} /></div>
  {rf.gainMethod === "two"
    ? <div className="row"><label>{t("Distance (m)")}</label><Num value={rf.distance} min={0.01} step={0.1} onChange={(v) => setRf({ distance: v })} /></div>
    : <div className="row"><label>{t("Reference gain (dBi)")}</label><Num value={rf.refGain} step={0.1} onChange={(v) => setRf({ refGain: v })} /></div>}
  <div className="row"><label>{t("Antenna size D (m)")}</label><Num value={rf.antSize} min={0.001} step={0.01} onChange={(v) => setRf({ antSize: v })} /></div>
</>}
```
Import `Check` from `./inputs` and `type RfTestSettings` from `../store`.

- [ ] **Step 3: AnalysisBox.** Add `const rf = useStore((s) => s.rfTest);` to the hooks and the `useMemo` deps.
- In the summary VSWR row, after the `%`, append the Q: change the template to
  ``${band.pct!.toFixed(2)} %) · Q ≈ ${antennaQ(band.bw / data[band.best].f).toFixed(1)}``.
- Add helpers in the memo:

```ts
    const two = markers[0].enabled && markers[1].enabled;
    const span = (d: { f: number }[]) => (two ? [nearestIndex(d as never, markers[0].f), nearestIndex(d as never, markers[1].f)] : [0, d.length - 1]) as [number, number];
    const need = (...slots: MemorySlot[]) => slots.filter((k) => !memories[k]?.length);
    const missing = (m: MemorySlot[]) => <p className="hint">{tr("Store memory {0} first (Display → Memories).", m.join(", "))}</p>;
    const gridErr = <p className="hint err-text">{tr("The memories were measured on different frequency grids. Keep the sweep settings unchanged.")}</p>;
    const db = (x: number) => `${x.toFixed(2)} dB`;
    const floorNote = (meas: SweepPoint[], i0: number, i1: number) => {
      if (!rf.floorSlot || !memories.D) return null;
      const lim = floorLimited(meas, memories.D, i0, i1);
      if (lim == null) return <span style={{ gridColumn: "1 / -1" }} className="err-text">{tr("Memory D (noise floor) is on a different frequency grid.")}</span>;
      return lim ? <span style={{ gridColumn: "1 / -1", color: "var(--warn)" }}>{tr("Within 10 dB of the noise floor: the true value is at least this good (dynamic-range limited).")}</span> : null;
    };
```
`nearestIndex` takes `SweepPoint[]`; pass `memories.A!` directly and drop the cast if the types allow it.

- Mode branches (before the final `return`):

```tsx
    } else if (mode === "balance") {
      const m = need("A", "B");
      if (m.length) extra = missing(m);
      else {
        const [i0, i1] = span(memories.A!);
        const r = compareS21(memories.A!, memories.B!, i0, i1);
        extra = r ? (
          <div className="kv">
            <span>{tr("Output 1 (A) mean")}</span><span>{db(r.meanDbA)}</span>
            <span>{tr("Output 2 (B) mean")}</span><span>{db(r.meanDbB)}</span>
            <span>{tr("Amplitude imbalance")}</span><span>{tr("{0} max @ {1}", db(r.maxAbsDb), fmtHz(r.maxAbsDbF))}</span>
            <span>{tr("Phase imbalance")}</span><span>{tr("{0} max @ {1}", `${r.maxAbsDeg.toFixed(2)}°`, fmtHz(r.maxAbsDegF))}</span>
          </div>
        ) : gridErr;
      }
    } else if (mode === "isolation") {
      const m = need("A", "B");
      if (m.length) extra = missing(m);
      else {
        const [i0, i1] = span(memories.A!);
        const r = isolationTest(memories.A!, memories.B!, i0, i1);
        extra = r ? (
          <div className="kv">
            <span>{tr("Insertion loss")}</span><span>{`${r.ilMin.toFixed(2)} – ${db(r.ilMax)}`}</span>
            <span>{tr("Worst isolation")}</span><span>{tr("{0} @ {1}", db(r.isoWorst), fmtHz(r.isoWorstF))}</span>
            <span>{tr("Isolation − loss")}</span><span>{tr("{0} @ {1}", db(r.marginWorst), fmtHz(r.marginWorstF))}</span>
            {floorNote(memories.B!, i0, i1)}
          </div>
        ) : gridErr;
      }
    } else if (mode === "directivity") {
      const m = need("A", "B");
      if (m.length) extra = missing(m);
      else {
        const [i0, i1] = span(memories.A!);
        const r = directivityTest(memories.A!, memories.B!, i0, i1);
        extra = r ? (
          <div className="kv">
            <span>{tr("Coupling (mean)")}</span><span>{db(r.couplingMean)}</span>
            <span>{tr("Directivity (mean)")}</span><span>{db(r.dirMean)}</span>
            <span>{tr("Worst directivity")}</span><span>{tr("{0} @ {1}", db(r.dirWorst), fmtHz(r.dirWorstF))}</span>
            {floorNote(memories.B!, i0, i1)}
          </div>
        ) : gridErr;
      }
    } else if (mode === "gain") {
      const ref = rf.gainMethod === "ref";
      if (ref && !memories.A?.length) extra = missing(["A"]);
      else if (ref && !sameGrid(data, memories.A!)) extra = gridErr;
      else {
        const g = (i: number) => {
          const s = s21Db(data[i].s21);
          return ref ? gainReference(s, s21Db(memories.A![i].s21), rf.refGain) : gainTwoIdentical(s, data[i].f, rf.distance);
        };
        const [i0, i1] = span(data);
        let lo = Infinity, hi = -Infinity;
        for (let i = Math.min(i0, i1); i <= Math.max(i0, i1); i++) { const v = g(i); if (Number.isFinite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }
        const im = nearestIndex(data, mf);
        const ff = farFieldDistance(data[data.length - 1].f, rf.antSize);
        extra = (
          <div className="kv">
            <span>{tr("Gain at M{0}", activeMarker + 1)}</span><span>{`${g(im).toFixed(2)} dBi @ ${fmtHz(data[im].f)}`}</span>
            {Number.isFinite(lo) && <><span>{tr("Gain range")}</span><span>{`${lo.toFixed(2)} – ${hi.toFixed(2)} dBi`}</span></>}
            {!ref && <><span>{tr("Path loss at M{0}", activeMarker + 1)}</span><span>{db(fspl(data[im].f, rf.distance))}</span></>}
            {!ref && rf.distance < ff && <span style={{ gridColumn: "1 / -1", color: "var(--warn)" }}>{tr("Closer than the far-field distance {0} m (2D²/λ): the gain reads low.", ff.toFixed(2))}</span>}
            <span style={{ gridColumn: "1 / -1" }} className="hint">{tr("Expect ±1–2 dB from room reflections.")}</span>
          </div>
        );
      }
```

- Filter ripple: in the `filter` branch, after the shape-factor line, add:

```tsx
          {r.low3 && r.high3 && (() => { const rp = rippleIn(data.map((p) => p.f), data.map((p) => s21Db(p.s21)), r.low3, r.high3); return rp != null && <><span>{tr("Passband ripple")}</span><span>{rp.toFixed(2)} dB</span></>; })()}
```

Imports: `antennaQ, compareS21, directivityTest, farFieldDistance, floorLimited, fspl, gainReference, gainTwoIdentical, isolationTest, rippleIn, s21Db, sameGrid` from `../lib/rftests`; `type MemorySlot` from `../store`; `type SweepPoint` from `../lib/litevna`.

- [ ] **Step 4: i18n.** Run `PATH=$HOME/.n/bin:$PATH ./node_modules/.bin/vitest run src/i18n.test.ts` to list the missing keys. Then add **every** new literal to uk, de, pl and es (the test output names them). The keys are:
  - the 4 mode labels and 4 hints
  - "Memory D is the noise floor", "Method", "Two identical antennas", "Reference antenna (memory A)", "Distance (m)", "Reference gain (dBi)", "Antenna size D (m)"
  - "Store memory {0} first (Display → Memories).", the grid error, "Memory D (noise floor) is on a different frequency grid.", the floor warning
  - "Output 1 (A) mean", "Output 2 (B) mean", "Amplitude imbalance", "Phase imbalance", "{0} max @ {1}"
  - "Insertion loss", "Worst isolation", "Isolation − loss", "{0} @ {1}"
  - "Coupling (mean)", "Directivity (mean)", "Worst directivity"
  - "Gain at M{0}", "Gain range", "Path loss at M{0}", the far-field warning, "Expect ±1–2 dB from room reflections.", "Passband ripple"

  Translate them properly (technical RF terms: uk "розв'язка", "спрямованість", "коефіцієнт підсилення"; de "Isolation", "Richtschärfe", "Gewinn"; pl "izolacja", "kierunkowość", "zysk"; es "aislamiento", "directividad", "ganancia"). Keep every `{n}` placeholder.

- [ ] **Step 5: Verify**: `PATH=$HOME/.n/bin:$PATH ./node_modules/.bin/vitest run && ./node_modules/.bin/tsc -b && ./node_modules/.bin/oxlint src`. Expected: all green.

- [ ] **Step 6: Commit**: `git commit -am "feat(measure): splitter balance, isolator/circulator, coupler directivity, antenna gain modes; antenna Q; filter ripple"`

---

### Task 5: Filter mask builder in LimitsSection

**Files:**
- Modify: `src/components/LimitsSection.tsx`
- Modify: `src/i18n/{uk,de,pl,es}.ts`

**Interfaces:**
- Consumes: `filterMask`, `rippleIn`, `FilterMaskSpec` (Task 1).

- [ ] **Step 1: Implement** a `FilterMask` sub-component in the same file. Render it at the end of `LimitsSection`, only when `tc.channel === "s21" && (tc.format === "logmag" || tc.format === "s21gain")`:

```tsx
function FilterMask({ ti }: { ti: number }) {
  const t = useT();
  const start = useStore((s) => s.start), stop = useStore((s) => s.stop), data = useStore((s) => s.data);
  const [open, setOpen] = useState(false);
  const [m, setM] = useState(() => {
    const w = stop - start;
    return { passLo: start + 0.4 * w, passHi: start + 0.6 * w, maxIl: 3, maxRipple: 1, stopLo: start + 0.2 * w as number | null, stopHi: start + 0.8 * w as number | null, minRej: 40 };
  });
  const p = (q: Partial<typeof m>) => setM({ ...m, ...q });
  const ripple = data.length ? rippleIn(data.map((x) => x.f), data.map((x) => s21Db(x.s21)), m.passLo, m.passHi) : null;
  if (!open) return <button className="small" onClick={() => setOpen(true)}>{t("Filter mask…")}</button>;
  return (
    <div style={{ borderTop: "1px solid var(--line)", paddingTop: 4, marginTop: 4 }}>
      <p className="hint">{t("Builds limit lines: passband loss at most the max IL, stopbands at least the min rejection below 0 dB. Leave a stopband edge empty for one-sided masks.")}</p>
      <div className="grid2">
        <Field label="Passband from"><FreqInput value={m.passLo} onChange={(v) => p({ passLo: v })} ariaLabel="Passband start" /></Field>
        <Field label="Passband to"><FreqInput value={m.passHi} onChange={(v) => p({ passHi: v })} ariaLabel="Passband stop" /></Field>
        <Field label="Max IL (dB)"><Num value={m.maxIl} min={0} step={0.1} onChange={(v) => p({ maxIl: v })} /></Field>
        <Field label="Max ripple (dB)"><Num value={m.maxRipple} min={0} step={0.1} onChange={(v) => p({ maxRipple: v })} /></Field>
        <Field label="Lower stopband edge"><Check checked={m.stopLo != null} onChange={(v) => p({ stopLo: v ? start + 0.2 * (stop - start) : null })}>{m.stopLo != null ? "" : t("off")}</Check>{m.stopLo != null && <FreqInput value={m.stopLo} onChange={(v) => p({ stopLo: v })} ariaLabel="Lower stopband edge" />}</Field>
        <Field label="Upper stopband edge"><Check checked={m.stopHi != null} onChange={(v) => p({ stopHi: v ? start + 0.8 * (stop - start) : null })}>{m.stopHi != null ? "" : t("off")}</Check>{m.stopHi != null && <FreqInput value={m.stopHi} onChange={(v) => p({ stopHi: v })} ariaLabel="Upper stopband edge" />}</Field>
        <Field label="Min rejection (dB)"><Num value={m.minRej} min={0} step={1} onChange={(v) => p({ minRej: v })} /></Field>
      </div>
      {ripple != null && <p className="hint" style={{ color: ripple <= m.maxRipple ? "var(--ok)" : "var(--err)", fontWeight: 600 }}>{t("Passband ripple {0} dB (max {1}): {2}", ripple.toFixed(2), m.maxRipple, ripple <= m.maxRipple ? "PASS" : "FAIL")}</p>}
      <div className="row">
        <button className="small primary" onClick={() => updateTrace(ti, { limits: filterMask({ ...m, fMin: start, fMax: stop }) })}>{t("Apply mask (replaces limits)")}</button>
        <button className="small" onClick={() => setOpen(false)}>{t("Close")}</button>
      </div>
    </div>
  );
}
```
Imports: `filterMask, rippleIn, s21Db` from `../lib/rftests`. `Field` already translates its label, so the labels are i18n keys too.

- [ ] **Step 2: i18n**: run `src/i18n.test.ts` and add the missing keys to all four dictionaries:
  - "Filter mask…", the hint, "Passband from", "Passband to", "Max IL (dB)", "Max ripple (dB)", "Lower stopband edge", "Upper stopband edge", "Min rejection (dB)"
  - "Passband ripple {0} dB (max {1}): {2}", "Apply mask (replaces limits)", "off", "Close"
  - Some may already exist (e.g. "Close"); the dictionary is a `Record`, so don't duplicate a key, because oxlint/tsc flag duplicate object keys.

- [ ] **Step 3: Verify**: the full vitest suite, `tsc -b`, oxlint. Expected: green.

- [ ] **Step 4: Commit**: `git commit -am "feat(limits): filter mask builder with passband ripple check"`

---

### Task 6: Stability (K, μ) in TwoPortSection

**Files:**
- Modify: `src/components/TwoPortSection.tsx`
- Modify: `src/i18n/{uk,de,pl,es}.ts`

- [ ] **Step 1: Implement.** Under the "Result ready" hint:

```tsx
      {st && (
        <div className="kv">
          <span>{t("Min K (Rollett)")}</span><span>{Number.isFinite(st.kMin) ? st.kMin.toFixed(3) : "∞"} @ {fmtHz(st.kMinF)}</span>
          <span>{t("Min μ")}</span><span>{st.muMin.toFixed(3)} @ {fmtHz(st.muMinF)}</span>
          <span>{t("Max |Δ|")}</span><span>{st.deltaMax.toFixed(3)}</span>
          <span style={{ gridColumn: "1 / -1", fontWeight: 600, color: st.unconditional ? "var(--ok)" : "var(--warn)" }}>{st.unconditional ? t("Unconditionally stable over the sweep (μ > 1).") : t("Potentially unstable (μ ≤ 1 somewhere in the sweep).")}</span>
          <span style={{ gridColumn: "1 / -1" }} className="hint">{t("From the flip method: less accurate than a true 2-port VNA, especially near μ = 1.")}</span>
        </div>
      )}
```
with `const st = useMemo(() => (result ? stabilitySummary(result) : null), [result]);` (import `useMemo` and `stabilitySummary`).

- [ ] **Step 2: i18n**: add the 6 keys to all four dictionaries.
- [ ] **Step 3: Verify**: vitest, tsc, oxlint.
- [ ] **Step 4: Commit**: `git commit -am "feat(2-port): K and mu stability from the flip-DUT result"`

---

### Task 7: Radiation pattern section, chart and controller actions

**Files:**
- Create: `src/components/PatternSection.tsx` (section and canvas chart)
- Modify: `src/controller.ts`: `capturePattern()`, `undoPattern()`, `clearPattern()`, `exportPatternCsv()`
- Modify: `src/components/MeasurePanel.tsx`: render `<PatternSection />` below the Measure section
- Modify: `src/i18n/{uk,de,pl,es}.ts`

**Interfaces:**
- Consumes: from Task 2, `capturePoint`, `patternMetrics`, `patternCsv`, `patternValueAt`, `DEFAULT_PATTERN`; from Task 3, `State.pattern`; the existing `sweepOnce`, `download`, `log`.

- [ ] **Step 1: Controller.** Add to `src/controller.ts`:

```ts
/** Wait until `n` more sweeps have completed (continuous mode), so the data was measured after the rotation. */
function nextSweeps(n: number, timeoutMs = 30000): Promise<void> {
  const target = get().sweepCount + n;
  return new Promise((resolve) => {
    const t0 = Date.now();
    const unsub = useStore.subscribe((s) => { if (s.sweepCount >= target || !s.continuous || Date.now() - t0 > timeoutMs) { unsub(); resolve(); } });
  });
}

/** Capture |S21| at the pattern frequency for the current angle, from a sweep taken after the button press. */
export async function capturePattern() {
  const s = get();
  if (s.status === "connected") {
    if (s.continuous) await nextSweeps(2);
    else if (!s.running) await sweepOnce();
  }
  const st = get();
  const next = capturePoint(st.pattern, st.data, st.markers[st.activeMarker]?.f ?? 0);
  if (!next) { log(tr("Pattern: no S21 data at the capture frequency."), "error"); return; }
  set({ pattern: next });
}
export function undoPattern() {
  const p = get().pattern;
  if (!p.points.length) return;
  const prev = normDeg(p.angle - p.step);
  set({ pattern: { ...p, angle: prev, points: p.points.filter((q) => Math.abs(q.deg - prev) > 0.01) } });
}
export const clearPattern = () => set((s) => ({ pattern: { ...s.pattern, angle: 0, points: [] } }));
export function exportPatternCsv() {
  const s = get();
  download(`webvna-pattern-${stamp()}.csv`, patternCsv(s.pattern.points, s.pattern.freq ?? s.markers[s.activeMarker]?.f ?? 0), "text/csv");
}
```
- Confirm that `useStore`, `sweepOnce` and `stamp` exist and are importable in controller.ts (`grep -n "export async function sweepOnce\|function stamp\|useStore" src/controller.ts`). Add `useStore` to the `./store` import, and import `capturePoint, normDeg, patternCsv` from `./lib/pattern`.
- `undoPattern` removes the last captured angle, which is `angle − step`.

- [ ] **Step 2: Component** `src/components/PatternSection.tsx`:

```tsx
import { useMemo } from "react";
import { useStore, set } from "../store";
import { capturePattern, clearPattern, exportPatternCsv, undoPattern } from "../controller";
import { patternMetrics, patternValueAt } from "../lib/pattern";
import { fmtHz } from "../lib/units";
import { useCanvas } from "../hooks/useCanvas";
import { FreqInput, Num, Section } from "./inputs";
import { useT, tr } from "../i18n";

const RANGE = 30; // dB shown from the peak to the centre

function PatternChart() {
  const pattern = useStore((s) => s.pattern);
  const lang = useStore((s) => s.lang);
  const ref = useCanvas((ctx, w, h) => {
    const css = getComputedStyle(document.documentElement);
    const v = (n: string) => css.getPropertyValue(n).trim();
    const cx = w / 2, cy = h / 2, r = Math.min(w, h) / 2 - 18;
    ctx.clearRect(0, 0, w, h);
    ctx.font = "11px system-ui, sans-serif";
    ctx.strokeStyle = v("--grid") || "#888"; ctx.fillStyle = v("--muted") || "#888"; ctx.lineWidth = 1;
    for (let k = 0; k <= RANGE; k += 10) {
      const rr = r * (1 - k / RANGE);
      ctx.beginPath(); ctx.arc(cx, cy, Math.max(rr, 0.5), 0, 2 * Math.PI); ctx.stroke();
      if (k < RANGE) ctx.fillText(`−${k}`, cx + 3, cy - rr + 11);
    }
    for (let a = 0; a < 360; a += 30) {
      const t = ((a - 90) * Math.PI) / 180;
      ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(cx + r * Math.cos(t), cy + r * Math.sin(t)); ctx.stroke();
      ctx.textAlign = "center"; ctx.fillText(`${a}°`, cx + (r + 10) * Math.cos(t), cy + (r + 10) * Math.sin(t) + 4);
    }
    ctx.textAlign = "start";
    const pts = pattern.points;
    if (!pts.length) { ctx.fillText(tr("No points captured."), 8, 14); return; }
    const peak = Math.max(...pts.map((p) => p.db));
    const xy = (deg: number, db: number): [number, number] => {
      const rr = r * Math.max(0, 1 + (db - peak) / RANGE), t = ((deg - 90) * Math.PI) / 180;
      return [cx + rr * Math.cos(t), cy + rr * Math.sin(t)];
    };
    ctx.strokeStyle = v("--accent") || "#3fb7e8"; ctx.fillStyle = ctx.strokeStyle; ctx.lineWidth = 2;
    ctx.beginPath();
    let pen = false;
    for (let deg = 0; deg <= 360; deg += 1) {
      const db = pts.length > 1 ? patternValueAt(pts, deg) : NaN;
      if (!Number.isFinite(db)) { pen = false; continue; }
      const [x, y] = xy(deg, db);
      if (pen) ctx.lineTo(x, y); else ctx.moveTo(x, y);
      pen = true;
    }
    ctx.stroke();
    for (const p of pts) { const [x, y] = xy(p.deg, p.db); ctx.beginPath(); ctx.arc(x, y, 2.5, 0, 2 * Math.PI); ctx.fill(); }
    // next capture angle
    const [nx, ny] = xy(pattern.angle, peak);
    ctx.strokeStyle = v("--warn") || "orange"; ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(cx, cy); ctx.lineTo(nx, ny); ctx.stroke(); ctx.setLineDash([]);
  }, [pattern, lang]);
  return <canvas ref={ref} style={{ width: "100%", aspectRatio: "1", display: "block" }} aria-label={tr("Radiation pattern")} />;
}

export function PatternSection() {
  const t = useT();
  const p = useStore((s) => s.pattern);
  const busy = useStore((s) => s.running && !s.continuous);
  const markerF = useStore((s) => s.markers[s.activeMarker]?.f ?? 0);
  const m = useMemo(() => patternMetrics(p.points), [p.points]);
  const patch = (q: Partial<typeof p>) => set((s) => ({ pattern: { ...s.pattern, ...q } }));
  return (
    <Section title="Radiation pattern">
      <p className="hint">{t("Antenna under test on port 2, a fixed source antenna on port 1. Rotate the antenna by the step, press Capture, repeat. Each capture takes a fresh sweep.")}</p>
      <div className="row">
        <label>{t("Frequency")}</label>
        {p.freq == null
          ? <button className="small" onClick={() => patch({ freq: markerF || null })}>{t("Active marker ({0})", fmtHz(markerF))}</button>
          : <><FreqInput value={p.freq} onChange={(v) => patch({ freq: v })} ariaLabel="Pattern frequency" /><button className="small" onClick={() => patch({ freq: null })}>{t("Use marker")}</button></>}
      </div>
      <div className="row">
        <label>{t("Step (°)")}</label><Num value={p.step} min={1} max={180} step={1} onChange={(v) => patch({ step: v })} ariaLabel="Angle step" />
        <label>{t("Next angle (°)")}</label><Num value={p.angle} min={0} max={359} step={1} onChange={(v) => patch({ angle: ((v % 360) + 360) % 360 })} ariaLabel="Next angle" />
      </div>
      <div className="row">
        <button className="primary" disabled={busy} onClick={() => void capturePattern()}>{t("Capture {0}°", p.angle)}</button>
        <button disabled={!p.points.length} onClick={() => undoPattern()}>{t("Undo")}</button>
        <button disabled={!p.points.length} onClick={() => exportPatternCsv()}>{t("Export CSV")}</button>
        <button className="danger" disabled={!p.points.length} onClick={() => clearPattern()}>{t("Clear")}</button>
      </div>
      <PatternChart />
      {m && (
        <div className="kv">
          <span>{t("Peak")}</span><span>{`${m.peakDb.toFixed(2)} dB @ ${m.peakDeg}°`}</span>
          <span>{t("Beamwidth −3 dB")}</span><span>{m.beamwidth != null ? `${m.beamwidth.toFixed(1)}°` : "—"}</span>
          <span>{t("Front-to-back")}</span><span>{m.frontToBack != null ? `${m.frontToBack.toFixed(1)} dB` : "—"}</span>
          <span>{t("Points")}</span><span>{p.points.length}</span>
        </div>
      )}
    </Section>
  );
}
```
- Before using the CSS variable names (`--grid`, `--muted`, `--accent`, `--warn`), check them in `src/index.css` (`grep -n "^\s*--" src/index.css | head -40`) and substitute the real token names.
- Check how `SmithChart.tsx` reads colours, and reuse its helper if one exists.

- [ ] **Step 3: Mount** it in `MeasurePanel`: `import { PatternSection } from "./PatternSection";`, and render `<PatternSection />` after the Measure `Section`.

- [ ] **Step 4: i18n**: run `src/i18n.test.ts` and add every missing key to all four dictionaries:
  - "Radiation pattern", the hint, "Frequency", "Active marker ({0})", "Use marker", "Step (°)", "Next angle (°)", "Capture {0}°"
  - "Undo", "Export CSV", "Clear", "Peak", "Beamwidth −3 dB", "Front-to-back", "Points"
  - "No points captured.", "Pattern: no S21 data at the capture frequency."
  - Skip keys that already exist.

- [ ] **Step 5: Verify**: vitest, tsc, oxlint, `npm run build` (`PATH=$HOME/.n/bin:$PATH npm_config_cache=$TMPDIR/npm-cache npm run build`). Expected: green, and the build emits dist.

- [ ] **Step 6: Browser check** (if the dev server is available; it needs the sandbox disabled to bind the port):
  - Start `./node_modules/.bin/vite`, open the Measure tab, and connect the simulator through `window.__webvna.controller.connectSimulator()`.
  - Store memories A and B, select Splitter balance, and confirm numbers appear.
  - Capture 3 pattern points and confirm the polar plot draws.
  - If the browser isn't available, say so in the PR body.

- [ ] **Step 7: Commit**: `git add -A src && git commit -m "feat(measure): radiation pattern capture with polar plot, beamwidth and front-to-back"`

---

### Task 8: Docs and PR

**Files:**
- Modify: `docs/USER-GUIDE.md`: a short section per new feature
- Modify: `CLAUDE.md`: the layout lines for `rftests.ts` and `pattern.ts`

- [ ] **Step 1: Write the user guide**: add an "RF component tests" section covering:
  - memory-slot roles per mode
  - the noise-floor slot D and the dynamic-range caveat (≈ 70–90 dB at low frequencies, less towards 6 GHz)
  - the gain methods and the ±1–2 dB caveat
  - the filter mask
  - K/μ from the flip method
  - radiation-pattern capture

  In `CLAUDE.md` Layout, add:
  - `rftests.ts         antenna Q, K/μ stability, splitter balance, isolation, coupler directivity, Friis gain, ripple, filter masks`
  - `pattern.ts         radiation pattern capture (|S21| per angle), beamwidth, front-to-back`
- [ ] **Step 2: Run the full verification**: `vitest run`, `tsc -b`, `oxlint src`, `npm run build`, and paste the results into the PR body.
- [ ] **Step 3: Commit, push and open the PR.**
  - Commit: `git commit -am "docs: RF component tests"`.
  - Push with the sandbox disabled: `git push -u fork feat/rf-measurements`.
  - Open the PR: `gh pr create --repo vkopitsa/WebVNA --head hermes98761234:feat/rf-measurements --base main --title "RF component tests: antenna Q, masks, balance, isolation, directivity, gain, K/μ, radiation pattern"`. The body should say it is stacked on #2, summarise each feature with its accuracy caveats, and include the test results. End the body with the 🤖 Generated line and the session link.
