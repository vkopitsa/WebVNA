// LibreVNA USB packet protocol (experimental; simulator-tested only, NOT verified on hardware).
//
// Written from memory of the LibreVNA sources (Software/PC_Application/Device/device.cpp and
// Firmware/.../Protocol.hpp, protocol version ~13, LibreVNA 1.5/1.6). EVERY item below is an assumption that real
// hardware may contradict; the whole protocol lives in this file so it is cheap to correct.
//
// USB:      VID 0x0483, PID 0x564e (older boards 0x4121). One vendor-specific interface with bulk endpoints
//           EP 0x01 OUT (host → device), EP 0x81 IN (device → host), EP 0x82 IN (firmware log text, optional).
// Framing:  0x5A | u16 LE total length (header and CRC included) | u8 type | payload | u32 LE CRC32.
//           CRC32 is the standard reflected CRC-32 (poly 0xEDB88320, "123456789" → 0xCBF43926) over every byte before
//           the CRC. ASSUMPTION: the real firmware may use the STM32 hardware CRC variant; a CRC of 0 is therefore
//           accepted as "unchecked" (counted in `zeroCrc`), like the LiteVNA zero checksum.
// Types:    the numeric PacketType values below follow protocol version 13 as remembered; they changed between versions.
// Payloads: layouts below are simplified from the C++ structs (all little-endian):
//   DeviceInfo   u16 protocol, u8 fwMajor, u8 fwMinor, u8 fwPatch, u8 hwVersion, u64 minHz, u64 maxHz,
//                u32 minIfBw, u32 maxIfBw, u16 maxPoints, i16 minCdbm, i16 maxCdbm            (36 bytes, longer is tolerated)
//   SweepSettings u64 fStart, u64 fStop, u16 points, u32 ifBw, i16 cdbmStart, i16 cdbmStop, u8 flags, u8 syncMode (28 bytes)
//                flags: bit0 excitePort1, bit1 excitePort2, bit2 suppressPeaks, bit3 fixedPower, bit4 logSweep
//   VNADatapoint u16 pointNum, u64 frequency, i16 cdbm, then f32 re/im of reference, port1 and port2 receivers (36 bytes)
//                with port 1 excited: S11 = port1 / reference, S21 = port2 / reference.
// Sweeping: the device sweeps continuously after SweepSettings and answers with an Ack then one VNADatapoint per point;
//           the host sends SetIdle when it has what it needs.
// Safety:   firmware update / flash / calibration-write packets are never sent (isForbiddenLibrePacket(); allow-list).

export const LIBRE_USB_IDS = [
  { usbVendorId: 0x0483, usbProductId: 0x564e },
  { usbVendorId: 0x0483, usbProductId: 0x4121 },
];

export const LIBRE_PROTOCOL_VERSIONS = [13] as const;

export const LIBRE_HEADER = 0x5a;
export const LIBRE_MAX_PACKET = 1024;

export const PKT = {
  Datapoint: 1,
  SweepSettings: 2,
  ManualStatus: 3,
  ManualControl: 4,
  DeviceInfo: 5,
  FirmwareChunk: 6,
  Ack: 7,
  ClearFlash: 8,
  PerformFirmwareUpdate: 9,
  Nack: 10,
  Reference: 11,
  Generator: 12,
  SpectrumAnalyzerSettings: 13,
  SpectrumAnalyzerResult: 14,
  RequestDeviceInfo: 15,
  RequestSourceCal: 16,
  RequestReceiverCal: 17,
  SourceCalPoint: 18,
  ReceiverCalPoint: 19,
  SetIdle: 20,
  RequestFrequencyCorrection: 21,
  FrequencyCorrection: 22,
  RequestDeviceConfiguration: 23,
  DeviceConfiguration: 24,
  RequestAcquisitionFrequencySettings: 25,
  AcquisitionFrequencySettings: 26,
  DeviceStatus: 27,
  RequestDeviceStatus: 28,
  VNADatapoint: 29,
} as const;

