import { describe, expect, it } from "vitest";
import { C, type Complex } from "./complex";
import type { SweepPoint } from "./litevna";
import { applyGate, canGate, DEFAULT_GATE, distanceToTime, gateTimeAxis, type GateSettings } from "./gating";
import { DEFAULT_TDR, timeDomain } from "./tdr";
import { SPEED_OF_LIGHT } from "./units";

const T1 = 2e-9, T2 = 10e-9;
const refl = (f: number, a: number, tau: number): Complex => C.scale(C.expj(-2 * Math.PI * f * tau), a);
const grid = (n = 401, f0 = 1e6, f1 = 1e9) => Array.from({ length: n }, (_, i) => f0 + ((f1 - f0) * i) / (n - 1));
const dut = (freqs: number[]): SweepPoint[] =>
  freqs.map((f) => ({ f, s11: C.add(refl(f, 0.3, T1), refl(f, 0.2, T2)), s21: C.add(refl(f, 0.5, T1), refl(f, 0.1, T2)) }));
const gate = (o: Partial<GateSettings>): GateSettings => ({ ...DEFAULT_GATE, enabled: true, ...o });
const maxErr = (a: SweepPoint[], b: (f: number) => Complex, ch: "s11" | "s21" | "s12" | "s22" = "s11", lo = 0.1, hi = 0.9) => {
  let m = 0;
  for (let i = Math.floor(a.length * lo); i < Math.ceil(a.length * hi); i++) m = Math.max(m, C.abs(C.sub(a[i][ch]!, b(a[i].f))));
  return m;
};

describe("time-domain gating", () => {
  const data = dut(grid());

  it("band-pass gate around the first reflection recovers it", () => {
    const out = applyGate(data, gate({ center: T1, span: 6e-9 }));
    expect(maxErr(out, (f) => refl(f, 0.3, T1))).toBeLessThan(0.02);
  });

  it("notch gate around the second reflection removes it", () => {
    const out = applyGate(data, gate({ type: "notch", center: T2, span: 6e-9 }));
    expect(maxErr(out, (f) => refl(f, 0.3, T1))).toBeLessThan(0.02);
  });

  it("band-pass at the second reflection recovers it, hard-edged gate too", () => {
    for (const window of ["minimum", "normal", "maximum"] as const) {
      const out = applyGate(data, gate({ center: T2, span: 6e-9, window }));
      expect(maxErr(out, (f) => refl(f, 0.2, T2))).toBeLessThan(0.03);
    }
  });

  it("an all-pass gate returns the input", () => {
    const out = applyGate(data, gate({ center: 0, span: 1e-6 }));
    expect(maxErr(out, (f) => C.add(refl(f, 0.3, T1), refl(f, 0.2, T2)), "s11", 0, 1)).toBeLessThan(1e-9);
  });

  it("channel selection", () => {
    const s11 = applyGate(data, gate({ channel: "s11", center: T1, span: 6e-9 }));
    expect(s11[100].s21).toEqual(data[100].s21);
    expect(s11[100].s11).not.toEqual(data[100].s11);
    const s21 = applyGate(data, gate({ channel: "s21", center: T1, span: 6e-9 }));
    expect(s21[100].s11).toEqual(data[100].s11);
    expect(maxErr(s21, (f) => refl(f, 0.5, T1), "s21")).toBeLessThan(0.03);
    const both = applyGate(data, gate({ channel: "both", center: T1, span: 6e-9 }));
    expect(maxErr(both, (f) => refl(f, 0.5, T1), "s21")).toBeLessThan(0.03);
    expect(maxErr(both, (f) => refl(f, 0.3, T1))).toBeLessThan(0.02);
  });

  it("works on a sweep that does not start near zero", () => {
    const d = dut(grid(401, 500e6, 1.5e9));
    const out = applyGate(d, gate({ center: T1, span: 6e-9 }));
    expect(maxErr(out, (f) => refl(f, 0.3, T1))).toBeLessThan(0.03);
  });

  it("disabled gate is identity", () => {
    expect(applyGate(data, { ...DEFAULT_GATE, enabled: false, center: T1 })).toBe(data);
  });

  it("log grid is returned unchanged", () => {
    const f = Array.from({ length: 101 }, (_, i) => 1e6 * Math.pow(1000, i / 100));
    const d = dut(f);
    expect(canGate(d)).toBe(false);
    expect(applyGate(d, gate({ center: T1, span: 6e-9 }))).toBe(d);
  });

  it("canGate: uniform yes, too short / decreasing no, 1 Hz rounding ok", () => {
    expect(canGate(data)).toBe(true);
    expect(canGate(data.slice(0, 3))).toBe(false);
    expect(canGate([...data].reverse())).toBe(false);
    expect(canGate(data.map((p, i) => ({ ...p, f: Math.round(p.f) + (i % 2) })))).toBe(true);
  });

  it("time axis and distance helper", () => {
    const ax = gateTimeAxis(data);
    expect(ax.tMax).toBeCloseTo(1 / (2 * 2.4975e6), 12);
    expect(ax.dt).toBeCloseTo(1 / (2048 * 2.4975e6), 14);
    expect(gateTimeAxis([]).tMax).toBe(0);
    expect(distanceToTime(1, 1, false)).toBeCloseTo(1 / SPEED_OF_LIGHT, 15);
    expect(distanceToTime(1, 0.66)).toBeCloseTo(2 / (SPEED_OF_LIGHT * 0.66), 15);
  });
});

