import { describe, expect, it } from "vitest";
import { C, type Complex } from "./complex";
import { FORMAT_BY_ID, FORMATS, formatValue, impedance, traceValues, type FormatId } from "./formats";
import { airInductance, DEFAULT_CORE, permeability, type CoreParams } from "./permeability";

/** Γ for a given series impedance on S11. */
const gammaOf = (z: Complex): Complex => C.div(C.sub(z, [50, 0]), C.add(z, [50, 0]));
const f = 10e6, w = 2 * Math.PI * f;

describe("R/ω and X/ω", () => {
  it("series R + jωL", () => {
    const L = 2e-6, R = 30;
    const g = gammaOf([R, w * L]);
    expect(formatValue("rw", g, f, "s11")).toBeCloseTo(R / w, 12);
    expect(formatValue("xw", g, f, "s11")).toBeCloseTo(L, 12);
    expect(formatValue("xw", g, f, "s11")).toBeCloseTo(formatValue("l", g, f, "s11"), 12);
  });
  it("capacitive gives negative X/ω", () => {
    expect(formatValue("xw", gammaOf([10, -100]), f, "s11")).toBeLessThan(0);
  });
  it("S21 series fixture uses impedance()", () => {
    const s21: Complex = [0.8, -0.1];
    const z = impedance(s21, "s21");
    expect(formatValue("rw", s21, f, "s21")).toBeCloseTo(z[0] / w, 15);
  });
  it("definitions", () => {
    expect(FORMAT_BY_ID.rw).toMatchObject({ label: "R/ω", unit: "Ω·s", impedance: true });
    expect(FORMAT_BY_ID.xw).toMatchObject({ label: "X/ω", unit: "H", impedance: true });
  });
});

describe("permeability", () => {
  const core: CoreParams = { turns: 10, areaMm2: 7, pathMm: 21.2 };
  it("air inductance µ0 N² A / l", () => {
    expect(airInductance(core)).toBeCloseTo((4e-7 * Math.PI * 100 * 7e-6) / 21.2e-3, 15);
    expect(airInductance(DEFAULT_CORE)).toBeGreaterThan(1e-8);
    expect(airInductance(DEFAULT_CORE)).toBeLessThan(1e-6);
  });
  it("µ′ and µ″ recover a synthetic core", () => {
    const L = airInductance(core), mu1 = 800, mu2 = 300;
    const z: Complex = [w * L * mu2, w * L * mu1];
    const p = permeability(z, f, core);
    expect(p.mu1).toBeCloseTo(mu1, 9);
    expect(p.mu2).toBeCloseTo(mu2, 9);
  });
  it("air core gives µ′ = 1, µ″ = 0", () => {
    const p = permeability([0, w * airInductance(core)], f, core);
    expect(p.mu1).toBeCloseTo(1, 12);
    expect(p.mu2).toBeCloseTo(0, 12);
  });
  it("formatValue mu_r / mu_i use default core and honour opts.core", () => {
    const L = airInductance(DEFAULT_CORE);
    const g = gammaOf([w * L * 40, w * L * 100]);
    expect(formatValue("mu_r", g, f, "s11")).toBeCloseTo(100, 6);
    expect(formatValue("mu_i", g, f, "s11")).toBeCloseTo(40, 6);
    const dbl = { core: { ...DEFAULT_CORE, turns: DEFAULT_CORE.turns * 2 } }; // 4x air L → µ/4
    expect(formatValue("mu_r", g, f, "s11", dbl)).toBeCloseTo(25, 6);
    expect(formatValue("mu_i", g, f, "s11", dbl)).toBeCloseTo(10, 6);
  });
  it("traceValues passes opts through", () => {
    const L = airInductance(DEFAULT_CORE);
    const data = [10e6, 20e6].map((fr) => ({ f: fr, s11: gammaOf([0, 2 * Math.PI * fr * L * 50]), s21: [0, 0] as Complex }));
    const a = traceValues(data, "s11", "mu_r");
    expect(a[0]).toBeCloseTo(50, 6); expect(a[1]).toBeCloseTo(50, 6);
    const b = traceValues(data, "s11", "mu_r", { core: { ...DEFAULT_CORE, turns: DEFAULT_CORE.turns * 2 } });
    expect(b[0]).toBeCloseTo(12.5, 6);
  });
});

describe("format registry", () => {
  it("new ids are registered once and existing ones unchanged", () => {
    for (const id of ["rw", "xw", "mu_r", "mu_i"] as FormatId[]) expect(FORMATS.filter((x) => x.id === id)).toHaveLength(1);
    expect(new Set(FORMATS.map((x) => x.id)).size).toBe(FORMATS.length);
    expect(FORMAT_BY_ID.mu_r.label).toBe("µ′");
    expect(FORMAT_BY_ID.mu_i.label).toBe("µ″");
    const g = gammaOf([30, 40]);
    expect(formatValue("r", g, f, "s11")).toBeCloseTo(30, 9);
  });
});
