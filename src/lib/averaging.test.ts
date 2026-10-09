import { describe, expect, it } from "vitest";
import type { Complex } from "./complex";
import type { SweepPoint } from "./litevna";
import { averageSweeps, SweepAccumulator } from "./averaging";

const sw = (vals: Complex[], s21: Complex = [0, 0]): SweepPoint[] => vals.map((v, i) => ({ f: 1e6 * (i + 1), s11: v, s21 }));

describe("averageSweeps", () => {
  it("plain complex mean", () => {
    const r = averageSweeps([sw([[1, 0], [0, 2]]), sw([[3, 2], [0, 4]])]);
    expect(r[0].s11).toEqual([2, 1]);
    expect(r[1].s11).toEqual([0, 3]);
    expect(r[0].f).toBe(1e6);
  });
  it("single sweep returns same values; empty returns []", () => {
    expect(averageSweeps([sw([[1, 2]])], 5)[0].s11).toEqual([1, 2]);
    expect(averageSweeps([])).toEqual([]);
  });
  it("discards the furthest outlier", () => {
    const sweeps = [sw([[1, 0]]), sw([[1, 0]]), sw([[1, 0]]), sw([[100, 50]])];
    const r = averageSweeps(sweeps, 1);
    expect(r[0].s11[0]).toBeCloseTo(1);
    expect(r[0].s11[1]).toBeCloseTo(0);
  });
  it("discard is per point and per channel", () => {
    const sweeps = [
      sw([[1, 0], [5, 0]], [2, 0]), sw([[1, 0], [5, 0]], [2, 0]), sw([[9, 0], [5, 0]], [2, 0]),
    ];
    sweeps[1][1].s21 = [20, 0];
    const r = averageSweeps(sweeps, 1);
    expect(r[0].s11[0]).toBeCloseTo(1);
    expect(r[1].s11[0]).toBeCloseTo(5);
    expect(r[0].s21[0]).toBeCloseTo(2);
    expect(r[1].s21[0]).toBeCloseTo(2);
  });
  it("effective discard is capped at N-1 (mean of the closest one)", () => {
    const r = averageSweeps([sw([[0, 0]]), sw([[1, 0]]), sw([[10, 0]])], 99);
    expect(r[0].s11[0]).toBeCloseTo(1); // mean 3.67, closest is 1
  });
  it("throws on different lengths", () => {
    expect(() => averageSweeps([sw([[1, 0]]), sw([[1, 0], [2, 0]])])).toThrow();
  });
  it("averages optional s12/s22 only when on every sweep", () => {
    type E = SweepPoint & { s12?: Complex; s22?: Complex };
    const a = sw([[0, 0]]) as E[], b = sw([[0, 0]]) as E[], c = sw([[0, 0]]) as E[];
    a[0].s12 = [1, 0]; b[0].s12 = [3, 0]; a[0].s22 = [1, 1];
    const r = averageSweeps([a, b])[0] as E;
    expect(r.s12).toEqual([2, 0]);
    expect(r.s22).toBeUndefined();
    expect((averageSweeps([a, c])[0] as E).s12).toBeUndefined();
  });
  it("does not mutate inputs", () => {
    const a = sw([[1, 0]]), b = sw([[3, 0]]);
    averageSweeps([a, b], 1);
    expect(a[0].s11).toEqual([1, 0]);
    expect(b[0].s11).toEqual([3, 0]);
  });
});

describe("SweepAccumulator", () => {
  it("accumulates and averages incrementally", () => {
    const acc = new SweepAccumulator();
    acc.add(sw([[1, 0]]));
    expect(acc.result()[0].s11).toEqual([1, 0]);
    acc.add(sw([[3, 0]]));
    expect(acc.count).toBe(2);
    expect(acc.result()[0].s11).toEqual([2, 0]);
  });
  it("keeps only the last max sweeps; reset clears", () => {
    const acc = new SweepAccumulator(2);
    acc.add(sw([[100, 0]])); acc.add(sw([[2, 0]])); acc.add(sw([[4, 0]]));
    expect(acc.count).toBe(2);
    expect(acc.result()[0].s11).toEqual([3, 0]);
    acc.reset();
    expect(acc.count).toBe(0);
    expect(acc.result()).toEqual([]);
  });
  it("rejects length mismatch", () => {
    const acc = new SweepAccumulator();
    acc.add(sw([[1, 0]]));
    expect(() => acc.add(sw([[1, 0], [1, 0]]))).toThrow();
  });
});
