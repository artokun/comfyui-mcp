import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetClient } from "../../comfyui/client.js";
import { getJobStatus } from "../../services/queue-manager.js";

const PROMPT_ID = "f8969f48-7bec-4c3c-bd16-3d6d30cad279";

/** #2507 repro: the library's getPromptStatus derives `done = !running && !pending`
 *  from /queue alone. When a restart wiped the queue AND /history holds no record,
 *  that derivation reported a prompt ComfyUI never executed as finished. */
function mockComfy(opts: { history: Record<string, unknown>; historyFails?: boolean }): void {
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL) => {
    const path = String(url);
    if (path.includes("/queue")) {
      return Response.json({ queue_running: [], queue_pending: [] });
    }
    if (path.includes(`/history/${PROMPT_ID}`)) {
      if (opts.historyFails) return new Response("boom", { status: 500 });
      return Response.json(opts.history);
    }
    return new Response("Unexpected URL", { status: 500 });
  }));
}

describe("getJobStatus when ComfyUI has no record of the prompt (#2507)", () => {
  beforeEach(() => {
    resetClient();
  });

  afterEach(() => {
    resetClient();
    vi.unstubAllGlobals();
  });

  it("reports found:false — never done:true — when the queue is empty and /history has no record", async () => {
    mockComfy({ history: {} });

    const status = await getJobStatus(PROMPT_ID);

    expect(status).toMatchObject({
      running: false,
      pending: false,
      done: false,
      found: false,
    });
    expect(status.message).toMatch(/no record of this prompt/i);
    expect(status.message).toMatch(/get_history/);
    expect(status.status_str).toBeUndefined();
  });

  it("keeps done:true when /history DOES hold the prompt", async () => {
    mockComfy({
      history: {
        [PROMPT_ID]: {
          prompt: {},
          outputs: {},
          status: { status_str: "success", completed: true, messages: [] },
        },
      },
    });

    const status = await getJobStatus(PROMPT_ID);

    expect(status).toMatchObject({
      running: false,
      pending: false,
      done: true,
      status_str: "success",
    });
    expect(status.found).toBeUndefined();
  });

  it("does not claim absence from a /history read that failed — ignorance is not absence", async () => {
    mockComfy({ history: {}, historyFails: true });

    const status = await getJobStatus(PROMPT_ID);

    expect(status).toMatchObject({ running: false, pending: false, done: true });
    expect(status.found).toBeUndefined();
  });
});
