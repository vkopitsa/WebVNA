import { describe, expect, it } from "vitest";
import { mergeDefaults, mergePersisted, initialState, DEFAULT_RF_TEST } from "./store";
import { limitReports } from "./display";
import type { SweepPoint } from "./lib/litevna";

describe("mergePersisted", () => {
  it("adds defaults for fields missing in old persisted objects", () => {
    const old = {
      tdr: { enabled: true, mode: "bandpass", window: "normal", velocityFactor: 0.7, yAxis: "linear", xAxis: "distance", maxDistance: 0 },
      traces: [{ enabled: true, channel: "s21", format: "logmag", color: "#fff", scale: { auto: true, perDiv: 10, ref: 0, refPos: 7 }, memory: null, math: "off" }],
      kit: { name: "Custom", open: { c0: 5 } },
    };
    const m = mergePersisted(old);
    expect(m.tdr).toMatchObject({ enabled: true, mode: "bandpass", velocityFactor: 0.7, padding: 1 });
    expect(m.traces![0].limits).toEqual([]);
    expect(m.traces![0].channel).toBe("s21");
    expect(m.kit!.open).toMatchObject({ c0: 5, c1: 0, delayPs: 0 });
    expect(m.kit!.load.r).toBe(50);
  });

  it("keeps persisted limits, kit data and ignores unknown keys", () => {
    const limits = [{ kind: "upper", f1: 1, f2: 2, v1: 1.5, v2: 1.5 }];
    const data = { open: { name: "o.s1p", freqs: [1, 2], gamma: [[1, 0], [0.9, 0.1]] } };
    const m = mergePersisted({ traces: [{ ...initialState.traces[0], limits }], kit: { ...initialState.kit, data }, bogus: 1 });
    expect(m.traces![0].limits).toEqual(limits);
    expect(m.kit!.data).toEqual(data);
    expect("bogus" in m).toBe(false);
  });

  it("drops out-of-range and mistyped values instead of persisting them", () => {
    const m = mergePersisted({
      start: 5, stop: 1e12, points: 70000, cwFreq: "x", sweepMode: "bogus", swAverage: 0, ifAverage: 500, powerHf: 200, powerLf: -1, channelsMode: 7,
      deviceCal: "yes", simModel: "evil", simDut: "evil", lang: "xx", measure: "rm -rf", smithReadout: 5, measureVf: 9, autoSaveName: 3,
    });
    expect(m).toEqual({});
    const ok = mergePersisted({ points: 401, ifAverage: 80, powerHf: 0, powerLf: 3, channelsMode: 2, sweepMode: "log", simModel: "nanovna-h4", simDut: "pad", lang: "uk" });
    expect(ok).toEqual({ points: 401, ifAverage: 80, powerHf: 0, powerLf: 3, channelsMode: 2, sweepMode: "log", simModel: "nanovna-h4", simDut: "pad", lang: "uk" });
  });

  it("repairs malformed traces, markers and nested objects", () => {
    const m = mergePersisted({
      traces: [{ format: "bogus", channel: "s99", color: "red;x", scale: { perDiv: -1, ref: "a" }, limits: [{ kind: "upper", f1: "x" }], memory: "Z" }, 5],
      markers: [{ enabled: "x", f: -4, trace: 99, tracking: "weird" }, "x"],
      tdr: 5, gate: { span: "big", channel: "s11" }, core: { turns: -1 }, correction: { s11Delay: Infinity },
      fixture: { enabled: true, port1: [{ type: "file", op: "embed", name: "x", points: "oops" }], port2: [] },
      kit: { open: { c0: "x" }, data: { open: { name: 1, freqs: [1], gamma: [] } } },
    });
    const t0 = m.traces![0], d0 = initialState.traces[0];
    expect(t0).toEqual(d0);
    expect(m.traces).toHaveLength(2);
    expect(m.traces![1]).toEqual(initialState.traces[1]);
    expect(m.markers).toHaveLength(initialState.markers.length);
    expect(m.markers![0]).toEqual(initialState.markers[0]);
    expect(m.tdr).toEqual(initialState.tdr);
    expect(m.gate).toEqual({ ...initialState.gate });
    expect(m.core).toEqual(initialState.core);
    expect(m.correction).toEqual(initialState.correction);
    expect(m.fixture).toEqual(initialState.fixture);
    expect(m.kit!.open.c0).toBe(0);
    expect(m.kit!.data).toBeUndefined();
  });

  it("rejects non-array traces/markers and non-object input", () => {
    expect(mergePersisted({ traces: "x", markers: "x" })).toEqual({});
    expect(mergePersisted({ traces: [] })).toEqual({});
    expect(mergePersisted(5 as never)).toEqual({});
  });

  it("keeps a valid fixture and valid kit data", () => {
    const fixture = { enabled: true, z0: 75, port1: [{ type: "lumped", op: "embed", kind: "series", element: "L", value: 1e-9 }, { type: "line", op: "deembed", z0: 50, lengthM: 0.1, vf: 0.7 }], port2: [] };
    expect(mergePersisted({ fixture }).fixture).toEqual(fixture);
  });

  it("mergeDefaults fills nested objects only", () => {
    expect(mergeDefaults({ a: 1, b: { c: 2, d: 3 }, e: [1] }, { b: { c: 9 }, e: [] })).toEqual({ a: 1, b: { c: 9, d: 3 }, e: [] });
  });
});

describe("limitReports", () => {
  const data: SweepPoint[] = [1e6, 2e6, 3e6].map((f) => ({ f, s11: [0.5, 0], s21: [0, 0] })); // SWR 3
  const mk = (limits: unknown) => ({ data, memories: {}, core: initialState.core, traces: [{ ...initialState.traces[1], limits }] } as never);
  it("reports pass, fail and nothing checked", () => {
    expect(limitReports(mk([{ kind: "upper", f1: 1e6, f2: 3e6, v1: 5, v2: 5 }]))[0].status).toBe("pass");
    expect(limitReports(mk([{ kind: "upper", f1: 1e6, f2: 3e6, v1: 2, v2: 2 }]))[0].status).toBe("fail");
    expect(limitReports(mk([{ kind: "upper", f1: 5e6, f2: 6e6, v1: 2, v2: 2 }]))[0].status).toBe("none");
    expect(limitReports(mk([]))).toEqual([]);
  });
});

describe("rfTest settings", () => {
  it("fills defaults and repairs bad fields", () => {
    const p = mergePersisted({ rfTest: { gainMethod: "ref", distance: -1, refGain: "x", floorSlot: true } });
    expect(p.rfTest).toEqual({ ...DEFAULT_RF_TEST, gainMethod: "ref", floorSlot: true });
    expect(mergePersisted({ measure: "directivity" }).measure).toBe("directivity");
  });
});
