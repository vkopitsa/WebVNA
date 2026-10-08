# Changelog

All notable changes to WebVNA are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and versions follow [Semantic Versioning](https://semver.org/). Releases are tagged `vX.Y.Z`.

## [Unreleased]

## [0.3.0] - 2026-10-08

### Added
- **German, Polish and Spanish UI translations.** Dictionaries now live one per language in `src/i18n/`; tests check placeholders, full key coverage per language, and that every `t()`/`tr()` literal has an entry.

- **NanoVNA V1 / -H / -H4 support (experimental).** A text-shell driver (`src/lib/nanovna.ts`) for stock and DiSlord NanoVNA-D firmware, with binary scan framing where available, screenshot via `capture`, and a command allow-list (`isForbiddenShellCommand()`). Only exercised against the simulator so far; see [docs/DEVICES.md](docs/DEVICES.md).
- **LibreVNA support (experimental).** WebUSB bulk-endpoint link (`WebUsbBulkLink`), packet protocol with CRC32 framing and a resyncing parser (`libre-protocol.ts`), driver (`librevna.ts`), simulator model `librevna` (`mock-libre.ts`) and a firmware-packet guard (`isForbiddenLibrePacket()`). Written from memory of the LibreVNA sources and only exercised against the simulator; see [docs/DEVICES.md](docs/DEVICES.md).
- **Driver interface and capabilities** (`VnaDriver`, `DriverCapabilities`) and protocol detection on connect (`detect.ts`). Controls the device lacks (screenshot, battery, IF averaging, power, channels, device calibration) are hidden, and the frequency range and point count follow the connected device.
- **Simulator for the NanoVNA shell** (`MockShellLink`: H and H4 boards, NanoVNA-D and stock firmware), plus a model selector in the Simulator section.
- **Bluetooth serial** connection (Web Serial over Bluetooth, Chrome on Android, experimental) next to Web Serial and WebUSB.
- **Scripting:** `window.webvna` API (connect, stimulus, sweep, markers, traces, limits, export, events) and an in-app **Script** tab. See the README.
- **Limit lines** per trace with pass/fail, margin readout and a `limits()` script call; limits can be exported and imported as text.
- **Trace statistics** (min, max, mean, RMS, std, slope, ripple) over a marker range or the whole sweep.
- **Sweep averaging with outlier rejection:** average N sweeps and discard the K samples furthest from the mean, per point.
- **New trace formats:** R/ω, X/ω and the complex permeability µ′ / µ″ of a toroid core (turns, cross-section, path length; NanoVNA-Saver "S11 µ").
- **TDR zero padding** (FFT size x1 to x16) for smoother time-domain traces.
- **Time-domain gating** (band-pass style FD to TD to gate to FD) for S11 and S21, with gate centre, span and edge window.
- **Touchstone calibration standards:** use a measured `.s1p`/`.s2p` file for OPEN, SHORT or LOAD instead of a polynomial model.
- **Full 2-port Touchstone** import and export (S11, S12, S21, S22).
- **Fixture de-embedding / embedding** (Calibration tab): remove or add a 2-port at either port from a Touchstone file, lumped R/L/C or a transmission line, with optional renormalisation to another impedance.
- **Flip-DUT full 2-port measurement:** a wizard that measures the DUT in both orientations on the one-path instrument and combines them into full S-parameters.
- **Session files** (`.webvna.json`) that save and restore the setup, and **shareable links** (`#s=...` in the URL) that carry the setup.
- **Installable PWA** with an offline service worker, an install button and an update prompt.
- **Touch gestures** on the charts: drag the marker, pinch to zoom, double-tap to auto-scale.
- Documentation: [User guide](docs/USER-GUIDE.md), [Devices](docs/DEVICES.md), [Android](docs/ANDROID.md), [Translating](docs/TRANSLATING.md), issue templates.

### Changed

- The app and the sweep loop talk to the device through `VnaDriver` instead of the LiteVNA class directly.
- Frequency and point-count limits come from the connected device instead of fixed LiteVNA values.
- The 2-port Touchstone importer is no longer limited to S11/S21.

### Fixed

- Nothing recorded yet for this release.

## [0.2.0]

Baseline feature set.

- **Device:** Web Serial and WebUSB, auto-reconnect, IF averaging, output power, channel select, device calibration mode, battery voltage, clock, device screenshot, hex comms monitor. Verified on a LiteVNA 64 (hw 2, fw 2.2); NanoVNA V2 family expected to work.
- **Sweeps:** start/stop/center/span, up to 65,535 points (segmented), log and CW sweeps, sweep averaging, amateur and ISM band presets.
- **Calibration:** SOL, isolation, thru and enhanced response, cal-kit models, save/recall/import/export, interpolation when the range changes, electrical delay and port extension.
- **Display:** 4 traces in 27 formats, Smith and polar charts, stored traces A to D with data/memory maths, `.sNp` overlays, light and dark themes, mobile layout.
- **Markers:** 8 markers, peak/valley search and tracking, delta markers, marker to start/stop/center/span/e-delay.
- **Analysis:** VSWR bandwidth and best match, L/C matching networks, filter, cable, crystal and LC resonators, resonances.
- **Time domain:** TDR/DTF with low-pass impulse/step and band-pass modes, Kaiser windows, velocity factor, distance or time axis.
- **Files:** Touchstone `.s1p`/`.s2p` (RI/MA/DB) and CSV export/import, auto-save to a folder, chart PNG.
- **Simulator** of the LiteVNA with antenna, filter, crystal, cable, RLC and calibration-standard DUTs.
- English and Ukrainian UI.

[Unreleased]: https://github.com/vkopitsa/WebVNA/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/vkopitsa/WebVNA/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/vkopitsa/WebVNA/releases/tag/v0.2.0
