import { afterEach, describe, expect, it } from "vitest";
import { get, set, initialState } from "./store";
import { buildFlip, connectSimulator, disconnect, measureFlip } from "./controller";
import { dutS4 } from "./lib/mock";
import { C } from "./lib/complex";

afterEach(async () => { await disconnect(); set({ ...initialState }); });

describe("flip-DUT wizard with the NanoVNA shell simulator", () => {
  it("recovers the asymmetric pad (S22 differs from S11) from a reversed sweep", async () => {
    // device-calibrated data (data mode 3) so the shell simulator returns ideal S-parameters
    set({ ...initialState, simModel: "nanovna-h", simDut: "pad", deviceCal: true, start: 100e6, stop: 800e6, points: 41 });
    await connectSimulator();
    expect(get().capabilities?.protocol).toBe("v1-shell");
    await measureFlip("fwd");
    await measureFlip("rev");
    buildFlip();
    const res = get().twoPort.result!;
    expect(res).toHaveLength(41);
    for (const p of res) {
      const t = dutS4("pad", p.f);
      for (const k of ["s11", "s21", "s12", "s22"] as const) expect(C.abs(C.sub(p[k]!, t[k]))).toBeLessThan(0.02);
    }
    const mid = res[20];
    expect(C.abs(C.sub(mid.s22!, mid.s11))).toBeGreaterThan(0.1);
  });
});

describe("device-cal preference", () => {
  it("is kept when a device without that capability connects", async () => {
    set({ ...initialState, simModel: "nanovna-stock", deviceCal: true });
    await connectSimulator();
    expect(get().capabilities?.deviceCal).toBe(false);
    expect(get().deviceCal).toBe(true);
  });
});