describe("TDR zero-padding", () => {
  const d = dut(grid(201, 1e6, 1e9));
  it("default padding is 1 and unchanged", () => {
    expect(DEFAULT_TDR.padding).toBe(1);
    const a = timeDomain(d, "s11", DEFAULT_TDR)!;
    const b = timeDomain(d, "s11", { ...DEFAULT_TDR, padding: undefined as unknown as number })!;
    expect(a.value.length).toBe(512);
    expect(b.value).toEqual(a.value);
  });
  it("padding scales FFT size, refines time step, keeps range", () => {
    const a = timeDomain(d, "s11", DEFAULT_TDR)!;
    for (const padding of [2, 4, 8, 16]) {
      const r = timeDomain(d, "s11", { ...DEFAULT_TDR, padding })!;
      expect(r.value.length).toBe(a.value.length * padding);
      expect(r.time[1]).toBeCloseTo(a.time[1] / padding, 15);
      expect(r.resolution).toBe(a.resolution);
      expect(r.range).toBe(a.range);
    }
  });
  it("padded result interpolates: peak stays at the same time, amplitude not lower", () => {
    const mode = { ...DEFAULT_TDR, mode: "bandpass" as const };
    const peak = (v: Float64Array) => v.reduce((b, x, i) => (x > v[b] ? i : b), 0);
    const a = timeDomain(d, "s11", mode)!, b = timeDomain(d, "s11", { ...mode, padding: 8 })!;
    expect(Math.abs(b.time[peak(b.value)] - T1)).toBeLessThanOrEqual(Math.abs(a.time[peak(a.value)] - T1) + 1e-12);
    expect(Math.max(...b.value)).toBeGreaterThanOrEqual(Math.max(...a.value) - 1e-9);
  });
  it("invalid padding falls back to 1", () => {
    expect(timeDomain(d, "s11", { ...DEFAULT_TDR, padding: 3 })!.value.length).toBe(512);
  });
});

describe("gating keeps the other S-parameters", () => {
  const full = (freqs: number[]): SweepPoint[] =>
    freqs.map((f) => ({ ...dut([f])[0], s12: C.add(refl(f, 0.4, T1), refl(f, 0.2, T2)), s22: C.add(refl(f, 0.3, T1), refl(f, 0.3, T2)) }));
  it("passes s12/s22 through when only one channel is gated", () => {
    const data = full(grid());
    const out = applyGate(data, gate({ center: T1, span: 6e-9 }));
    expect(out[10].s12).toEqual(data[10].s12);
    expect(out[10].s22).toEqual(data[10].s22);
    expect(out[10].s11).not.toEqual(data[10].s11);
  });
  it("gates s12 and s22 too when the channel is both", () => {
    const data = full(grid());
    const out = applyGate(data, gate({ channel: "both", center: T1, span: 6e-9 }));
    // the T2 echo is outside the gate: s22 (0.3@T1 + 0.3@T2) must approach 0.3@T1
    expect(maxErr(out, (f) => refl(f, 0.3, T1), "s22")).toBeLessThan(0.05);
    expect(maxErr(out, (f) => refl(f, 0.4, T1), "s12")).toBeLessThan(0.05);
    expect(out[10].f).toBe(data[10].f);
  });
  it("leaves 2-port-less data without s12/s22", () => {
    const out = applyGate(dut(grid()), gate({ channel: "both", center: T1, span: 6e-9 }));
    expect(out[5].s12).toBeUndefined();
    expect(out[5].s22).toBeUndefined();
  });
});
