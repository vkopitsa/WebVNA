// Prints all translatable keys (the Ukrainian dictionary keys) as a JSON array: node scripts/i18n-keys.mjs
import { readFileSync } from "node:fs";
const src = readFileSync(new URL("../src/i18n/uk.ts", import.meta.url), "utf8");
const body = src.slice(src.indexOf("{", src.indexOf("export const UK")));
const dict = new Function(`return (${body.replace(/;\s*$/, "")});`)();
console.log(JSON.stringify(Object.keys(dict), null, 2));
