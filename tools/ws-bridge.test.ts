import { spawn, type ChildProcess } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let proc: ChildProcess;
let port = 0;
const TOKEN = "s3cret";

const start = (extra: string[] = []) =>
  new Promise<{ proc: ChildProcess; port: number }>((resolve, reject) => {
    const p = spawn(process.execPath, ["tools/ws-bridge.mjs", "--port", "0", ...extra], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stdout!.on("data", (d: Buffer) => {
      out += d.toString();
      const m = /ws:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m) resolve({ proc: p, port: Number(m[1]) });
    });
    p.on("error", reject);
    p.on("exit", (c) => reject(new Error(`bridge exited ${c}`)));
  });

const open = (path: string) =>
  new Promise<WebSocket>((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`);
    ws.onopen = () => resolve(ws);
    ws.onerror = () => reject(new Error("connect failed"));
  });

/** Next message for which `pick` returns true. */
const next = (ws: WebSocket, pick: (m: Record<string, unknown>) => boolean = () => true) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const h = (e: MessageEvent) => {
      const m = JSON.parse(String(e.data)) as Record<string, unknown>;
      if (pick(m)) { ws.removeEventListener("message", h); resolve(m); }
    };
    ws.addEventListener("message", h);
  });

beforeAll(async () => { ({ proc, port } = await start(["--token", TOKEN])); });
afterAll(() => { proc.removeAllListeners("exit"); proc.kill(); });

describe("tools/ws-bridge.mjs", () => {
  it("rejects a missing or wrong token and unknown paths", async () => {
    await expect(open("/client")).rejects.toThrow();
    await expect(open("/client?token=nope")).rejects.toThrow();
    await expect(open(`/other?token=${TOKEN}`)).rejects.toThrow();
  });

  it("routes requests to the app and replies back under the client's id, with errors", async () => {
    const app = await open(`/app?token=${TOKEN}`);
    app.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id: number; method: string; params: Record<string, unknown> };
      app.send(JSON.stringify(m.method === "boom" ? { id: m.id, error: { message: "bad" } } : { id: m.id, result: { echo: m.method, params: m.params } }));
    };
    const a = await open(`/client?token=${TOKEN}`);
    const b = await open(`/client?token=${TOKEN}`);
    const ra = next(a, (m) => "id" in m);
    const rb = next(b, (m) => "id" in m);
    a.send(JSON.stringify({ id: 7, method: "state", params: { x: 1 } }));
    b.send(JSON.stringify({ id: 7, method: "boom" }));
    expect(await ra).toEqual({ id: 7, result: { echo: "state", params: { x: 1 } } });
    expect(await rb).toEqual({ id: 7, error: { message: "bad" } });
    a.send("not json");
    expect((await next(a)).error).toBeTruthy();
    a.close(); b.close(); app.close();
  });

  it("broadcasts app events to every client and reports a missing app", async () => {
    const a = await open(`/client?token=${TOKEN}`);
    const b = await open(`/client?token=${TOKEN}`);
    const none = next(a, (m) => "id" in m);
    a.send(JSON.stringify({ id: 1, method: "state" }));
    expect(((await none).error as { message: string }).message).toMatch(/not connected/);
    const ea = next(a, (m) => m.event === "sweep");
    const eb = next(b, (m) => m.event === "sweep");
    const app = await open(`/app?token=${TOKEN}`);
    app.send(JSON.stringify({ event: "sweep", data: { count: 3 } }));
    expect((await ea).data).toEqual({ count: 3 });
    expect((await eb).data).toEqual({ count: 3 });
    a.close(); b.close(); app.close();
  });

  it("relays a large (5 MB) message and a 70 KB one (64-bit length path is >= 64 KiB)", async () => {
    const app = await open(`/app?token=${TOKEN}`);
    app.onmessage = (e) => {
      const m = JSON.parse(String(e.data)) as { id: number; params: { blob: string } };
      app.send(JSON.stringify({ id: m.id, result: m.params.blob }));
    };
    const c = await open(`/client?token=${TOKEN}`);
    for (const n of [70_000, 5 * 1024 * 1024]) {
      const blob = "é".repeat(n / 2);
      const r = next(c, (m) => m.id === n);
      c.send(JSON.stringify({ id: n, method: "x", params: { blob } }));
      expect((await r).result).toBe(blob);
    }
    c.close(); app.close();
  });

  it("closes a client that sends a message over the limit", async () => {
    const c = await open(`/client?token=${TOKEN}`);
    const closed = new Promise<number>((r) => { c.onclose = (e) => r(e.code); });
    c.send("x".repeat(17 * 1024 * 1024));
    expect(await closed).toBe(1009);
  });

  it("refuses browser-origin /client connections and mismatched --origin on /app", async () => {
    const raw = async (p: number, path: string, origin: string) => {
      const { request } = await import("node:http");
      return new Promise<number>((resolve) => {
        const req = request({ host: "127.0.0.1", port: p, path, headers: { Connection: "Upgrade", Upgrade: "websocket", "Sec-WebSocket-Version": "13", "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==", Origin: origin } });
        req.on("upgrade", (res, s) => { s.destroy(); resolve(res.statusCode ?? 0); });
        req.on("response", (res) => resolve(res.statusCode ?? 0));
        req.end();
      });
    };
    expect(await raw(port, `/client?token=${TOKEN}`, "https://evil.example")).toBe(403);
    const o = await start(["--origin", "https://good.example"]);
    try {
      expect(await raw(o.port, "/app", "https://evil.example")).toBe(403);
      expect(await raw(o.port, "/app", "https://good.example")).toBe(101);
    } finally { o.proc.removeAllListeners("exit"); o.proc.kill(); }
  });
});
