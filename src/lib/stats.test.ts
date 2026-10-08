import { describe, expect, it } from "vitest";
import { rippleAnalysis, traceStats } from "./stats";

const f = [0, 10, 20, 30, 40];

describe("traceStats", () => {
  it("basic stats", () => {
    const s = traceStats(f, [1, 3, 2, 5, 4], 0, 4)!;
    expect(s.n).toBe(5);
    expect(s.min).toBe(1); expect(s.max).toBe(5);
    expect(s.fMin).toBe(0); expect(s.fMax).toBe(30);
    expect(s.mean).toBe(3);
    expect(s.std).toBeCloseTo(Math.sqrt(2));
    expect(s.peakToPeak).toBe(4);
  });
  it("exact line has slope and zero flatness", () => {
    const s = traceStats(f, f.map((x) => 2 + 0.5 * x), 0, 4)!;
    expect(s.slope).toBeCloseTo(0.5, 12);
    expect(s.flatness).toBeCloseTo(0, 9);
    expect(s.peakToPeak).toBeCloseTo(20);
  });
  it("line plus ripple: flatness is the ripple", () => {
    const v = f.map((x, i) => 0.1 * x + (i % 2 ? 1 : -1));
    const s = traceStats(f, v, 0, 4)!;
    expect(s.flatness).toBeGreaterThan(1.5);
    expect(s.flatness).toBeLessThanOrEqual(2 + 1e-9);
  });
  it("range is order-insensitive and clamped", () => {
    const v = [1, 2, 3, 4, 5];
    expect(traceStats(f, v, 3, 1)).toEqual(traceStats(f, v, 1, 3));
    expect(traceStats(f, v, -5, 99)).toEqual(traceStats(f, v, 0, 4));
    expect(traceStats(f, v, 2, 2)!.n).toBe(1);
  });
  it("single point: slope and flatness NaN", () => {
    const s = traceStats(f, [7, 8, 9, 1, 2], 1, 1)!;
    expect(s).toMatchObject({ n: 1, min: 8, max: 8, mean: 8, std: 0, peakToPeak: 0 });
    expect(s.slope).toBeNaN(); expect(s.flatness).toBeNaN();
  });
  it("skips non-finite values", () => {
    const s = traceStats(f, [1, NaN, Infinity, -Infinity, 3], 0, 4)!;
    expect(s.n).toBe(2);
    expect(s.mean).toBe(2);
    expect(s.slope).toBeCloseTo(2 / 40);
  });
  it("null when nothing finite or empty", () => {
    expect(traceStats(f, [NaN, NaN, NaN, NaN, NaN], 0, 4)).toBeNull();
    expect(traceStats([], [], 0, 0)).toBeNull();
  });
  it("identical frequencies give NaN slope", () => {
    const s = traceStats([5, 5], [1, 2], 0, 1)!;
    expect(s.slope).toBeNaN();
    expect(s.mean).toBe(1.5);
  });
  it("works with typed arrays", () => {
    expect(traceStats(new Float64Array(f), new Float64Array([1, 1, 1, 1, 1]), 0, 4)!.std).toBe(0);
  });
});

describe("rippleAnalysis", () => {
  it("max/min/ripple of a passband", () => {
    expect(rippleAnalysis(f, [-1, -0.5, -2, -1.5, -1])).toEqual({ maxValue: -0.5, minValue: -2, ripple: 1.5 });
  });
  it("null for empty or all-NaN", () => {
    expect(rippleAnalysis([], [])).toBeNull();
    expect(rippleAnalysis([1], [NaN])).toBeNull();
  });
});
