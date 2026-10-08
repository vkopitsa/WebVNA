import { describe, expect, it } from "vitest";
import { C } from "./complex";
import { LiteVNA } from "./litevna";
import { MockLink, dutS4, type Dut } from "./mock";
import { computeErrorTerms, IDEAL_KIT, type CalData } from "./calibration";
import { combineFlip, fakeFlip } from "./twoport";
import { parseTouchstone, writeTouchstone } from "./touchstone";
import { processData } from "../process";
import { NO_CORRECTION } from "./calibration";
import { DEFAULT_GATE } from "./gating";
import { NO_FIXTURE } from "./deembed";

const START = 100e6, STOP = 900e6, N = 41;

async function setup() {
  const link = new MockLink(), vna = new LiteVNA(link);
  await vna.init();
  return { link, vna };
}

async function calibrate(link: MockLink, vna: LiteVNA): Promise<CalData> {
  const meas = async (d: Dut) => { link.dut = d; return vna.sweep(START, STOP, N); };
  const o = await meas("open"), s = await meas("short"), l = await meas("load"), iso = await meas("isolation"), t = await meas("thru");
  return {
    name: "t", created: "", freqs: o.map((p) => p.f), kit: IDEAL_KIT, enhancedResponse: true,
    open: o.map((p) => p.s11), short: s.map((p) => p.s11), load: l.map((p) => p.s11),
    isolation: iso.map((p) => p.s21), thru: t.map((p) => p.s21), thru11: t.map((p) => p.s11),
  };
}

describe("flip-DUT two-port", () => {
  it("recovers S11, S21, S12, S22 of an asymmetric pad from forward and reversed sweeps", async () => {
    const { link, vna } = await setup();
    const terms = computeErrorTerms(await calibrate(link, vna));
    link.dut = "pad";
    link.reversed = false;
    const fwd = await vna.sweep(START, STOP, N);
    link.reversed = true;
    const rev = await vna.sweep(START, STOP, N);
    const out = combineFlip(fwd, rev, terms);
    expect(out).toHaveLength(N);
    for (const p of out) {
      const t = dutS4("pad", p.f);
      for (const k of ["s11", "s21", "s12", "s22"] as const) expect(C.abs(C.sub(p[k]!, t[k]))).toBeLessThan(0.01);
    }
    // the pad really is asymmetric, so the test is meaningful
    const t0 = dutS4("pad", 500e6);
    expect(C.abs(C.sub(t0.s11, t0.s22))).toBeGreaterThan(0.1);
  });

  it("the Touchstone export carries the real S12/S22 and round-trips", async () => {
    const { link, vna } = await setup();
    link.dut = "pad";
    const fwd = await vna.sweep(START, STOP, N);
    link.reversed = true;
    const rev = await vna.sweep(START, STOP, N);
    const res = combineFlip(fwd, rev, null);
    const back = parseTouchstone(writeTouchstone(res, 2, "t"), "x.s2p");
    expect(back.ports).toBe(2);
    expect(C.abs(C.sub(back.data[5].s22!, res[5].s22!))).toBeLessThan(1e-6);
    expect(C.abs(C.sub(back.data[5].s12!, res[5].s12!))).toBeLessThan(1e-6);
  });

  it("fakeFlip mirrors a symmetric DUT", () => {
    const f = fakeFlip([{ f: 1e6, s11: [0.1, 0.2], s21: [0.3, 0.4] }]);
    expect(f[0].s22).toEqual([0.1, 0.2]);
    expect(f[0].s12).toEqual([0.3, 0.4]);
  });
});

describe("processData pipeline", () => {
  const raw = [1e6, 2e6, 3e6, 4e6].map((f) => ({ f, s11: [0.2, 0.1] as [number, number], s21: [0.5, 0] as [number, number] }));
  const base = { calEnabled: true, terms: null, correction: NO_CORRECTION, fixture: NO_FIXTURE, gate: DEFAULT_GATE };
  it("passes data through without fixture and applies the fixture when enabled", () => {
    expect(processData(raw, base)).toEqual(raw);
    const fx = { enabled: true, port1: [{ type: "lumped" as const, op: "embed" as const, kind: "series" as const, element: "R" as const, value: 50 }], port2: [] };
    const out = processData(raw, { ...base, fixture: fx });
    expect(out[0].s11).not.toEqual(raw[0].s11);
    expect(processData(raw, { ...base, fixture: { ...fx, enabled: false } })).toEqual(raw);
  });
  it("throws on an empty file stage and returns [] for no data", () => {
    const fx = { enabled: true, port1: [{ type: "file" as const, op: "deembed" as const, name: "x", points: [] }], port2: [] };
    expect(() => processData(raw, { ...base, fixture: fx })).toThrow();
    expect(processData([], base)).toEqual([]);
  });
});
