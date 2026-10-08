import { describe, expect, it } from "vitest";
import {
  FrameParser, LIBRE_USB_IDS, PKT, SWEEP_FLAG, crc32, decodeDatapoint, decodeDeviceInfo, decodeSweepSettings, encodeDatapoint, encodeDeviceInfo,
  encodePacket, encodeSweepSettings, isForbiddenLibrePacket,
} from "./libre-protocol";
import { LibreVNA } from "./librevna";
import { MockLibreLink } from "./mock-libre";
import { AbortError } from "./litevna";
import { dutS } from "./mock";
import { C } from "./complex";
import { connectSimulator, disconnect, sweepOnce } from "../controller";
import { get, set, initialState } from "../store";

const setup = async (opts = {}, dut: MockLibreLink["dut"] = "antenna") => {
  const link = new MockLibreLink({ ideal: true, ...opts });
  link.dut = dut;
  const vna = new LibreVNA(link);
  await vna.init();
  return { link, vna };
};

describe("LibreVNA framing", () => {
  it("crc32 matches the standard check value", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });

  it("round-trips packets and payload codecs", () => {
    const parsed = new FrameParser().push(encodePacket(PKT.SetIdle));
    expect(parsed).toEqual([{ type: PKT.SetIdle, payload: new Uint8Array(0) }]);
    const s = { fStart: 1e6, fStop: 6e9, points: 501, ifBw: 1000, cdbmStart: -1000, cdbmStop: -500, flags: SWEEP_FLAG.EXCITE_PORT1, syncMode: 0 };
    expect(decodeSweepSettings(encodeSweepSettings(s))).toEqual(s);
    const d = { pointNum: 7, frequency: 433e6, cdbm: -1000, reference: [0.5, 0.25] as [number, number], port1: [0.125, -0.5] as [number, number], port2: [1, 2] as [number, number] };
    expect(decodeDatapoint(encodeDatapoint(d))).toEqual(d);
    const i = { protocol: 13, fwMajor: 1, fwMinor: 6, fwPatch: 2, hwVersion: 1, minHz: 100e3, maxHz: 6e9, minIfBw: 10, maxIfBw: 50000, maxPoints: 4501, minCdbm: -4000, maxCdbm: 0 };
    expect(decodeDeviceInfo(encodeDeviceInfo(i))).toEqual(i);
  });

  it("handles split chunks, resyncs on garbage and drops bad CRC frames", () => {
    const a = encodePacket(PKT.Ack), b = encodePacket(PKT.Nack, Uint8Array.of(1, 2, 3));
    const bad = encodePacket(PKT.Ack, Uint8Array.of(9));
    bad[4] ^= 0xff; // corrupt payload, CRC no longer matches
    const stream = Uint8Array.from([0x00, 0x5a, 0x02, 0x00, 0x5a, ...bad, ...a, 0x11, ...b]);
    const p = new FrameParser();
    const out = [...p.push(stream.subarray(0, 7)), ...p.push(stream.subarray(7, 20)), ...p.push(stream.subarray(20))];
    expect(out.map((x) => x.type)).toEqual([PKT.Ack, PKT.Nack]);
    expect(out[1].payload).toEqual(Uint8Array.of(1, 2, 3));
    expect(p.badCrc).toBeGreaterThan(0);
  });

  it("accepts CRC 0 as unchecked", () => {
    const f = encodePacket(PKT.Ack);
    f.fill(0, f.length - 4);
    const p = new FrameParser();
    expect(p.push(f)).toHaveLength(1);
    expect(p.zeroCrc).toBe(1);
  });

  it("allow-lists outgoing packet types", () => {
    for (const t of [PKT.FirmwareChunk, PKT.ClearFlash, PKT.PerformFirmwareUpdate, PKT.SourceCalPoint, PKT.ReceiverCalPoint, PKT.FrequencyCorrection, PKT.DeviceConfiguration, 200])
      expect(isForbiddenLibrePacket(t)).toBe(true);
    for (const t of [PKT.RequestDeviceInfo, PKT.SweepSettings, PKT.SetIdle, PKT.RequestDeviceStatus]) expect(isForbiddenLibrePacket(t)).toBe(false);
    expect(LIBRE_USB_IDS[0]).toEqual({ usbVendorId: 0x0483, usbProductId: 0x564e });
  });
});

