import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startPanelConsoleHttpServer } from "../../orchestrator/panel-console-http.js";
import { DEFAULT_PANEL_BRIDGE_PORT } from "../../services/bridge-ports.js";

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return {
    ...actual,
    getInstanceSlug: () => "test-instance",
  };
});

import { LoraCatalog, resetLoraCatalog } from "../../services/lora-catalog.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "panel-console-"));
  process.env.COMFYUI_MCP_LORA_CATALOG = join(dir, "lora-catalog.json");
  process.env.COMFYUI_MCP_LORA_PREVIEWS = join(dir, "previews");
  // This file only READS /api/secrets, but point the credential store at a temp
  // path anyway: a test must never be able to touch the developer's real
  // ~/.comfyui-mcp/.env, and the next write-shaped case added here would.
  process.env.COMFYUI_MCP_ENV_FILE = join(dir, ".env");
  process.env.COMFYUI_MCP_PANEL_SECRETS = join(dir, "panel-secrets.json");
  resetLoraCatalog();
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_LORA_CATALOG;
  delete process.env.COMFYUI_MCP_LORA_PREVIEWS;
  delete process.env.COMFYUI_MCP_ENV_FILE;
  delete process.env.COMFYUI_MCP_PANEL_SECRETS;
  resetLoraCatalog();
  rmSync(dir, { recursive: true, force: true });
});

