// The console pages under a catalog that actually answers.
//
// No `locales/` catalogs ship in this repo, so with the real i18n module every page
// renders its English fallback — which means a suite that only fetches pages cannot
// tell a working translation path from one where `trFor` was deleted outright
// (measured: replacing `trFor(...)` with the bare fallback leaves the sibling suite
// fully green). So `trFor` is mocked here and each test installs the answer it needs:
// a marker to prove the catalog is consulted with the right locale and key, or a
// hostile string to prove no translation can break the document that carries it.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return { ...actual, getInstanceSlug: () => "test-instance" };
});

/** Installed per test; returning undefined defers to the real (fallback) behaviour. */
let translate: ((locale: string, key: string) => string | undefined) | null = null;

vi.mock("../../i18n/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../i18n/index.js")>();
  return {
    ...actual,
    trFor: (locale: string, key: string, fallback: unknown, vars?: unknown) => {
      const hit = translate?.(locale, key);
      return hit === undefined
        ? (actual.trFor as (...a: unknown[]) => string)(locale, key, fallback, vars)
        : hit;
    },
  };
});

import { startPanelConsoleHttpServer } from "../../orchestrator/panel-console-http.js";
import { DEFAULT_PANEL_BRIDGE_PORT, localBridgeUrl } from "../../services/bridge-ports.js";
import { resetLoraCatalog } from "../../services/lora-catalog.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panel-console-i18n-"));
  process.env.COMFYUI_MCP_LORA_CATALOG = join(dir, "lora-catalog.json");
  process.env.COMFYUI_MCP_LORA_PREVIEWS = join(dir, "previews");
  // Never let a test reach the developer's real ~/.comfyui-mcp/.env.
  process.env.COMFYUI_MCP_ENV_FILE = join(dir, ".env");
  process.env.COMFYUI_MCP_PANEL_SECRETS = join(dir, "panel-secrets.json");
  resetLoraCatalog();
});

afterEach(() => {
  translate = null;
  for (const k of [
    "COMFYUI_MCP_LORA_CATALOG",
    "COMFYUI_MCP_LORA_PREVIEWS",
    "COMFYUI_MCP_ENV_FILE",
    "COMFYUI_MCP_PANEL_SECRETS",
    "COMFYUI_MCP_LANG",
  ]) {
    delete process.env[k];
  }
  resetLoraCatalog();
  rmSync(dir, { recursive: true, force: true });
});

const serve = () =>
  startPanelConsoleHttpServer({
    port: 0,
    bridgePort: DEFAULT_PANEL_BRIDGE_PORT,
    comfyuiUrl: "http://127.0.0.1:9500",
    token: "tok-123",
  });

const get = async (srvUrl: string, path: string, lang?: string): Promise<string> => {
  const res = await fetch(`${srvUrl}${path}`, lang ? { headers: { "accept-language": lang } } : undefined);
  return await res.text();
};

/** Every inline script body in the document. */
const scriptsOf = (html: string) => [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);

