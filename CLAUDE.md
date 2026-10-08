# WebVNA (web/): notes for Claude Code

Browser app (React 19 + TypeScript 6 + Vite 8 + zustand 5) that controls a **LiteVNA 64** (and the NanoVNA V2 family) over **Web Serial**. It has parity with the on-device UI and NanoVNA-App / NanoVNA-Saver; the checklist is `../docs/06-FEATURES.md`. Firmware update (DFU) is deliberately out of scope.
This folder is its own git repo (`main`). The parent folder (`../`) holds docs, references, the legacy single-file app (`../src/core.js`, `../src/ui.html`) and Python/Node examples. Those are **not** in git.

## Commands
```bash
npm run dev        # http://localhost:5173 (Chrome/Edge; localhost counts as a secure context for Web Serial)
npm test           # vitest: src/lib/*.test.ts (simulators), src/api.test.ts, src/store.test.ts, src/i18n.test.ts, pwa-precache.test.ts
npm run test:hw    # src/lib/hardware.test.ts against the real device (HW_PORT, default /dev/cu.usbmodemv1_01) → hw-report.json
npm run typecheck  # tsc -b (app + node + test projects)
npm run build      # tsc -b && vite build → dist/ (base './')
./node_modules/.bin/oxlint src
```
Environment quirks in this setup:
- **rtk hook** rewrites some shell commands. `npx vite …` becomes `npm run vite`, which fails. `cat a b` and `head a b` with several files break. Call `./node_modules/.bin/<tool>` directly, and use the Read tool for files.
- **npm needs** `npm_config_cache=$TMPDIR/npm-cache`, because `~/.npm` has root-owned files and the sandbox blocks it, plus `registry.npmjs.org` in allowed_domains.
- **Sandbox blocks** binding local ports (dev server), opening `/dev/cu.*` (hardware tests) and writing `.git`. Run those with the sandbox disabled.
- **Browser testing:** with Claude in Chrome, dev builds expose `window.__webvna = { useStore, controller }`. Drive state with `useStore.setState`, and call `controller.connectSimulator()`, `reconnectKnown()`, `sweepOnce()` and the rest. The Web Serial port chooser is native browser UI that can't be clicked. Once the user has granted the port, `reconnectKnown()` connects without it.

## Layout
```
src/lib/              NO DOM, NO React, NO i18n. Runs in Node (vitest)
  protocol.ts         opcodes, registers, checksum, identify(), isForbiddenWrite()
  links.ts            LinkBase (byte queue + read(n, timeout)), SerialLink (Web Serial), UsbLink (WebUSB CDC), WebUsbBulkLink (WebUSB vendor bulk, LibreVNA)
  litevna.ts          LiteVNA driver: init, read/write regs, sweepSegments (≤1024/segment), screenshot, extras; planSegments() for linear/log/CW
  driver.ts           VnaDriver interface, DriverCapabilities, splitSegments()
  detect.ts           detectProtocol() (V2 vs shell) and createDriver()
  nanovna.ts          NanoVNAShell: V1/-H/-H4 text-shell driver (experimental), isForbiddenShellCommand()
  mock-shell.ts       MockShellLink: shell simulator (H/H4, NanoVNA-D/stock)
  libre-protocol.ts   LibreVNA packet framing (CRC32, FrameParser), payload codecs, isForbiddenLibrePacket(), USB ids (all assumptions in the header)
  librevna.ts         LibreVNA driver (experimental, WebUSB; chosen by USB id, not probed)
  mock-libre.ts       MockLibreLink: LibreVNA packet simulator (simModel "librevna")
  mock.ts             MockLink simulator with the same byte protocol; DUTs: antenna, filter, crystal, cable, rlc, open/short/load/thru/isolation
  calibration.ts      SOL (closed-form ideal + general 3×3 with cal-kit models), response/isolation/thru, enhanced response, interpolation, e-delay, JSON
  formats.ts          27 trace formats (FORMATS/FORMAT_BY_ID), impedance(), swr() (Infinity when |Γ|≥1), groupDelay(), traceValues()
  analysis.ts         marker search, SWR bandwidth, resonances, filter, L/C match, cable, crystal, LC resonators
  tdr.ts              FFT, Kaiser windows, low-pass impulse/step, band-pass, distance axis
  touchstone.ts       .s1p/.s2p write (RI/MA/DB) + parse (any unit/format/Z0), CSV
  limits.ts stats.ts  limit lines + pass/fail; trace statistics and ripple
  averaging.ts        outlier-rejecting sweep averaging (SweepAccumulator)
  permeability.ts     µ′/µ″ of a toroid core from S11
  gating.ts           time-domain gating (FD→TD→gate→FD)
  s2.ts deembed.ts    2×2 S/T maths; fixture de-embedding/embedding
  twoport.ts          flip-DUT combination into full S-parameters
  units.ts            si(), fmtHz(), parseHz("435M"), parseSI("4.7n"), niceStep()
src/store.ts          zustand State + defaults; PERSIST keys saved to localStorage ("webvna.settings.v1")
src/controller.ts     everything with side effects: connect/disconnect, sweep loop (AbortController), calibration workflow,
                      cal slots ("webvna.cal.<name>", active cal "webvna.activecal"), memories, import/export, auto-save
src/caps.ts           frequency/point limits from the connected driver's capabilities, simulator model labels
src/api.ts            window.webvna scripting API; src/script.ts runs the Script tab code
src/pwa.ts            service worker registration, install/update state (pwa-plugin.ts, pwa-precache.ts at the root emit dist/sw.js)
src/session.ts        session files (.webvna.json) and share links (#s=…)
src/display.ts        state → chart Series (rectSeries), autoScale, valueText, zText (Smith readouts)
src/i18n.ts           translate/useT/tr, LANGS, DICTS; dictionaries in src/i18n/{uk,de,pl,es}.ts (English source string → translation)
src/components/       Toolbar, *Panel (sidebar tabs), RectChart/SmithChart (canvas via hooks/useCanvas), ScaleTools,
                      ChartTools (PNG/fullscreen), MarkerTable, AnalysisBox (in MeasurePanel.tsx), LogPanel, inputs.tsx
```

