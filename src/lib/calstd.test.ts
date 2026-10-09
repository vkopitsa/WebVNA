import { describe, expect, it } from "vitest";
import { C, type Complex } from "./complex";
import {
  applyCalibration, computeErrorTerms, IDEAL_KIT, kitGamma, parseCal, serializeCal, standardFromTouchstone,
  type CalData, type CalKit, type StandardData,
} from "./calibration";
import type { SweepPoint } from "./litevna";
import { writeTouchstone } from "./touchstone";

const freqs = Array.from({ length: 51 }, (_, i) => 1e6 + (i * 499e6) / 50);
// Fixed, mildly bad error box.
const err = (f: number) => ({
  e00: C.polar(0.08, 0.3 + f * 1e-9), e11: C.polar(0.12, -0.5 + f * 2e-9), T: C.polar(0.9, -f * 3e-10),
});
const measure = (g: Complex, f: number): Complex => {
  const e = err(f);
  return C.add(e.e00, C.div(C.mul(e.T, g), C.sub([1, 0], C.mul(e.e11, g))));
};
const polyKit: CalKit = { ...IDEAL_KIT, name: "poly", open: { ...IDEAL_KIT.open, c0: 300, c1: 100 } };
const dutG = (f: number): Complex => C.polar(0.4, -f * 4e-9);

function calibrate(kit: CalKit, truth: CalKit): CalData {
  return {
    name: "t", created: "", freqs, kit, enhancedResponse: false,
    open: freqs.map((f) => measure(kitGamma(truth, "open", f), f)),
    short: freqs.map((f) => measure(kitGamma(truth, "short", f), f)),
    load: freqs.map((f) => measure(kitGamma(truth, "load", f), f)),
  };
}
const raw: SweepPoint[] = freqs.map((f) => ({ f, s11: measure(dutG(f), f), s21: [0, 0] }));
const worst = (cal: CalData) => {
  const out = applyCalibration(raw, computeErrorTerms(cal));
  return Math.max(...out.map((p) => C.abs(C.sub(p.s11, dutG(p.f)))));
};
// Standard as the .s1p of the polynomial open, on a denser grid so interpolation is accurate.
const fine = Array.from({ length: 501 }, (_, i) => 1e6 + (i * 499e6) / 500);
const openText = writeTouchstone(fine.map((f) => ({ f, s11: kitGamma(polyKit, "open", f), s21: [0, 0] as Complex })), 1, "open", "RI");

describe("Touchstone calibration standards", () => {
  it("standardFromTouchstone reads S11", () => {
    const s = standardFromTouchstone(openText, "open.s1p");
    expect(s.name).toBe("open.s1p");
    expect(s.freqs.length).toBe(501);
    expect(C.abs(C.sub(s.gamma[100], kitGamma(polyKit, "open", s.freqs[100])))).toBeLessThan(1e-8);
  });

  it("rejects empty files", () => {
    expect(() => standardFromTouchstone("# Hz S RI R 50\n", "x.s1p")).toThrow();
  });

  it("kitGamma interpolates and clamps measured data", () => {
    const data: StandardData = { name: "d", freqs: [1e6, 3e6], gamma: [[1, 0], [0, 1]] };
    const kit: CalKit = { ...IDEAL_KIT, data: { open: data } };
    expect(kitGamma(kit, "open", 2e6)).toEqual([0.5, 0.5]);
    expect(kitGamma(kit, "open", 0)).toEqual([1, 0]);
    expect(kitGamma(kit, "open", 9e9)).toEqual([0, 1]);
    // other standards still use the model
    expect(kitGamma(kit, "short", 2e6)[0]).toBeCloseTo(-1, 12);
  });

  it("calibration with the open given as data matches the polynomial kit", () => {
    const truth = polyKit;
    const viaPoly = worst(calibrate(polyKit, truth));
    const kit: CalKit = { ...IDEAL_KIT, name: "data", data: { open: standardFromTouchstone(openText, "open.s1p") } };
    const viaData = worst(calibrate(kit, truth));
    expect(viaPoly).toBeLessThan(1e-9);
    expect(viaData).toBeLessThan(1e-4);
    // and the ideal assumption would be clearly wrong
    expect(worst(calibrate(IDEAL_KIT, truth))).toBeGreaterThan(0.01);
  });

  it("any data forces the general solver (short and load too)", () => {
    const sh: StandardData = { name: "s", freqs: [1e6, 1e9], gamma: [[-1, 0], [-1, 0]] };
    const ld: StandardData = { name: "l", freqs: [1e6, 1e9], gamma: [[0, 0], [0, 0]] };
    const kit: CalKit = { ...IDEAL_KIT, data: { short: sh, load: ld } };
    expect(worst(calibrate(kit, IDEAL_KIT))).toBeLessThan(1e-9);
  });

  it("round-trips through serializeCal / parseCal", () => {
    const kit: CalKit = { ...IDEAL_KIT, data: { open: standardFromTouchstone(openText, "open.s1p") } };
    const cal = calibrate(kit, polyKit);
    const back = parseCal(serializeCal(cal));
    expect(back.kit.data?.open).toEqual(kit.data!.open);
    expect(worst(back)).toBeCloseTo(worst(cal), 12);
  });

  it("parseCal still accepts kits without data", () => {
    expect(parseCal(serializeCal(calibrate(polyKit, polyKit))).kit.data).toBeUndefined();
  });

  it("parseCal rejects malformed data", () => {
    const good = { name: "d", freqs: [1, 2], gamma: [[0, 0], [1, 0]] };
    const text = (d: unknown) => serializeCal({ ...calibrate(IDEAL_KIT, IDEAL_KIT), kit: { ...IDEAL_KIT, data: { open: d } } } as unknown as CalData);
    expect(() => parseCal(text(good))).not.toThrow();
    expect(() => parseCal(text({ ...good, gamma: [[0, 0]] }))).toThrow();
    expect(() => parseCal(text({ ...good, freqs: [] , gamma: [] }))).toThrow();
    expect(() => parseCal(text({ ...good, gamma: [[0, 0], [1]] }))).toThrow();
    expect(() => parseCal(text({ ...good, gamma: [[0, 0], [1, "x"]] }))).toThrow();
    expect(() => parseCal(text({ ...good, freqs: [1, null] }))).toThrow(); // JSON turns NaN into null
    expect(() => parseCal(text({ ...good, freqs: [2, 1] }))).toThrow();
    expect(() => parseCal(text({ ...good, name: 5 }))).toThrow();
    expect(() => parseCal(text("junk"))).toThrow();
    expect(() => parseCal(text(null))).toThrow();
  });
});
