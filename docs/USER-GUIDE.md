# WebVNA user guide

## Getting started

**Browsers.** Chrome or Edge 89+ on desktop (Web Serial). Firefox and Safari have no Web Serial; the simulator and file analysis still work there. Android: see [ANDROID.md](ANDROID.md). The page must be served over HTTPS or from `localhost`.

**Connect.** Close NanoVNA-App / NanoVNA-Saver first: only one program can open the port.

- **Connect**: Web Serial over USB. Pick the device in the browser's port chooser. Next time, **Reconnect to a known device** (Device tab) needs no chooser.
- **WebUSB**: talks to the USB CDC interface directly. Use it if the port is missing from the Web Serial chooser (some Android setups).
- **Bluetooth**: a Bluetooth serial module, where the browser supports Web Serial over Bluetooth (Chrome on Android, experimental).
- **Simulator**: no hardware. The Device tab picks the model (LiteVNA, NanoVNA-H, -H4, stock) and the DUT (antenna, filter, crystal, cable, RLC, open/short/load/thru/isolation).

Then press **Sweep** (once, Space) or **Run** (continuous, R). The toolbar shows the model, firmware and link. The protocol is detected automatically and controls the device lacks are hidden. See [DEVICES.md](DEVICES.md) for what is verified.

## Calibration

Set the sweep range and point count first; the calibration belongs to that grid (it is interpolated if you change the range later, and held constant outside it). Use the same cable or adapter you will measure with.

1. **Calibrate** tab. Connect OPEN, SHORT, LOAD in turn and press each button. The result is a one-port SOL (closed-form with ideal standards, or the general form when the cal kit models are not ideal).
2. For S21, also measure **ISOLATION** (loads on both ports) and **THRU**.
3. **Enhanced response** improves a response-only (thru) calibration using the one-port data.
4. Press **Done (apply)**. The summary line shows what is active.

**Cal kit.** The *Calibration standard (kit)* section sets offset delay, loss, and the C0..C3 / L0..L3 polynomials for open and short, and the load. Instead of a model, a standard can come from a measured **Touchstone file** (S11 of a `.s1p`/`.s2p`, interpolated onto the sweep); attach it to OPEN, SHORT or LOAD, detach to go back to the model.

**Save and recall.** *Save / recall* stores named slots in the browser, and the active one is restored on reload. Export a calibration to a file to move it between machines; import it back. *Cal range to sweep* sets the sweep to the calibration's range.

**Device calibration.** LiteVNA / V2 can deliver data calibrated by the device itself (data mode 3). Tick *Use device's own calibration*. Out-of-band data may then have |S11| > 1, so for accurate antenna work recalibrate at the cable end. NanoVNA-D can ignore its own calibration so WebVNA's applies; stock NanoVNA firmware returns raw data from `scan`, so use the WebVNA calibration.

**Port extension.** *Port extension / electrical delay* removes cable delay from S11 and S21. A marker can also set the e-delay.

## How to tune a dipole

1. Sweep around the target band, with some margin, for example 6.5 to 8 MHz for 40 m. Set the range from a **band preset** or start/stop. Use 201+ points.
2. Calibrate at the end of the feed line (OPEN, SHORT, LOAD at the connector you will attach the antenna to). Reconnect the antenna.
3. Trace 1: **SWR**. Trace 2: **Smith** or R/X. Press **Run**.
4. Use marker search (min SWR / valley on SWR) to find the resonance. The Measure tab's *VSWR bandwidth / best match* readout gives the frequency of minimum SWR and the bandwidth where SWR < 2.
5. Add a **limit line**: SWR upper limit 1.5 over the band you need (Display tab, *Limits*). The trace turns to fail where it exceeds it, with the margin shown.
6. Trim:
   - Resonance **below** the target: the antenna is too long. Shorten each leg a little. Roughly 1 % of the length moves it about 1 % of the frequency, so cut in small steps (a few cm per leg on HF).
   - Resonance **above** the target: too short. Add wire (or fold back and unfold later).
   - Where the Smith chart curve crosses the real axis is the resonance; its R there is the feed resistance (about 50 to 70 ohm for a dipole at moderate height).
