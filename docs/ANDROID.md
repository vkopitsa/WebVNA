# WebVNA on Android

Android support is **untested** on real devices. This page says how to try it and what to tell us.

## What you need

- **Chrome 148 or newer** on Android (earlier versions have no Web Serial on Android). Edge and other Chromium browsers may also work.
- A way to reach the VNA:
  - **USB:** a USB-OTG adapter or cable, then the VNA's USB cable. Web Serial on Android only lists a limited subset of USB serial devices, so the VNA may not appear.
  - **Bluetooth:** a Bluetooth serial (SPP / RFCOMM) module wired to the VNA's UART, paired in Android settings first.
- The page over HTTPS (the GitHub Pages site) or `localhost`.

## Steps

1. Open [vkopitsa.github.io/WebVNA](https://vkopitsa.github.io/WebVNA/) in Chrome.
2. Plug in the VNA through the OTG adapter. Tap **Connect** and pick the device in the chooser. Allow the permission prompt.
3. If **Connect** shows no device, try the **WebUSB** button. It talks to the CDC interface directly and does not depend on Web Serial's device list. Android may ask for USB permission.
4. For a Bluetooth module: pair it first (Settings, Bluetooth, PIN is usually 1234 or 0000), then tap **Bluetooth** and choose it.
5. No device? Tap **Simulator** to check that the app itself runs.

## Install as an app

Use Chrome's menu, **Install app** (or the install button in WebVNA). The app then starts full screen, works offline and shows an update prompt when a new version is deployed. The service worker is only active in the production build.

## Mobile layout and gestures

Below 800 px width the sidebar becomes a drawer (the hamburger button), and the toolbar stays at the top.

- Drag on a rectangular chart: move the active marker.
- Pinch horizontally: change the frequency range. Pinch vertically: change scale/div.
- Double-tap: auto-scale.
- Tap or drag on the Smith chart: pick the nearest point.

## Known limitations

- Web Serial over USB on Android sees only some USB-serial chips; the VNA's CDC interface may be hidden. WebUSB is the fallback.
- Bluetooth serial is experimental and slow. A full sweep can take much longer than over USB.
- No file-system folder access for auto-save on mobile Chrome; exports go to Downloads.
- iOS and iPadOS have neither Web Serial nor WebUSB and are unsupported.
- The phone may power the VNA through OTG; watch for brown-outs with weak ports.

## What to report

Open a [device report](https://github.com/vkopitsa/WebVNA/issues/new?template=device-report.md) with: phone model and Android version, Chrome version, the VNA model and firmware, the adapter/cable, which of Connect / WebUSB / Bluetooth worked, and whether sweeping, calibration and the gestures behaved. Failed connections: attach the hex comms log from the Log panel.
