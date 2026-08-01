import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getAgentSettings,
  getNsfwConsent,
  normalizePreferredModels,
  setAgentSettings,
  setNsfwConsent,
} from "../../services/panel-settings.js";

let dir: string;
let settingsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmcp-settings-"));
  // Point at a nested path that doesn't exist yet, to exercise mkdir.
  settingsPath = join(dir, "nested", "panel-settings.json");
  process.env.COMFYUI_MCP_PANEL_SETTINGS = settingsPath;
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_PANEL_SETTINGS;
  rmSync(dir, { recursive: true, force: true });
});

describe("panel-settings nsfw consent", () => {
  it("defaults to OFF when never set", () => {
    expect(getNsfwConsent()).toEqual({ allowed: false });
    expect(existsSync(settingsPath)).toBe(false); // reading doesn't create the file
  });

  it("persists an opt-in with a timestamp and creates the dir", () => {
    const state = setNsfwConsent(true);
    expect(state.allowed).toBe(true);
    expect(typeof state.decidedAt).toBe("string");
    expect(existsSync(settingsPath)).toBe(true);
    // Survives a fresh read (i.e. a reload).
    expect(getNsfwConsent().allowed).toBe(true);
  });

  it("revokes back to OFF", () => {
    setNsfwConsent(true);
    expect(getNsfwConsent().allowed).toBe(true);
    setNsfwConsent(false);
    expect(getNsfwConsent().allowed).toBe(false);
  });

  function writeRawSettings(json: string): void {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, json);
  }

  it("FAILS CLOSED on a non-boolean on-disk allowed (tampered/legacy file) — #390", () => {
    // read() casts arbitrary JSON, so a truthy STRING or number could otherwise
    // sneak past `if (!allowed)` and enable adult content. Only strict `true` counts.
    for (const bad of ['"false"', '"true"', "1", "0", '"yes"', "null", "{}"]) {
      writeRawSettings(`{"nsfwConsent":{"allowed":${bad},"decidedAt":"2020-01-01T00:00:00.000Z"}}`);
      expect(getNsfwConsent().allowed, `allowed:${bad} must NOT be consent`).toBe(false);
    }
  });

  it("accepts a strict boolean true from disk as consent — #390", () => {
    writeRawSettings(`{"nsfwConsent":{"allowed":true,"decidedAt":"2020-01-01T00:00:00.000Z"}}`);
    expect(getNsfwConsent().allowed).toBe(true);
    expect(getNsfwConsent().decidedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("preserves unrelated settings keys", () => {
    setNsfwConsent(true); // creates the file (with mkdir) holding nsfwConsent
    const raw = JSON.parse(readFileSync(settingsPath, "utf-8"));
    raw.someOtherSetting = 42;
    writeFileSync(settingsPath, JSON.stringify(raw));
    setNsfwConsent(false);
    const after = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(after.someOtherSetting).toBe(42);
    expect(after.nsfwConsent.allowed).toBe(false);
  });
});

describe("panel-settings agent model preferences", () => {
  it("defaults to {} when never set", () => {
    expect(getAgentSettings()).toEqual({});
  });

  it("persists preferred models, deduped and trimmed", () => {
    setAgentSettings({ preferredModels: [" gemma4:12b ", "xiaomi/mimo-v2.5", "gemma4:12b", ""] });
    expect(getAgentSettings().preferredModels).toEqual(["gemma4:12b", "xiaomi/mimo-v2.5"]);
  });

  it("replaces the whole preferred list on update", () => {
    setAgentSettings({ preferredModels: ["a:1", "b:2"] });
    setAgentSettings({ preferredModels: ["c:3"] });
    expect(getAgentSettings().preferredModels).toEqual(["c:3"]);
  });

  it("merges ollama config per-key", () => {
    setAgentSettings({ ollama: { api: "openai", baseUrl: "https://openrouter.ai/api/v1" } });
    setAgentSettings({ ollama: { model: "xiaomi/mimo-v2.5" } });
    expect(getAgentSettings().ollama).toEqual({
      api: "openai",
      baseUrl: "https://openrouter.ai/api/v1",
      model: "xiaomi/mimo-v2.5",
    });
  });

  it("leaves ollama config untouched when only preferred models change", () => {
    setAgentSettings({ ollama: { model: "gemma4:e4b" } });
    setAgentSettings({ preferredModels: ["x/y"] });
    expect(getAgentSettings().ollama).toEqual({ model: "gemma4:e4b" });
  });

  it("coexists with nsfw consent in the same file", () => {
    setNsfwConsent(true);
    setAgentSettings({ preferredModels: ["m:1"] });
    expect(getNsfwConsent().allowed).toBe(true);
    expect(getAgentSettings().preferredModels).toEqual(["m:1"]);
  });
});

describe("normalizePreferredModels (#393 loop guard)", () => {
  it("trims, drops blanks, dedupes, and caps at 50 — the same shape setAgentSettings persists", () => {
    expect(normalizePreferredModels([" a ", "a", "", "  ", "b"])).toEqual(["a", "b"]);
    expect(normalizePreferredModels(Array.from({ length: 60 }, (_, i) => `m${i}`)).length).toBe(50);
  });

  it("is idempotent, so a re-sent normalized list compares EQUAL (no heartbeat re-push)", () => {
    const once = normalizePreferredModels([" x ", "x", "y"]);
    expect(normalizePreferredModels(once)).toEqual(once);
    // What the set_config guard actually compares: raw payload normalized vs the
    // persisted (already-normalized) list must be equal when nothing changed.
    setAgentSettings({ preferredModels: [" x ", "x", "y"] });
    expect(getAgentSettings().preferredModels).toEqual(normalizePreferredModels([" x ", "x", "y"]));
  });
});
