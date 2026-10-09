import { useStore, set } from "../store";
import { FreqInput, Num, Section, Select, Field } from "./inputs";
import { restartIfRunning } from "../controller";
import { limitsOf } from "../caps";
import { fmtHz } from "../lib/units";
import { useT } from "../i18n";

export const BANDS: [string, number, number][] = [
  ["160 m", 1.8e6, 2.0e6], ["80 m", 3.5e6, 4.0e6], ["60 m", 5.3e6, 5.4e6], ["40 m", 7.0e6, 7.3e6], ["30 m", 10.1e6, 10.15e6],
  ["20 m", 14.0e6, 14.35e6], ["17 m", 18.068e6, 18.168e6], ["15 m", 21.0e6, 21.45e6], ["12 m", 24.89e6, 24.99e6], ["10 m", 28.0e6, 29.7e6],
  ["6 m", 50e6, 54e6], ["4 m", 70e6, 70.5e6], ["2 m", 144e6, 148e6], ["1.25 m", 222e6, 225e6], ["70 cm", 420e6, 450e6],
  ["LoRa / ISM 433", 433.05e6, 434.79e6], ["ISM 868", 863e6, 870e6], ["ISM 915", 902e6, 928e6], ["23 cm", 1240e6, 1300e6],
  ["GPS L1", 1565e6, 1585e6], ["13 cm / Wi-Fi 2.4", 2300e6, 2500e6], ["9 cm", 3300e6, 3500e6], ["Wi-Fi 5", 5150e6, 5850e6],
  ["HF 1–30 MHz", 1e6, 30e6], ["Full range", 50e3, 6.3e9],
];

const AVERAGES = [1, 2, 3, 4, 5, 8, 9, 16, 25, 32];
const POINTS = [11, 51, 101, 201, 401, 801, 1001, 1601, 2001, 4001, 10001, 20001, 65535];

export function StimulusPanel() {
  const s = useStore();
  const t = useT();
  const { minHz: MIN_HZ, maxHz, maxPoints: maxPts } = limitsOf(s.capabilities);
  const apply = (patch: Partial<typeof s>) => { set(patch); restartIfRunning(); };
  const center = (s.start + s.stop) / 2, span = s.stop - s.start;
  const setRange = (a: number, b: number) => {
    a = Math.max(MIN_HZ, Math.min(a, maxHz)); b = Math.max(MIN_HZ, Math.min(b, maxHz));
    if (b < a) [a, b] = [b, a];
    apply({ start: Math.round(a), stop: Math.round(b) });
  };
  const step = s.points > 1 ? span / (s.points - 1) : 0;

  return (
    <div>
      <Section title="Frequency">
        <div className="grid2">
          <Field label="Start"><FreqInput value={s.start} onChange={(v) => setRange(v, Math.max(v, s.stop))} ariaLabel="Start frequency" /></Field>
          <Field label="Stop"><FreqInput value={s.stop} onChange={(v) => setRange(Math.min(v, s.start), v)} ariaLabel="Stop frequency" /></Field>
          <Field label="Center"><FreqInput value={center} onChange={(v) => setRange(v - span / 2, v + span / 2)} ariaLabel="Center frequency" /></Field>
          <Field label="Span"><FreqInput value={span} onChange={(v) => setRange(center - v / 2, center + v / 2)} ariaLabel="Span" /></Field>
        </div>
        <p className="hint">{t("Type values like 435M, 1.2G or 500k. Step {0}. Range {1} – {2}.", fmtHz(step), fmtHz(MIN_HZ), fmtHz(maxHz))}</p>
        <div className="row">
          <button className="small" onClick={() => setRange(center - span, center + span)}>{t("Zoom out ×2")}</button>
          <button className="small" onClick={() => setRange(center - span / 4, center + span / 4)}>{t("Zoom in ×2")}</button>
          <button className="small" onClick={() => setRange(s.start - span / 4, s.stop - span / 4)}>◀</button>
          <button className="small" onClick={() => setRange(s.start + span / 4, s.stop + span / 4)}>▶</button>
        </div>
      </Section>
      <Section title="Sweep">
        <div className="grid2">
          <Field label="Points">
            <Select value={POINTS.includes(s.points) ? s.points : -1} ariaLabel="Points"
              options={[...POINTS.filter((p) => p <= maxPts).map((p) => [p, String(p)] as [number, string]), [-1, t("Custom…")]]}
              onChange={(v) => { if (v > 0) apply({ points: v }); }} />
          </Field>
          <Field label="Custom points"><Num value={s.points} min={2} max={maxPts} onChange={(v) => apply({ points: Math.round(v) })} ariaLabel="Custom points" /></Field>
          <Field label="Mode">
            <Select value={s.sweepMode} ariaLabel="Sweep mode" options={[["linear", t("Linear")], ["log", t("Logarithmic")], ["cw", t("CW (zero span)")]]}
              onChange={(v) => apply({ sweepMode: v })} />
          </Field>
          <Field label="Sweep averaging">
            <Select value={s.swAverage} ariaLabel="Software averaging" options={AVERAGES.map((n) => [n, n === 1 ? t("Off") : t("{0} sweeps", n)] as [number, string])}
              onChange={(v) => apply({ swAverage: v, swDiscard: Math.min(s.swDiscard, v - 1) })} />
          </Field>
          <Field label="Discard">
            <Select value={Math.min(s.swDiscard, s.swAverage - 1)} ariaLabel="Outlier sweeps to discard" options={Array.from({ length: s.swAverage }, (_, i) => i)}
              onChange={(v) => apply({ swDiscard: v })} />
          </Field>
        </div>
        {s.swAverage > 1 && <p className="hint">{t("Per point, the sweeps furthest from the mean are dropped before averaging. NanoVNA-Saver presets (sweeps/discard): 3/0, 5/2, 9/4, 25/6.")}</p>}
        {s.sweepMode === "cw" && (
          <div className="row"><label>{t("CW frequency")}</label><FreqInput value={s.cwFreq} onChange={(v) => apply({ cwFreq: v })} ariaLabel="CW frequency" /></div>
        )}
        {s.sweepMode === "log" && <p className="hint">{t("The device sweeps linearly; log sweeps are made from short linear segments and take longer.")}</p>}
        {s.points > 1024 && <p className="hint">{t("More than 1024 points are swept in 1024-point segments.")}</p>}
      </Section>
      <Section title="Band presets">
        <div className="grid3">
          {BANDS.filter(([, a]) => a < maxHz).map(([name, a, b]) => (
            <button key={name} className="small" onClick={() => {
              const m = (b - a) * 0.1;
              setRange(a - m, Math.min(b + m, maxHz));
            }} title={`${fmtHz(a)} – ${fmtHz(b)}`}>{t(name)}</button>
          ))}
        </div>
      </Section>
    </div>
  );
}
