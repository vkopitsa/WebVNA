import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { extractSection } from "./changelog-section.mjs";

const DOC = `# Changelog

## [Unreleased]

## [0.3.0] - 2026-10-08

### Added

- Thing A

## [0.2.0]

- Old

[Unreleased]: https://example.com/a
[0.2.0]: https://example.com/b
`;

describe("changelog-section", () => {
  it("extracts one version without the heading or the next section", () => {
    expect(extractSection(DOC, "0.3.0")).toBe("### Added\n\n- Thing A");
  });
  it("stops at the link references for the last section", () => {
    expect(extractSection(DOC, "0.2.0")).toBe("- Old");
  });
  it("returns an empty body for an empty section and null for a missing one", () => {
    expect(extractSection(DOC, "Unreleased")).toBe("");
    expect(extractSection(DOC, "9.9.9")).toBeNull();
    expect(extractSection(DOC, "0.3")).toBeNull();
  });
  it("CLI prints the section of the real CHANGELOG for the package version", () => {
    const out = execFileSync(process.execPath, ["scripts/changelog-section.mjs", "0.3.0"], { encoding: "utf8" });
    expect(out.trim().length).toBeGreaterThan(20);
  });
});
