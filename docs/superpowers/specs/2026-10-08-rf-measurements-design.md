# RF measurements: antenna Q, masks, multi-sweep tests, stability, gain, radiation pattern

Date: 2026-10-08 · Branch: `feat/rf-measurements` (stacked on `feat/roadmap`, PR #2)

## Goal

Add the RF tests that a one-path VNA (LiteVNA: S11 + S21) can do in software, with honest accuracy notes.
P1dB is out of scope (needs a power sweep the hardware can't do with calibrated levels).

| Feature | Status before | Delivered by |
|---|---|---|
| Antenna Q, % bandwidth | % BW only | `antennaQ()` in the summary |
| Limit lines | done | — |
| Ripple, rejection masks | `rippleAnalysis` unused | filter-mode ripple + filter mask builder |
| Cable de-embedding (.s2p) | done | — |
| Radiation pattern | missing | `pattern.ts`, `PatternSection`, `PatternChart` |
| Splitter balance | missing | Measure mode `balance` |
| Isolator / circulator | missing | Measure mode `isolation` |
| S12/S22 via flip | done | — |
| K / μ stability | missing | `stability()` in `TwoPortSection` |
| Antenna gain | missing | Measure mode `gain` |
| Coupler directivity | missing | Measure mode `directivity` |
| Dynamic-range caveat | missing | optional noise-floor memory (slot D) |

## Decisions (agreed)

- Multi-sweep tests use the existing memory slots A–D; no wizard.
- Radiation pattern: manual rotation, "Capture" button (or Space), fixed angle step.
- Masks: a filter-mask builder that generates ordinary limit segments.
- No new sidebar tab: extend Measure, Limits and 2-port sections.

## Library (`src/lib`, no DOM, unit-tested)

### `rftests.ts`
- `antennaQ(fbw: number, s = 2): number`: Yaghjian–Best, Q ≈ (s − 1) / (√s · FBW), FBW as a fraction.
- `stability(s11, s21, s12, s22): { k, delta, mu, muPrime }`
  - Δ = S11·S22 − S12·S21
  - K = (1 − |S11|² − |S22|² + |Δ|²) / (2|S12·S21|)
  - μ = (1 − |S11|²) / (|S22 − Δ·S11*| + |S12·S21|), μ′ is the same with the ports swapped.
- `stabilitySummary(points)`: min K, min μ, max |Δ|, worst frequency, and `unconditional` (μ > 1 at every point). Points without s12/s22 are skipped; null if none.
- `compareS21(a, b, i0?, i1?)` → per-point `dDb` (|a|dB − |b|dB) and `dDeg` (wrapped phase difference ±180°), plus the max |Δ| of each and the mean dB of a and b. Used for splitter balance. The grids must match (same length, |Δf| < 1 Hz), otherwise null.
- `isolationTest(fwd, rev)` → `{ ilMin, ilMax, isoWorst, isoWorstF, marginWorst }`. IL = −|fwd|dB, isolation = −|rev|dB, margin = isolation − IL (per point, worst = smallest).
- `directivityTest(coupled, isolated)` → `{ couplingMean, dirWorst, dirWorstF, dirMean }`, where directivity = |coupled|dB − |isolated|dB.
- `floorLimited(measDb, floorDb, margin = 10): boolean`: true when the measured level is within `margin` dB of the noise floor. The UI then shows "≥ x dB (dynamic-range limited)".
- `fspl(f, d)` = 20·log10(4πdf/c).
- `gainTwoIdentical(s21Db, f, d)` = (s21Db + fspl) / 2.
- `gainReference(s21Db, refDb, gRef)` = gRef + s21Db − refDb.
- `farField(f, sizeM)` = 2D²/λ (the minimum distance).
- `rippleIn(freqs, values, f1, f2)` → peak-to-peak of the finite values in [f1, f2], or null.
- `filterMask(spec)` → `LimitSegment[]`. The spec is `{ passLo, passHi, maxIl, maxRipple, stopLo?, stopHi?, minRej, fMin, fMax }`. Values are in the trace's S21 dB.
  - Passband: lower limit −maxIl.
  - Stopbands: upper limit −minRej on [fMin, stopLo] and [stopHi, fMax].
  - Ripple is checked with `rippleIn`; it's not a limit line, because it's relative.

### `pattern.ts`
- `PatternPoint { deg: number; db: number }`.
- `addPatternPoint(points, p)`: normalises deg to [0, 360) and replaces any point within 0.01°. The result is sorted.
- `patternMetrics(points)` → `{ peakDeg, peakDb, beamwidth | null, frontToBack | null }`.
  - Beamwidth: −3 dB crossings around the peak, linearly interpolated, wrapping at 360°. Null if there's no crossing on either side.
  - F/B: the peak minus the value at peak+180°, interpolated; null when there aren't enough points.
- `patternCsv(points, f)`.

## State (`store.ts`)
- `MeasureMode` adds `"balance" | "isolation" | "directivity" | "gain"`.
- `rfTest` (persisted):
  - `{ floorSlot: boolean`: memory D is the noise floor
  - `gainMethod: "two" | "ref", distance: number, refGain: number, antSize: number }`
- `pattern` (not persisted): `{ freq: number | null, step: number, angle: number, points: PatternPoint[] }`.

## UI
- **Summary:** Q ≈ n is appended to the VSWR < 2 row.
- **AnalysisBox:** the four new modes, each with a hint naming the slots.
  - Missing slots show "Store memory A first".
  - Mismatched grids show an error line.
  - Isolation and directivity show the dynamic-range flag when `floorSlot` is on and memory D exists.
  - Gain shows the method and inputs in MeasurePanel; the results are at the active marker plus min/max, with a "±1–2 dB (room reflections)" note and a far-field warning.
- **Filter mode:** passband ripple between the −3 dB points.
- **LimitsSection:** a "Filter mask" block (S21 logmag/s21gain traces) that replaces the trace's limits.
- **TwoPortSection:** a stability block once `result` exists.
- **PatternSection** (Measure tab):
  - inputs for frequency (blank means the active marker) and step
  - Capture (Space while the section is focused), Undo, Clear, Export CSV
  - `PatternChart` polar canvas: 0° up, clockwise, 30 dB range normalised to the peak, rings every 10 dB
  - metrics underneath
- `controller.ts`: `capturePattern()`, `undoPattern()`, `clearPattern()`, `exportPatternCsv()`.

## i18n
Every new visible string goes through `t()`/`tr()`, with entries in uk/de/pl/es (the coverage tests enforce this).

## Testing
- `src/lib/rftests.test.ts`:
  - Q for a known FBW
  - K/μ of a unilateral device (S12 = 0: K = ∞, μ = 1/|S22|), a hand-computed bilateral case
  - a known unstable case
  - balance phase wrap
  - isolation margin
  - Friis round-trip (synthetic S21 from the gains gives the gain back)
  - mask segments
  - ripple
- `src/lib/pattern.test.ts`: replace on the same angle, a cos² pattern beamwidth (≈ 90°), wrap-around peak at 350°, F/B.
- Capture logic lives in a pure helper `capturePoint(pattern, data, markerF)` in `pattern.ts` (tested); the controller only calls it.
- `npm test`, `npm run typecheck`, oxlint, `npm run build`.

## Out of scope
P1dB; automatic turntables / scripting hooks for the pattern; saved mask presets; a wizard UI.
