# WebVNA

A browser app for the **LiteVNA** (and the NanoVNA V2 family; NanoVNA V1/-H/-H4 support is experimental). Connect over USB, sweep from 50 kHz to 6.3 GHz, calibrate, and analyse S11/S21 on rectangular and Smith charts. It runs in Chrome or Edge with no install and no drivers.

**Try it now: [vkopitsa.github.io/WebVNA](https://vkopitsa.github.io/WebVNA/)** (click **Simulator** if you have no device).

[![Deploy to GitHub Pages](https://github.com/vkopitsa/WebVNA/actions/workflows/deploy.yml/badge.svg)](https://github.com/vkopitsa/WebVNA/actions/workflows/deploy.yml)

![WebVNA showing an antenna sweep: S11 log-magnitude and SWR on the left, Smith chart on the right, marker and VSWR bandwidth readouts below](docs/screenshot.jpg)

*The built-in simulator, sweeping an antenna near 435 MHz.*

## Why

NanoVNA-App and NanoVNA-Saver are desktop programs. WebVNA does the same job in a browser tab through the [Web Serial API](https://developer.mozilla.org/docs/Web/API/Web_Serial_API). There is nothing to install, it works the same on macOS, Windows, Linux and ChromeOS, and you can host it as a static site. The main use is antenna work: S11, VSWR, impedance and bandwidth, with S21 and time-domain analysis on top.

## Features

- **Device:** Web Serial or WebUSB, auto-reconnect, IF averaging, output power, channel select, device calibration mode, battery voltage, clock, device screenshot, hex comms monitor.
- **Sweeps:** start/stop/center/span, up to 65,535 points (segmented), log and CW sweeps, sweep averaging, amateur and ISM band presets.
- **Calibration:** SOL, isolation, thru and enhanced response, cal-kit models, save/recall/import/export, interpolation when the range changes, electrical delay and port extension.
- **Display:** 4 traces in 27 formats (log mag, phase, group delay, SWR, R/X, \|Z\|, Q, L/C, G/B, …), Smith and polar charts, stored traces A–D with data/memory maths, `.sNp` overlays, light and dark themes, a mobile layout.
- **Markers:** 8 markers, peak/valley search and tracking, delta markers, marker → start/stop/center/span/e-delay.
- **Analysis:** VSWR bandwidth and best match, L/C matching networks, filter (type, insertion loss, bandwidth, Q), cable, crystal and LC resonators, resonances.
- **Time domain:** TDR/DTF with low-pass impulse/step and band-pass modes, Kaiser windows, zero padding, velocity factor, distance or time axis, and time-domain gating.
- **Limits and statistics:** limit lines with pass/fail per trace, trace statistics (min/max/mean/RMS/std/slope/ripple), sweep averaging with outlier discard, R/ω, X/ω and µ′/µ″ (toroid core) formats.
- **2-port:** full 2-port Touchstone import/export, fixture de-embedding/embedding (Touchstone, lumped R/L/C, transmission line), a flip-DUT wizard for full S-parameters on a one-path instrument, Touchstone files as calibration standards.
- **Files:** Touchstone `.s1p`/`.s2p` (RI/MA/DB) and CSV export/import, auto-save to a folder, chart PNG, session files (`.webvna.json`) and shareable links (`#s=…`).
- **Offline and mobile:** installable PWA that works offline, touch gestures on the charts (drag, pinch, double-tap). See [docs/ANDROID.md](docs/ANDROID.md).
- **Devices:** LiteVNA / NanoVNA V2 (binary protocol) and, experimentally, NanoVNA V1 / -H / -H4 (text shell; NanoVNA-D firmware is best, stock firmware sweeps 101 points) and LibreVNA over WebUSB (experimental, simulator-tested only). The protocol is detected on connect, and controls the device lacks (screenshot, battery, IF averaging, power, channels, device calibration) are hidden. A Bluetooth serial module can be used where the browser supports Web Serial over Bluetooth (Chrome on Android, experimental).
- **Simulator:** byte-level emulators of the LiteVNA, of the NanoVNA-H / -H4 shell (NanoVNA-D and stock firmware) and of the LibreVNA packet protocol with antenna, filter, crystal, cable, RLC and calibration-standard DUTs. Try everything without hardware.
- **Scripting:** a `window.webvna` API and an in-app Script tab (see [Scripting API](#scripting-api)).
- **Languages:** English, Ukrainian, German, Polish and Spanish ([adding one](docs/TRANSLATING.md)).

More: [User guide](docs/USER-GUIDE.md) (calibration, antenna tuning, TDR, scripting), [Device compatibility](docs/DEVICES.md), [Android](docs/ANDROID.md), [Changelog](CHANGELOG.md).

## Quick start

You need [Node.js](https://nodejs.org/) 20.19+ or 22.12+ and Chrome or Edge 89+ (Firefox and Safari don't support Web Serial).

```bash
git clone https://github.com/vkopitsa/WebVNA.git
cd WebVNA
npm install
npm run dev       # http://localhost:5173
```

1. Close NanoVNA-App / NanoVNA-Saver: only one program can open the serial port.
2. Plug in the LiteVNA and click **Connect**, then pick the device in the browser's port chooser.
3. Press **Sweep** (once) or **Run** (continuous).

No hardware? Click **Simulator**.

**Calibrating:** set the sweep range first. On the **Calibrate** tab, connect OPEN, SHORT and LOAD in turn and press each button. For S21, also measure ISOLATION and THRU. Then press **Done (apply)**.

## Building and deploying

```bash
npm run build     # static site in dist/
npm run preview   # serve dist/ locally
```

`dist/` uses relative paths, so it works from any sub-path, including GitHub Pages. Web Serial only works in a [secure context](https://developer.mozilla.org/docs/Web/Security/Secure_Contexts), so serve the site over HTTPS or from `localhost`.

Every push to `main` runs the tests, builds the site and deploys it to GitHub Pages (`.github/workflows/deploy.yml`). In a fork, enable it under **Settings → Pages → Source: GitHub Actions**.

## Development

```bash
npm test           # unit tests against the simulator (vitest)
npm run typecheck  # tsc -b
npm run lint       # oxlint
npm run test:hw    # hardware tests on a real LiteVNA; HW_PORT=/dev/cu.usbmodem… to override the port
```

```
src/lib/          protocol, transports (Web Serial / WebUSB), drivers (LiteVNA/V2, NanoVNA shell), simulators,
                  calibration, trace formats, analysis, TDR, gating, limits, de-embedding, Touchstone.
                  No DOM: runs and is tested in Node.
src/store.ts      app state (zustand, persisted to localStorage)
src/controller.ts device I/O, sweep loop, calibration workflow, import/export
src/display.ts    state → chart series
src/components/   React UI; charts are drawn on canvas
src/api.ts        window.webvna scripting API (src/script.ts runs the Script tab)
src/pwa.ts        service worker registration, install/update state
src/i18n.ts       translations
```

Stack: React 19, TypeScript, Vite, zustand, vitest. No runtime dependencies besides React and zustand.

### Releases

Releases are tagged `vX.Y.Z` (semantic versioning); what changed is in [CHANGELOG.md](CHANGELOG.md). The version is shown in the app (Files tab, Settings).

To cut a release:

1. Bump `version` in `package.json` (and `package-lock.json`).
2. In `CHANGELOG.md`, move the entries from `## [Unreleased]` into a new `## [X.Y.Z] - YYYY-MM-DD` section and update the link references at the bottom.
3. Merge to `main`. The **Release** workflow (`.github/workflows/release.yml`) reads the version from `package.json`; if the tag `vX.Y.Z` does not exist yet it runs `npm ci`, `npm test` and `npm run build`, zips `dist/` as `webvna-vX.Y.Z.zip`, takes the matching CHANGELOG section (`scripts/changelog-section.mjs X.Y.Z`) as the release notes, and creates the tag and the GitHub Release with the zip attached. It can also be started by hand (workflow_dispatch). If the tag exists, it does nothing.

### Contributing

Issues and pull requests are welcome. A few rules:

- Keep `src/lib` free of DOM and React so it stays testable in Node.
- Each new protocol feature needs a simulator implementation in `src/lib/mock.ts` and a test in `src/lib/core.test.ts`.
- Every visible string goes through `t()` / `tr()`. Add an entry to every dictionary in `src/i18n/` (the coverage test lists what is missing), or ask for help with a language in the PR.
- Run `npm test`, `npm run typecheck` and `npm run lint` before opening a PR.

## Scripting API

Every build exposes a `window.webvna` object, and the **Script** tab runs code against it. A script is an async function body with `webvna` and `print()` in scope. It runs locally in the page, so only run code you trust: it can control the connected device. Values are plain arrays and objects.

```js
await webvna.connectSimulator({ model: "nanovna-h", dut: "antenna" }); // or: await webvna.connect() from a click handler
webvna.setStimulus({ start: 400e6, stop: 470e6, points: 101 });         // Hz
const data = await webvna.sweep();            // [{ f, s11: [re, im], s21: [re, im] }, ...] (calibrated)
const swr = webvna.trace(1);                  // { format, channel, unit, freqs, values }
print("min SWR", Math.min(...swr.values).toFixed(2));
const off = webvna.on("sweep", (e) => print("sweep", e.count));
webvna.run();                                 // continuous sweeping; webvna.stop() to end
const ts = webvna.exportTouchstone(2, "RI");  // string, also exportCsv()
```

| Call | Result |
|---|---|
| `version` | API version string |
| `connectSimulator({model?, dut?})`, `connect()`, `disconnect()` | model: `litevna`, `nanovna-h`, `nanovna-h4`, `nanovna-stock`, `librevna` |
| `setStimulus({start, stop, points?, mode?, cwFreq?})` | clamps to the device's range, returns the applied stimulus |
| `sweep()`, `run()`, `stop()` | `sweep()` resolves with the newly acquired, corrected points |
| `raw()`, `data()` | last raw / calibrated sweep |
| `markers()`, `setMarker(i, f)` | enabled markers with value at the nearest point |
| `trace(i)` | display values of trace `i` (0-3) |
| `limits(i?)` | pass/fail of trace `i`, or a summary of all traces with limit lines |
| `exportTouchstone(ports, fmt)`, `exportCsv()` | file contents as strings |
| `on("sweep", cb)` | returns an unsubscribe function; `cb({count, points, ms})` |
| `state()`, `setState(partial)` | JSON-safe snapshot; `setState` accepts only stimulus, averaging, power, channel, display and simulator settings and throws on anything else |

There is no TCP server in a browser. To drive the app from Python, use Playwright or Selenium with a Chromium browser and call `window.webvna` through `evaluate`. The simulator needs no device; a real serial device needs the port chooser, which can't be automated, so grant the port once in a persistent profile and use `window.__webvna.controller.reconnectKnown()` in a dev build.

```python
from playwright.sync_api import sync_playwright

with sync_playwright() as p:
    page = p.chromium.launch().new_page()
    page.goto("http://localhost:5173/")
    page.evaluate("webvna.connectSimulator({ dut: 'antenna' })")
    data = page.evaluate("webvna.setStimulus({ start: 400e6, stop: 470e6, points: 101 }), webvna.sweep()")
    print(len(data), data[0]["f"])
```

### Automation bridge (Python)

A browser page can't listen on a port, so scripts reach it through a small relay that the page connects out to. `tools/ws-bridge.mjs` is a dependency-free WebSocket relay for Node 22 or newer:

```bash
node tools/ws-bridge.mjs --port 8765 --token SECRET   # token optional; --origin https://your.host limits the page
```

Then open WebVNA, go to the **Script** tab, and under **Automation bridge** set the same port and token and tick *Connect to the local bridge*. The status shows *Connected*; the page reconnects every 2 s while the option is on. It is off at every page load.

A client connects to `ws://127.0.0.1:8765/client?token=SECRET` and sends `{"id": 1, "method": "sweep", "params": {}}`; the answer is `{"id": 1, "result": ...}` or `{"id": 1, "error": {"message": ...}}`. Methods are the API calls above: `connectSimulator`, `setStimulus`, `sweep`, `run`, `stop`, `disconnect`, `raw`, `data`, `markers`, `setMarker`, `trace`, `limits`, `exportTouchstone`, `exportCsv`, `state`, `setState`. `params` is an object with the named arguments (`setMarker`: `i`, `f`; `trace` and `limits`: `i`; `exportTouchstone`: `ports`, `fmt`; `connectSimulator`, `setStimulus` and `setState`: the options object itself) or an array of positional arguments. `connect()` (needs a click) and `on()` are not callable. Clients also receive `{"event": "sweep", "data": {count, points, ms}}` after each sweep and `{"event": "app", "data": {"connected": bool}}`. Infinite values (SWR) arrive as the strings `"Infinity"`.

```python
# pip install websockets
from webvna_client import WebVNA   # tools/webvna_client.py

with WebVNA("ws://127.0.0.1:8765/client?token=SECRET") as vna:
    vna.call("connectSimulator", dut="antenna")
    vna.call("setStimulus", start=400e6, stop=470e6, points=101)
    vna.call("sweep")
    swr = vna.call("trace", i=1)
    print(min(float(v) for v in swr["values"]))
```

`python tools/webvna_client.py` runs this as an example. Security: the relay binds to `127.0.0.1` only; set `--token` on a shared machine, since any local program that knows the port can drive the connected device; browser pages are refused on `/client` (they always send an `Origin` header); only the whitelisted API methods run (no arbitrary code); and the WebVNA page must stay open.

## Safety

The LiteVNA protocol also exposes the bootloader's flash registers (`0xE0–0xEF`). WebVNA **never writes them**, except `0xEE` (screenshot). The driver refuses those writes in code (`isForbiddenWrite()` in `src/lib/protocol.ts`). Firmware update is deliberately not implemented; use NanoVNA-App for that.

Tested on a LiteVNA 64 (hardware rev 2, firmware 2.2). Other NanoVNA V2–protocol devices should work but haven't been tested; reports are welcome ([docs/DEVICES.md](docs/DEVICES.md)). NanoVNA V1/-H/-H4 support (text shell, `src/lib/nanovna.ts`) is **experimental** and so far only exercised against the simulator. The driver refuses dangerous shell commands (`isForbiddenShellCommand()`), and the app sends `resume` on disconnect so the device screen comes back.

## Acknowledgements

- [NanoVNA-App](https://github.com/OneOfEleven/NanoVNA-App) and [NanoVNA-Saver](https://github.com/NanoVNA-Saver/nanovna-saver), the reference for features and behaviour.
- [NanoVNA2-firmware](https://github.com/nanovna-v2/NanoVNA2-firmware), [NanoVNA-QT](https://github.com/nanovna-v2/NanoVNA-QT) and [liteVNA](https://github.com/openhoangnc/liteVNA), for the USB protocol.

## License

[MIT](LICENSE)
