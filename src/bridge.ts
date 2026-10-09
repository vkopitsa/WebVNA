// Automation bridge: lets a local script (Python, …) call the `window.webvna` API through tools/ws-bridge.mjs.
// The page connects OUT to ws://127.0.0.1:<port>/app; nothing listens in the browser. Only a fixed list of API methods can be called
// (no code execution, no script runner), and the bridge is off until the user switches it on in the Script tab.
import { useSyncExternalStore } from "react";
import type { WebvnaApi } from "./api";

export const BRIDGE_KEY = "webvna.bridge";
export const DEFAULT_PORT = 8765;

/** How named params map to positional arguments. "object" = pass the params object itself as the single argument. */
const SPEC: Record<string, string[] | "object"> = {
  connectSimulator: "object", setStimulus: "object", setState: "object",
  disconnect: [], sweep: [], run: [], stop: [], raw: [], data: [], markers: [], exportCsv: [], state: [],
  setMarker: ["i", "f"], trace: ["i"], limits: ["i"], exportTouchstone: ["ports", "fmt"],
};
/** Methods a bridge client may call. connect() is excluded: the serial chooser needs a user gesture. */
export const BRIDGE_METHODS = Object.keys(SPEC);

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Call one whitelisted API method. `params` is an object (named) or an array (positional). Throws on anything else. */
export async function dispatch(api: WebvnaApi, method: unknown, params: unknown): Promise<unknown> {
  if (typeof method !== "string" || !Object.hasOwn(SPEC, method)) throw new Error(`Unknown or disallowed method "${String(method)}". Allowed: ${BRIDGE_METHODS.join(", ")}.`);
  const fn = (api as unknown as Record<string, unknown>)[method];
  if (typeof fn !== "function") throw new Error(`Method "${method}" is not available.`);
  const spec = SPEC[method];
  let args: unknown[];
  if (params === undefined || params === null) args = [];
  else if (Array.isArray(params)) args = params;
  else if (isObj(params)) {
    if (spec === "object") args = [params];
    else {
      const bad = Object.keys(params).filter((k) => !spec.includes(k));
      if (bad.length) throw new Error(`Unknown parameter(s) for ${method}: ${bad.join(", ")}. Expected: ${spec.join(", ") || "none"}.`);
      args = spec.map((k) => params[k]);
      while (args.length && args[args.length - 1] === undefined) args.pop();
    }
  } else throw new Error("params must be an object or an array");
  return await fn.apply(api, args);
}

/** JSON text with NaN as null and ±Infinity as the strings "Infinity" / "-Infinity" (SWR can be infinite). */
export function safeJson(v: unknown): string {
  return JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isFinite(x) ? (Number.isNaN(x) ? null : x > 0 ? "Infinity" : "-Infinity") : x)) ?? "null";
}

/** Handle one text message from the bridge ({id, method, params}); resolves to the reply text, or null when it is not a request. */
export async function handleRequest(api: WebvnaApi, text: string): Promise<string | null> {
  let m: unknown;
  try { m = JSON.parse(text); } catch { return null; }
  if (!isObj(m) || !("method" in m)) return null;
  const id = m.id ?? null;
  try {
    const result = await dispatch(api, m.method, m.params);
    return safeJson({ id, result: result === undefined ? null : result });
  } catch (e) {
    return safeJson({ id, error: { message: e instanceof Error ? e.message : String(e) } });
  }
}

// ---- connection manager (module state, observable from React) ----

export type BridgeStatus = "off" | "connecting" | "connected";
export interface BridgeState { enabled: boolean; port: number; token: string; status: BridgeStatus }

const loadSaved = (): { port: number; token: string } => {
  try {
    const o = JSON.parse(localStorage.getItem(BRIDGE_KEY) ?? "{}") as { port?: unknown; token?: unknown };
    const port = typeof o.port === "number" && Number.isInteger(o.port) && o.port > 0 && o.port < 65536 ? o.port : DEFAULT_PORT;
    return { port, token: typeof o.token === "string" ? o.token : "" };
  } catch { return { port: DEFAULT_PORT, token: "" }; }
};

let state: BridgeState = { enabled: false, ...loadSaved(), status: "off" };
const listeners = new Set<() => void>();
let ws: WebSocket | null = null;
let retry: ReturnType<typeof setTimeout> | undefined;
let offSweep: (() => void) | undefined;

const setState = (p: Partial<BridgeState>) => { state = { ...state, ...p }; listeners.forEach((l) => l()); };

export const getBridgeState = () => state;
export const subscribeBridge = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };
export const useBridge = () => useSyncExternalStore(subscribeBridge, getBridgeState);

const drop = () => {
  offSweep?.(); offSweep = undefined;
  if (ws) { const w = ws; ws = null; w.onclose = null; w.onerror = null; w.onmessage = null; try { w.close(); } catch { /* already closed */ } }
};

function open() {
  clearTimeout(retry);
  drop();
  if (!state.enabled) return;
  setState({ status: "connecting" });
  const q = state.token ? `?token=${encodeURIComponent(state.token)}` : "";
  let w: WebSocket;
  try { w = new WebSocket(`ws://127.0.0.1:${state.port}/app${q}`); } catch { schedule(); return; }
  ws = w;
  w.onopen = () => {
    setState({ status: "connected" });
    const api = window.webvna;
    offSweep = api.on("sweep", (e) => { if (w.readyState === WebSocket.OPEN) w.send(safeJson({ event: "sweep", data: e })); });
  };
  w.onmessage = (ev) => {
    if (typeof ev.data !== "string") return;
    void handleRequest(window.webvna, ev.data).then((r) => { if (r && w.readyState === WebSocket.OPEN) w.send(r); });
  };
  w.onclose = () => { if (ws === w) { ws = null; offSweep?.(); offSweep = undefined; schedule(); } };
  w.onerror = () => { /* onclose follows */ };
}

function schedule() {
  if (!state.enabled) { setState({ status: "off" }); return; }
  setState({ status: "connecting" });
  clearTimeout(retry);
  retry = setTimeout(open, 2000);
}

/** Switch the bridge on or off. While on, it reconnects every 2 s. Never enabled automatically at page load. */
export function setBridgeEnabled(enabled: boolean) {
  setState({ enabled });
  if (enabled) open();
  else { clearTimeout(retry); drop(); setState({ status: "off" }); }
}

/** Change port / token (persisted); reconnects when enabled. */
export function setBridgeConfig(p: { port?: number; token?: string }) {
  setState({ ...(p.port !== undefined ? { port: p.port } : {}), ...(p.token !== undefined ? { token: p.token } : {}) });
  try { localStorage.setItem(BRIDGE_KEY, JSON.stringify({ port: state.port, token: state.token })); } catch { /* storage unavailable */ }
  if (state.enabled) open();
}
