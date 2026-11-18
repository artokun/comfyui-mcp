import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  clearPanelVersionPin,
  describePanelPin,
  getAgentSettings,
  getNsfwConsent,
  getPanelPinState,
  normalizePreferredModels,
  PANEL_PIN_ENV_VAR,
  setAgentSettings,
  setNsfwConsent,
  setPanelVersionPin,
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

  it("persists the ollama context window alongside the endpoint", () => {
    setAgentSettings({ ollama: { baseUrl: "http://192.168.1.113:11434" } });
    setAgentSettings({ ollama: { numCtx: "max" } });
    expect(getAgentSettings().ollama).toEqual({ baseUrl: "http://192.168.1.113:11434", numCtx: "max" });
    setAgentSettings({ ollama: { numCtx: 32768 } });
    expect(getAgentSettings().ollama?.numCtx).toBe(32768);
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

describe("panel version pin", () => {
  afterEach(() => {
    delete process.env[PANEL_PIN_ENV_VAR];
  });

  it("defaults to unpinned and reading does not create the file", () => {
    expect(getPanelPinState({})).toEqual({ pinned: false, source: "none" });
    expect(existsSync(settingsPath)).toBe(false);
  });

  it("persists a pin with a timestamp and reason, and survives a reload", () => {
    const pin = setPanelVersionPin(" 0.11.20 ", "  waiting on a node-pack fix  ");
    expect(pin.version).toBe("0.11.20");
    expect(typeof pin.pinnedAt).toBe("string");
    expect(pin.reason).toBe("waiting on a node-pack fix");

    expect(getPanelPinState({})).toMatchObject({
      pinned: true,
      version: "0.11.20",
      source: "settings",
      reason: "waiting on a node-pack fix",
    });
  });

  it("clearing returns the removed pin and leaves the state unpinned", () => {
    setPanelVersionPin("0.11.20");
    expect(clearPanelVersionPin()?.version).toBe("0.11.20");
    expect(getPanelPinState({})).toEqual({ pinned: false, source: "none" });
    // Second clear is a no-op, not an error.
    expect(clearPanelVersionPin()).toBeUndefined();
  });

  it("clearing the pin leaves the rest of the settings intact", () => {
    setNsfwConsent(true);
    setPanelVersionPin("0.11.20");
    clearPanelVersionPin();
    expect(getNsfwConsent().allowed).toBe(true);
  });

  it("an env pin wins over the persisted one (env > .env > json)", () => {
    setPanelVersionPin("0.11.20");
    expect(getPanelPinState({ [PANEL_PIN_ENV_VAR]: "0.9.9" })).toMatchObject({
      pinned: true,
      version: "0.9.9",
      source: "env",
    });
  });

  it.each(["   ", "\t", " \n "])(
    "a WHITESPACE-ONLY env value (%j) reads as PINNED-indeterminate, never unpinned",
    (value) => {
      // The trap: trimming first made a SET variable look absent, so it fell
      // through to the JSON store and resolved unpinned — the same
      // present-but-unreadable fail-open as a corrupt settings file.
      expect(getPanelPinState({ [PANEL_PIN_ENV_VAR]: value })).toMatchObject({
        pinned: true,
        source: "env",
        indeterminate: true,
      });
    },
  );

  it.each(["not-a-version", "0.11", "??"])(
    "a non-empty env value (%j) pins as given — the pin is a label, not a parsed version",
    (value) => {
      // Deliberate: pins are only ever compared for equality and shown to the
      // user, never parsed. What matters is that a set value never resolves
      // UNPINNED, whatever it says.
      expect(getPanelPinState({ [PANEL_PIN_ENV_VAR]: value })).toMatchObject({
        pinned: true,
        source: "env",
        version: value,
      });
    },
  );

  it("a whitespace-padded env pin still resolves to the trimmed version", () => {
    expect(getPanelPinState({ [PANEL_PIN_ENV_VAR]: "  0.11.20  " })).toMatchObject({
      pinned: true,
      version: "0.11.20",
      source: "env",
    });
  });

  it("an EMPTY env value means unset, the ordinary meaning of FOO=", () => {
    expect(getPanelPinState({ [PANEL_PIN_ENV_VAR]: "" })).toEqual({
      pinned: false,
      source: "none",
    });
  });

  it("an env 'off' explicitly overrides a persisted pin", () => {
    setPanelVersionPin("0.11.20");
    for (const off of ["off", "none", "0", "false", "UNPINNED"]) {
      expect(getPanelPinState({ [PANEL_PIN_ENV_VAR]: off })).toEqual({
        pinned: false,
        source: "none",
      });
    }
  });

  it("a junk persisted pin reads as PINNED-indeterminate, never as unpinned", () => {
    // A pin key we cannot make sense of is not proof the user did not pin.
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ panelPin: { version: "   " } }));
    expect(getPanelPinState({})).toMatchObject({ pinned: true, indeterminate: true });
  });

  it("an UNPARSEABLE settings file reads as PINNED-indeterminate", () => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, "{ not json");
    expect(getPanelPinState({})).toMatchObject({
      pinned: true,
      indeterminate: true,
      source: "settings",
    });
  });

  it("a ZERO-BYTE settings file (a torn write) reads as empty, not indeterminate (#798)", () => {
    // Zero bytes provably contain no pin; treating the torn write as
    // unreadable would hold the panel pinned-indeterminate forever over a file
    // that records nothing.
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, "");
    expect(getPanelPinState({})).toMatchObject({ pinned: false });
    // And a new write lands cleanly on top of it.
    setPanelVersionPin("0.11.20");
    expect(getPanelPinState({})).toMatchObject({ pinned: true, version: "0.11.20" });
  });

  it.each(["[]", '["a"]', "null", '"x"', "42"])(
    "valid JSON that isn't a plain object (%s) reads as PINNED-indeterminate",
    (body) => {
      // `[]` is the trap: typeof [] === "object", so a naive check accepts it,
      // reports "no pin" on a file we never understood, AND silently drops any
      // pin written to it (an array expando does not survive JSON.stringify).
      mkdirSync(dirname(settingsPath), { recursive: true });
      writeFileSync(settingsPath, body);
      expect(getPanelPinState({})).toMatchObject({ pinned: true, indeterminate: true });
    },
  );

  it.each([
    ["null", null],
    ["false", false],
    ["zero", 0],
    ["a bare string", "0.11.3"],
    ["an array", ["0.11.3"]],
  ])("a PRESENT but malformed panelPin (%s) reads as pinned, not unpinned", (_label, value) => {
    // Only an ABSENT key means unpinned. A present key we failed to understand
    // is somebody's hand-edit — reading it as "no pin" moves a user who
    // believed they were protected.
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ panelPin: value }));
    expect(getPanelPinState({})).toMatchObject({ pinned: true, indeterminate: true });
  });

  it.each([
    ["a null version", { version: null }],
    ["a blank version", { version: "   " }],
    ["a numeric version", { version: 11 }],
    ["no version at all", { reason: "oops" }],
  ])("clearing an object-shaped malformed pin (%s) reports it as unreadable", (_l, value) => {
    // getPanelPinState calls these indeterminate; unpin must not then report
    // "was null" / "was " — two parts of the system describing one pin differently.
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ panelPin: value }));
    expect(getPanelPinState({})).toMatchObject({ pinned: true, indeterminate: true });
    expect(clearPanelVersionPin()?.version).toBe("(unreadable)");
    expect(getPanelPinState({})).toEqual({ pinned: false, source: "none" });
  });

  it("clearing removes a malformed FALSY pin instead of leaving the user stuck", () => {
    // `!previous` would have skipped the delete, leaving an indeterminate pin
    // in place forever while reporting "no pin was set".
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify({ panelPin: null }));
    expect(getPanelPinState({}).pinned).toBe(true);
    const removed = clearPanelVersionPin();
    expect(removed?.version).toBe("(unreadable)");
    expect(getPanelPinState({})).toEqual({ pinned: false, source: "none" });
  });

  it("refuses to pin into a JSON-array settings file rather than silently dropping it", () => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, "[]");
    expect(() => setPanelVersionPin("0.11.20")).toThrow(/could not be parsed/i);
    // Never leaves the caller believing they are pinned when they are not.
    expect(getPanelPinState({}).version).toBeUndefined();
    expect(readFileSync(settingsPath, "utf-8")).toBe("[]");
  });

  it("only reports a pin after re-reading it back from disk", () => {
    // The contract set/clear verify: a returned pin has been OBSERVED on disk,
    // so "pinned" is never claimed from a write we didn't confirm.
    const pin = setPanelVersionPin("0.11.20");
    const onDisk = JSON.parse(readFileSync(settingsPath, "utf-8"));
    expect(onDisk.panelPin.version).toBe(pin.version);

    clearPanelVersionPin();
    expect(JSON.parse(readFileSync(settingsPath, "utf-8")).panelPin).toBeUndefined();
  });

  it("refuses to rewrite an unparseable settings file rather than clobber it", () => {
    mkdirSync(dirname(settingsPath), { recursive: true });
    writeFileSync(settingsPath, "{ not json");
    expect(() => setPanelVersionPin("0.11.20")).toThrow(/could not be parsed/i);
    expect(() => clearPanelVersionPin()).toThrow(/could not be parsed/i);
    // The user's file is untouched, so nothing was silently lost.
    expect(readFileSync(settingsPath, "utf-8")).toBe("{ not json");
  });

  it("rejects a blank pin version instead of storing a meaningless pin", () => {
    expect(() => setPanelVersionPin("   ")).toThrow(/non-empty version/i);
    expect(getPanelPinState({})).toEqual({ pinned: false, source: "none" });
  });

  it("describePanelPin names the source so the user knows how to clear it", () => {
    expect(describePanelPin({ pinned: false, source: "none" })).toBe("not pinned");
    expect(describePanelPin({ pinned: true, version: "0.11.20", source: "env" })).toContain(
      PANEL_PIN_ENV_VAR,
    );
    expect(
      describePanelPin({ pinned: true, version: "0.11.20", source: "settings" }),
    ).toContain("0.11.20");
  });
});