/** The only packet types the host may send. Everything else (firmware, flash, calibration/config writes) is refused. */
const ALLOWED_TX = new Set<number>([PKT.RequestDeviceInfo, PKT.RequestDeviceStatus, PKT.SweepSettings, PKT.SetIdle]);

/** True when a packet must never be sent (firmware update, flash erase, calibration or configuration writes, unknown types). */
export function isForbiddenLibrePacket(type: number): boolean {
  return !ALLOWED_TX.has(type);
}

// ---------------------------------------------------------------- CRC32
let table: Uint32Array | null = null;
export function crc32(bytes: Uint8Array): number {
  if (!table) {
    table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      table[i] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i++) c = table[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

// ---------------------------------------------------------------- framing
export interface Packet { type: number; payload: Uint8Array }

export function encodePacket(type: number, payload: Uint8Array = new Uint8Array(0)): Uint8Array {
  const len = payload.length + 8;
  if (len > 0xffff) throw new Error("LibreVNA packet too long.");
  const out = new Uint8Array(len), dv = new DataView(out.buffer);
  out[0] = LIBRE_HEADER;
  dv.setUint16(1, len, true);
  out[3] = type;
  out.set(payload, 4);
  dv.setUint32(len - 4, crc32(out.subarray(0, len - 4)), true);
  return out;
}

/** Streaming frame parser: tolerates split chunks, garbage between frames and corrupted frames (resync on the next 0x5A). */
export class FrameParser {
  private buf = new Uint8Array(0);
  badCrc = 0;
  zeroCrc = 0;
  skipped = 0;
  /** Accept CRC 0 as "unchecked". */
  acceptZeroCrc = true;

  reset(): void { this.buf = new Uint8Array(0); }

  push(chunk: Uint8Array): Packet[] {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf);
    joined.set(chunk, this.buf.length);
    this.buf = joined;
    const out: Packet[] = [];
    for (;;) {
      const b = this.buf;
      let i = 0;
      while (i < b.length && b[i] !== LIBRE_HEADER) i++;
      if (i > 0) { this.skipped += i; this.buf = b.slice(i); continue; }
      if (b.length < 3) break;
      const len = b[1] | (b[2] << 8);
      if (len < 8 || len > LIBRE_MAX_PACKET) { this.skipped++; this.buf = b.slice(1); continue; }
      if (b.length < len) break;
      const dv = new DataView(b.buffer, b.byteOffset, len);
      const got = dv.getUint32(len - 4, true), want = crc32(b.subarray(0, len - 4));
      if (got === want || (got === 0 && this.acceptZeroCrc)) {
        if (got !== want) this.zeroCrc++;
        out.push({ type: b[3], payload: b.slice(4, len - 4) });
        this.buf = b.slice(len);
      } else {
        this.badCrc++;
        this.buf = b.slice(1); // not a frame after all: rescan from the next byte
      }
    }
    return out;
  }
}

// ---------------------------------------------------------------- payloads
export interface LibreDeviceInfo {
  protocol: number; fwMajor: number; fwMinor: number; fwPatch: number; hwVersion: number;
  minHz: number; maxHz: number; minIfBw: number; maxIfBw: number; maxPoints: number; minCdbm: number; maxCdbm: number;
}
const DEVICE_INFO_LEN = 36;

export function encodeDeviceInfo(d: LibreDeviceInfo): Uint8Array {
  const b = new Uint8Array(DEVICE_INFO_LEN), dv = new DataView(b.buffer);
  dv.setUint16(0, d.protocol, true); b[2] = d.fwMajor; b[3] = d.fwMinor; b[4] = d.fwPatch; b[5] = d.hwVersion;
  dv.setBigUint64(6, BigInt(Math.round(d.minHz)), true); dv.setBigUint64(14, BigInt(Math.round(d.maxHz)), true);
  dv.setUint32(22, d.minIfBw, true); dv.setUint32(26, d.maxIfBw, true);
  dv.setUint16(30, d.maxPoints, true); dv.setInt16(32, d.minCdbm, true); dv.setInt16(34, d.maxCdbm, true);
  return b;
}

export function decodeDeviceInfo(p: Uint8Array): LibreDeviceInfo {
  if (p.length < DEVICE_INFO_LEN) throw new Error(`LibreVNA DeviceInfo too short (${p.length} bytes).`);
  const dv = new DataView(p.buffer, p.byteOffset, p.length);
  return {
    protocol: dv.getUint16(0, true), fwMajor: p[2], fwMinor: p[3], fwPatch: p[4], hwVersion: p[5],
    minHz: Number(dv.getBigUint64(6, true)), maxHz: Number(dv.getBigUint64(14, true)),
    minIfBw: dv.getUint32(22, true), maxIfBw: dv.getUint32(26, true),
    maxPoints: dv.getUint16(30, true), minCdbm: dv.getInt16(32, true), maxCdbm: dv.getInt16(34, true),
  };
}

export const SWEEP_FLAG = { EXCITE_PORT1: 1, EXCITE_PORT2: 2, SUPPRESS_PEAKS: 4, FIXED_POWER: 8, LOG_SWEEP: 16 } as const;

export interface LibreSweepSettings {
  fStart: number; fStop: number; points: number; ifBw: number; cdbmStart: number; cdbmStop: number; flags: number; syncMode: number;
}
const SWEEP_LEN = 28;

export function encodeSweepSettings(s: LibreSweepSettings): Uint8Array {
  const b = new Uint8Array(SWEEP_LEN), dv = new DataView(b.buffer);
  dv.setBigUint64(0, BigInt(Math.round(s.fStart)), true); dv.setBigUint64(8, BigInt(Math.round(s.fStop)), true);
  dv.setUint16(16, s.points, true); dv.setUint32(18, s.ifBw, true);
  dv.setInt16(22, s.cdbmStart, true); dv.setInt16(24, s.cdbmStop, true); b[26] = s.flags; b[27] = s.syncMode;
  return b;
}

export function decodeSweepSettings(p: Uint8Array): LibreSweepSettings {
  if (p.length < SWEEP_LEN) throw new Error(`LibreVNA SweepSettings too short (${p.length} bytes).`);
  const dv = new DataView(p.buffer, p.byteOffset, p.length);
  return {
    fStart: Number(dv.getBigUint64(0, true)), fStop: Number(dv.getBigUint64(8, true)), points: dv.getUint16(16, true),
    ifBw: dv.getUint32(18, true), cdbmStart: dv.getInt16(22, true), cdbmStop: dv.getInt16(24, true), flags: p[26], syncMode: p[27],
  };
}

export type Cx = [number, number];
export interface LibreDatapoint { pointNum: number; frequency: number; cdbm: number; reference: Cx; port1: Cx; port2: Cx }
const DATAPOINT_LEN = 36;

export function encodeDatapoint(d: LibreDatapoint): Uint8Array {
  const b = new Uint8Array(DATAPOINT_LEN), dv = new DataView(b.buffer);
  dv.setUint16(0, d.pointNum, true); dv.setBigUint64(2, BigInt(Math.round(d.frequency)), true); dv.setInt16(10, d.cdbm, true);
  [d.reference, d.port1, d.port2].forEach((c, i) => { dv.setFloat32(12 + i * 8, c[0], true); dv.setFloat32(16 + i * 8, c[1], true); });
  return b;
}

export function decodeDatapoint(p: Uint8Array): LibreDatapoint {
  if (p.length < DATAPOINT_LEN) throw new Error(`LibreVNA VNADatapoint too short (${p.length} bytes).`);
  const dv = new DataView(p.buffer, p.byteOffset, p.length);
  const c = (i: number): Cx => [dv.getFloat32(12 + i * 8, true), dv.getFloat32(16 + i * 8, true)];
  return { pointNum: dv.getUint16(0, true), frequency: Number(dv.getBigUint64(2, true)), cdbm: dv.getInt16(10, true), reference: c(0), port1: c(1), port2: c(2) };
}
