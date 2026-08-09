// #1191 — the enqueue error builders printed up to 500 RAW response bytes.
//
// A gateway that reflects the request can echo OUR OWN CREDENTIAL in the body it
// answers with, and that string goes straight into a tool result the agent reads
// and users paste into bug reports. `/prompt` is the worst endpoint to have this
// on: it is the one call that enqueues work, so it runs on every render, and its
// error path is the one most likely to be hit and shared.
//
// Same class as #828 (the diagnosis path) and #1187 (the branches it made
// reachable); genuinely pre-existing on both sites, which is why it was filed
// separately rather than folded into that PR.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TOKEN = "sk-live-9f2b7c41aa6e4d0e8b3f5a1c2d7e9f04";

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return {
    ...actual,
    isCloudMode: () => false,
    getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
    config: { ...actual.config, comfyuiAuthToken: TOKEN, comfyuiAuthHeader: "Authorization" },
  };
});

const comfyuiFetch = vi.fn();
vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: (...a: unknown[]) => comfyuiFetch(...a),
}));

const { enqueuePrompt } = await import("../../comfyui/client.js");

function res(status: number, body: string, statusText = "Bad Request"): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText,
    text: async () => body,
    json: async () => JSON.parse(body),
    headers: new Map(),
  } as unknown as Response;
}

beforeEach(() => comfyuiFetch.mockReset());
afterEach(() => vi.clearAllMocks());

describe("an enqueue error never hands back the credential (#1191)", () => {
  it("does not echo a reflected token from the body", async () => {
    // The shape that matters: a gateway echoing the request it received.
    const reflected = JSON.stringify({
      message: "unauthorized",
      request: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    comfyuiFetch.mockResolvedValueOnce(res(401, reflected, "Unauthorized"));

    const err = (await enqueuePrompt({}).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
  });

  it("does not echo a token reflected in the STATUS phrase either", async () => {
    comfyuiFetch.mockResolvedValueOnce(res(403, "", `denied for ${TOKEN}`));
    const err = (await enqueuePrompt({}).catch((e: unknown) => e)) as Error;
    expect(err.message).not.toContain(TOKEN);
  });

  it("still says WHAT happened — redaction must not eat the diagnosis", async () => {
    // A redaction that withholds everything trades one defect for another.
    comfyuiFetch.mockResolvedValueOnce(res(502, "upstream gateway exploded", "Bad Gateway"));
    const err = (await enqueuePrompt({}).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("502");
    expect(err.message).toContain("upstream gateway exploded");
  });

  it("keeps ComfyUI's own node_errors diagnosis intact (#485)", async () => {
    // The validation path is the whole reason /prompt errors are read at all, and
    // it must survive: it does not go through the raw-body fallback.
    const body = JSON.stringify({
      error: { message: "Prompt outputs failed validation" },
      node_errors: {
        "5": {
          class_type: "LoadImage",
          errors: [{ message: "Custom validation failed", details: "Invalid image file" }],
        },
      },
    });
    comfyuiFetch.mockResolvedValueOnce(res(400, body));
    const err = (await enqueuePrompt({}).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("Prompt outputs failed validation");
    expect(err.message).toContain("LoadImage");
    expect(err.message).toContain("Invalid image file");
  });

  it("bounds the body — a huge page cannot flood the tool result", async () => {
    comfyuiFetch.mockResolvedValueOnce(res(500, "x".repeat(5000), "Internal Server Error"));
    const err = (await enqueuePrompt({}).catch((e: unknown) => e)) as Error;
    // The old code allowed 500 bytes; bodyPrefixOf clips far tighter.
    expect(err.message.length).toBeLessThan(400);
  });
});
