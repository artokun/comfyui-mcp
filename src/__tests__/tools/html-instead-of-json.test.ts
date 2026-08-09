// #828 (end to end) — on a connected REMOTE ComfyUI, the template listing, the
// runtime classifier and get_system_stats received an HTML document where JSON
// was promised and surfaced only
//
//     Unexpected token '<', "<!DOCTYPE "... is not valid JSON
//
// These tests drive the actual tool handlers against a server that answers with
// a proxy/frontend HTML page and assert that the tool now names what answered —
// and, for action:"check_runtime", that it does NOT report the server as
// unreachable when the server plainly answered.
//
// 0.50.0 slice 9 folded both of these into `list_packs`, so the same handler is
// now reached by action rather than by tool name; the assertions are unchanged,
// which is the point — the fold was a surface change.

import { describe, expect, it, beforeEach, vi } from "vitest";

const authHeaders = vi.hoisted(() => ({ value: {} as Record<string, string> }));
vi.mock("../../config.js", () => ({
  // #1191 — the scrubber now also redacts the CLOUD API KEY and the download
  // tokens by known value, so it reads `config` directly. Stubbed empty here:
  // these tests are about the non-JSON diagnosis, not about redaction.
  config: {},
  getComfyUIBaseUrl: () => "http://remote.example:8188",
  getComfyUIAuthHeaders: () => authHeaders.value,
}));

// action:"check_runtime" classifies nodes through this service; make it throw the
// SAME non-JSON error the shared client would, so the tool's error branch is the
// one under test.
const checkWorkflowRuntimeMock = vi.fn();
vi.mock("../../services/api-nodes.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/api-nodes.js")>();
  return {
    ...actual,
    checkWorkflowRuntime: (...a: unknown[]) => checkWorkflowRuntimeMock(...a),
  };
});

import { registerSkillsAccessTools } from "../../tools/skills-access.js";
import { registerWorkflowExecuteTools } from "../../tools/workflow-execute.js";
import { NonJsonResponseError, classifyNonJson } from "../../comfyui/json-guard.js";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };
type ToolHandler = (args: Record<string, unknown>) => Promise<ToolResult>;

function getHandler(name: string, register = registerSkillsAccessTools): ToolHandler {
  let handler: ToolHandler | undefined;
  const server = {
    tool: (n: string, _d: string, _s: unknown, h: ToolHandler) => {
      if (n === name) handler = h;
    },
  };
  register(server as never);
  if (!handler) throw new Error(`tool ${name} not registered`);
  return handler;
}

const SPA_INDEX =
  "<!DOCTYPE html><html><head><title>ComfyUI</title></head><body><div id='vue-app'></div></body></html>";

