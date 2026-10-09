import { afterEach, describe, expect, it } from "vitest";
import { get, set, initialState } from "./store";
import { buildFlip, capturePattern, connectSimulator, disconnect, measureFlip, sweepOnce } from "./controller";
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

describe("radiation pattern capture", () => {
  const setup = async () => {
    set({ ...initialState, simDut: "filter", start: 400e6, stop: 500e6, points: 21 });
    await connectSimulator();
    set((s) => ({ pattern: { ...s.pattern, freq: 435e6 } }));
  };
  it("captures from a fresh sweep and advances the angle", async () => {
    await setup();
    const n0 = get().sweepCount;
    await capturePattern();
    expect(get().sweepCount).toBe(n0 + 1);
    expect(get().pattern.points).toHaveLength(1);
    expect(get().pattern.angle).toBe(10);
  });
  it("does not record a point when no fresh sweep arrives (frozen)", async () => {
    await setup();
    await sweepOnce();
    set({ frozen: true });
    await capturePattern();
    expect(get().pattern.points).toHaveLength(0);
    expect(get().pattern.angle).toBe(0);
    expect(get().log.at(-1)?.level).toBe("error");
  });
  it("ignores a second press while a capture is pending", async () => {
    await setup();
    await sweepOnce(); // stale data exists, so a second capture would succeed if it weren't blocked
    await Promise.all([capturePattern(), capturePattern()]);
    expect(get().pattern.points).toHaveLength(1);
    expect(get().pattern.angle).toBe(10);
  });
});
