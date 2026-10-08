import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { translate, DICTS, UK, type Lang } from "./i18n";

const placeholders = (s: string) => (s.match(/\{\d+\}/g) ?? []).sort().join(",");

describe("translate", () => {
  it("passes English through unchanged", () => {
    expect(translate("en", "Sweep")).toBe("Sweep");
    expect(translate("en", "Step {0}. Range {1}", "1 kHz", "10 MHz")).toBe("Step 1 kHz. Range 10 MHz");
  });

  it("looks up Ukrainian", () => {
    expect(translate("uk", "Sweep")).toBe("Розгортка");
    expect(translate("uk", "RESISTANCE")).toBe("ОПІР");
  });

  it("substitutes placeholders", () => {
    expect(translate("uk", "Marker {0}", 3)).toBe("Маркер 3");
    expect(translate("uk", "Connected via {0}: {1}, hw rev {2}, firmware {3}.{4}", "USB", "LiteVNA", "1", 2, 5))
      .toBe("Підключено через USB: LiteVNA, апаратна ревізія 1, прошивка 2.5");
  });

  it("falls back to English for missing keys", () => {
    expect(translate("uk", "Not a real key {0}", 7)).toBe("Not a real key 7");
  });
});

const LANG_CODES = (Object.keys(DICTS) as Lang[]).filter((l) => l !== "en");

describe.each(LANG_CODES)("dictionary %s", (lang) => {
  const dict = DICTS[lang];
  it("keeps the same placeholders as the key", () => {
    for (const [k, v] of Object.entries(dict)) expect(placeholders(v), k).toBe(placeholders(k));
  });
  it("has no keys missing from UK", () => {
    expect(Object.keys(dict).filter((k) => !(k in UK))).toEqual([]);
  });
});

// Coverage: enabled only for dictionaries that have been started (non-empty).
describe.each(LANG_CODES.filter((l) => l !== "uk" && Object.keys(DICTS[l]).length > 0))("coverage %s", (lang) => {
  it("translates every UK key", () => {
    expect(Object.keys(UK).filter((k) => !(k in DICTS[lang]))).toEqual([]);
  });
});

function sources(dir: string, out: string[] = []): string[] {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (statSync(p).isDirectory()) {
      if (f !== "lib" && f !== "i18n") sources(p, out);
    } else if (/\.tsx?$/.test(f) && !/\.test\.tsx?$/.test(f) && f !== "i18n.ts") out.push(p);
  }
  return out;
}

describe("UK covers the code", () => {
  it("has every literal passed to t()/tr()", () => {
    const re = /(?<![\w.$])tr?\(\s*(?:"((?:[^"\\\n]|\\.)*)"|'((?:[^'\\\n]|\\.)*)')/g;
    const missing: string[] = [];
    for (const f of sources(join(__dirname))) {
      for (const m of readFileSync(f, "utf8").matchAll(re)) {
        const lit = m[1] ?? m[2];
        const key = JSON.parse(`"${m[1] !== undefined ? lit : lit.replace(/\\'/g, "'").replace(/"/g, '\\"')}"`) as string;
        if (!(key in UK)) missing.push(`${f.slice(__dirname.length + 1)}: ${key}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
