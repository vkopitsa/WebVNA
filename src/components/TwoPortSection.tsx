import { useState } from "react";
import { useStore } from "../store";
import { buildFlip, clearTwoPort, exportFull2Port, fakeFlipCurrent, flipAsOverlay, isSimulator, measureFlip } from "../controller";
import { fmtHz } from "../lib/units";
import { Section, Select } from "./inputs";
import { useT } from "../i18n";

export function TwoPortSection() {
  const s = useStore();
  const t = useT();
  const [fmt, setFmt] = useState<"RI" | "MA" | "DB">("RI");
  const { fwd, rev, result } = s.twoPort;
  const connected = s.status === "connected";
  const grid = (d: typeof fwd) => (d && d.length ? `${fmtHz(d[0].f)}–${fmtHz(d[d.length - 1].f)}, ${d.length} ${t("pts")}` : t("not measured"));
  const sameGrid = !fwd || !rev || (fwd.length === rev.length && Math.abs(fwd[0].f - rev[0].f) < 1);

  return (
    <Section title="2-port (flip DUT)">
      <p className="hint">{t("Gets S11, S21, S12 and S22 from a one-path instrument: measure the DUT, turn it around, measure again. Calibrate with THRU first (enhanced response recommended). Keep the sweep settings unchanged between the steps.")}</p>
      <div className="row">
        <button disabled={!connected || s.running} className={fwd ? "on" : ""} onClick={() => void measureFlip("fwd")}>{fwd ? "✓ " : ""}{t("1. Measure forward")}</button>
        <span className="hint">{grid(fwd)}</span>
      </div>
      <div className="row">
        <button disabled={!connected || s.running || !fwd} className={rev ? "on" : ""} onClick={() => void measureFlip("rev")}>{rev ? "✓ " : ""}{t("2. Reverse the DUT and measure")}</button>
        <span className="hint">{grid(rev)}</span>
      </div>
      <p className="hint">{isSimulator() ? t("The simulator reverses the DUT for you (use the L-pad DUT for an asymmetric one).") : t("Reverse the DUT now (swap its ports), then press step 2.")}</p>
      {!sameGrid && <p className="hint err-text">{t("Forward and reversed sweeps are on different frequency grids.")}</p>}
      <div className="row">
        <button className="primary" disabled={!fwd || !rev || !sameGrid} onClick={() => buildFlip()}>{t("Build S-parameters")}</button>
        <button disabled={!s.data.length} title={t("Assume S12 = S21 and S22 = S11 of the current sweep")} onClick={() => fakeFlipCurrent()}>{t("Fake flip (symmetric DUT)")}</button>
        <button className="danger" disabled={!fwd && !rev && !result} onClick={() => clearTwoPort()}>{t("Clear")}</button>
      </div>
      <p className="hint">{result ? t("Result ready: {0}", grid(result)) : t("No result yet.")}</p>
      <div className="row">
        <Select value={fmt} ariaLabel="Touchstone format" options={[["RI", "Real/Imag"], ["MA", "Mag/Angle"], ["DB", "dB/Angle"]] as ["RI" | "MA" | "DB", string][]} onChange={(v) => setFmt(v)} />
        <button disabled={!result} onClick={() => exportFull2Port(fmt)}>{t("Export .s2p")}</button>
        <button disabled={!result} onClick={() => flipAsOverlay()}>{t("Show as overlay")}</button>
      </div>
      <p className="hint">{t("The overlay can be viewed with trace channels S12 and S22 (Display tab).")}</p>
    </Section>
  );
}