## Conventions
- **Units and numbers:** frequencies are Hz internally. Complex numbers are `[re, im]` tuples; use `C` from `lib/complex.ts`.
- **TypeScript:** `erasableSyntaxOnly` is on, so no enums and no constructor parameter properties. Use `as const` objects and unions.
- **New protocol features:** each one needs a `MockLink` implementation and a test in `src/lib/core.test.ts`.
- **i18n:** every visible string goes through `t()` (`useT()` in components) or `tr()` (non-React code, canvas). The key is the exact English text, with placeholders `{0}`, `{1}`. Add the entry to every dictionary in `src/i18n/` (uk, de, pl, es); the tests check placeholders and that every language covers every key, and that every literal `t()`/`tr()` string has a UK entry. English is the default. `lib/` stays untranslated. Format labels from `FORMAT_BY_ID[..].label` are translated at display time with `t(label)`. Canvas `useCanvas` deps must include `lang`.
- **Styling:** colours come from CSS tokens in `src/index.css`, with light/dark via `prefers-color-scheme` and `[data-theme]`. Below 800 px the layout is mobile: the sidebar becomes a drawer (☰), the toolbar is sticky, `.mobile-only` elements show and `.theme-select` hides.
- **Charts:** canvas, 8 vertical by 10 horizontal divisions, NanoVNA-style per-trace scale (`perDiv`, `ref`, `refPos`).
  - The left axis follows the active trace; the right axis shows the second trace.
  - SWR defaults to a manual scale of 1 + 0.5/div, like the device. When auto, it is floored at 1 and capped at 30.
  - ±Infinity values are drawn clipped at the edge; NaN breaks the line.
  - Rect chart: drag moves the active marker, Shift-drag zooms the frequency range, double-click auto-scales, the wheel changes scale/div, Shift+wheel moves the reference.
- **Drivers:** the app talks to `VnaDriver` (`lib/driver.ts`), never to `LiteVNA` or `NanoVNAShell` directly. A new device feature adds a flag to `DriverCapabilities`, an implementation in each driver that has it, and hides the UI when absent. The shell driver only sends allow-listed commands (`isForbiddenShellCommand()`); keep it that way. Shell features need a `MockShellLink` implementation and a test.
- **Device access:** goes through `LiteVNA.exclusive()`, a promise queue. Stimulus changes during continuous sweeps call `restartIfRunning()`, which aborts and restarts the sweep.

## Hardware rules (the real device is often plugged in)
- **Port:** `/dev/cu.usbmodemv1_01`. Close NanoVNA-App/Saver first; only one program can hold the port.
- **Session start and end:** start every session with 8×NOP plus INDICATE (expect `'2'`). End with `00×8, 20 26 02` (exit USB mode) so the device screen comes back. `controller.disconnect()` and the `beforeunload` handler do this.
- **Forbidden registers:** never write `0xE0–0xEF` except `0xEE` (screenshot). Never send WRITEFIFO (`0x28`) or `20 EF 5E`. Never write `0x26 = 1`. `isForbiddenWrite()` enforces this in the driver; keep it that way.
- **Restore defaults:** `0x40`, `0x41`, `0x42` and `0x44` are safe to change, but restore the defaults afterwards (avg 1, LF power 1, HF power 3, channels 0).
- **Don't assume the DUT:** assume the user has an antenna or standards on the ports, not a 50 Ω load. Ask.

## Verified on hardware (LiteVNA hw 2, fw 2.2; details in ../docs/01-PROTOCOL.md §9)
| Check | Result |
|---|---|
| Identification | F0..F4 = 2,1,2,2,2 → LiteVNA (max 65535 points, 6.3 GHz) |
| VBAT `0x5C` | ≈ 4.0 V |
| Serial `0xD0` | readable |
| FIFO checksum | present and valid |
| Sweep speed | ~617 pts/s at avg 1; 201 pts ≈ 0.42 s; 3001 pts (segmented) ≈ 4.9 s |
| Avg 10 | 101 pts ≈ 1.3 s |
| Data mode 3 (device calibration) | works |
| First sweep after a range change | not stale |
| Screenshot | 480×320 RGB565 big-endian |

**Still unverified:** average > 80, power register ranges, READFIFO NN = 0 speed.

**User's setup (Oct 2026):** a 3.3 GHz antenna on port 1. Best match ≈ 3.48–3.49 GHz with SWR < 2 from 3.18 to 3.64 GHz, using the device calibration. That calibration gives |S11| > 1 out of band, so the antenna should be recalibrated at the cable end.

## Ideas / not done
- **Firmware:** DFU flashing (deliberately out; brick risk).
- **Drivers:** a WebSocket bridge to remote or SCPI-style instruments.
- **Calibration:** the NanoVNA-Saver `.cal` format.
- **Display:**
  - SWR on a log axis.
  - Per-trace TDR settings: currently global, with one series per channel.
  - A multi-window "pop-out" (fullscreen per chart exists).
- **Hardware verification:** NanoVNA-H / -H4 (binary scan layout, capture byte order, point counts) and Android (Web Serial over OTG/Bluetooth, WebUSB) are untested on real devices.
- **Translation gaps:** the TDR legend, `calSummary` and the L/C match topology text are English only, because they come from `lib/`.
