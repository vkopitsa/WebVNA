import { useStore, get } from "./store";
import { UK } from "./i18n/uk";
import { DE } from "./i18n/de";
import { PL } from "./i18n/pl";
import { ES } from "./i18n/es";

export type Lang = "en" | "uk" | "de" | "pl" | "es";
export const LANGS: [Lang, string][] = [["en", "English"], ["uk", "Українська"], ["de", "Deutsch"], ["pl", "Polski"], ["es", "Español"]];

/** English source string → translation, per language. English is the key itself. */
export const DICTS: Record<Lang, Record<string, string>> = { en: {}, uk: UK, de: DE, pl: PL, es: ES };

export { UK };

export function translate(lang: Lang, s: string, ...args: (string | number)[]): string {
  let out = DICTS[lang]?.[s] ?? s;
  args.forEach((a, i) => { out = out.split(`{${i}}`).join(String(a)); });
  return out;
}

/** React hook: re-renders on language change. */
export function useT() {
  const lang = useStore((s) => s.lang);
  return (s: string, ...a: (string | number)[]) => translate(lang, s, ...a);
}

/** Non-React code (controller logs, canvas drawing): current language. */
export const tr = (s: string, ...a: (string | number)[]) => translate(get().lang, s, ...a);
