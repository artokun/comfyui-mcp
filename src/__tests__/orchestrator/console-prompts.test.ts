// The system-prompt editor the console never actually served.
//
// The prompt registry (services/prompt-overrides.ts) has shipped list/set/clear since
// the fork port, and NOTHING called them: the port dropped the "/prompts editor page +
// /api/prompts endpoints" its own commit message claims, so every editable prompt was
// unreachable and `GET /prompts?token=…` answered `{"ok":false,"error":"not_found"}`.
// These cases pin the page and the endpoints behind it — including the two the store
// treats identically but the wire must not (an emptied textarea vs. a pressed Reset)
// and the write guard that keeps a typo'd id out of the user's overrides file.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

vi.mock("../../config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../config.js")>();
  return { ...actual, getInstanceSlug: () => "test-instance" };
});

import { startPanelConsoleHttpServer } from "../../orchestrator/panel-console-http.js";
import { registerPrompt, resolvePrompt } from "../../services/prompt-overrides.js";
import { resetLoraCatalog } from "../../services/lora-catalog.js";

const TOKEN = "test-token";
const DEFAULT_TEXT = "You are the panel agent. Keep the canvas honest.";

let dir: string;
let overridesFile: string;

async function withServer<T>(fn: (url: string) => Promise<T>): Promise<T> {
  const srv = await startPanelConsoleHttpServer({
    port: 0,
    bridgePort: 9180,
    comfyuiUrl: "http://127.0.0.1:9500",
    token: TOKEN,
  });
  try {
    return await fn(srv.url);
  } finally {
    await srv.stop();
  }
}

