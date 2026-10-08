# Translating WebVNA

English is the source language and the default. Each language has its own file under `src/i18n/`: `uk.ts` (Ukrainian, the reference with the full key list), and `de.ts`, `pl.ts`, `es.ts` (German, Polish, Spanish). `src/i18n.ts` holds `Lang`, `LANGS`, `DICTS` and `translate()`.

## Fill in a language

Each file exports a `Record<string, string>`. The key is the **exact English source string**, the value is the translation:

```ts
export const DE: Record<string, string> = {
  "Connect": "Verbinden",
  "fw {0}.{1}": "FW {0}.{1}",
};
```

Get the full key list with `node scripts/i18n-keys.mjs` (JSON array of every key in `uk.ts`).

## Add a new language

1. Create `src/i18n/xx.ts` exporting `XX` (start from `de.ts`).
2. In `src/i18n.ts`: extend the `Lang` union, add `[code, native name]` to `LANGS` and the dictionary to `DICTS`. The language selector and settings validation read `LANGS`.
3. Run `npm test`. `src/i18n.test.ts` checks, for every language, that placeholders match and that no key is absent from `UK`. Once a dictionary is non-empty, a coverage test requires every `UK` key to be present. A test also scans the code for `t("...")` / `tr("...")` literals and fails if `UK` lacks one, so new English strings must be added to `uk.ts` first.

## Rules

- **Placeholders** `{0}`, `{1}` must appear in the translation exactly as in the key (same set; order may change). The test fails otherwise.
- Keep units, symbols and numbers as they are (`MHz`, `dB`, `Ω`).
- A missing key falls back to English at runtime, but the coverage test fails for a started dictionary, so translate every key.
- Keys must match the English text character for character, including punctuation and `…`. If you change an English string in the code, change its key in every dictionary file.
- Strings go through `t()` / `useT()` in components and `tr()` in non-React code (canvas). Trace format labels from `FORMAT_BY_ID[..].label` are translated at display time.
- `src/lib/` is deliberately untranslated (no i18n there). Known English-only strings: the TDR legend, the calibration summary and the L/C match topology text.
- Canvas drawing hooks must include `lang` in their dependencies.

## PR checklist

- [ ] Dictionary file registered in `Lang`, `LANGS` and `DICTS`; language selector shows the new entry
- [ ] Placeholders match; `npm test` passes
- [ ] `npm run typecheck` and `npm run lint` pass
- [ ] Checked a few screens in the browser (long words can overflow narrow buttons, especially on mobile)
- [ ] Listed in the PR any strings left untranslated
