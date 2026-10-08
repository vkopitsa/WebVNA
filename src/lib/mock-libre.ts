// Simulator: speaks the LibreVNA packet protocol of libre-protocol.ts (same framing/CRC, DeviceInfo, SweepSettings, VNADatapoint).
import { C, type Complex } from "./complex";
import { dutS4, type Dut } from "./mock";
import { LinkBase } from "./links";
import {
  FrameParser, PKT, decodeSweepSettings, encodeDatapoint, encodeDeviceInfo, encodePacket, isForbiddenLibrePacket, type LibreSweepSettings,
} from "./libre-protocol";

export interface MockLibreOptions {
  /** Largest point count per sweep the "firmware" accepts. Default 1001. */
  maxPoints?: number;
  /** Protocol version reported in DeviceInfo. Default 13. */
  protocol?: number;
  /** Return the true DUT S-parameters (no systematic receiver errors). Default false. */
  ideal?: boolean;
  /** Prefix the byte stream with garbage (exercises resync). */
  garbage?: boolean;
}

export class MockLibreLink extends LinkBase {
  kind = "Simulator (LibreVNA)";
  dut: Dut = "antenna";
  /** DUT physically flipped: port 1 sees DUT port 2 (S22 / S12). */
  reversed = false;
  noise = 0.0005;
  readonly opts: Required<MockLibreOptions>;
  /** Types of every packet received, in order. */
  received: number[] = [];
  /** Packets isForbiddenLibrePacket() rejects, received anyway (must stay 0). */
  forbidden = 0;
  idles = 0;
  sweeps: LibreSweepSettings[] = [];
  private parser = new FrameParser();
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: MockLibreOptions = {}) {
    super();
    this.opts = { maxPoints: 1001, protocol: 13, ideal: false, garbage: false, ...opts };
    if (this.opts.garbage) setTimeout(() => this.push(Uint8Array.from([0x00, 0x5a, 0x01, 0xff, 0x5a, 0x10, 0x00, 0x99])), 1);
  }

  private reply(type: number, payload?: Uint8Array) { this.push(encodePacket(type, payload)); }

  private sample(f: number): { ref: Complex; p1: Complex; p2: Complex } {
    const t = dutS4(this.dut, f);
    let g = this.reversed ? t.s22 : t.s11, s = this.reversed ? t.s12 : t.s21;
    const ph = -2 * Math.PI * f * 1.2e-9;
    if (!this.opts.ideal) {
      const e00 = C.polar(0.05, ph * 0.3 + 1), e11 = C.polar(0.07, ph * 0.5), T = C.polar(0.9, ph);
      g = C.add(e00, C.div(C.mul(T, g), C.sub([1, 0], C.mul(e11, g))));
      s = C.add(C.mul(C.polar(0.8, ph * 1.4), s), C.polar(0.001, ph));
    }
    const n = (): Complex => [(Math.random() - 0.5) * this.noise, (Math.random() - 0.5) * this.noise];
    const ref = C.polar(0.5, 0.7 + ph * 0.2);
    return { ref, p1: C.add(C.mul(ref, g), n()), p2: C.add(C.mul(ref, s), n()) };
  }

  private startSweep(s: LibreSweepSettings) {
    this.stopSweep();
    let i = 0;
    const step = s.points > 1 ? (s.fStop - s.fStart) / (s.points - 1) : 0;
    const tick = () => {
      this.timer = null;
      if (this.closed) return;
      for (let k = 0; k < 64 && i < s.points; k++, i++) {
        const f = Math.round(s.fStart + step * i), v = this.sample(f);
        this.reply(PKT.VNADatapoint, encodeDatapoint({ pointNum: i, frequency: f, cdbm: s.cdbmStart, reference: v.ref, port1: v.p1, port2: v.p2 }));
      }
      if (i < s.points) this.timer = setTimeout(tick, 1);
    };
    this.timer = setTimeout(tick, 1);
  }

  private stopSweep() { if (this.timer) { clearTimeout(this.timer); this.timer = null; } }

  protected async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("Simulator closed.");
    for (const p of this.parser.push(bytes)) {
      this.received.push(p.type);
      if (isForbiddenLibrePacket(p.type)) { this.forbidden++; continue; }
      switch (p.type) {
        case PKT.RequestDeviceInfo:
          setTimeout(() => this.reply(PKT.DeviceInfo, encodeDeviceInfo({
            protocol: this.opts.protocol, fwMajor: 1, fwMinor: 6, fwPatch: 0, hwVersion: 1, minHz: 100e3, maxHz: 6e9,
            minIfBw: 10, maxIfBw: 50000, maxPoints: this.opts.maxPoints, minCdbm: -4000, maxCdbm: 0,
          })), 1);
          break;
        case PKT.RequestDeviceStatus: setTimeout(() => this.reply(PKT.DeviceStatus, new Uint8Array(4)), 1); break;
        case PKT.SetIdle: this.idles++; this.stopSweep(); setTimeout(() => this.reply(PKT.Ack), 1); break;
        case PKT.SweepSettings: {
          const s = decodeSweepSettings(p.payload);
          if (!(s.fStart >= 100e3) || !(s.fStop >= s.fStart) || s.fStop > 6e9 || s.points < 1 || s.points > this.opts.maxPoints) {
            setTimeout(() => this.reply(PKT.Nack), 1);
            break;
          }
          this.sweeps.push(s);
          setTimeout(() => this.reply(PKT.Ack), 1);
          this.startSweep(s);
          break;
        }
        default: setTimeout(() => this.reply(PKT.Nack), 1);
      }
    }
  }

  async close(): Promise<void> { this.closed = true; this.stopSweep(); }
}
