#!/usr/bin/env node
// Print the CHANGELOG.md section of one version: `node scripts/changelog-section.mjs 0.3.0 [CHANGELOG.md]`.
// The section runs from its "## [x.y.z]" heading to the next "## " heading (or the link references at the end).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Body of `## [version]` in a Keep a Changelog document, without the heading; null if absent. */
export function extractSection(text, version) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const esc = version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const head = new RegExp(`^##\\s+\\[?v?${esc}\\]?(\\s|$)`);
  const start = lines.findIndex((l) => head.test(l));
  if (start < 0) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^## /.test(lines[i]) || /^\[[^\]]+\]:\s+\S+/.test(lines[i])) { end = i; break; }
  }
  return lines.slice(start + 1, end).join("\n").trim();
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [version, file = "CHANGELOG.md"] = process.argv.slice(2);
  if (!version) { console.error("usage: changelog-section.mjs <version> [CHANGELOG.md]"); process.exit(2); }
  const body = extractSection(readFileSync(file, "utf8"), version.replace(/^v/, ""));
  if (!body) { console.error(`No section for ${version} in ${file}`); process.exit(1); }
  console.log(body);
}
