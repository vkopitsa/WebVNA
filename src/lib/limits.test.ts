import { describe, expect, it } from "vitest";
import { evalLimits, limitAt, limitsFromBand, parseLimits, serializeLimits, type LimitSegment } from "./limits";

const f = [1, 2, 3, 4, 5];

describe("limits", () => {
  it("interpolates limitAt, either endpoint order, NaN outside", () => {
    const s: LimitSegment = { kind: "upper", f1: 0, f2: 10, v1: 0, v2: 10 };
    expect(limitAt(s, 5)).toBe(5);
    expect(limitAt(s, 0)).toBe(0);
    expect(limitAt(s, 11)).toBeNaN();
    expect(limitAt({ ...s, f1: 10, f2: 0, v1: 10, v2: 0 }, 2)).toBeCloseTo(2);
    expect(limitAt({ ...s, f2: 0, v2: 7 }, 0)).toBe(0);
  });
  it("limitsFromBand is flat and enabled", () => {
    const s = limitsFromBand(1, 3, "lower", -3);
    expect(s).toEqual({ kind: "lower", f1: 1, f2: 3, v1: -3, v2: -3, enabled: true });
  });
  it("passes and fails an upper limit with margins", () => {
    const r = evalLimits(f, [1, 2, 3, 2, 1], [limitsFromBand(1, 5, "upper", 2.5)]);
    expect(r.pass).toBe(false);
    expect(r.checked).toBe(5);
    expect(r.failures).toBe(1);
    expect(r.failIndex).toEqual([2]);
    expect(r.worst).toEqual({ index: 2, f: 3, value: 3, limit: 2.5, margin: -0.5 });
    expect(evalLimits(f, [1, 2, 2, 2, 1], [limitsFromBand(1, 5, "upper", 2)]).pass).toBe(true);
  });
  it("lower limits", () => {
    const r = evalLimits(f, [5, 5, 1, 5, 5], [limitsFromBand(1, 5, "lower", 2)]);
    expect(r.failIndex).toEqual([2]);
    expect(r.worst?.margin).toBe(-1);
  });
  it("skips points outside segments and disabled segments", () => {
    const r = evalLimits(f, [9, 9, 0, 9, 9], [limitsFromBand(2.5, 3.5, "upper", 1)]);
    expect(r.checked).toBe(1);
    expect(r.pass).toBe(true);
    const d = evalLimits(f, [9, 9, 9, 9, 9], [{ ...limitsFromBand(1, 5, "upper", 1), enabled: false }]);
    expect(d.checked).toBe(0);
    expect(d.pass).toBe(true);
    expect(d.worst).toBeNull();
  });
  it("nothing to check passes", () => {
    const r = evalLimits([], [], []);
    expect(r).toMatchObject({ pass: true, checked: 0, failures: 0, worst: null });
  });
  it("NaN skipped, +Infinity violates upper, -Infinity violates lower", () => {
    const up = evalLimits(f, [NaN, Infinity, 0, 0, 0], [limitsFromBand(1, 5, "upper", 1)]);
    expect(up.checked).toBe(4);
    expect(up.failIndex).toEqual([1]);
    expect(up.worst?.margin).toBe(-Infinity);
    const lo = evalLimits(f, [-Infinity, Infinity, 5, 5, 5], [limitsFromBand(1, 5, "lower", 1)]);
    expect(lo.failIndex).toEqual([0]);
  });
  it("sloped segment and overlapping segments count each point once", () => {
    const sl: LimitSegment = { kind: "upper", f1: 1, f2: 5, v1: 0, v2: 4 };
    const r = evalLimits(f, [0, 1, 2.5, 3, 4], [sl, limitsFromBand(1, 5, "upper", 10)]);
    expect(r.checked).toBe(5);
    expect(r.failIndex).toEqual([2]);
    expect(r.failures).toBe(1);
  });
  it("window with both upper and lower", () => {
    const segs = [limitsFromBand(1, 5, "upper", 3), limitsFromBand(1, 5, "lower", 1)];
    expect(evalLimits(f, [2, 2, 2, 2, 2], segs).pass).toBe(true);
    expect(evalLimits(f, [2, 0, 2, 4, 2], segs).failIndex).toEqual([1, 3]);
  });
  it("round-trips through JSON", () => {
    const segs: LimitSegment[] = [limitsFromBand(1, 2, "upper", 3), { kind: "lower", f1: 5, f2: 6, v1: 1, v2: 2 }];
    const t = serializeLimits(segs);
    expect(JSON.parse(t)).toMatchObject({ format: "webvna-limits", version: 1 });
    expect(parseLimits(t)).toEqual(segs);
  });
  it("parse rejects bad input", () => {
    const wrap = (s: unknown) => JSON.stringify({ format: "webvna-limits", version: 1, segments: [s] });
    const ok = { kind: "upper", f1: 1, f2: 2, v1: 0, v2: 0 };
    expect(() => parseLimits("nope")).toThrow();
    expect(() => parseLimits("null")).toThrow();
    expect(() => parseLimits(JSON.stringify({ format: "x", version: 1, segments: [] }))).toThrow();
    expect(() => parseLimits(JSON.stringify({ format: "webvna-limits", version: 2, segments: [] }))).toThrow();
    expect(() => parseLimits(JSON.stringify({ format: "webvna-limits", version: 1 }))).toThrow();
    expect(() => parseLimits(wrap({ ...ok, kind: "middle" }))).toThrow();
    expect(() => parseLimits(wrap({ ...ok, f1: "1" }))).toThrow();
    expect(() => parseLimits(wrap({ ...ok, v2: null }))).toThrow();
    expect(() => parseLimits(wrap(ok).replace('"v1":0', '"v1":1e999'))).toThrow(); // parses to Infinity
    expect(() => parseLimits(wrap({ ...ok, enabled: "yes" }))).toThrow();
    expect(() => parseLimits(wrap(null))).toThrow();
    expect(parseLimits(wrap(ok))).toEqual([ok]);
  });
});
