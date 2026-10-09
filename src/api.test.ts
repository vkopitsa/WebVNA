import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "./api";
import { get } from "./store";
import { clampHz, clampPoints, limitsOf } from "./caps";
import { createDriver } from "./lib/detect";
import { MockLink } from "./lib/mock";
import { MockShellLink } from "./lib/mock-shell";
import { runScript } from "./script";

const api = createApi();
afterEach(async () => { await api.disconnect(); });

describe("window.webvna API (simulator)", () => {
  it("connectSimulator → setStimulus → sweep returns N plain points", async () => {
    await api.connectSimulator();
    expect(get().status).toBe("connected");
    expect(api.setStimulus({ start: 400e6, stop: 470e6, points: 51 })).toMatchObject({ start: 400e6, stop: 470e6, points: 51, mode: "linear" });
    const d = await api.sweep();
    expect(d).toHaveLength(51);
    expect(Array.isArray(d[0].s11)).toBe(true);
    expect(d[0].f).toBeCloseTo(400e6, -3);
    expect(api.raw()).toHaveLength(51);
    expect(() => JSON.stringify(d)).not.toThrow();
    const tr = api.trace(0);
    expect(tr.values).toHaveLength(51);
    expect(Array.isArray(tr.values)).toBe(true);
    expect(api.exportTouchstone(2, "MA")).toMatch(/# Hz S MA R 50/);
    expect(api.exportCsv().split("\n").length).toBeGreaterThan(50);
    api.setMarker(1, 430e6);
    expect(api.markers().some((m) => m.index === 1)).toBe(true);
    expect(api.limits().pass).toBe(true);
    expect(api.state().capabilities?.protocol).toBe("v2");
  });

  it("fires on('sweep') after each completed sweep and unsubscribes", async () => {
    await api.connectSimulator();
    api.setStimulus({ start: 100e6, stop: 200e6, points: 21 });
    const seen: number[] = [];
    const off = api.on("sweep", (e) => seen.push(e.count));
    await api.sweep();
    await api.sweep();
    off();
    await api.sweep();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toBe(seen[0] + 1);
  });

  it("setState rejects unsafe keys and bad values, accepts settings", async () => {
    await expect(api.setState({ cal: null } as never)).rejects.toThrow(/Not allowed/);
    await expect(api.setState({ data: [] } as never)).rejects.toThrow(/Not allowed/);
    await expect(api.setState({ points: "5" } as never)).rejects.toThrow(/finite number/);
    await api.connectSimulator();
    await api.setState({ points: 33, swAverage: 2 });
    expect(get().points).toBe(33);
    expect(get().swAverage).toBe(2);
    await api.setState({ swAverage: 1 });
  });

  it("sweep() fails when not connected", async () => {
    await expect(api.sweep()).rejects.toThrow(/Not connected/);
  });

  for (const model of ["nanovna-h", "nanovna-h4", "nanovna-stock"] as const) {
    it(`connects the ${model} shell simulator and sweeps`, async () => {
      await api.connectSimulator({ model });
      const st = api.state();
      expect(st.capabilities?.protocol).toBe("v1-shell");
      expect(st.capabilities?.power).toBe(false);
      api.setStimulus({ start: 100e6, stop: 500e6, points: 150 }); // above the 101-point stock limit: segmented
      const d = await api.sweep();
      expect(d).toHaveLength(150);
    });
  }
});

describe("capability helpers", () => {
  it("limitsOf/clamp use the driver's range", async () => {
    expect(limitsOf(null).maxHz).toBe(6.3e9);
    const shell = await createDriver(new MockShellLink({ board: "H" }));
    await shell.init();
    expect(clampHz(5e9, shell.capabilities)).toBe(shell.capabilities.maxHz);
    expect(clampPoints(5000, shell.capabilities)).toBeLessThanOrEqual(shell.capabilities.maxPoints);
    const v2 = await createDriver(new MockLink());
    await v2.init();
    expect(v2.capabilities.protocol).toBe("v2");
    expect(v2.capabilities.power).toBe(true);
    expect(shell.capabilities.screenshot !== undefined && shell.setAverage === undefined).toBe(true);
  });
});

describe("script runner", () => {
  it("captures print output and the returned value, and errors", async () => {
    const r = await runScript('print("a", 1); await Promise.resolve(); return webvna.version;', api);
    expect(r).toMatchObject({ ok: true, output: "a 1", value: api.version });
    const e = await runScript("throw new Error('boom')", api);
    expect(e).toMatchObject({ ok: false, error: "boom" });
  });
});
