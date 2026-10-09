// LibreVNA driver (experimental): binary packet protocol over WebUSB bulk endpoints. See libre-protocol.ts for the
// wire format and its (unverified) assumptions. One-path instrument for our purposes: port 1 is excited, S11 and S21
// come from the port 1 / port 2 receivers divided by the reference receiver.
import { C, type Complex } from "./complex";
import { splitSegments, type DriverCapabilities, type DriverStats, type Segment, type VnaDriver } from "./driver";
import type { LinkBase } from "./links";
import { AbortError, type SweepOptions, type SweepPoint } from "./litevna";
import {
  FrameParser, LIBRE_PROTOCOL_VERSIONS, PKT, SWEEP_FLAG, decodeDatapoint, decodeDeviceInfo, encodePacket, encodeSweepSettings,
  isForbiddenLibrePacket, type LibreDeviceInfo, type Packet,
} from "./libre-protocol";
import type { DeviceInfo } from "./protocol";

export class LibreVNA implements VnaDriver {
  readonly link: LinkBase;
  info: DeviceInfo | null = null;
  libre: LibreDeviceInfo | null = null;
  stats: DriverStats = { records: 0, badChecksum: 0, zeroChecksum: 0, sweeps: 0, lastSweepMs: 0 };
  /** Measurement IF bandwidth in Hz (clamped to the device range). */
  ifBandwidth = 1000;
  /** Stimulus level in dBm. */
  powerDbm = -10;
  private parser = new FrameParser();
  private inbox: Packet[] = [];
  private queue: Promise<unknown> = Promise.resolve();

  constructor(link: LinkBase) { this.link = link; }

  get capabilities(): DriverCapabilities {
    return {
      protocol: "libre", maxPoints: this.libre?.maxPoints ?? 1001, minHz: this.libre?.minHz ?? 100e3, maxHz: this.libre?.maxHz ?? 6e9,
      screenshot: false, battery: false, ifAverage: false, power: false, channels: false, deviceCal: false, serial: false, clock: false,
    };
  }

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private async sendPacket(type: number, payload?: Uint8Array): Promise<void> {
    if (isForbiddenLibrePacket(type)) throw new Error(`Refusing to send LibreVNA packet type ${type}.`);
    await this.link.send(encodePacket(type, payload));
  }

  /** Next packet from the device (in 100 ms slices so an abort is honoured). */
  private async next(ms: number, signal?: AbortSignal): Promise<Packet> {
    const t0 = Date.now();
    for (;;) {
      const p = this.inbox.shift();
      if (p) return p;
      if (signal?.aborted) throw new AbortError();
      const left = ms - (Date.now() - t0);
      if (left <= 0) throw new Error("No reply from the LibreVNA.");
      let first: Uint8Array;
      try { first = await this.link.read(1, Math.min(left, 100)); }
      catch (e) { if (this.link.closed) throw e; continue; }
      const rest = this.link.pending ? await this.link.read(this.link.pending) : new Uint8Array(0);
      const bytes = new Uint8Array(1 + rest.length);
      bytes[0] = first[0]; bytes.set(rest, 1);
      this.inbox.push(...this.parser.push(bytes));
      this.stats.badChecksum = this.parser.badCrc;
      this.stats.zeroChecksum = this.parser.zeroCrc;
    }
  }

  private clear() { this.inbox = []; this.parser.reset(); this.link.flush(); }

  init(): Promise<DeviceInfo> {
    return this.exclusive(async () => {
      this.clear();
      await this.sendPacket(PKT.SetIdle);
      await new Promise((r) => setTimeout(r, 20));
      this.clear();
      let li: LibreDeviceInfo | null = null;
      for (let attempt = 0; attempt < 3 && !li; attempt++) {
        await this.sendPacket(PKT.RequestDeviceInfo);
        try {
          for (;;) {
            const p = await this.next(1500);
            if (p.type === PKT.DeviceInfo) { li = decodeDeviceInfo(p.payload); break; }
          }
        } catch (e) { if (this.link.closed) throw e; }
      }
      if (!li) throw new Error("The device did not answer like a LibreVNA (no DeviceInfo packet).");
      this.libre = li;
      this.info = {
        variant: 3, protocol: li.protocol, hardware: li.hwVersion, fwMajor: li.fwMajor, fwMinor: li.fwMinor, model: "LibreVNA",
        maxPoints: li.maxPoints, minHz: li.minHz, maxHz: li.maxHz, firmware: `${li.fwMajor}.${li.fwMinor}.${li.fwPatch}`, board: "LibreVNA",
      };
      return this.info;
    });
  }

