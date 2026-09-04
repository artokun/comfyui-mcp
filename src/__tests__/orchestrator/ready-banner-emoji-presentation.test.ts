// panel#2023 — a Chromium DirectWrite null-deref crashes the Comfy Desktop renderer
// during text layout. comfyui-mcp-panel#2210 established the mitigation on the panel
// side: U+FE0F (VARIATION SELECTOR-16) does not merely PERMIT emoji presentation, it
// REQUESTS it, pinning the glyph to `seguiemj.ttf` — the file KB5120998 replaced two
// days before the crash cluster. #2210 stripped the selector from nine panel strings
// and deliberately KEPT the glyph, because dropping a warning sign is a worse change.
//
// The orchestrator's ready banner reaches the same canvas, as an agent bubble:
//
//   src/orchestrator/index.ts   bridge.push({ type: "say", text: readyBannerText(...) }, panelTab)
//
// so it renders through the same font stack and the same fallback. `banner.ready.copilot`
// carried the identical `⚠️` sequence in the source fallback and in all twelve catalogs,
// which is why a panel-only sweep left it in place.
//
// Both halves are pinned here. Asserting only "no U+FE0F" would be satisfied by deleting
// the warning sign outright — the change #2210 explicitly rejected — so the glyph's
// survival is asserted too.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const VS16 = /\uFE0F/gu;
const WARNING_SIGN = /\u26A0/gu;
const LOCALES_DIR = join(process.cwd(), "locales");
const READY_BANNER = join(process.cwd(), "src", "orchestrator", "ready-banner.ts");

const count = (haystack: string, re: RegExp) => (haystack.match(re) ?? []).length;

describe("ready banner does not REQUEST the emoji font (panel#2023 / panel#2210 parity)", () => {
  it("carries no U+FE0F in the ready-banner source", () => {
    expect(count(readFileSync(READY_BANNER, "utf8"), VS16)).toBe(0);
  });

  it("still carries the warning sign itself — the selector goes, the glyph stays", () => {
    // Guards the wrong fix: stripping U+26A0 too would silently pass the assertion above.
    expect(count(readFileSync(READY_BANNER, "utf8"), WARNING_SIGN)).toBeGreaterThan(0);
  });

  const locales = readdirSync(LOCALES_DIR);

  it("finds the catalogs it means to check", () => {
    // A directory read that silently returned [] would make every case below vacuous.
    expect(locales.length).toBeGreaterThanOrEqual(12);
    expect(locales).toContain("en");
  });

  it.each(locales)("catalog %s carries no U+FE0F", (locale) => {
    const raw = readFileSync(join(LOCALES_DIR, locale, "main.json"), "utf8");
    expect(count(raw, VS16)).toBe(0);
  });

  it("keeps the warning glyph in the English catalog", () => {
    const raw = readFileSync(join(LOCALES_DIR, "en", "main.json"), "utf8");
    expect(count(raw, WARNING_SIGN)).toBeGreaterThan(0);
  });
});