7. Re-sweep after every change, keep the old trace in **memory** (stored traces A to D) to compare, and watch the min SWR move toward the target.

## TDR / cable fault location

*Time domain (TDR / DTF)* on the Display tab turns S11 into a response versus distance.

- **Low-pass impulse / step** assumes the sweep is a harmonic grid (start near the step Δf, so f = k x Δf); DC is extrapolated from the lowest points. Start the sweep low (for example 50 kHz with a matching step). The step response shows impedance steps (open: up, short: down) and is good for locating discontinuities; impulse shows reflections as peaks.
- **Band-pass** works with any start frequency; it gives the reflection magnitude versus distance and is the right choice for a cable measured at, say, 100 MHz to 1 GHz.
- **Window:** minimum (rectangular, best resolution, most ringing), normal, maximum (Kaiser, lowest sidelobes, widest peaks). Use *normal* first.
- **Padding:** zero-padding (x1 to x16) interpolates the response so peaks are placed more precisely. It does not add resolution.
- **Velocity factor:** set the cable's value (about 0.66 for solid PE coax, 0.82 foam, 0.95 air). The distance axis scales directly with it; calibrate by measuring a cable of known length.
- **Range:** the unambiguous distance is set by the frequency step, so more points over the same span reach further. Resolution is about c x VF / (2 x span). For a fault in a long cable use many points and a wide span.
- Calibrate at the cable end, leave the far end open or shorted, and read the distance of the first large peak.

## Time gating

*Time gating* (Display tab) removes unwanted reflections from S11 or S21 in the frequency-domain result: FD to TD, a gate around a time window, back to FD. Set the channel, **type** (band-pass keeps the gate, notch removes it), **centre** and **span** in time (round trip for S11, one way for S21), and the edge **window**. It needs an increasing, uniform sweep. Use it to cut the connector mismatch before an antenna, or to isolate one reflection in a cable.

## Fixture de-embedding

The Calibration tab's *Fixture* section removes (de-embed) or adds (embed) 2-ports at either port: a Touchstone file of the fixture, a series or shunt R/L/C, or a transmission line (impedance, length, velocity factor, loss). Stages are applied in order, and you can renormalise the result to another port impedance. Typical uses: take out a test-fixture or SMA-adapter, or simulate what a device would do with a matching network in front.

## 2-port measurement with the flip-DUT wizard

The one-path instrument measures only S11 and S21. The *2-port (flip DUT)* section of the Calibration tab measures the DUT in both orientations and combines them into full S-parameters (S11, S21, S12, S22) with the two-port one-path error model, using the forward error terms for both directions.

1. Calibrate with SOL + THRU (enhanced response recommended, isolation optional) and keep the sweep settings unchanged.
2. **1. Measure forward** with the DUT connected normally.
3. Reverse the DUT (swap its ports) and press **2. Reverse the DUT and measure**. On the simulator this happens for you; pick the *pad* DUT (an asymmetric L-pad) to see S11 ≠ S22.
4. **Build S-parameters**, then **Export .s2p** or **Show as overlay** (view it with trace channels S12 and S22).

For a symmetric, reciprocal DUT (a cable, an attenuator) **Fake flip** skips the second measurement and assumes S12 = S21 and S22 = S11. Imported `.s2p` files keep all four parameters.

## Limit lines

On the Display tab, per trace, add segments with a start/stop frequency, a start/stop value and a kind (upper or lower limit); a sensible default is suggested for the trace format (SWR: upper 1.5). Values are in the trace's display units (dB, SWR, ...). The sweep shows pass/fail and the point with the smallest margin. Limits can be exported and imported as text. Scripts get the result through `webvna.limits()`.

## Statistics