  exitUsbMode() { return this.exclusive(async () => { await this.sendPacket(PKT.SetIdle); }); }

  private checkVersion(): LibreDeviceInfo {
    const li = this.libre;
    if (!li) throw new Error("The LibreVNA is not initialised.");
    if (!(LIBRE_PROTOCOL_VERSIONS as readonly number[]).includes(li.protocol))
      throw new Error(`Unsupported LibreVNA protocol version ${li.protocol} (this app speaks ${LIBRE_PROTOCOL_VERSIONS.join(", ")}). Update WebVNA or the device firmware.`);
    return li;
  }

  private async segment(s: Segment, li: LibreDeviceInfo, o: SweepOptions): Promise<SweepPoint[]> {
    if (o.signal?.aborted) throw new AbortError();
    const cdbm = Math.max(li.minCdbm, Math.min(li.maxCdbm, Math.round(this.powerDbm * 100)));
    const ifBw = Math.max(li.minIfBw, Math.min(li.maxIfBw, Math.round(this.ifBandwidth)));
    this.clear();
    await this.sendPacket(PKT.SweepSettings, encodeSweepSettings({
      fStart: s.start, fStop: s.stop, points: s.points, ifBw, cdbmStart: cdbm, cdbmStop: cdbm, flags: SWEEP_FLAG.EXCITE_PORT1 | SWEEP_FLAG.FIXED_POWER, syncMode: 0,
    }));
    const step = s.points > 1 ? (s.stop - s.start) / (s.points - 1) : 0;
    const tol = Math.max(step * 0.5, 1) + 1;
    const got: (SweepPoint | undefined)[] = new Array(s.points);
    let n = 0;
    const ms = 3000 + (o.perPointTimeoutMs ?? 40) * s.points;
    const t0 = Date.now();
    while (n < s.points) {
      const p = await this.next(Math.max(1, ms - (Date.now() - t0)), o.signal);
      if (p.type === PKT.Nack) throw new Error("The LibreVNA rejected the sweep settings.");
      if (p.type !== PKT.VNADatapoint) continue;
      const d = decodeDatapoint(p.payload);
      if (d.pointNum >= s.points || got[d.pointNum]) continue;
      const want = s.start + step * d.pointNum;
      if (Math.abs(d.frequency - want) > tol) continue; // stale point of an earlier sweep
      this.stats.records++;
      got[d.pointNum] = { f: d.frequency, s11: C.div(d.port1 as Complex, d.reference as Complex), s21: C.div(d.port2 as Complex, d.reference as Complex) };
      n++;
      o.onProgress?.(n / s.points);
    }
    return got as SweepPoint[];
  }

  sweepSegments(segments: Segment[], o: SweepOptions = {}, maxPerSegment = 1024): Promise<SweepPoint[]> {
    return this.exclusive(async () => {
      const li = this.checkVersion();
      const t0 = performance.now();
      const split = splitSegments(segments, Math.max(1, Math.min(maxPerSegment, li.maxPoints)));
      const total = split.reduce((a, s) => a + s.points, 0);
      const out: SweepPoint[] = [];
      let done = 0;
      for (const s of split) {
        try {
          const seg = await this.segment(s, li, { ...o, onProgress: (p) => o.onProgress?.((done + p * s.points) / total) });
          for (const p of seg) out.push(p);
        } catch (e) {
          try { await this.sendPacket(PKT.SetIdle); } catch { /* link lost */ }
          throw e;
        }
        try { await this.sendPacket(PKT.SetIdle); } catch { /* link lost */ }
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
