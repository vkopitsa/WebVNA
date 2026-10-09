// Common surface of every VNA driver (LiteVNA / NanoVNA V2 binary protocol, NanoVNA V1/H/H4 text shell).
import type { LinkBase } from "./links";
import type { DeviceInfo } from "./protocol";
import type { SweepOptions, SweepPoint } from "./litevna";

export interface Segment { start: number; stop: number; points: number }

/** What the device can do; the UI hides controls that are not supported. */
export interface DriverCapabilities {
  protocol: "v2" | "v1-shell" | "libre";
  /** Largest total point count the app may request (segmented sweeps included). */
  maxPoints: number;
  minHz: number;
  maxHz: number;
  screenshot: boolean;
  battery: boolean;
  /** IF averaging (setAverage). */
  ifAverage: boolean;
  /** Generator power control (setPower). */
  power: boolean;
  /** Channel selection (setChannels). */
  channels: boolean;
  /** The device can deliver its own calibrated data (setDataMode(DATA_MODE.DEVICE_CAL)). */
  deviceCal: boolean;
  serial: boolean;
  /** Real-time clock (setTime). */
  clock: boolean;
  /** Text-shell only: binary scan framing was probed and works. */
  binaryScan?: boolean;
}

export interface DriverStats { records: number; badChecksum: number; zeroChecksum: number; sweeps: number; lastSweepMs: number }

export interface VnaDriver {
  readonly link: LinkBase;
  info: DeviceInfo | null;
  stats: DriverStats;
  /** Valid after init(); before that a conservative guess. */
  readonly capabilities: DriverCapabilities;
  /** Serialise device access: every public operation runs exclusively. */
  exclusive<T>(fn: () => Promise<T>): Promise<T>;
  init(): Promise<DeviceInfo>;
  sweepSegments(segments: Segment[], o?: SweepOptions, maxPerSegment?: number): Promise<SweepPoint[]>;
  /** End the session so the device screen resumes (V2: exit USB mode, shell: `resume`). */
  exitUsbMode(): Promise<void>;
  // ---- capability-gated operations (see `capabilities`)
  setAverage?(n: number): Promise<void>;
  setPower?(p: { lf?: number; hf?: number }): Promise<void>;
  setChannels?(mode: number): Promise<void>;
  setTime?(unixSeconds?: number): Promise<void>;
  /** Battery voltage in volts. */
  readVbat?(): Promise<number>;
  /** DATA_MODE.DEVICE_CAL (3) → device-calibrated data, DATA_MODE.USB (0) → raw. */
  setDataMode?(mode: number): Promise<void>;
  readSerial?(): Promise<string>;
  screenshot?(timeout?: number): Promise<{ width: number; height: number; rgba: Uint8ClampedArray }>;
}

/** Split segments longer than maxPerSegment into consecutive linear runs. */
export function splitSegments(segments: Segment[], maxPerSegment: number): Segment[] {
  const split: Segment[] = [];
  for (const s of segments) {
    if (s.points <= maxPerSegment) { split.push(s); continue; }
    const step = (s.stop - s.start) / (s.points - 1);
    for (let i = 0; i < s.points; i += maxPerSegment) {
      const n = Math.min(maxPerSegment, s.points - i);
      split.push({ start: s.start + i * step, stop: s.start + (i + n - 1) * step, points: n });
    }
  }
  return split;
}