function htmlResponse(status = 200): Response {
  return new Response(SPA_INDEX, { status, headers: { "content-type": "text/html" } });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('list_packs action:"list_templates" on an HTML-answering remote (#828)', () => {
  it("names the HTML page and the responder instead of 'Unexpected token <'", async () => {
    global.fetch = vi.fn(async () => htmlResponse(200)) as unknown as typeof fetch;
    const out = await getHandler("list_packs")({ action: "list_templates" });
    const text = out.content[0].text;
    expect(text).not.toMatch(/Unexpected token/);
    expect(text).toContain("http://remote.example:8188/api/workflow_templates");
    expect(text).toContain("HTML page");
    // This fixture carries ComfyUI's own frontend markers, so naming the
    // frontend is warranted rather than speculative.
    expect(text).toContain("ComfyUI web FRONTEND answered");
  });

  it("does not blame the ComfyUI VERSION when a non-2xx is actually a proxy page", async () => {
    global.fetch = vi.fn(async () => htmlResponse(502)) as unknown as typeof fetch;
    const out = await getHandler("list_packs")({ action: "list_templates" });
    const text = out.content[0].text;
    expect(out.isError).toBe(true);
    // The old message guessed at an outdated server; the body says otherwise.
    expect(text).not.toMatch(/recent enough to expose workflow templates/);
    expect(text).toContain("502");
  });

  it("shows the JSON error body so the caller can tell ComfyUI from a gateway", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response('{"error":"unknown route"}', {
          status: 404,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const out = await getHandler("list_packs")({ action: "list_templates" });
    expect(out.isError).toBe(true);
    const text = out.content[0].text;
    expect(text).toContain('{"error":"unknown route"}');
    // Both readings are offered; neither is asserted, because a 404 JSON body
    // alone does not say whether ComfyUI or something in front of it answered.
    expect(text).toContain("may predate the workflow-templates endpoint");
    expect(text).toContain("never reached ComfyUI");
    // ...and it must NOT open by attributing the status to ComfyUI.
    expect(text).not.toMatch(/^ComfyUI returned/);
  });

  it("redacts our own ComfyUI credential from a JSON error body a gateway reflected", async () => {
    // The JSON-error branch echoes the body, so a gateway that reflects the
    // request would otherwise put our token straight into the tool result.
    authHeaders.value = { Authorization: "Bearer reflected-secret-token" };
    try {
      global.fetch = vi.fn(
        async () =>
          new Response('{"error":"bad token: Bearer reflected-secret-token"}', {
            status: 401,
            headers: { "content-type": "application/json" },
          }),
      ) as unknown as typeof fetch;
      const out = await getHandler("list_packs")({ action: "list_templates" });
      expect(out.content[0].text).not.toContain("reflected-secret-token");
    } finally {
      authHeaders.value = {};
    }
  });

  it("still returns the index on a healthy JSON 200", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response('{"pack-a":[{"name":"t1"}]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const out = await getHandler("list_packs")({ action: "list_templates" });
    expect(out.isError).toBeUndefined();
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.source_count).toBe(1);
    expect(parsed.template_count).toBe(1);
  });
});

describe('list_packs action:"check_runtime" must not call an answering server unreachable (#828)', () => {
  const graph = { "1": { class_type: "KSampler", inputs: {} } };

  it("reports the non-JSON reason rather than 'could not reach the ComfyUI server'", async () => {
    checkWorkflowRuntimeMock.mockRejectedValue(
      new NonJsonResponseError(
        classifyNonJson({
          url: "http://remote.example:8188/object_info",
          status: 200,
          contentType: "text/html",
          body: SPA_INDEX,
        }),
      ),
    );
    const out = await getHandler("list_packs")({ action: "check_runtime", graph });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.runtime).toBe("unknown");
    expect(parsed.reason).toBe("non_json_response");
    expect(parsed.note).toContain("was reached");
    expect(parsed.note).not.toMatch(/Could not reach the ComfyUI server/);
    // The paid-credits safety wording must survive — 'unknown' is still possibly paid.
    expect(parsed.note).toContain("POSSIBLY paid");
  });

  it("keeps the non-JSON reason for a RAW markup-parse failure the probe could not confirm", async () => {
    // The parse error itself proves the server answered with something that is
    // not JSON. Filing that under "unavailable" because the follow-up probe was
    // inconclusive loses the #828 diagnosis and sends the user to check whether
    // ComfyUI is running.
    checkWorkflowRuntimeMock.mockRejectedValue(
      new SyntaxError(`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`),
    );
    const out = await getHandler("list_packs")({ action: "check_runtime", graph });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.reason).toBe("non_json_response");
    expect(parsed.note).toContain("was reached");
    expect(parsed.note).toContain("not identified"); // the probe did not settle what answered
    expect(parsed.note).toContain("POSSIBLY paid");
  });

  it("redacts a reflected credential out of the failure detail it reports", async () => {
    authHeaders.value = { Authorization: "Bearer echoed-secret-token-here" };
    try {
      checkWorkflowRuntimeMock.mockRejectedValue(
        new SyntaxError(
          `Unexpected token '<', "<html>Bearer echoed-secret-token-here</html>" is not valid JSON`,
        ),
      );
      const out = await getHandler("list_packs")({ action: "check_runtime", graph });
      expect(out.content[0].text).not.toContain("echoed-secret-token-here");
    } finally {
      authHeaders.value = {};
    }
  });

  it("keeps the unreachable wording for a genuine transport failure", async () => {
    checkWorkflowRuntimeMock.mockRejectedValue(new Error("fetch failed"));
    const out = await getHandler("list_packs")({ action: "check_runtime", graph });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.reason).toBe("object_info_unavailable");
    expect(parsed.note).toContain("unavailable");
    expect(parsed.note).toContain("POSSIBLY paid");
  });

  it("still classifies normally when the server answers properly", async () => {
    checkWorkflowRuntimeMock.mockResolvedValue({
      runtime: "local",
      usesApiNodes: false,
      apiNodes: [],
      unknownNodes: [],
    });
    const out = await getHandler("list_packs")({ action: "check_runtime", graph });
    const parsed = JSON.parse(out.content[0].text);
    expect(parsed.runtime).toBe("local");
    expect(parsed.reason).toBeUndefined();
  });
});