describe("LibreVNA driver against the simulator", () => {
  it("reads device info and capabilities, tolerating leading garbage", async () => {
    const { vna } = await setup({ garbage: true });
    expect(vna.info?.model).toBe("LibreVNA");
    expect(vna.info?.firmware).toBe("1.6.0");
    expect(vna.info?.maxPoints).toBe(1001);
    const c = vna.capabilities;
    expect(c.protocol).toBe("libre");
    expect([c.screenshot, c.battery, c.ifAverage, c.power, c.channels, c.deviceCal]).toEqual([false, false, false, false, false, false]);
  });

  it("sweeps S11/S21 matching the DUT", async () => {
    const { vna, link } = await setup({}, "filter");
    const pts = await vna.sweep(130e6, 160e6, 101);
    expect(pts).toHaveLength(101);
    pts.forEach((p, i) => {
      expect(p.f).toBeCloseTo(130e6 + (30e6 * i) / 100, -1);
      const t = dutS("filter", p.f);
      expect(C.abs(C.sub(p.s11, t.s11))).toBeLessThan(0.01);
      expect(C.abs(C.sub(p.s21, t.s21))).toBeLessThan(0.01);
    });
    expect(link.forbidden).toBe(0);
    expect(link.received).toContain(PKT.SetIdle);
    expect(link.sweeps[0].flags & SWEEP_FLAG.EXCITE_PORT1).toBeTruthy();
  });

  it("splits long sweeps into segments", async () => {
    const { vna, link } = await setup({ maxPoints: 200 });
    const pts = await vna.sweepSegments([{ start: 100e6, stop: 900e6, points: 450 }]);
    expect(pts).toHaveLength(450);
    expect(link.sweeps.map((s) => s.points)).toEqual([200, 200, 50]);
    pts.forEach((p, i) => { if (i) expect(p.f).toBeGreaterThan(pts[i - 1].f); });
    expect(C.abs(C.sub(pts[300].s11, dutS("antenna", pts[300].f).s11))).toBeLessThan(0.01);
  });

  it("sends SetIdle when aborted", async () => {
    const { vna, link } = await setup({ maxPoints: 5000 });
    const ac = new AbortController();
    const before = link.idles;
    const p = vna.sweep(1e6, 1e9, 4000, { signal: ac.signal, onProgress: (f) => { if (f > 0.05) ac.abort(); } });
    await expect(p).rejects.toBeInstanceOf(AbortError);
    expect(link.idles).toBeGreaterThan(before);
    expect(link.forbidden).toBe(0);
  });

  it("refuses to sweep an unknown protocol version, and rejects Nack", async () => {
    const { vna } = await setup({ protocol: 99 });
    await expect(vna.sweep(1e6, 2e6, 11)).rejects.toThrow(/protocol version 99/);
    const ok = await setup({ maxPoints: 50 });
    await expect(ok.vna.sweepSegments([{ start: 1e3, stop: 2e3, points: 10 }])).rejects.toThrow(/rejected/);
  });

  it("never sends a forbidden packet even if asked", async () => {
    const { vna, link } = await setup();
    const send = (vna as unknown as { sendPacket(t: number): Promise<void> }).sendPacket.bind(vna);
    await expect(send(PKT.ClearFlash)).rejects.toThrow(/Refusing/);
    await expect(send(PKT.PerformFirmwareUpdate)).rejects.toThrow(/Refusing/);
    expect(link.received).not.toContain(PKT.ClearFlash);
  });
});

describe("LibreVNA simulator model in the app", () => {
  it("connects and sweeps via the controller", async () => {
    set({ ...initialState, simModel: "librevna", simDut: "antenna", start: 400e6, stop: 470e6, points: 51 });
    await connectSimulator();
    expect(get().capabilities?.protocol).toBe("libre");
    expect(get().info?.model).toBe("LibreVNA");
    await sweepOnce();
    expect(get().raw).toHaveLength(51);
    await disconnect();
  });
});