describe("console pages with a catalog installed", () => {
  it("renders each page from the catalog, keyed by the negotiated locale", async () => {
    translate = (locale, key) => `«${locale}:${key}»`;
    const srv = await serve();
    try {
      const landing = await get(srv.url, "/console", "ja-JP");
      expect(landing).toContain("«ja:console.landing.title»");
      expect(landing).toContain("«ja:console.landing.subtitle»");
      expect(landing).toContain("«ja:console.landing.status.loading»");
      expect(landing).toContain(`<html lang="ja">`);

      const creds = await get(srv.url, "/credentials?token=tok-123", "ko");
      expect(creds).toContain("«ko:console.credentials.title»");
      expect(creds).toContain("«ko:console.credentials.privacy»");
      expect(creds).toContain(`<html lang="ko">`);

      const denied = await get(srv.url, "/credentials?token=wrong", "ru");
      expect(denied).toBe(`<p lang="ru">«ru:console.unauthorized»</p>`);
    } finally {
      await srv.stop();
    }
  });

  it("mirrors the document for Arabic and Persian only", async () => {
    translate = (locale, key) => `«${locale}:${key}»`;
    const srv = await serve();
    try {
      expect(await get(srv.url, "/console", "ar")).toContain(`<html lang="ar" dir="rtl">`);
      expect(await get(srv.url, "/credentials?token=tok-123", "fa-IR")).toContain(
        `<html lang="fa" dir="rtl">`,
      );
      const tr = await get(srv.url, "/console", "tr");
      expect(tr).toContain(`<html lang="tr">`);
      expect(tr).not.toContain(`dir="rtl"`);
    } finally {
      await srv.stop();
    }
  });

  it("ranks Accept-Language by q-value and honours a q=0 rejection", async () => {
    translate = (locale, key) => `«${locale}:${key}»`;
    const srv = await serve();
    try {
      // Order says English first; the weights say Japanese. The weights win.
      expect(await get(srv.url, "/console", "en;q=0.3,ja;q=0.9")).toContain(`<html lang="ja">`);
      // `q=0` REJECTS Arabic — taking it because it came first would hand an RTL page
      // to someone who explicitly asked for something else.
      expect(await get(srv.url, "/console", "ar;q=0,ja")).toContain(`<html lang="ja">`);
      // The parameter name is case-insensitive per RFC 9110.
      expect(await get(srv.url, "/console", "ar;Q=0,ja")).toContain(`<html lang="ja">`);
      // A malformed weight means "accept", not "reject" — proxies do emit these.
      expect(await get(srv.url, "/console", "ja;q=oops")).toContain(`<html lang="ja">`);
    } finally {
      await srv.stop();
    }
  });

  it("falls back to the process locale when the browser asks for nothing we ship", async () => {
    translate = (locale, key) => `«${locale}:${key}»`;
    process.env.COMFYUI_MCP_LANG = "tr";
    const srv = await serve();
    try {
      expect(await get(srv.url, "/console", "kl-GL")).toContain(`<html lang="tr">`);
    } finally {
      await srv.stop();
    }
  });

  // A catalog is DATA — a hostile or simply careless entry must not be able to close
  // the <script>, escape an attribute, or inject an element. Without the `<` escape in
  // scriptJson this fails on the credentials page (measured), and without escapeHtml
  // it fails on the landing page.
  it("cannot break out of the document, whatever the catalog says", async () => {
    const hostile = `</script><img src=x onerror="alert(1)">'"\\`;
    translate = () => hostile;
    const srv = await serve();
    try {
      for (const path of ["/console", "/credentials?token=tok-123"]) {
        const html = await get(srv.url, path);
        const scripts = scriptsOf(html);
        expect(scripts.length).toBeGreaterThan(0);
        for (const body of scripts) expect(() => new Function(body)).not.toThrow();
        expect(html).not.toContain("<img src=x");
        // The credentials page interpolates prose into an attribute value too.
        expect(html).not.toContain(`placeholder="</script>`);
      }
    } finally {
      await srv.stop();
    }
  });

  // A `{slot}` carries a fact, not decoration. A translation that drops one must lose
  // the SENTENCE (fall back to English), never the fact inside it.
  it("keeps the ComfyUI URL when a translation drops its placeholder", async () => {
    translate = (_locale, key) =>
      key === "console.landing.connection.endpoints" ? "接続情報" : undefined;
    const srv = await serve();
    try {
      const html = await get(srv.url, "/console", "ja");
      expect(html).not.toContain("接続情報");
      expect(html).toContain("http://127.0.0.1:9500");
      expect(html).toContain(localBridgeUrl(DEFAULT_PANEL_BRIDGE_PORT));
    } finally {
      await srv.stop();
    }
  });

  it("keeps the masked-key placeholder when a translation drops it", async () => {
    translate = (_locale, key) => (key === "console.credentials.badge_set" ? "設定済み" : undefined);
    const srv = await serve();
    try {
      const html = await get(srv.url, "/credentials?token=tok-123", "ja");
      expect(html).not.toContain("設定済み");
      expect(html).toContain("{masked}");
    } finally {
      await srv.stop();
    }
  });
});
