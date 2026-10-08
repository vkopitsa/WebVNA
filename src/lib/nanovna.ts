// NanoVNA V1 / -H / -H4 driver: ChibiOS text shell over USB CDC (edy555, hugen79 and DiSlord "NanoVNA-D" firmware).
//
// Wire format (from the firmware sources and NanoVNA-Saver; NOT yet verified on hardware, see ASSUMPTIONS below):
//   host → device   "cmd args\r"
//   device → host   "cmd args\r\n" (echo) + output lines ("...\r\n") + "ch> " (prompt, no newline)
//   scan <start> <stop> [points] [outmask]
//     outmask bit0 freq, bit1 S11, bit2 S21, bit3 ignore device calibration (NanoVNA-D), bit4 ignore e-delay,
//     bit5 ignore S21 offset, bit7 binary framing (NanoVNA-D).
//     ASCII : one line per point, fields in order [freq] [s11re s11im] [s21re s21im].
//     binary: u16 mask, u16 points, then per point [u32 freq] [f32 re, f32 im (S11)] [f32 re, f32 im (S21)], little-endian.
//   capture → width*height RGB565 words, big-endian (NanoVNA-Saver unpacks ">u2"), then the prompt.
//
// ASSUMPTIONS (unverified on hardware): binary header/record layout; `scan` of N points with start == stop (CW);
// 401 points per scan on NanoVNA-D (we fall back to 101 if a longer scan fails); screenshot endianness on H4;
// stock (non-D) firmware returns raw, uncalibrated data from `scan`; `pause` before scanning is harmless.
import type { Complex } from "./complex";
import { splitSegments, type DriverCapabilities, type DriverStats, type Segment, type VnaDriver } from "./driver";
import type { LinkBase } from "./links";
import { AbortError, type SweepOptions, type SweepPoint } from "./litevna";
import { DATA_MODE, type DeviceInfo } from "./protocol";

export const PROMPT = "ch> ";
export const SCAN = { FREQ: 1, S11: 2, S21: 4, NO_CAL: 8, NO_EDELAY: 16, NO_S21_OFFSET: 32, BINARY: 0x80 } as const;

/** Shell commands the app may send. Everything else (saveconfig, clearconfig, dfu, reset, cal, touchcal, config, ...) is refused. */
const ALLOWED = new Set(["info", "version", "vbat", "capture", "pause", "resume", "scan", "help"]);

/** True when a command line must never be sent (writes flash/calibration, reboots, or is not on the allow-list). */
export function isForbiddenShellCommand(cmd: string): boolean {
  if (/[\r\n\0]/.test(cmd)) return true; // no command chaining
  const name = cmd.trim().split(/\s+/)[0] ?? "";
  return name !== "" && !ALLOWED.has(name);
}

const latin1 = (b: Uint8Array) => { let s = ""; for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return s; };
const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

export class NanoVNAShell implements VnaDriver {
  readonly link: LinkBase;
  info: DeviceInfo | null = null;
  stats: DriverStats = { records: 0, badChecksum: 0, zeroChecksum: 0, sweeps: 0, lastSweepMs: 0 };
  /** Request device-calibrated data (only meaningful on NanoVNA-D firmware). */
  deviceCal = false;
  /** Screenshot pixel byte order. */
  captureBigEndian = true;
  private binary = false;
  private isD = false;
  private screen = { width: 320, height: 240 };
  private segLimit = 101;
  private queue: Promise<unknown> = Promise.resolve();
  private buf = new Uint8Array(4096);
  private len = 0;
  private caps: DriverCapabilities = {
    protocol: "v1-shell", maxPoints: 1001, minHz: 50e3, maxHz: 900e6, screenshot: true, battery: true,
    ifAverage: false, power: false, channels: false, deviceCal: false, serial: false, clock: false, binaryScan: false,
  };

  constructor(link: LinkBase) { this.link = link; }

