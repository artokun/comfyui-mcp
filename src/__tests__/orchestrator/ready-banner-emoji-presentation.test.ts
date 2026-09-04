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
// carried the identical warning-sign-plus-selector sequence in the source fallback and in
// all twelve catalogs, which is why a panel-only sweep left it in place.
//
// SCOPING, and why it is not symmetric. The "no selector" assertions are `=== 0` over a
// whole file: sound, because any stray occurrence anywhere fails them. The "glyph stays"
// assertion is `> 0`, and a whole-file count of that CANNOT pin a regression — the first
// draft of this test counted U+26A0 across ready-banner.ts, and the file's own doc comment
// above contains one, so deleting the glyph from the Copilot fallback still passed 16/16.
// It only looked verified because the mutation I ran deleted the comment's glyph too.
// Positive assertions are therefore made against the RENDERED banner and the specific
// catalog key, never against a file-wide count.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { readyBannerText } from "../../orchestrator/ready-banner.js";

const VS16 = /\uFE0F/gu;
const WARNING_SIGN = /\u26A0/gu;
const LOCALES_DIR = join(process.cwd(), "locales");
const READY_BANNER = join(process.cwd(), "src", "orchestrator", "ready-banner.ts");

const count = (haystack: string, re: RegExp) => (haystack.match(re) ?? []).length;

const copilotFor = (locale: string) => readyBannerText("copilot", "some-model", "", locale);

const localeDirs = readdirSync(LOCALES_DIR);

const copilotString = (locale: string): string => {
  const raw = JSON.parse(readFileSync(join(LOCALES_DIR, locale, "main.json"), "utf8"));
  const v = raw?.banner?.ready?.copilot;
  if (typeof v !== "string") throw new Error(`banner.ready.copilot missing from ${locale}`);
  return v;
};

describe("ready banner does not REQUEST the emoji font (panel#2023 / panel#2210 parity)", () => {
  it("finds the catalogs it means to check", () => {
    // A directory read that silently returned [] would make every it.each below vacuous.
    expect(localeDirs.length).toBeGreaterThanOrEqual(12);
    expect(localeDirs).toContain("en");
  });

  it("carries no U+FE0F anywhere in the ready-banner source", () => {
    expect(count(readFileSync(READY_BANNER, "utf8"), VS16)).toBe(0);
  });

  it.each(localeDirs)("catalog %s carries no U+FE0F", (locale) => {
    expect(count(readFileSync(join(LOCALES_DIR, locale, "main.json"), "utf8"), VS16)).toBe(0);
  });

  // The positive half, scoped to the one string this change touched.
  it.each(localeDirs)("catalog %s keeps the warning sign in banner.ready.copilot", (locale) => {
    const s = copilotString(locale);
    expect(count(s, WARNING_SIGN)).toBeGreaterThan(0);
    expect(count(s, VS16)).toBe(0);
  });

  it("renders the Copilot banner with the glyph and without the selector", () => {
    // The rendered string is what actually reaches the canvas, so the assertion cannot be
    // rescued by an unrelated occurrence elsewhere in the file or the catalog.
    //
    // Measured, not assumed: "en" resolves to the SOURCE FALLBACK (English is the source
    // catalog) while every other locale resolves from its catalog file — `readyBannerText`
    // returns English here and Korean for "ko". So this case pins the fallback in
    // ready-banner.ts, the per-catalog cases above pin the twelve files, and the
    // all-backends case below pins the rendered output for the other eleven locales.
    const rendered = copilotFor("en");
    expect(count(rendered, WARNING_SIGN)).toBeGreaterThan(0);
    expect(count(rendered, VS16)).toBe(0);
  });

  it("renders no selector on any backend, in any locale", () => {
    const backends = ["copilot", "codex", "chatgpt", "gemini", "antigravity", "pi", "grok", "ollama", "lmstudio", "llamacpp", "custom"];
    for (const locale of localeDirs) {
      for (const backend of backends) {
        expect(count(readyBannerText(backend, "some-model", "https://example.invalid", locale), VS16)).toBe(0);
      }
    }
  });
});
