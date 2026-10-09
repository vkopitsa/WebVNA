// Simulator: speaks the NanoVNA V1/H/H4 ChibiOS text shell ("ch> " prompt, echo, scan, capture, ...).
import { C, type Complex } from "./complex";
import { dutS4, type Dut } from "./mock";
import { LinkBase } from "./links";
import { SCAN, isForbiddenShellCommand } from "./nanovna";

export interface MockShellOptions {
  /** Board: "H" (320x240, 101 pts) or "H4" (480x320, 401 pts). Default "H". */
  board?: "H" | "H4";
  /** "D" = DiSlord NanoVNA-D (ignore-cal bit, up to 401 pts); "stock" = edy555/hugen (always raw, 101 pts, no binary). Default "D". */
  firmware?: "D" | "stock";
  /** Binary scan framing (D firmware only). Set false to emulate firmware without it. Default true. */
  binary?: boolean;
  /** Start with a power-on banner and garbage in the receive buffer. */
  banner?: boolean;
}

export class MockShellLink extends LinkBase {
  kind = "Simulator (NanoVNA shell)";
  dut: Dut = "antenna";
  /** DUT physically flipped: port 1 sees DUT port 2 (S22 / S12). Same meaning as MockLink.reversed. */
  reversed = false;
  noise = 0.0005;
  readonly opts: Required<MockShellOptions>;
  /** Every command line received, in order. */
  commands: string[] = [];
  /** Commands that isForbiddenShellCommand() rejects, received anyway (must stay 0). */
  forbidden = 0;
  paused = false;
  resumes = 0;
  private line = "";

  constructor(opts: MockShellOptions = {}) {
    super();
    this.opts = { board: "H", firmware: "D", binary: true, banner: false, ...opts };
    if (this.opts.banner) setTimeout(() => this.push(Uint8Array.from(ascii("\u0000\u0001garbage\r\nNanoVNA Shell\r\nch> "))), 1);
  }

  private get d() { return this.opts.firmware === "D"; }
  private get limit() { return this.d ? 401 : 101; }
  private get screen() { return this.opts.board === "H4" ? { w: 480, h: 320 } : { w: 320, h: 240 }; }

  private sample(f: number, ignoreCal: boolean): { s11: Complex; s21: Complex } {
    const t4 = dutS4(this.dut, f);
    const G = this.reversed ? t4.s22 : t4.s11, S = this.reversed ? t4.s12 : t4.s21;
    let m = G, s21 = S;
    if (ignoreCal) {
      const ph = -2 * Math.PI * f * 1.2e-9;
      const e00 = C.polar(0.06, ph * 0.3 + 1), e11 = C.polar(0.08, ph * 0.5), T = C.polar(0.85, ph);
      m = C.add(e00, C.div(C.mul(T, G), C.sub([1, 0], C.mul(e11, G))));
      s21 = C.add(C.mul(C.polar(0.7, ph * 1.4), S), C.polar(0.001, ph));
    }
    const n = () => (Math.random() - 0.5) * this.noise;
    return { s11: [m[0] + n(), m[1] + n()], s21: [s21[0] + n(), s21[1] + n()] };
  }

  private run(cmd: string, out: number[]): void {
    const text = (s: string) => out.push(...ascii(s));
    const [name, ...args] = cmd.trim().split(/\s+/);
    switch (name) {
      case "": return;
      case "info":
        text(`Kernel: 4.0.0\r\nCompiler: GCC 9.2.1\r\nArchitecture: ARMv6-M\r\nPort Info: Cortex-M0 r0p0\r\nPlatform: STM32F072xB\r\n`);
        if (this.d) text("Firmware: NanoVNA-D by DiSlord\r\n");
        text(`Board: NanoVNA-${this.opts.board}\r\nBuild time: Oct 1 2026 - 12:00:00\r\n`);
        return;
      case "version": text(this.d ? "1.2.28\r\n" : "0.2.3\r\n"); return;
      case "vbat": text("4012 mV\r\n"); return;
      case "pause": this.paused = true; return;
      case "resume": this.paused = false; this.resumes++; return;
      case "capture": {
        const { w, h } = this.screen;
        for (let y = 0; y < h; y++)
          for (let x = 0; x < w; x++) {
            const v = (((x * 31) / w) << 11) | (((y * 63) / h) << 5) | 8;
            out.push(v >> 8, v & 255); // big-endian RGB565
          }
        return;
      }
      case "scan": this.scan(args, out); return;
      default: text(`${name}?\r\n`);
    }
  }

  private scan(args: string[], out: number[]): void {
    const [a, b, n, m] = args.map(Number);
    const points = args[2] === undefined ? 101 : n;
    const mask = args[3] === undefined ? 3 : m;
    if (!(a > 0) || !(b >= a) || !(points >= 1) || points > this.limit || !Number.isFinite(mask)) {
      out.push(...ascii("usage: scan {start(Hz)} {stop(Hz)} [points] [outmask]\r\n"));
      return;
    }
    const binary = this.d && this.opts.binary && (mask & SCAN.BINARY) !== 0;
    const ignoreCal = !this.d || (mask & SCAN.NO_CAL) !== 0;
    const size = (mask & SCAN.FREQ ? 4 : 0) + (mask & SCAN.S11 ? 8 : 0) + (mask & SCAN.S21 ? 8 : 0);
    const buf = new Uint8Array(binary ? 4 + points * size : 0), dv = new DataView(buf.buffer);
    if (binary) { dv.setUint16(0, mask, true); dv.setUint16(2, points, true); }
    for (let i = 0; i < points; i++) {
      const f = Math.round(points > 1 ? a + ((b - a) * i) / (points - 1) : a);
      const { s11, s21 } = this.sample(f, ignoreCal);
      if (binary) {
        let o = 4 + i * size;
        if (mask & SCAN.FREQ) { dv.setUint32(o, f, true); o += 4; }
        if (mask & SCAN.S11) { dv.setFloat32(o, s11[0], true); dv.setFloat32(o + 4, s11[1], true); o += 8; }
        if (mask & SCAN.S21) { dv.setFloat32(o, s21[0], true); dv.setFloat32(o + 4, s21[1], true); }
      } else {
        const fields: (string | number)[] = [];
        if (mask & SCAN.FREQ) fields.push(f);
        if (mask & SCAN.S11) fields.push(s11[0].toFixed(6), s11[1].toFixed(6));
        if (mask & SCAN.S21) fields.push(s21[0].toFixed(6), s21[1].toFixed(6));
        out.push(...ascii(fields.join(" ") + "\r\n"));
      }
    }
    out.push(...buf);
  }

  protected async write(bytes: Uint8Array): Promise<void> {
    if (this.closed) throw new Error("Simulator closed.");
    const out: number[] = [];
    for (const c of bytes) {
      if (c === 0x0d) {
        const cmd = this.line;
        this.line = "";
        out.push(0x0d, 0x0a);
        if (cmd.trim()) {
          this.commands.push(cmd.trim());
          if (isForbiddenShellCommand(cmd)) this.forbidden++;
          else this.run(cmd, out);
        }
        out.push(...ascii("ch> "));
      } else if (c !== 0x0a && c !== 0) { this.line += String.fromCharCode(c); out.push(c); }
    }
    if (out.length) setTimeout(() => this.push(Uint8Array.from(out)), 2);
  }

  async close(): Promise<void> { this.closed = true; }
}

function ascii(s: string): number[] { return Array.from(s, (c) => c.charCodeAt(0) & 0xff); }
