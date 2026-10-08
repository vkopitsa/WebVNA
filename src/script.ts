// Runs user scripts with `webvna` and `print` in scope. Local to the page: nothing is sent anywhere.
import type { WebvnaApi } from "./api";

export const SCRIPT_KEY = "webvna.script";

export const EXAMPLE_SCRIPT = `// Runs locally in this page. 'webvna' and print() are in scope; use await.
await webvna.connectSimulator({ dut: "antenna" });
webvna.setStimulus({ start: 400e6, stop: 470e6, points: 101 });
const data = await webvna.sweep();
const swr = webvna.trace(1);
const best = Math.min(...swr.values);
print("points:", data.length, " min SWR:", best.toFixed(2));
return webvna.markers();
`;

export interface ScriptResult { ok: boolean; output: string; value?: unknown; error?: string }

const show = (v: unknown): string => {
  if (typeof v === "string") return v;
  if (v === undefined) return "undefined";
  try { return JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isFinite(x) ? String(x) : x), 2) ?? String(v); } catch { return String(v); }
};

/** Execute `code` as the body of an async function. print() output and the returned value are captured. */
export async function runScript(code: string, api: WebvnaApi, onPrint?: (line: string) => void): Promise<ScriptResult> {
  const lines: string[] = [];
  const print = (...a: unknown[]) => { const l = a.map(show).join(" "); lines.push(l); onPrint?.(l); };
  try {
    const fn = new Function("webvna", "print", "return (async () => {" + code + "\n})()") as (w: WebvnaApi, p: typeof print) => Promise<unknown>;
    const value = await fn(api, print);
    return { ok: true, output: lines.join("\n"), value };
  } catch (e) {
    return { ok: false, output: lines.join("\n"), error: e instanceof Error ? e.message : String(e) };
  }
}

export const formatValue = show;