  get capabilities(): DriverCapabilities { return this.caps; }

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  // ---- receive buffer
  private append(chunk: Uint8Array) {
    if (this.len + chunk.length > this.buf.length) {
      const n = new Uint8Array(Math.max(this.buf.length * 2, this.len + chunk.length));
      n.set(this.buf.subarray(0, this.len));
      this.buf = n;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
  }
  private take(n: number): Uint8Array {
    const out = this.buf.slice(0, n);
    this.buf.copyWithin(0, n, this.len);
    this.len -= n;
    return out;
  }
  private clear() { this.len = 0; this.link.flush(); }

  /** Wait for more bytes (in 100 ms slices so an abort is honoured). */
  private async pump(ms: number, signal?: AbortSignal): Promise<void> {
    const t0 = Date.now();
    for (;;) {
      if (signal?.aborted) throw new AbortError();
      const left = ms - (Date.now() - t0);
      if (left <= 0) throw new Error("No reply from the device.");
      let first: Uint8Array;
      try { first = await this.link.read(1, Math.min(left, 100)); }
      catch (e) { if (this.link.closed) throw e; continue; }
      this.append(first);
      if (this.link.pending) this.append(await this.link.read(this.link.pending));
      return;
    }
  }

  private promptAt(from = 0): number {
    const v = this.buf;
    for (let i = from; i + PROMPT.length <= this.len; i++)
      if (v[i] === 0x63 && v[i + 1] === 0x68 && v[i + 2] === 0x3e && v[i + 3] === 0x20) return i;
    return -1;
  }

  /** Consume everything up to and including the next prompt; returns the text before it. */
  private async waitPrompt(ms: number, signal?: AbortSignal): Promise<string> {
    const t0 = Date.now();
    for (;;) {
      const i = this.promptAt();
      if (i >= 0) { const t = latin1(this.take(i)); this.take(PROMPT.length); return t; }
      await this.pump(Math.max(1, ms - (Date.now() - t0)), signal);
    }
  }

  /** Next text line, or null if the prompt comes first (end of output). */
  private async readLine(ms: number, signal?: AbortSignal): Promise<string | null> {
    const t0 = Date.now();
    for (;;) {
      const nl = this.buf.subarray(0, this.len).indexOf(0x0a);
      if (nl >= 0) return latin1(this.take(nl + 1)).replace(/\r?\n$/, "");
      if (this.promptAt() === 0) return null;
      await this.pump(Math.max(1, ms - (Date.now() - t0)), signal);
    }
  }

  private async readExact(n: number, ms: number, signal?: AbortSignal): Promise<Uint8Array> {
    const t0 = Date.now();
    while (this.len < n) await this.pump(Math.max(1, ms - (Date.now() - t0)), signal);
    return this.take(n);
  }

  private async sendLine(cmd: string): Promise<void> {
    if (isForbiddenShellCommand(cmd)) throw new Error(`Refusing to send shell command "${cmd}".`);
    this.clear();
    await this.link.send(ascii(cmd + "\r"));
  }

  /** Run a short command and return its output lines (echo removed). */
  private async command(cmd: string, ms = 3000): Promise<string[]> {
    await this.sendLine(cmd);
    const lines = (await this.waitPrompt(ms)).split(/\r?\n/);
    if (cmd && lines.length && lines[0].includes(cmd.trim())) lines.shift();
    return lines.map((l) => l.trim()).filter((l) => l !== "");
  }

  /** Throw away banner/garbage until the shell answers a bare CR with its prompt. */
  private async sync(): Promise<void> {
    for (let i = 0; i < 4; i++) {
      await this.sendLine("");
      try { await this.waitPrompt(i === 0 ? 800 : 1500); return; } catch { /* retry */ }
    }
    throw new Error("The device does not answer like a NanoVNA (no \"ch>\" prompt). Is this a NanoVNA V1 / -H / -H4?");
  }

  /** After an error or abort the device may still be streaming a scan; swallow it up to the prompt. */
  private async recover(): Promise<void> {
    try { await this.waitPrompt(3000); } catch { try { await this.sync(); } catch { /* give up */ } }
  }

  // ---- session
  init(): Promise<DeviceInfo> {
    return this.exclusive(async () => {
      await this.sync();
      const infoLines = await this.command("info");
      const verLines = await this.command("version");
      const text = [...infoLines, ...verLines].join("\n");
      const boardRaw = /Board:\s*(.+)/i.exec(text)?.[1]?.trim() ?? infoLines[0] ?? "NanoVNA";
      const board = /nanovna/i.test(boardRaw) ? boardRaw : `NanoVNA ${boardRaw}`;
      const h4 = /H\s*-?\s*4/i.test(boardRaw);
      const firmware = verLines[0]?.replace(/^version:?\s*/i, "") ?? "";
      const ver = /(\d+)\.(\d+)/.exec(firmware);
      this.isD = /NanoVNA-D|DiSlord/i.test(text);
      this.screen = h4 ? { width: 480, height: 320 } : { width: 320, height: 240 };
      this.segLimit = this.isD ? 401 : 101;
      const maxHz = h4 ? 1.5e9 : 900e6;
      this.info = {
        variant: 1, protocol: 0, hardware: h4 ? 4 : 1, fwMajor: ver ? +ver[1] : 0, fwMinor: ver ? +ver[2] : 0,
        model: board, maxPoints: this.caps.maxPoints, minHz: this.caps.minHz, maxHz, firmware, board: boardRaw,
      };
      await this.command("pause"); // we drive the sweeps; undone by exitUsbMode()
      this.binary = await this.probeBinary();
      this.caps = { ...this.caps, maxHz, deviceCal: this.isD, binaryScan: this.binary };
      return this.info;
    });
  }

  /** 2-point scan with the binary bit; true only if the reply is a well-formed binary frame. */
  private async probeBinary(): Promise<boolean> {
    const f0 = 1e6, f1 = 2e6, mask = SCAN.FREQ | SCAN.S11 | SCAN.S21 | SCAN.BINARY;
    let ok = false;
    try {
      await this.sendLine(`scan ${f0} ${f1} 2 0x${mask.toString(16)}`);
      await this.readLine(2000); // echo
      const h = new DataView((await this.readExact(4, 2000)).buffer);
      if ((h.getUint16(0, true) & 7) === 7 && h.getUint16(2, true) === 2) {
        const d = new DataView((await this.readExact(40, 2000)).buffer);
        ok = [f0, f1].every((f, i) => Math.abs(d.getUint32(i * 20, true) - f) <= f * 0.01) &&
          Array.from({ length: 8 }, (_, k) => d.getFloat32((k < 4 ? 4 : 24) + (k % 4) * 4, true)).every((x) => Number.isFinite(x) && Math.abs(x) < 1e3);
      }
    } catch { ok = false; }
    await this.recover(); // consume the prompt (or any ASCII reply of firmware without binary support)
    return ok;
  }

  exitUsbMode() { return this.exclusive(async () => { await this.command("resume"); }); }

  // ---- extras
  setDataMode(mode: number) { return this.exclusive(async () => { this.deviceCal = mode === DATA_MODE.DEVICE_CAL; }); }

  readVbat() {
    return this.exclusive(async () => {
      const t = (await this.command("vbat")).join(" ");
      const m = /(\d+(?:\.\d+)?)\s*(mV)?/i.exec(t);
      if (!m) throw new Error(`Unexpected reply to vbat: "${t}"`);
      const v = +m[1];
      return m[2] || v > 100 ? v / 1000 : v;
    });
  }

  screenshot(timeout = 15000) {
    return this.exclusive(async () => {
      const { width, height } = this.screen;
      await this.sendLine("capture");
      await this.readLine(timeout); // echo
      const px = await this.readExact(width * height * 2, timeout);
      await this.waitPrompt(2000).catch(() => undefined);
      const rgba = new Uint8ClampedArray(width * height * 4);
      for (let i = 0; i < width * height; i++) {
        const v = this.captureBigEndian ? (px[i * 2] << 8) | px[i * 2 + 1] : (px[i * 2 + 1] << 8) | px[i * 2];
        rgba[i * 4] = (((v >> 11) & 31) * 255) / 31;
        rgba[i * 4 + 1] = (((v >> 5) & 63) * 255) / 63;
        rgba[i * 4 + 2] = ((v & 31) * 255) / 31;
        rgba[i * 4 + 3] = 255;
      }
      return { width, height, rgba };
    });
  }

  // ---- sweeps
  private async scanOnce(startHz: number, stopHz: number, points: number, o: SweepOptions): Promise<SweepPoint[]> {
    if (o.signal?.aborted) throw new AbortError();
    const a = Math.round(startHz), b = Math.round(stopHz);
    const mask = SCAN.FREQ | SCAN.S11 | SCAN.S21 | (this.isD && !this.deviceCal ? SCAN.NO_CAL : 0) | (this.binary ? SCAN.BINARY : 0);
    const ms = 3000 + (o.perPointTimeoutMs ?? 40) * points;
    await this.sendLine(`scan ${a} ${b} ${points} 0x${mask.toString(16)}`);
    await this.readLine(ms, o.signal); // echo
    const out: SweepPoint[] = [];
    const push = (f: number, v: number[]) => {
      this.stats.records++;
      out.push({ f, s11: [v[0], v[1]] as Complex, s21: [v[2], v[3]] as Complex });
      o.onProgress?.(out.length / points);
      if (o.signal?.aborted) throw new AbortError();
    };
    if (this.binary) {
      const h = new DataView((await this.readExact(4, ms, o.signal)).buffer);
      if (h.getUint16(2, true) !== points || (h.getUint16(0, true) & 7) !== 7) throw new Error("Unexpected binary scan header.");
      for (let i = 0; i < points; i++) {
        const d = new DataView((await this.readExact(20, ms, o.signal)).buffer);
        const v = [1, 2, 3, 4].map((k) => d.getFloat32(k * 4, true));
        if (!v.every(Number.isFinite)) { this.stats.badChecksum++; continue; }
        push(d.getUint32(0, true), v);
      }
    } else {
      while (out.length < points) {
        const line = await this.readLine(ms, o.signal);
        if (line === null) break;
        const f = line.trim().split(/\s+/).map(Number);
        if (f.length !== 5 || !f.every(Number.isFinite)) { if (line.trim()) this.stats.badChecksum++; continue; }
        push(f[0], f.slice(1));
      }
    }
    await this.waitPrompt(2000, o.signal);
    if (out.length < points) throw new Error(`Sweep incomplete: received ${out.length} of ${points} points.`);
    return out.map((p, i) => ({ ...p, f: p.f || (points > 1 ? a + ((b - a) * i) / (points - 1) : a) }));
  }

  /** Sweep linear segments with one `scan` each; segments longer than the firmware limit are split. */
  sweepSegments(segments: Segment[], o: SweepOptions = {}, maxPerSegment = 1024): Promise<SweepPoint[]> {
    return this.exclusive(async () => {
      const t0 = performance.now();
      const split = splitSegments(segments, Math.max(1, Math.min(maxPerSegment, this.segLimit)));
      const total = split.reduce((a, s) => a + s.points, 0);
      const out: SweepPoint[] = [];
      let done = 0;
      for (const s of split) {
        try {
          const seg = await this.scanOnce(s.start, s.stop, s.points, { ...o, onProgress: (p) => o.onProgress?.((done + p * s.points) / total) });
          for (const p of seg) out.push(p);
        } catch (e) {
          await this.recover();
          // Firmware that cannot do long scans: fall back to the classic 101 points for the next attempt.
          if (!(e instanceof AbortError) && s.points > 101 && this.segLimit > 101) this.segLimit = 101;
          throw e;
        }
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

