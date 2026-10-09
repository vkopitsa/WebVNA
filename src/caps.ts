// Capability helpers: what the connected driver allows (frequency range, point count), with LiteVNA-sized defaults while disconnected.
import type { DriverCapabilities } from "./lib/driver";
import type { SimModel } from "./store";
import { MIN_HZ } from "./lib/protocol";

export const DEFAULT_LIMITS = { minHz: MIN_HZ, maxHz: 6.3e9, maxPoints: 65535 } as const;

export function limitsOf(caps: Pick<DriverCapabilities, "minHz" | "maxHz" | "maxPoints"> | null | undefined) {
  if (!caps) return { ...DEFAULT_LIMITS };
  return { minHz: caps.minHz || DEFAULT_LIMITS.minHz, maxHz: caps.maxHz || DEFAULT_LIMITS.maxHz, maxPoints: caps.maxPoints || DEFAULT_LIMITS.maxPoints };
}

export const clampHz = (f: number, caps: DriverCapabilities | null | undefined) => {
  const l = limitsOf(caps);
  return Math.max(l.minHz, Math.min(f, l.maxHz));
};

export const clampPoints = (n: number, caps: DriverCapabilities | null | undefined) => Math.max(2, Math.min(Math.round(n), limitsOf(caps).maxPoints));

/** Simulator model → English label (translate with t() at display time). */
export const SIM_MODEL_LABEL: Record<SimModel, string> = {
  litevna: "LiteVNA (V2 protocol)",
  "nanovna-h": "NanoVNA-H (NanoVNA-D firmware)",
  "nanovna-h4": "NanoVNA-H4 (NanoVNA-D firmware)",
  "nanovna-stock": "NanoVNA-H (stock firmware)",
  librevna: "LibreVNA (experimental)",
};