describe("panel-console-http", () => {
  it("serves /api/status and landing page on loopback", async () => {
    const srv = await startPanelConsoleHttpServer({
      port: 0,
      bridgePort: DEFAULT_PANEL_BRIDGE_PORT,
      comfyuiUrl: "http://127.0.0.1:9500",
    });
    try {
      const statusRes = await fetch(`${srv.url}/api/status`);
      expect(statusRes.ok).toBe(true);
      const body = (await statusRes.json()) as { ok: boolean; bridge_port: number; backends: unknown[] };
      expect(body.ok).toBe(true);
      expect(body.bridge_port).toBe(DEFAULT_PANEL_BRIDGE_PORT);
      expect(Array.isArray(body.backends)).toBe(true);

      const htmlRes = await fetch(srv.url);
      expect(htmlRes.ok).toBe(true);
      const html = await htmlRes.text();
      expect(html).toContain("ComfyUI MCP Console");
    } finally {
      await srv.stop();
    }
  });

  it("serves LoRA preview images by catalog id", async () => {
    const previews = join(dir, "previews");
    mkdirSync(previews, { recursive: true });
    writeFileSync(join(previews, "thumb.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const catalog = new LoraCatalog();
    const entry = catalog.upsert({
      relPath: "loras/test.safetensors",
      displayName: "Test LoRA",
      previewFile: "thumb.png",
    });

    const srv = await startPanelConsoleHttpServer({
      port: 0,
      bridgePort: DEFAULT_PANEL_BRIDGE_PORT,
      comfyuiUrl: "http://127.0.0.1:9500",
    });
    try {
      const miss = await fetch(`${srv.url}/api/lora-preview?id=missing`);
      expect(miss.status).toBe(404);

      const res = await fetch(`${srv.url}/api/lora-preview?id=${encodeURIComponent(entry.id)}`);
      expect(res.ok).toBe(true);
      expect(res.headers.get("content-type")).toMatch(/image\/png/);
      const buf = Buffer.from(await res.arrayBuffer());
      expect(buf.slice(0, 4).toString("hex")).toBe("89504e47");
    } finally {
      await srv.stop();
    }
  });

  // ── i18n of the two served pages ───────────────────────────────────────────
  //
  // These used to assert that every page came back `lang="en"` no matter what the
  // browser asked for, because no catalog existed and stamping `lang="fa" dir="rtl"`
  // onto English prose is worse than saying nothing — it mirrors the layout and tells
  // a screen reader to pronounce English as Persian. Catalogs now ship, so the same
  // rule points the other way: the document must declare the language it RENDERED,
  // which is now the reader's own. `renderedLocale` is the single mechanism behind
  // both directions, and the English direction is still reachable for a language we
  // do not ship — which is what the second test here holds down.
  describe("page language", () => {
    const serve = async () =>
      startPanelConsoleHttpServer({
        port: 0,
        bridgePort: DEFAULT_PANEL_BRIDGE_PORT,
        comfyuiUrl: "http://127.0.0.1:9500",
        token: "tok-123",
      });

    it("declares the language it rendered, and mirrors the page for RTL", async () => {
      const srv = await serve();
      try {
        for (const [lang, code] of [
          ["fa-IR,fa;q=0.9", "fa"],
          ["ar", "ar"],
          ["ja-JP", "ja"],
          ["ru", "ru"],
        ] as const) {
          const html = await (await fetch(srv.url, { headers: { "accept-language": lang } })).text();
          // Anchored on the character that ENDS the attribute, so `lang="ja"` cannot be
          // satisfied by a `lang="ja-x"` the negotiator was never supposed to emit. RTL pages
          // continue with ` dir="rtl"`, so the boundary is a space or the closing bracket.
          expect(html).toMatch(new RegExp(`<html lang="${code}"[ >]`));
          // The subtitle is the sentence `renderedLocale` probes, so its presence in the
          // reader's language is what proves the declared code was EARNED rather than echoed.
          expect(html).not.toContain("Control plane for the panel orchestrator");
        }
        const rtl = await (await fetch(srv.url, { headers: { "accept-language": "ar" } })).text();
        expect(rtl).toContain(`<html lang="ar" dir="rtl">`);
        const ltr = await (await fetch(srv.url, { headers: { "accept-language": "ja" } })).text();
        expect(ltr).not.toContain(`dir="rtl"`);

        const creds = await (
          await fetch(`${srv.url}/credentials?token=tok-123`, { headers: { "accept-language": "ar" } })
        ).text();
        expect(creds).toContain(`<html lang="ar" dir="rtl">`);
      } finally {
        await srv.stop();
      }
    });

    it("stays English and LTR for a language we do not ship", async () => {
      // The direction that used to be the only one: a reader whose language has no catalog
      // gets a correct English LTR page, never a mirrored layout around English prose.
      const srv = await serve();
      try {
        const html = await (await fetch(srv.url, { headers: { "accept-language": "kl-GL,kl" } })).text();
        expect(html).toContain(`<html lang="en">`);
        expect(html).not.toContain(`dir="rtl"`);
        expect(html).toContain("Control plane for the panel orchestrator");
      } finally {
        await srv.stop();
      }
    });

    // The 401 is a bare fragment with no <html> to carry the language, so the <p> has to.
    it("carries the language on the unauthorized fragment itself", async () => {
      const srv = await serve();
      try {
        const res = await fetch(`${srv.url}/credentials?token=wrong`, {
          headers: { "accept-language": "fa" },
        });
        expect(res.status).toBe(401);
        const body = await res.text();
        expect(body).toMatch(/^<p lang="fa" dir="rtl">/);
        expect(body).not.toContain("Unauthorized — reconnect the panel.");

        const unshipped = await fetch(`${srv.url}/credentials?token=wrong`, {
          headers: { "accept-language": "kl-GL,kl" },
        });
        expect(await unshipped.text()).toBe(`<p lang="en">Unauthorized — reconnect the panel.</p>`);
      } finally {
        await srv.stop();
      }
    });

    // Translated strings are now serialized INTO the inline scripts. A stray quote
    // or a `</script>` would break the page silently — the server would still answer
    // 200 and the page would still contain its prose. Compiling the script body is
    // the only assertion that sees it. (The hostile-translation case, which is what
    // makes this bite, lives in panel-console-i18n.test.ts.)
    it("keeps both inline scripts parseable", async () => {
      const srv = await serve();
      try {
        for (const path of ["/console", "/credentials?token=tok-123"]) {
          const html = await (await fetch(`${srv.url}${path}`)).text();
          const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
          expect(scripts.length).toBeGreaterThan(0);
          // `new Function` COMPILES without running: a syntax error throws here, and
          // nothing touches document/fetch.
          for (const body of scripts) expect(() => new Function(body)).not.toThrow();
        }
      } finally {
        await srv.stop();
      }
    });

    it("escapes markup from the served ComfyUI URL rather than emitting it", async () => {
      const srv = await startPanelConsoleHttpServer({
        port: 0,
        bridgePort: DEFAULT_PANEL_BRIDGE_PORT,
        comfyuiUrl: "http://127.0.0.1:9500/<script>alert(1)</script>",
      });
      try {
        const html = await (await fetch(srv.url)).text();
        expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
        expect(html).not.toContain("<script>alert(1)</script>");
      } finally {
        await srv.stop();
      }
    });
  });

  it("sends CORS headers for the ComfyUI origin (and its localhost twin) only", async () => {
    const srv = await startPanelConsoleHttpServer({
      port: 0,
      bridgePort: DEFAULT_PANEL_BRIDGE_PORT,
      comfyuiUrl: "http://127.0.0.1:9500",
    });
    try {
      // The panel page's origin: allowed.
      const allowed = await fetch(`${srv.url}/api/secrets`, {
        headers: { origin: "http://127.0.0.1:9500" },
      });
      expect(allowed.headers.get("access-control-allow-origin")).toBe("http://127.0.0.1:9500");

      // localhost twin of the same origin: allowed (page may be open under either name).
      const twin = await fetch(`${srv.url}/api/secrets`, {
        headers: { origin: "http://localhost:9500" },
      });
      expect(twin.headers.get("access-control-allow-origin")).toBe("http://localhost:9500");

      // Arbitrary web origin: NO CORS grant (token would otherwise be probeable
      // from any page the user has open).
      const denied = await fetch(`${srv.url}/api/secrets`, {
        headers: { origin: "https://evil.example" },
      });
      expect(denied.headers.get("access-control-allow-origin")).toBeNull();

      // Preflight for the authorized JSON POST.
      const preflight = await fetch(`${srv.url}/api/secrets`, {
        method: "OPTIONS",
        headers: {
          origin: "http://127.0.0.1:9500",
          "access-control-request-method": "POST",
          "access-control-request-headers": "authorization, content-type",
        },
      });
      expect(preflight.status).toBe(204);
      expect(preflight.headers.get("access-control-allow-methods")).toContain("POST");
      expect(preflight.headers.get("access-control-allow-headers")).toContain("authorization");
    } finally {
      await srv.stop();
    }
  });
});