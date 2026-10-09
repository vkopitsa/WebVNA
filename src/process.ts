// Pure data pipeline shared by the controller: raw sweep → calibration → fixture (de-embed/embed) → time gating.
import type { SweepPoint } from "./lib/litevna";
import { applyCalibration, type Correction, type ErrorTerms } from "./lib/calibration";
import { applyFixture, type FixtureSettings } from "./lib/deembed";
import { applyGate, type GateSettings } from "./lib/gating";

export interface ProcessSettings { calEnabled: boolean; terms: ErrorTerms | null; correction: Correction; fixture: FixtureSettings; gate: GateSettings }

/** Calibrate a raw sweep (no fixture or gate). */
export const calibrate = (raw: SweepPoint[], s: Pick<ProcessSettings, "calEnabled" | "terms" | "correction">): SweepPoint[] =>
  raw.length ? applyCalibration(raw, s.calEnabled ? s.terms : null, s.correction) : [];

/** Full pipeline. Throws if a fixture stage is unusable (e.g. an empty file stage). */
export function processData(raw: SweepPoint[], s: ProcessSettings): SweepPoint[] {
  if (!raw.length) return [];
  return applyGate(applyFixture(calibrate(raw, s), s.fixture), s.gate);
}
