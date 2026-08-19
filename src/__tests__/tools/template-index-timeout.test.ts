// #1415 — the configured template read must let COMFYUI_MCP_HTTP_TIMEOUT_S
// govern it.
//
// `comfyuiFetch` applies its configurable ceiling ONLY to callers that passed no
// signal (`init.signal ?? defaultComfyTimeoutSignal()`). A hard-coded
// `AbortSignal.timeout(8000)` at the call site therefore always wins, and a user
// who raised the timeout for a slow remote still had this one read aborted at 8s
// — the setting silently did nothing here.
//
// WHY THIS IS A SEPARATE FILE, AND NOT A TIMING TEST. A real-timer version (a
// 50ms configured budget against a slower stub) passed alone and failed in the
// full suite: the outcome depended on when the stub was scheduled relative to a
// timer that had already fired, which is not the claim. The claim is structural:
// THIS CALL SITE PASSES NO SIGNAL, so the configured ceiling is what applies.
// Asserting that directly needs comfyuiFetch itself mocked, which must not leak
// into the behaviour tests next door.

import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

vi.mock("../../config.js", () => ({
  config: { comfyuiApiKey: undefined, huggingfaceToken: undefined, civitaiApiToken: undefined },
  getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  getComfyUIAuthHeaders: () => ({}),
}));

const seen: Array<{ url: string; init: RequestInit | undefined }> = [];

vi.mock("../../comfyui/fetch.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../comfyui/fetch.js")>();
  return {
    ...actual,
    comfyuiFetch: async (input: string | URL | Request, init?: RequestInit) => {
      seen.push({ url: String(input), init });
      return new Response(JSON.stringify({ core: [{ name: "t" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
  };
});

import { registerSkillsAccessTools } from "../../tools/skills-access.js";

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

function handler(): Handler {
  const tools: Array<{ name: string; handler: Handler }> = [];
  const server = {
    tool: (name: string, _d: string, _s: z.ZodRawShape, h: Handler) => {
      tools.push({ name, handler: h });
    },
  };
  registerSkillsAccessTools(server as never);
  const t = tools.find((x) => x.name === "list_packs");
  if (!t) throw new Error("list_packs not registered");
  return t.handler;
}

describe('list_packs action:"list_templates" — the configured timeout governs', () => {
  it("passes NO signal of its own, so comfyuiFetch's configurable ceiling applies", async () => {
    seen.length = 0;

    const res = await handler()({ action: "list_templates" });

    expect(res.isError).toBeFalsy();
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe("http://127.0.0.1:8188/api/workflow_templates");
    // The whole finding in one assertion: any signal here overrides the user's
    // setting, because comfyuiFetch only fills one in when the caller passed none.
    expect(seen[0].init?.signal).toBeUndefined();
  });
});
