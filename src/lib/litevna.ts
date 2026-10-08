// LiteVNA / NanoVNA V2 device driver over any LinkBase.
import { C, type Complex } from "./complex";
import { DATA_MODE, OP, REG, fifoChecksum, identify, isForbiddenWrite, le, MIN_HZ, type DeviceInfo } from "./protocol";
import type { LinkBase } from "./links";

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface SweepPoint { f: number; s11: Complex; s21: Complex }
export type Progress = (fraction: number) => void;

export interface SweepOptions {
  chunk?: number;
  perPointTimeoutMs?: number;
  signal?: AbortSignal;
  onProgress?: Progress;
}

export class AbortError extends Error { constructor() { super("Sweep stopped."); this.name = "AbortError"; } }

export class LiteVNA {
  readonly link: LinkBase;
  info: DeviceInfo | null = null;
  stats = { records: 0, badChecksum: 0, zeroChecksum: 0, sweeps: 0, lastSweepMs: 0 };
  average = 1;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(link: LinkBase) { this.link = link; }

  /** Serialise device access: every public operation runs exclusively. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private cmd(bytes: number[]): Promise<void> {
    const op = bytes[0];
    if (op === OP.WRITEFIFO || (op >= OP.WRITE && op <= OP.WRITE8 && isForbiddenWrite(bytes[1], op, bytes.slice(2))))
      throw new Error(`Refusing to write protected register 0x${bytes[1].toString(16)}.`);
    return this.link.send(new Uint8Array(bytes));
  }

  async reset(): Promise<void> {
    await this.cmd([0, 0, 0, 0, 0, 0, 0, 0]);
    await sleep(50);
    this.link.flush();
  }

  init(): Promise<DeviceInfo> {
    return this.exclusive(async () => {
      await this.reset();
      await this.cmd([OP.INDICATE]);
      const r = await this.link.read(1, 1500);
      if (r[0] !== 0x32) throw new Error(`Unexpected reply 0x${r[0].toString(16)} to INDICATE. Is this a LiteVNA / NanoVNA V2?`);
      const variant = await this.read1(REG.VARIANT);
      const protocol = await this.read1(REG.PROTOCOL);
      const hardware = await this.read1(REG.HW_REV);
      const fwMajor = await this.read1(REG.FW_MAJOR);
      const fwMinor = await this.read1(REG.FW_MINOR);
      const id = identify({ variant, hardware, fwMajor });
      this.info = { variant, protocol, hardware, fwMajor, fwMinor, model: id.model, maxPoints: id.maxPoints, minHz: MIN_HZ, maxHz: id.maxHz };
      return this.info;
    });
  }

  async read1(a: number): Promise<number> { this.link.flush(); await this.cmd([OP.READ, a]); return (await this.link.read(1))[0]; }
  async read2(a: number): Promise<number> { this.link.flush(); await this.cmd([OP.READ2, a]); const b = await this.link.read(2); return b[0] | (b[1] << 8); }
  async read4(a: number): Promise<number> {
    this.link.flush(); await this.cmd([OP.READ4, a]);
    const b = await this.link.read(4);
    return (b[0] | (b[1] << 8) | (b[2] << 16) | (b[3] << 24)) >>> 0;
  }
  write1(a: number, v: number) { return this.cmd([OP.WRITE, a, v & 0xff]); }
  write2(a: number, v: number) { return this.cmd([OP.WRITE2, a, ...le(v, 2)]); }
  write4(a: number, v: number) { return this.cmd([OP.WRITE4, a, ...le(v, 4)]); }
  write8(a: number, v: number) { return this.cmd([OP.WRITE8, a, ...le(v, 8)]); }

  // ---- LiteVNA extras (docs/01-PROTOCOL.md §4)
  setAverage(n: number) {
    this.average = Math.max(1, Math.min(80, n | 0));
    return this.exclusive(() => this.write1(REG.AVERAGE, this.average));
  }
  setPower({ lf, hf }: { lf?: number; hf?: number }) {
    return this.exclusive(async () => {
      if (lf != null) await this.write1(REG.POWER_LF, lf);
      if (hf != null) await this.write1(REG.POWER_HF, hf);
    });
  }
  setChannels(mode: number) { return this.exclusive(() => this.write1(REG.CHANNELS, mode)); }
  setTime(unixSeconds = Math.floor(Date.now() / 1000)) { return this.exclusive(() => this.write4(REG.UNIX_TIME, unixSeconds)); }
  readVbat() { return this.exclusive(async () => (await this.read2(REG.VBAT_MV)) / 1000); }
  setDataMode(mode: number) { return this.exclusive(() => this.write1(REG.DATA_MODE, mode)); }
  exitUsbMode() { return this.exclusive(async () => { await this.reset(); await this.write1(REG.DATA_MODE, DATA_MODE.EXIT); }); }
  readSerial() {
    return this.exclusive(async () => {
      const v = [await this.read4(REG.SERIAL), await this.read4(REG.SERIAL + 4), await this.read4(REG.SERIAL + 8)];
      return v.map((x) => x.toString(16).padStart(8, "0")).join("-");
    });
  }

  screenshot(timeout = 15000) {
    return this.exclusive(async () => {
      await this.reset();
      await this.write1(REG.CAPTURE, 0);
      const h = await this.link.read(5, timeout);
      const width = h[0] | (h[1] << 8), height = h[2] | (h[3] << 8), bpp = h[4];
      if (bpp !== 16) throw new Error(`Unsupported screenshot pixel format: ${bpp} bits`);
      const px = await this.link.read(width * height * 2, timeout);
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const v = (px[i * 2] << 8) | px[i * 2 + 1]; // RGB565 big-endian
        rgba[i * 4] = (((v >> 11) & 31) * 255) / 31;
        rgba[i * 4 + 1] = (((v >> 5) & 63) * 255) / 63;
        rgba[i * 4 + 2] = ((v & 31) * 255) / 31;
        rgba[i * 4 + 3] = 255;
      }
      return { width, height, rgba };
    });
  }

  private async configure(startHz: number, stopHz: number, points: number): Promise<number> {
    const step = points > 1 ? Math.round((stopHz - startHz) / (points - 1)) : 0;
    await this.write8(REG.SWEEP_START, startHz);
    await this.write8(REG.SWEEP_STEP, step);
    await this.write2(REG.SWEEP_POINTS, points);
    await this.write2(REG.VALUES_PER_FREQ, 1);
    return step;
  }

  /** One linear segment → raw S11/S21 (device-calibrated only if DATA_MODE.DEVICE_CAL is set). */
  private async sweepOnce(startHz: number, stopHz: number, points: number, o: SweepOptions): Promise<SweepPoint[]> {
    const chunk = o.chunk ?? 255, perPoint = (o.perPointTimeoutMs ?? 40) * Math.max(1, this.average);
    await this.reset();
    const step = await this.configure(startHz, stopHz, points);
    const fwd: Complex[] = new Array(points), r0: Complex[] = new Array(points), r1: Complex[] = new Array(points);
    const have = new Uint8Array(points);
    let got = 0, reads = 0;
    this.link.flush();
    await this.write1(REG.VALUES_FIFO, 0); // clear stale data
    while (got < points) {
      if (o.signal?.aborted) throw new AbortError();
      if (++reads > Math.ceil(points / chunk) * 4 + 4) throw new Error(`Sweep incomplete: received ${got} of ${points} points.`);
      const n = Math.min(chunk, points - got);
      await this.cmd([OP.READFIFO, REG.VALUES_FIFO, n]);
      const d = await this.link.read(n * 32, 2000 + n * perPoint);
      const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
      for (let k = 0; k < n; k++) {
        const off = k * 32;
        this.stats.records++;
        if (d[off + 31] === 0) this.stats.zeroChecksum++;
        if (d[off + 31] !== 0 && fifoChecksum(d, off) !== d[off + 31]) { this.stats.badChecksum++; continue; }
        const fi = dv.getUint16(off + 24, true);
        if (fi >= points) continue;
        if (!have[fi]) { got++; have[fi] = 1; }
        fwd[fi] = [dv.getInt32(off, true), dv.getInt32(off + 4, true)];
        r0[fi] = [dv.getInt32(off + 8, true), dv.getInt32(off + 12, true)];
        r1[fi] = [dv.getInt32(off + 16, true), dv.getInt32(off + 20, true)];
      }
      o.onProgress?.(got / points);
    }
    const out: SweepPoint[] = new Array(points);
    for (let i = 0; i < points; i++) out[i] = { f: startHz + i * step, s11: C.div(r0[i], fwd[i]), s21: C.div(r1[i], fwd[i]) };
    return out;
  }