Measure → *Statistics* shows, for the active trace between markers 1 and 2 (or the whole sweep when both are not enabled): point count, min, max, mean, standard deviation, peak-to-peak, least-squares slope (per MHz) and flatness, the peak-to-peak of what remains after removing that slope. Use it for passband ripple and amplifier gain flatness.

## Averaging with discard

*Sweep averaging* in the Sweep section averages N sweeps. *Discard* drops the K samples furthest from the mean at each point before averaging, which removes spikes from interference. IF averaging (device side) is separate and only on devices that support it.

## Permeability (core parameters)

For measuring a ferrite or iron-powder toroid: wind it, connect it across the port and calibrate at the connector. In *Core (µ'/µ'')* enter turns, effective cross-section Ae (mm^2) and magnetic path length le (mm); defaults are an FT-37-43 with 10 turns. Choose the µ' / µ'' trace formats: with Z = R + jX, µ' = X / (ωL_air), µ'' = R / (ωL_air) where L_air = µ0 N^2 Ae / le. Also available: R/ω and X/ω.

## Sessions and share links

- **Session file** (`.webvna.json`): *Save session* in the Files tab stores the settings, the active calibration, the fixture, memories, reference overlays and the current sweep. *Open session…* restores all of it, with or without a device connected, so you can review a measurement later or send the file to someone.
- **Share link:** *Copy share link* puts a URL on the clipboard that carries the current corrected sweep and the display settings, compressed into the hash (`#s=...`). It does not include the calibration. Opening the link shows the measurement as a read-only dataset; nothing is uploaded anywhere. Very long sweeps make long URLs, so above ~30 000 characters the app suggests a session file instead.

## Offline and install

In production builds a service worker caches the app. After the first load it works offline. The browser offers **Install** (address bar or the app's install button); the installed app opens in its own window. When a new version is deployed, an update prompt appears; accept it to reload with the new version. Settings are kept in localStorage.

## Scripting

The **Script** tab and `window.webvna` run code against the app; see the [README](../README.md#scripting-api) for the call table. A script is an async function body with `webvna` and `print()`.

Find the minimum SWR across 40 m on the simulator:

```js
await webvna.connectSimulator({ dut: "antenna" });
webvna.setStimulus({ start: 6.5e6, stop: 8e6, points: 201 });
await webvna.sweep();
const t = webvna.trace(1);           // trace 2 (index 1) must be SWR
let i = t.values.indexOf(Math.min(...t.values));
print("min SWR", t.values[i].toFixed(2), "at", (t.freqs[i] / 1e6).toFixed(3), "MHz");
```

Log pass/fail every sweep:

```js
const off = webvna.on("sweep", () => print(JSON.stringify(webvna.limits())));
webvna.run();
```

Only run scripts you trust: they can control the connected device.

### Automation bridge (Python)

To drive WebVNA from a Python script on the same computer, run `node tools/ws-bridge.mjs --token SECRET` (Node 22 or newer), then on the **Script** tab, under **Automation bridge**, enter the port (8765) and token and tick *Connect to the local bridge*. The status line shows *Connected*. A script then connects to `ws://127.0.0.1:8765/client?token=SECRET` and calls the API methods; `tools/webvna_client.py` (`pip install websockets`) wraps this as `WebVNA(url).call("sweep")`. See the README, "Automation bridge (Python)", for the message format.

The bridge is off every time the page loads, listens on localhost only, and allows just the documented API calls (not arbitrary code). The WebVNA page has to stay open while a script runs. Use a token if other people use the computer.

## Keyboard and touch

| Action | Input |
|---|---|
| Single sweep | Space |
| Run / stop | R |
| Move active marker | drag on the rect chart; tap/drag on Smith |
| Zoom frequency range | Shift-drag (mouse), horizontal pinch (touch) |
| Auto-scale | double-click / double-tap |
| Scale per division | mouse wheel, vertical pinch |
| Move reference level | Shift + wheel |
