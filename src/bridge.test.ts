import { afterEach, describe, expect, it } from "vitest";
import { createApi } from "./api";
import { BRIDGE_METHODS, dispatch, handleRequest, safeJson } from "./bridge";

const api = createApi();
afterEach(async () => { await api.disconnect(); });

describe("automation bridge dispatcher", () => {
  it("only whitelisted API methods are callable", async () => {
    for (const m of ["connect", "constructor", "__proto__", "on", "eval", "toString", "hasOwnProperty", "runScript", ""])
      await expect(dispatch(api, m, {})).rejects.toThrow(/disallowed/);
    await expect(dispatch(api, 42, {})).rejects.toThrow(/disallowed/);
    expect(BRIDGE_METHODS).toContain("sweep");
    expect(BRIDGE_METHODS).not.toContain("connect");
    for (const m of BRIDGE_METHODS) expect(typeof (api as unknown as Record<string, unknown>)[m]).toBe("function");
  });

  it("maps named and positional params and returns results", async () => {
    await dispatch(api, "connectSimulator", { dut: "antenna" });
    expect(await dispatch(api, "setStimulus", { start: 400e6, stop: 470e6, points: 21 })).toMatchObject({ points: 21 });
    expect(await dispatch(api, "sweep", undefined)).toHaveLength(21);
    expect(await dispatch(api, "trace", { i: 0 })).toMatchObject({ freqs: expect.any(Array) });
    expect(await dispatch(api, "trace", [0])).toMatchObject({ freqs: expect.any(Array) });
    await dispatch(api, "setMarker", { i: 1, f: 430e6 });
    expect((await dispatch(api, "markers", {}) as unknown[]).length).toBeGreaterThan(0);
    expect(await dispatch(api, "exportTouchstone", { ports: 1, fmt: "MA" })).toMatch(/# Hz S MA/);
    expect(await dispatch(api, "setState", { points: 11 })).toBeUndefined();
  });

  it("rejects bad params and propagates API errors", async () => {
    await expect(dispatch(api, "trace", { index: 0 })).rejects.toThrow(/Unknown parameter/);
    await expect(dispatch(api, "state", "x")).rejects.toThrow(/params must be/);
    await expect(dispatch(api, "sweep", {})).rejects.toThrow(/Not connected/);
    await expect(dispatch(api, "setState", { evil: 1 })).rejects.toThrow(/Not allowed/);
  });

  it("handleRequest replies with the request id, results and errors", async () => {
    const ok = JSON.parse((await handleRequest(api, JSON.stringify({ id: 5, method: "state" })))!);
    expect(ok.id).toBe(5);
    expect(ok.result.status).toBe("disconnected");
    const bad = JSON.parse((await handleRequest(api, JSON.stringify({ id: "a", method: "sweep" })))!);
    expect(bad).toEqual({ id: "a", error: { message: expect.stringMatching(/Not connected/) } });
    const evil = JSON.parse((await handleRequest(api, JSON.stringify({ id: 6, method: "constructor" })))!);
    expect(evil.error.message).toMatch(/disallowed/);
    expect(await handleRequest(api, "garbage")).toBeNull();
    expect(await handleRequest(api, JSON.stringify({ event: "x" }))).toBeNull();
  });

  it("safeJson keeps infinities readable", () => {
    expect(JSON.parse(safeJson([Infinity, -Infinity, NaN, 1]))).toEqual(["Infinity", "-Infinity", null, 1]);
  });
});