  /**
   * Sweep an arbitrary list of linear segments (used for long, segmented and log sweeps).
   * Segments longer than maxPerSegment are split.
   */
  sweepSegments(segments: { start: number; stop: number; points: number }[], o: SweepOptions = {}, maxPerSegment = 1024): Promise<SweepPoint[]> {
    return this.exclusive(async () => {
      const t0 = performance.now();
      const split: { start: number; stop: number; points: number }[] = [];
      for (const s of segments) {
        if (s.points <= maxPerSegment) { split.push(s); continue; }
        const step = (s.stop - s.start) / (s.points - 1);
        for (let i = 0; i < s.points; i += maxPerSegment) {
          const n = Math.min(maxPerSegment, s.points - i);
          split.push({ start: s.start + i * step, stop: s.start + (i + n - 1) * step, points: n });
        }
      }
      const total = split.reduce((a, s) => a + s.points, 0);
      const out: SweepPoint[] = [];
      let done = 0;
      for (const s of split) {
        const seg = await this.sweepOnce(s.start, s.stop, s.points, { ...o, onProgress: (p) => o.onProgress?.((done + p * s.points) / total) });
        for (const p of seg) out.push(p);
        done += s.points;
      }
      this.stats.sweeps++;
      this.stats.lastSweepMs = performance.now() - t0;
      return out;
    });
  }

