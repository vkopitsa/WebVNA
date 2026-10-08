// App-layer regression tests (store, controller, display) in Node with a Map-backed localStorage.
// The store reads localStorage when its module loads, so every test imports it dynamically after seeding storage.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { C } from "./lib/complex";
import type { MockLink } from "./lib/mock";

const mem = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  key: (i: number) => [...mem.keys()][i] ?? null,
  clear: () => mem.clear(),
  get length() { return mem.size; },
});

const SETTINGS = "webvna.settings.v1", ACTIVE_CAL = "webvna.activecal";
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { mem.clear(); vi.resetModules(); });
afterEach(() => vi.restoreAllMocks());

describe("store", () => {
  it("loadPersisted replaces malformed fields with defaults and keeps good ones", async () => {
    mem.set(SETTINGS, JSON.stringify({ traces: null, markers: [], kit: {}, tdr: { enabled: true }, points: 401, start: "x", stop: NaN, sweepMode: "log" }));
    const { useStore, initialState } = await import("./store");
    const s = useStore.getState();
    expect(s.traces).toEqual(initialState.traces);
    expect(s.markers).toHaveLength(8);
    expect(s.kit).toEqual(initialState.kit);
    expect(s.tdr).toEqual({ ...initialState.tdr, enabled: true }); // fields missing from an older save take the default
    expect(s.start).toBe(initialState.start);
    expect(s.points).toBe(401);
    expect(s.sweepMode).toBe("log");
    mem.set(SETTINGS, JSON.stringify({ traces: [{ enabled: false, color: "#123456" }, { format: "bogus", color: "#000000" }], markers: [{ f: 1e8 }] }));
    vi.resetModules();
    const t = (await import("./store")).useStore.getState();
    expect(t.traces).toEqual([{ ...initialState.traces[0], enabled: false, color: "#123456" }, ...initialState.traces.slice(1)]); // unknown format → default trace
    expect(t.markers).toEqual([{ ...initialState.markers[0], f: 1e8 }, ...initialState.markers.slice(1)]);
  });
  it("resetSettings also forgets the active calibration", async () => {
    mem.set(ACTIVE_CAL, "{}");
    const { resetSettings } = await import("./store");
    resetSettings();
    expect(mem.has(ACTIVE_CAL)).toBe(false);
  });
});

describe("controller", () => {
  it("software averaging keeps the grid it started with", async () => {
    const { set, get } = await import("./store");
    const ctl = await import("./controller");
    await ctl.connectSimulator();
    set({ swAverage: 1, points: 401 });
    await ctl.sweepOnce();
    const clean = get().raw;
    set({ swAverage: 4 });
    const p = ctl.sweepOnce();
    await tick();
    set({ points: 51 }); // stimulus change during the averaging passes
    await p;
    const avg = get().raw;
    expect(avg).toHaveLength(401);
    expect(Math.abs(C.abs(avg[300].s11) - C.abs(clean[300].s11))).toBeLessThan(0.02);
    expect(get().log.filter((e) => e.level === "error")).toEqual([]);
    await ctl.disconnect();
  });
  it("disconnecting mid-sweep logs no sweep error", async () => {
    // Like SerialLink, make close() wake pending reads with "The device was disconnected." (same module instance as the controller's).
    const mock = await import("./lib/mock");
    vi.spyOn(mock.MockLink.prototype, "close").mockImplementation(async function (this: MockLink) { (this as unknown as { markClosed(): void }).markClosed(); });
    const { set, get } = await import("./store");
    const ctl = await import("./controller");
    await ctl.connectSimulator();
    set({ points: 2001 });
    void ctl.startContinuous();
    await tick(60); // past reset()'s 50 ms settle: the driver is now reading FIFO data
    await ctl.disconnect();
    await tick(100); // let the in-flight sweep fail and reach the catch block
    expect(get().running).toBe(false);
    expect(get().log.filter((e) => e.level === "error")).toEqual([]);
  });
  it("a calibration with a bad kit never reaches the store", async () => {
    const { get } = await import("./store");
    const ctl = await import("./controller");
    const file = { name: "k.json", text: async () => '{"format":"webvna-cal","freqs":[1e8,2e8],"open":[[1,0],[1,0]],"short":[[-1,0],[-1,0]],"load":[[0,0],[0,0]],"kit":5}' } as unknown as File;
    await ctl.importCalFile(file);
    expect(get().kit).toEqual((await import("./lib/calibration")).IDEAL_KIT);
    expect(get().cal).toBeNull();
    expect(get().log.some((e) => e.level === "error" && e.msg.includes("k.json"))).toBe(true);
  });
});

describe("display", () => {
  it("Smith readouts for an exact open", async () => {
    const { zText } = await import("./display");
    const p = { f: 1e9, s11: [1, 0] as [number, number], s21: [0, 0] as [number, number] };
    expect(zText(p, "s11", "rx")).toBe("∞ Ω");
    expect(zText(p, "s11", "rlc")).toBe("∞ Ω");
    expect(zText(p, "s11", "rpxp")).toBe("∞ Ω");
    expect(zText(p, "s11", "gb")).toBe("0 S + j0 S");
    expect(zText(p, "s11", "lin")).toBe("1.0000 ∠ 0.00°");
    expect(zText({ ...p, s11: [NaN, NaN] }, "s11", "rx")).not.toContain("∞"); // a missing point is not an open
  });
  it("autoScale keeps the floor when every value is ∞", async () => {
    const { autoScale } = await import("./display");
    const sc = autoScale([Infinity, Infinity], 8, { floor: 1, cap: 30 });
    expect(sc.ref).toBeLessThanOrEqual(1);
    expect(sc.ref + 8 * sc.perDiv).toBeGreaterThanOrEqual(30);
  });
});
