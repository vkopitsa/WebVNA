---
name: Device compatibility report
about: Tell us which device you tried and what worked
title: "[device] <model>: works / partly works / does not work"
labels: device-report
---

**Device**
- Model (e.g. LiteVNA 64, NanoVNA V2 Plus4, NanoVNA-H4):
- Hardware revision and firmware version (shown in the toolbar after connecting, or `version` / `info` output):

**Environment**
- OS and version:
- Browser and version (`chrome://version`):
- WebVNA version or URL:

**Connection**
- [ ] Web Serial (USB)
- [ ] WebUSB
- [ ] Bluetooth serial
- Cable / adapter (e.g. USB-OTG adapter on Android):

**What works** (tick what you tried)
- [ ] Connects and shows the model/firmware
- [ ] Single sweep and continuous run
- [ ] Calibration (SOL) and the result looks right
- [ ] Frequency range and point count as expected
- [ ] Screenshot / battery / averaging / power (if the device has them)
- [ ] Disconnect returns the device screen to normal

**What does not work**
Describe it. Attach the **Diagnostics** section or the hex comms log from the Log panel if connecting failed.

**Anything else**
