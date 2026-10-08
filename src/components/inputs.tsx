import { useEffect, useRef, useState, type ReactNode } from "react";
import { fmtHz, parseHz, parseSI, si } from "../lib/units";
import { useStore, set } from "../store";
import { useT, LANGS, type Lang } from "../i18n";

/** Frequency field accepting "435M", "1.2G", "500k", plain Hz. Commits on Enter/blur. */
export function FreqInput({ value, onChange, min, max, ariaLabel }: { value: number; onChange: (v: number) => void; min?: number; max?: number; ariaLabel?: string }) {
  const t = useT();
  const [text, setText] = useState(fmtHz(value));
  const [bad, setBad] = useState(false);
  const dirty = useRef(false); // true while the user is editing; cleared on blur so a rejected entry doesn't block outside updates
  useEffect(() => { if (dirty.current) return; setText(fmtHz(value)); setBad(false); }, [value]);
  const commit = () => {
    if (!dirty.current) return;
    const v = parseHz(text);
    if (v == null || (min != null && v < min) || (max != null && v > max)) { setBad(true); return; }
    setBad(false); dirty.current = false;
    setText(fmtHz(value)); // re-formatted from the committed value by the effect if it changes
    if (v !== value) onChange(v);
  };
  return (
    <input type="text" aria-label={ariaLabel && t(ariaLabel)} className={bad ? "bad" : ""} value={text}
      onChange={(e) => { dirty.current = true; setText(e.target.value); }} onBlur={() => { commit(); dirty.current = false; }} onKeyDown={(e) => e.key === "Enter" && commit()} />
  );
}

/** Number with optional SI prefix ("4.7n"). */
export function SIInput({ value, onChange, unit = "", ariaLabel, digits = 4 }: { value: number; onChange: (v: number) => void; unit?: string; ariaLabel?: string; digits?: number }) {
  const t = useT();
  const show = (v: number) => (unit ? si(v, unit, digits) : String(+v.toPrecision(digits + 2)));
  const [text, setText] = useState(show(value));
  const [bad, setBad] = useState(false);
  const dirty = useRef(false);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { if (dirty.current) return; setText(show(value)); setBad(false); }, [value, unit]);
  const commit = () => {
    if (!dirty.current) return;
    const v = parseSI(text);
    if (v == null || !isFinite(v)) { setBad(true); return; }
    setBad(false); dirty.current = false;
    setText(show(value));
    if (v !== value) onChange(v);
  };
  return (
    <input type="text" aria-label={ariaLabel && t(ariaLabel)} className={bad ? "bad" : ""} value={text}
      onChange={(e) => { dirty.current = true; setText(e.target.value); }} onBlur={() => { commit(); dirty.current = false; }} onKeyDown={(e) => e.key === "Enter" && commit()} />
  );
}

export function Num({ value, onChange, min, max, step, ariaLabel }: { value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; ariaLabel?: string }) {
  const t = useT();
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    let v = parseFloat(text);
    if (!isFinite(v)) { setText(String(value)); return; }
    if (min != null) v = Math.max(min, v);
    if (max != null) v = Math.min(max, v);
    setText(String(v));
    if (v !== value) onChange(v);
  };
  return <input type="number" aria-label={ariaLabel && t(ariaLabel)} value={text} min={min} max={max} step={step}
    onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />;
}

export function Select<T extends string | number>({ value, options, onChange, ariaLabel, className }: { value: T; options: (T | [T, string])[]; onChange: (v: T) => void; ariaLabel?: string; className?: string }) {
  const t = useT();
  const opts = options.map((o) => (Array.isArray(o) ? o : ([o, String(o)] as [T, string])));
  return (
    <select className={className} aria-label={ariaLabel && t(ariaLabel)} value={String(value)} onChange={(e) => {
      const hit = opts.find(([v]) => String(v) === e.target.value);
      if (hit) onChange(hit[0]);
    }}>
      {opts.map(([v, l]) => <option key={String(v)} value={String(v)}>{t(l)}</option>)}
    </select>
  );
}

export function Check({ checked, onChange, children }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode }) {
  return (
    <label style={{ display: "inline-flex", alignItems: "center", gap: 6, color: "var(--fg)", fontSize: 13 }}>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} /> {children}
    </label>
  );
}

export function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  const t = useT();
  return (
    <div className="section">
      <h3 style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>{t(title)}{right}</h3>
      {children}
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  const t = useT();
  return <div><label>{t(label)}</label>{children}</div>;
}

/** Interface language selector. */
export function LangSelect({ className }: { className?: string }) {
  const t = useT();
  const lang = useStore((s) => s.lang);
  return (
    <select className={className} aria-label={t("Language")} value={lang} onChange={(e) => set({ lang: e.target.value as Lang })}>
      {LANGS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
    </select>
  );
}
