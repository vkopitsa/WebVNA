import { useState } from "react";
import { useStore, set, resetSettings } from "../store";
import { exportData, importTouchstoneFile, chooseAutoSaveDir } from "../controller";
import { Check, Section, Select, LangSelect } from "./inputs";
import { useT } from "../i18n";
import { canShare, copyShareLink, openSessionFile, saveSessionFile } from "../session";

export function FilesPanel() {
  const s = useStore();
  const t = useT();
  const [fmt, setFmt] = useState<"RI" | "MA" | "DB">("RI");
  const has = s.data.length > 0;
  return (
    <div>
      <Section title="Export">
        <div className="row">
          <label>{t("Touchstone format")}</label>
          <Select value={fmt} ariaLabel="Touchstone format" options={[["RI", t("Real/Imag")], ["MA", t("Mag/Angle")], ["DB", t("dB/Angle")]] as ["RI" | "MA" | "DB", string][]} onChange={(v) => setFmt(v)} />
        </div>
        <div className="row">
          <button disabled={!has} onClick={() => exportData("s1p", fmt)}>{t("Save .s1p")}</button>
          <button disabled={!has} onClick={() => exportData("s2p", fmt)}>{t("Save .s2p")}</button>
          <button disabled={!has} onClick={() => exportData("csv")}>{t("Save .csv")}</button>
        </div>
        <div className="row">
          <label>{t("File name prefix")}</label>
          <input type="text" value={s.autoSaveName} onChange={(e) => set({ autoSaveName: e.target.value })} aria-label={t("File name prefix")} />
        </div>
        <p className="hint">{t("Exported data is calibrated if a calibration is applied. The LiteVNA measures one direction, so .s2p has S12 = S21 and S22 = 0.")}</p>
      </Section>
      <Section title="Import">
        <label>
          <input type="file" accept=".s1p,.s2p,.S1P,.S2P,.txt" multiple style={{ display: "none" }}
            onChange={(e) => { for (const f of Array.from(e.target.files ?? [])) void importTouchstoneFile(f); e.target.value = ""; }} />
          <span style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "5px 10px", cursor: "pointer", color: "var(--fg)", fontSize: 14, display: "inline-block" }}>{t("Open .s1p / .s2p…")}</span>
        </label>
        <p className="hint">{t("Imported files are shown as reference traces (Display tab). RI, MA and DB formats, any frequency unit and reference impedance.")}</p>
      </Section>
      <Section title="Session">
        <div className="row">
          <button onClick={() => saveSessionFile()}>{t("Save session")}</button>
          <label>
            <input type="file" accept=".json,application/json" style={{ display: "none" }} onChange={(e) => { const f = e.target.files?.[0]; if (f) void openSessionFile(f); e.target.value = ""; }} />
            <span style={{ border: "1px solid var(--line)", borderRadius: 6, padding: "5px 10px", cursor: "pointer", color: "var(--fg)", fontSize: 14, display: "inline-block" }}>{t("Open session…")}</span>
          </label>
          <button disabled={!has || !canShare()} onClick={() => void copyShareLink()}>{t("Copy share link")}</button>
        </div>
        <p className="hint">{t("A session file holds settings, calibration, fixture, memories, references and the current sweep, so it can be opened without a device. A share link carries only the corrected sweep and display settings.")}</p>
      </Section>
      <Section title="Auto-save">
        <Check checked={s.autoSave} onChange={async (v) => { if (v && !(await chooseAutoSaveDir())) return; set({ autoSave: v }); }}>{t("Save every sweep as Touchstone")}</Check>
        <p className="hint">{t("Chrome/Edge write into the folder you choose; other browsers download each file.")}</p>
      </Section>
      <Section title="Settings">
        <div className="row">
          <label>{t("Language")}</label>
          <LangSelect />
        </div>
        <button className="danger" onClick={() => resetSettings()}>{t("Reset all settings")}</button>
        <p className="hint">{t("Settings and saved calibrations are kept in this browser.")}</p>
        <p className="hint">{t("WebVNA v{0}", __APP_VERSION__)}</p>
      </Section>
    </div>
  );
}