const post = (url: string, body: unknown) =>
  fetch(`${url}/api/prompts?token=${TOKEN}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "console-prompts-"));
  overridesFile = join(dir, "panel-prompts.json");
  process.env.COMFYUI_MCP_PANEL_PROMPTS = overridesFile;
  process.env.COMFYUI_MCP_ENV_FILE = join(dir, ".env");
  process.env.COMFYUI_MCP_PANEL_SECRETS = join(dir, "panel-secrets.json");
  process.env.COMFYUI_MCP_LORA_CATALOG = join(dir, "lora-catalog.json");
  process.env.COMFYUI_MCP_LORA_PREVIEWS = join(dir, "previews");
  resetLoraCatalog();
  registerPrompt("panel.persona", "Panel agent persona", DEFAULT_TEXT, "Applies live.");
});

afterEach(() => {
  for (const k of [
    "COMFYUI_MCP_PANEL_PROMPTS",
    "COMFYUI_MCP_ENV_FILE",
    "COMFYUI_MCP_PANEL_SECRETS",
    "COMFYUI_MCP_LORA_CATALOG",
    "COMFYUI_MCP_LORA_PREVIEWS",
  ]) {
    delete process.env[k];
  }
  resetLoraCatalog();
  rmSync(dir, { recursive: true, force: true });
});

describe("the console serves the system prompts", () => {
  it("lists every registered prompt with its built-in default", async () => {
    await withServer(async (url) => {
      const res = await fetch(`${url}/api/prompts?token=${TOKEN}`);
      expect(res.ok).toBe(true);
      const body = (await res.json()) as {
        ok: boolean;
        prompts: { id: string; label: string; default: string; override: string | null; overridden: boolean }[];
      };
      expect(body.ok).toBe(true);
      const persona = body.prompts.find((p) => p.id === "panel.persona");
      expect(persona).toBeDefined();
      expect(persona?.default).toBe(DEFAULT_TEXT);
      expect(persona?.override).toBeNull();
      expect(persona?.overridden).toBe(false);
    });
  });

  it("saves an override, and the prompt the agent resolves is the saved one", async () => {
    await withServer(async (url) => {
      const res = await post(url, { id: "panel.persona", value: "Speak only in haiku." });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; prompt: { overridden: boolean; override: string } };
      expect(body.ok).toBe(true);
      expect(body.prompt.overridden).toBe(true);
      expect(body.prompt.override).toBe("Speak only in haiku.");
      // The point of the page: the CALL SITE now reads what was typed here.
      expect(resolvePrompt("panel.persona", DEFAULT_TEXT)).toBe("Speak only in haiku.");
      expect(JSON.parse(readFileSync(overridesFile, "utf-8"))).toEqual({
        "panel.persona": "Speak only in haiku.",
      });
    });
  });

  it("Reset drops the override so the built-in applies again", async () => {
    await withServer(async (url) => {
      await post(url, { id: "panel.persona", value: "Speak only in haiku." });
      const res = await post(url, { id: "panel.persona", reset: true });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; prompt: { overridden: boolean; override: string | null } };
      expect(body.prompt.overridden).toBe(false);
      expect(body.prompt.override).toBeNull();
      expect(resolvePrompt("panel.persona", DEFAULT_TEXT)).toBe(DEFAULT_TEXT);
    });
  });

  it("reports the STORED state, not the text that was sent", async () => {
    // Whitespace-only clears the override in the store. Echoing the request back would
    // have the badge say "customised" over a prompt that is running the built-in.
    await withServer(async (url) => {
      await post(url, { id: "panel.persona", value: "Speak only in haiku." });
      const res = await post(url, { id: "panel.persona", value: "   \n  " });
      const body = (await res.json()) as { prompt: { overridden: boolean; override: string | null } };
      expect(body.prompt.overridden).toBe(false);
      expect(body.prompt.override).toBeNull();
      expect(resolvePrompt("panel.persona", DEFAULT_TEXT)).toBe(DEFAULT_TEXT);
    });
  });

  it("refuses an id nothing registered, and writes nothing", async () => {
    await withServer(async (url) => {
      const res = await post(url, { id: "panel.persnoa", value: "typo" });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { ok: boolean; error: string };
      expect(body.ok).toBe(false);
      expect(body.error).toContain("panel.persnoa");
      expect(existsSync(overridesFile)).toBe(false);
    });
  });

  it("is token-gated — both the page and the endpoints", async () => {
    await withServer(async (url) => {
      expect((await fetch(`${url}/api/prompts`)).status).toBe(401);
      expect(
        (
          await fetch(`${url}/api/prompts`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ id: "panel.persona", value: "x" }),
          })
        ).status,
      ).toBe(401);
      const page = await fetch(`${url}/prompts`);
      expect(page.status).toBe(401);
      expect(await page.text()).toContain("Unauthorized");
      expect(existsSync(overridesFile)).toBe(false);
    });
  });

  it("serves the editor page, framed for the panel and free of inlined prompt text", async () => {
    await withServer(async (url) => {
      const res = await fetch(`${url}/prompts?token=${TOKEN}`);
      expect(res.ok).toBe(true);
      // The panel embeds this page the same way it embeds /credentials.
      expect(res.headers.get("content-security-policy")).toContain("frame-ancestors");
      const html = await res.text();
      expect(html).toContain("System Prompts");
      expect(html).toContain("/api/prompts");
      // Rows come from the endpoint at load time — a prompt registered after this
      // document was built must still appear, so nothing is baked in.
      expect(html).not.toContain(DEFAULT_TEXT);
    });
  });

  it("links the editor from the console landing page and never inlines the token", async () => {
    await withServer(async (url) => {
      const html = await (await fetch(`${url}/console`)).text();
      expect(html).toContain('href="/prompts"');
      expect(html).toContain("prompts-link");
      // /console is NOT token-gated. Rendering the token into it would hand the secret to
      // exactly the unauthenticated reader the gate on /prompts exists to stop, so the link
      // ships bare and the token reaches it through the query string instead.
      expect(html).not.toContain(TOKEN);
    });
  });

  // The landing page reads ?token= off its own URL and copies it onto the editor link.
  // That consumer is only worth anything if something PUTS a token there: every in-product
  // route to /console is an "Advanced" button on a page that is itself gated and already
  // holds the token. When those buttons opened a bare /console, the carry could not fire on
  // any real path and the advertised link answered 401 — green tests over a dead mechanism.
  it.each([["/credentials"], ["/prompts"]])(
    "%s hands its own token to /console, so the landing page has one to carry",
    async (path) => {
      await withServer(async (url) => {
        const html = await (await fetch(`${url}${path}?token=${TOKEN}`)).text();
        expect(html).toContain('"/console" + (CFG.token ? q(CFG.token) : "")');
        // q() is the shared builder both pages already use for their own fetches.
        expect(html).toContain('const q = (t) => "?token=" + encodeURIComponent(t);');
      });
    },
  );
});
