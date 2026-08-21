/**
 * The orchestrator's translation runtime.
 *
 * The behaviour worth guarding is what happens when translation CANNOT work — this text is
 * printed during startup and while reporting other failures, so it must never be able to add
 * a failure of its own.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { tr, trFor, resolveLocale, processLocale, LOCALES, __resetI18nForTest } from "../../i18n/index.js";

afterEach(() => __resetI18nForTest());

describe("fallbacks", () => {
  it("renders the English fallback when a key is missing, never the key", () => {
    expect(trFor("ko", "cli.nope", "Usage: comfyui-mcp")).toBe("Usage: comfyui-mcp");
    expect(trFor("ko", "cli.nope", "Save")).not.toContain("cli.");
  });

  it("interpolates {vars} in the fallback as well as the translation", () => {
    expect(trFor("en", "cli.x", "port {port} is busy", { port: 9180 })).toBe("port 9180 is busy");
  });

  it("an unshipped or malformed locale still renders English rather than throwing", () => {
    expect(() => trFor("kl-GL", "cli.x", "hello")).not.toThrow();
    expect(trFor("kl-GL", "cli.x", "hello")).toBe("hello");
  });
});

describe("locale resolution", () => {
  it("strips the encoding suffix POSIX env vars carry", () => {
    // LANG is "ko_KR.UTF-8" in the wild — underscore separator and an encoding suffix, both
    // of which make a naive lookup miss and silently fall back to English.
    expect(resolveLocale("ko_KR.UTF-8")).toBe("ko");
    expect(resolveLocale("pt_BR.utf8")).toBe("pt-BR");
    expect(resolveLocale("zh_TW")).toBe("zh-TW");
  });

  it("falls back to a shipped regional variant when the base language is not shipped alone", () => {
    expect(resolveLocale("pt-PT")).toBe("pt-BR");
    expect(resolveLocale("zh-HK")).toBe("zh-TW");
  });

  it("refuses a language we do not ship rather than guessing", () => {
    expect(resolveLocale("kl")).toBeNull();
    expect(resolveLocale("")).toBeNull();
    expect(resolveLocale(null)).toBeNull();
  });

  it("--lang beats the environment, and explicit env beats the POSIX chain", () => {
    const prev = { ...process.env };
    try {
      // Own the WHOLE chain, not just the link under test. The suite now pins
      // COMFYUI_MCP_LANG=en (see helpers/isolated-test-home.ts), and this case asserts that
      // LANG is consulted — which is only observable when the higher-precedence variables are
      // absent. Leaving them to the ambient environment made the test assert "en beats fr" on
      // a pinned machine and "ja beats fr" for anyone with LANG=ja_JP, i.e. it measured the
      // developer rather than the code.
      for (const k of ["COMFYUI_MCP_LANG", "LC_ALL", "LC_MESSAGES"]) delete process.env[k];
      process.env.LANG = "fr_FR.UTF-8";
      expect(processLocale(["node", "cli", "--lang", "ko"])).toBe("ko");
      expect(processLocale(["node", "cli", "--lang=ja"])).toBe("ja");
      expect(processLocale(["node", "cli"])).toBe("fr");
      process.env.COMFYUI_MCP_LANG = "es";
      expect(processLocale(["node", "cli"])).toBe("es");
    } finally {
      process.env = prev;
    }
  });

  it("defaults to English when nothing is set", () => {
    const prev = { ...process.env };
    try {
      for (const k of ["COMFYUI_MCP_LANG", "LC_ALL", "LC_MESSAGES", "LANG"]) delete process.env[k];
      expect(processLocale(["node", "cli"])).toBe("en");
    } finally {
      process.env = prev;
    }
  });
});

describe("plurals", () => {
  it("uses the categories the language actually has", () => {
    const forms = { one: "{count} model", other: "{count} models" };
    expect(trFor("en", "cli.n", forms, { count: 1 })).toBe("1 model");
    expect(trFor("en", "cli.n", forms, { count: 4 })).toBe("4 models");
    // Korean has a single form; an English-shaped one/other split would be wrong.
    expect(trFor("ko", "cli.n", forms, { count: 1 })).toBe("1 model");
  });
});

describe("the terminal vs the panel are separate audiences", () => {
  it("trFor renders a given panel's language regardless of the process locale", () => {
    // A `say` frame names panel controls ("Settings → OpenRouter"), so it must match the
    // language of the panel it lands in — not the language of whoever started the server.
    const prev = process.env.COMFYUI_MCP_LANG;
    try {
      process.env.COMFYUI_MCP_LANG = "en";
      expect(tr("cli.x", "Ready")).toBe("Ready");
      expect(trFor("ko", "cli.x", "Ready")).toBe("Ready"); // no catalog yet -> English
      expect(() => trFor("ko", "cli.x", "Ready")).not.toThrow();
    } finally {
      if (prev === undefined) delete process.env.COMFYUI_MCP_LANG;
      else process.env.COMFYUI_MCP_LANG = prev;
    }
  });
});

describe("packaging", () => {
  it("ships locales/ in the npm tarball", () => {
    // Without this the whole feature works perfectly on a dev machine and ships DEAD to every
    // npm user: the catalogs simply are not in the package, so `trFor` finds no file and
    // every language silently renders English. Nothing else would catch it.
    const pkg = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    expect(pkg.files).toContain("locales");
  });

  it("offers exactly the languages ComfyUI ships, so the panel list cannot disagree", () => {
    expect([...LOCALES].sort()).toEqual(
      ["ar", "en", "es", "fa", "fr", "ja", "ko", "pt-BR", "ru", "tr", "zh", "zh-TW"].sort(),
    );
  });
});
