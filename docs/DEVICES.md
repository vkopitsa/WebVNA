# Device compatibility

| Device | Status | Transport |
|---|---|---|
| LiteVNA 64 (hw 2, fw 2.2) | **Verified on hardware** | Web Serial, WebUSB |
| NanoVNA V2, V2 Plus4, NanoVNA-F V2, SAA2 | Expected to work, **unverified** | Web Serial, WebUSB |
| NanoVNA-H, NanoVNA-H4 (NanoVNA-D or stock firmware) | **Experimental**, simulator-tested only | Web Serial, Bluetooth serial |
| LibreVNA (USB, protocol 13) | **Experimental**, simulator-tested only | WebUSB |
| Android phone (Chrome) | Untested | Web Serial (OTG / Bluetooth), WebUSB |
| iOS / iPadOS | Unsupported (no Web Serial, no WebUSB) | none |

The protocol is detected on connect (`src/lib/detect.ts`): the app sends 8 NOPs plus INDICATE. A V2/LiteVNA answers `'2'`; a NanoVNA shell answers with its `ch> ` prompt. Controls the device lacks are hidden.

## LiteVNA 64

Verified on hardware revision 2, firmware 2.2 (details in docs/01-PROTOCOL.md, section 9, in the maintainer's notes outside this repo):

- Identification: F0..F4 = 2,1,2,2,2 gives LiteVNA (max 65535 points, 6.3 GHz).
- Battery voltage (`0x5C`) reads about 4.0 V.
- Serial number (`0xD0`) is readable.
- FIFO checksum is present and valid.
- Sweep speed about 617 points/s at average 1: 201 points take about 0.42 s, 3001 points (segmented) about 4.9 s.
- Average 10: 101 points take about 1.3 s.
- Data mode 3 (device calibration) works.
- The first sweep after a range change is not stale.
- Screenshot is 480x320 RGB565, big-endian.

Still unverified: IF average above 80, power register ranges, READFIFO with NN = 0 speed.

The driver never writes the bootloader/flash registers `0xE0-0xEF` (except `0xEE`, screenshot). Firmware update is not implemented.

## NanoVNA V2 family

The V2, V2 Plus4, NanoVNA-F V2 and SAA2 use the same binary protocol as the LiteVNA, so they should work, but nobody has tried them with WebVNA. Frequency range, point count and available features come from the identification registers. Reports wanted (see below).

## NanoVNA-H / -H4 (experimental)

Driver: `src/lib/nanovna.ts` (ChibiOS text shell over USB CDC). It has only been run against the simulator (`src/lib/mock-shell.ts`). The assumptions that real hardware may break:

- **Binary scan layout (NanoVNA-D):** `scan <start> <stop> <points> <mask>` with mask bit 7 returns `u16 mask, u16 points`, then per point `u32 freq, f32 S11 re/im, f32 S21 re/im`, little-endian. If binary framing is not probed successfully, the driver falls back to ASCII lines.
- **Capture byte order:** `capture` returns width x height RGB565 words, big-endian (as NanoVNA-Saver unpacks it). Endianness on the H4 is unconfirmed.
- **Points:** 401 per scan on NanoVNA-D (the driver falls back to 101 if a longer scan fails); stock firmware gives 101.
- **Frequency limits:** 50 kHz to 900 MHz (H), up to 1.5 GHz (H4).
- **Firmware detection:** NanoVNA-D is recognised from the `version`/`info` output. It supports the "ignore device calibration" mask bit, so WebVNA can apply its own calibration. Stock firmware always returns raw data from `scan`, so the device calibration mode is not offered and WebVNA calibration is used.
- CW sweeps use `scan` with start == stop; `pause` before scanning is assumed harmless.
- IF averaging, power and channel selection are not available on the shell and are hidden; screenshot (`capture`) and battery (`vbat`) are used.

Safety: only `info`, `version`, `vbat`, `capture`, `pause`, `resume`, `scan` and `help` are ever sent. `saveconfig`, `clearconfig`, `dfu`, `reset`, `cal`, `touchcal`, `config` and everything else are refused by `isForbiddenShellCommand()`. On disconnect the app sends `resume` so the device screen comes back.

## LibreVNA (experimental)

Driver: `src/lib/librevna.ts`, wire format and codecs in `src/lib/libre-protocol.ts`, simulator `src/lib/mock-libre.ts`. It is selected by USB id (VID 0x0483, PID 0x564e or 0x4121) when you pick the device in the WebUSB chooser; nothing is probed. Port 1 is excited, S11 and S21 are the port 1 / port 2 receivers divided by the reference receiver. The assumptions that real hardware may break (all written from memory of the LibreVNA sources, protocol version 13):

- **Endpoints:** a vendor-specific interface with bulk EP 0x01 OUT, 0x81 IN (data) and an optional 0x82 IN (log).
- **Framing:** `0x5A`, u16 length, u8 type, payload, u32 CRC32 (standard reflected CRC-32; a CRC of 0 is accepted as unchecked). The real firmware may use another CRC variant.
- **Packet type numbers and payload layouts** (DeviceInfo, SweepSettings, VNADatapoint) are simplified; they changed between protocol versions. The driver refuses to sweep unless DeviceInfo reports a known protocol version (13).
- **Sweeps:** the device is assumed to send an Ack and then one datapoint per point, repeating until `SetIdle`. Long sweeps are split into segments of at most the reported point limit. IF bandwidth is fixed at 1 kHz and power at -10 dBm; log sweeps become linear segments.
- No screenshot, battery, IF averaging, power, channel or device-calibration controls (hidden).

Safety: only `RequestDeviceInfo`, `RequestDeviceStatus`, `SweepSettings` and `SetIdle` are ever sent. Firmware, flash, calibration and configuration packets are refused by `isForbiddenLibrePacket()`. On disconnect the app sends `SetIdle`.

## Android and iOS

See [ANDROID.md](ANDROID.md). iOS has neither Web Serial nor WebUSB, so only the simulator and offline analysis of imported files work there.

## How to report

Open a [device compatibility report](https://github.com/vkopitsa/WebVNA/issues/new?template=device-report.md). Please include:

```
Device:        e.g. NanoVNA V2 Plus4
HW / FW:       as shown in the toolbar after connecting
OS / browser:  e.g. Android 15, Chrome 148
Connection:    Web Serial / WebUSB / Bluetooth; cable or adapter
Works:         connect, sweep, calibrate, screenshot, ...
Doesn't work:  what happened; attach the hex comms log (Log panel) if connecting failed
```

Close NanoVNA-App / NanoVNA-Saver first: only one program can hold the port.
