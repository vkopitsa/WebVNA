import { describe, expect, it } from "vitest";
import type { SweepPoint } from "./litevna";
import type { Complex } from "./complex";
import { C } from "./complex";
import { antennaQ, bandQ, interiorRipple, compareS21, directivityTest, farFieldDistance, filterMask, floorLimited, fspl, gainReference, gainTwoIdentical, isolationTest, rippleIn, sameGrid, stability, stabilitySummary } from "./rftests";

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
    const a = sweep(() => fromDb(-3.0, 179));
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

describe("review fixes", () => {
  it("interiorRipple ignores the roll-off edges", () => {
    // edges at −3 dB, Chebyshev-like interior ripple of 0.5 dB
    const v = [-3, -1.5, -0.2, 0, -0.3, -0.5, -0.2, 0, -0.4, -1.8, -3];
    expect(interiorRipple(v, 0, v.length - 1)).toBeCloseTo(0.5, 9);
    expect(interiorRipple([-3, -1, 0, -1, -3], 0, 4)).toBe(0); // single hump: no ripple
  });
  it("bandQ is null when the VSWR band is clipped by the sweep", () => {
    const data = [1, 2, 3, 4, 5].map((f) => ({ f: f * 1e9, s11: [0, 0] as Complex, s21: [0, 0] as Complex }));
    const band = { best: 2, bestSwr: 1.1, low: 2.5e9, high: 3.5e9, bw: 1e9, pct: 100 / 3 };
    expect(bandQ(band, data)).toBeCloseTo(antennaQ(1 / 3), 9);
    expect(bandQ({ ...band, low: 1e9, bw: 2.5e9 }, data)).toBeNull();
    expect(bandQ({ ...band, low: null, high: null, bw: null, pct: null }, data)).toBeNull();
  });
});