  sweep(startHz: number, stopHz: number, points: number, o: SweepOptions = {}): Promise<SweepPoint[]> {
    return this.sweepSegments([{ start: startHz, stop: stopHz, points }], o);
  }
}

/** Build the segment list for a sweep plan (linear, CW, or approximated logarithmic). */
export function planSegments(start: number, stop: number, points: number, mode: "linear" | "log" | "cw", cwHz?: number) {
  if (mode === "cw") { const f = cwHz ?? start; return [{ start: f, stop: f, points }]; }
  // Linear when the span is too narrow for a strictly increasing integer-Hz log grid.
  if (mode === "linear" || points < 4 || start <= 0 || stop - start < points - 1) return [{ start, stop, points }];
  // Log: geometric points grouped into short linear runs (the device only sweeps linearly).
  // The grid is integer Hz and strictly increasing; each run uses an integer step so its last point never passes the next run.
  const g: number[] = [];
  for (let i = 0; i < points; i++) g.push(Math.max((g[i - 1] ?? -Infinity) + 1, Math.round(start * Math.pow(stop / start, i / (points - 1)))));
  const per = Math.max(2, Math.min(64, Math.round(points / 24)));
  const segs: { start: number; stop: number; points: number }[] = [];
  for (let i = 0; i < points; i += per) {
    const n = Math.min(per, points - i);
    const step = n > 1 ? Math.floor((g[i + n - 1] - g[i]) / (n - 1)) : 0;
    segs.push({ start: g[i], stop: g[i] + (n - 1) * step, points: n });
  }
  return segs;
}
