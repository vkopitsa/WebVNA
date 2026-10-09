import { describe, expect, it } from "vitest";
import { C } from "./complex";
import type { SweepPoint } from "./litevna";
import { DEFAULT_PATTERN, addPatternPoint, capturePoint, undoCapture, patternCsv, patternMetrics, patternValueAt, s21DbAt, type PatternPoint } from "./pattern";

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

describe("capture freq lock and undo", () => {
  const data: SweepPoint[] = [1e9, 2e9, 3e9].map((f, i) => ({ f, s11: [0, 0], s21: C.polar(10 ** ((-20 - 10 * i) / 20), 0) }));
  it("locks the marker frequency on the first capture", () => {
    const st = capturePoint(DEFAULT_PATTERN, data, 2e9)!;
    expect(st.freq).toBe(2e9);
    expect(capturePoint(st, data, 3e9)!.points[1].db).toBeCloseTo(-30, 9); // marker moved; still 2 GHz
  });
  it("undo restores the point, angle and frequency even after the step changed", () => {
    let st = capturePoint({ ...DEFAULT_PATTERN, freq: 1e9 }, data, 0)!; // 0° → −20
    st = capturePoint(st, data, 0)!; // 10°
    st = capturePoint({ ...st, angle: 0, freq: 3e9 }, data, 0)!; // re-capture 0° at −40 (replaces)
    st = { ...st, step: 5 };
    st = undoCapture(st);
    expect(st.points).toEqual([{ deg: 0, db: -20 }, { deg: 10, db: -20 }]);
    expect(st.angle).toBe(0);
    expect(st.freq).toBe(3e9); // the frequency in effect before that capture
    st = undoCapture(undoCapture(st));
    expect(st.points).toEqual([]);
    expect(st.angle).toBe(0);
    expect(st.freq).toBe(1e9);
    expect(undoCapture(st)).toBe(st);
  });
});
