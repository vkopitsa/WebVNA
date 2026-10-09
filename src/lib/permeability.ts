// Complex permeability of a toroidal inductor core from S11 (NanoVNA-Saver "S11 µ").
import type { Complex } from "./complex";

export interface CoreParams {
  turns: number;
  /** Effective core cross-section, mm². */
  areaMm2: number;
  /** Effective magnetic path length, mm. */
  pathMm: number;
}

/** Approximate FT-37-43 (OD 9.5 mm): Ae ≈ 7 mm², le ≈ 21.2 mm, 10 turns. */
export const DEFAULT_CORE: CoreParams = { turns: 10, areaMm2: 7.0, pathMm: 21.2 };

const MU0 = 4e-7 * Math.PI;

/** Air-core inductance µ0·N²·A/l, H. */
export function airInductance(core: CoreParams): number {
  return (MU0 * core.turns ** 2 * core.areaMm2 * 1e-6) / (core.pathMm * 1e-3);
}

/** Z = jωL_air(µ′ − jµ″) → µ′ = X/(ωL_air), µ″ = R/(ωL_air). */
export function permeability(z: Complex, f: number, core: CoreParams): { mu1: number; mu2: number } {
  const wl = 2 * Math.PI * f * airInductance(core);
  return { mu1: z[1] / wl, mu2: z[0] / wl };
}
