// LiteVNA / NanoVNA V2 ("S-A-A-2") binary protocol constants. Reference: docs/01-PROTOCOL.md

export const OP = {
  NOP: 0x00, INDICATE: 0x0d,
  READ: 0x10, READ2: 0x11, READ4: 0x12, READ8: 0x13, READFIFO: 0x18,
  WRITE: 0x20, WRITE2: 0x21, WRITE4: 0x22, WRITE8: 0x23, WRITEFIFO: 0x28,
} as const;

export const REG = {
  SWEEP_START: 0x00,     // u64 Hz
  SWEEP_STEP: 0x10,      // u64 Hz
  SWEEP_POINTS: 0x20,    // u16
  VALUES_PER_FREQ: 0x22, // u16
  DATA_MODE: 0x26,       // u8: 0 USB, 1 raw samples, 2 exit USB mode, 3 device-calibrated
  VALUES_FIFO: 0x30,     // FIFO of 32-byte records; any WRITE clears it
  AVERAGE: 0x40,         // u8 1..80
  POWER_LF: 0x41,        // u8 low-band generator power
  POWER_HF: 0x42,        // u8 high-band generator power 0..3
  CHANNELS: 0x44,        // u8: 0 S11+S21, 1 S11 only, 2 S21 only
  UNIX_TIME: 0x58,       // u32 RTC
  VBAT_MV: 0x5c,         // u16 battery millivolts
  SERIAL: 0xd0,          // 3×u32 MCU unique ID
  CAPTURE: 0xee,         // WRITE → screenshot
  VARIANT: 0xf0, PROTOCOL: 0xf1, HW_REV: 0xf2, FW_MAJOR: 0xf3, FW_MINOR: 0xf4,
} as const;

export const DATA_MODE = { USB: 0, RAW: 1, EXIT: 2, DEVICE_CAL: 3 } as const;
export const CHANNELS = { BOTH: 0, S11: 1, S21: 2 } as const;

export const USB_IDS = [
  { usbVendorId: 0x04b4, usbProductId: 0x0008 }, // LiteVNA, NanoVNA V2 / V2Plus / V2Plus4
];

/** Registers the app must never write (DFU / flash). 0xEE (screenshot) is the only exception. Every byte of a multi-byte write is checked. */
export function isForbiddenWrite(addr: number, op: number, value?: number | readonly number[]): boolean {
  if (op === OP.WRITEFIFO) return true;
  const n = op >= OP.WRITE && op <= OP.WRITE8 ? 1 << (op - OP.WRITE) : 1;
  const bytes = typeof value === "number" ? le(value, n) : value; // a packed number is written little-endian
  for (let a = addr; a < addr + n; a++) {
    if (a >= 0xe0 && a <= 0xef && a !== REG.CAPTURE) return true;
    if (a === REG.DATA_MODE && bytes?.[a - addr] === DATA_MODE.RAW) return true;
  }
  return false;
}

export function le(value: number | bigint, nBytes: number): number[] {
  let x = typeof value === "bigint" ? value : BigInt(Math.round(value));
  const out: number[] = [];
  for (let i = 0; i < nBytes; i++) { out.push(Number(x & 0xffn)); x >>= 8n; }
  return out;
}

/** Byte 31 of each FIFO record. */
export function fifoChecksum(rec: Uint8Array, offset = 0): number {
  let c = 0x46;
  for (let i = 0; i < 31; i++) c = ((c ^ ((c << 1) | 1)) ^ rec[offset + i]) & 0xff;
  return c;
}

export interface DeviceInfo {
  variant: number;
  protocol: number;
  hardware: number;
  fwMajor: number;
  fwMinor: number;
  model: string;
  maxPoints: number;
  minHz: number;
  maxHz: number;
}

export function identify(info: Pick<DeviceInfo, "variant" | "hardware" | "fwMajor">): { model: string; maxPoints: number; maxHz: number } {
  if (info.variant !== 2) return { model: `Unknown device (variant ${info.variant})`, maxPoints: 1024, maxHz: 3e9 };
  if (info.fwMajor === 0xff) return { model: "V2-family device in DFU/bootloader mode", maxPoints: 0, maxHz: 0 };
  if (info.hardware === 2 && info.fwMajor === 2) return { model: "LiteVNA", maxPoints: 65535, maxHz: 6.3e9 };
  switch (info.hardware) {
    case 2: return { model: "NanoVNA V2.2", maxPoints: 1024, maxHz: 3e9 };
    case 3: return { model: "NanoVNA V2 Plus", maxPoints: 1024, maxHz: 3e9 };
    case 4: return { model: "NanoVNA V2 Plus4", maxPoints: 65535, maxHz: 4.4e9 };
    default: return { model: `NanoVNA V2 (hw rev ${info.hardware})`, maxPoints: 1024, maxHz: 3e9 };
  }
}

export const MIN_HZ = 10e3; // LiteVNA lower limit (50 kHz spec; 10 kHz usable)