describe('enqueue_workflow (action:"template_schema") must not call an answering server unreachable (#828)', () => {
  it("names the HTML page instead of reporting the ComfyUI server unreachable", async () => {
    // `.json()` on an HTML body threw into a catch that reported the server
    // UNREACHABLE — for a server that plainly answered.
    global.fetch = vi.fn(async () => htmlResponse(200)) as unknown as typeof fetch;
    const out = await getHandler("enqueue_workflow", registerWorkflowExecuteTools)({
      action: "template_schema",
      template: "some-template",
    });
    const text = out.content[0].text;
    expect(text).not.toMatch(/server is unreachable/i);
    expect(text).not.toMatch(/Unexpected token/);
    expect(text).toContain("/api/workflow_templates");
    expect(text).toContain("HTML page");
  });

  it("does not report a template MISSING when the index endpoint returned an error", async () => {
    // An HTTP error is not an empty index. Falling through with `{}` made a 502
    // read as "there is no template by that name" — a confident wrong verdict
    // about the template, from a response that said nothing about templates.
    global.fetch = vi.fn(async () => htmlResponse(502)) as unknown as typeof fetch;
    const out = await getHandler("enqueue_workflow", registerWorkflowExecuteTools)({
      action: "template_schema",
      template: "some-template",
    });
    const text = out.content[0].text;
    expect(text).not.toMatch(/No custom-node-contributed workflow template named/);
    expect(text).toContain("UNKNOWN");
    expect(text).toContain("502");
  });

  it("does not report a template MISSING for a gateway's JSON error envelope either", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response('{"message":"forbidden"}', {
          status: 403,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const out = await getHandler("enqueue_workflow", registerWorkflowExecuteTools)({
      action: "template_schema",
      template: "some-template",
    });
    const error = String(JSON.parse(out.content[0].text).error);
    expect(error).not.toMatch(/No custom-node-contributed workflow template named/);
    expect(error).toContain("UNKNOWN");
    expect(error).toContain('{"message":"forbidden"}'); // the body verbatim
    expect(error).toContain("403");
  });

  it("still reports a genuinely absent template as absent", async () => {
    global.fetch = vi.fn(
      async () =>
        new Response('{"pack-a":[{"name":"something-else"}]}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const out = await getHandler("enqueue_workflow", registerWorkflowExecuteTools)({
      action: "template_schema",
      template: "some-template",
    });
    expect(out.content[0].text).toMatch(/No custom-node-contributed workflow template named/);
  });

  it("keeps the unreachable wording for a genuine transport failure", async () => {
    global.fetch = vi.fn(async () => {
      throw new Error("fetch failed");
    }) as unknown as typeof fetch;
    const out = await getHandler("enqueue_workflow", registerWorkflowExecuteTools)({
      action: "template_schema",
      template: "some-template",
    });
    expect(out.content[0].text).toMatch(/server is unreachable/i);
  });
});
