import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * #2673 — a headless enqueue rejected because a LOADER names a file the server
 * does not have must say WHERE it looked and how to put the file there.
 *
 * The reporter attached an image in the panel; the sidebar showed
 * `input/8058752600640.JPG`; a headless workflow with `LoadImage image=` that
 * name came back "Invalid image file". Everything the agent received was
 * ComfyUI's own two lines, so it filed a P2 guessing at "attachment
 * registration/race, or filename handling in comfyui-mcp" — when nothing between
 * the panel and `/prompt` rewrites the value at all, and comfyui-mcp was already
 * holding the one machine-checkable cause (a connected panel on a DIFFERENT
 * ComfyUI than COMFYUI_URL, which `describeTargetDrift` has detected since #952
 * but only on TRANSPORT failures).
 *
 * THE FIXTURE IS VERSION-CHECKED, not invented. Read off the reporter's own
 * ComfyUI v0.34.0 (`execution.py`, `nodes.py`):
 *   - `LoadImage.VALIDATE_INPUTS(image)` returns "Invalid image file: {}";
 *   - the combo-membership check is SKIPPED for any input the node declares in
 *     its own VALIDATE_INPUTS, so LoadImage.image can only fail as
 *     `custom_validation_failed` — never `value_not_in_list`;
 *   - that error carries `extra_info: {"input_name": x}` and NOTHING else (no
 *     `input_config`, no `received_value`), which is why detection keys on
 *     `type` + `input_name` + class_type rather than on the input's upload flag.
 */

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>("../../config.js");
  return {
    ...actual,
    isCloudMode: () => false,
    getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  };
});

// Partial mock over the REAL fetch module: only the transport is faked, so the
// origin comparison under test is the shipped one, driven through its own setter
// rather than through a stub that could agree with anything.
const comfyuiFetch = vi.fn();
vi.mock("../../comfyui/fetch.js", async () => {
  const actual = await vi.importActual<typeof import("../../comfyui/fetch.js")>(
    "../../comfyui/fetch.js",
  );
  return { ...actual, comfyuiFetch: (...a: unknown[]) => comfyuiFetch(...a) };
});

const { enqueuePrompt } = await import("../../comfyui/client.js");
const { setConnectedPanelOrigins } = await import("../../comfyui/fetch.js");

function res(status: number, body: unknown, statusText = "Bad Request"): Response {
  return new Response(typeof body === "string" ? body : JSON.stringify(body), {
    status,
    statusText,
  });
}

/** One node error exactly as ComfyUI 0.34.0 emits it (execution.py). */
interface NodeErrorEntry {
  type?: string;
  message: string;
  details: string;
  extra_info: { input_name?: string; input_config?: unknown; received_value?: unknown };
}

/** The 400 envelope ComfyUI 0.34.0 answers a failed prompt validation with. */
interface RejectionBody {
  error: { type: string; message: string; details: string; extra_info: Record<string, never> };
  node_errors: Record<
    string,
    { class_type: string; errors: NodeErrorEntry[]; dependent_outputs?: string[] }
  >;
}

function rejection(nodeErrors: RejectionBody["node_errors"]): RejectionBody {
  return {
    error: {
      type: "prompt_outputs_failed_validation",
      message: "Prompt outputs failed validation",
      details: "",
      extra_info: {},
    },
    node_errors: nodeErrors,
  };
}

const MISSING_ATTACHMENT = rejection({
  "5": {
    class_type: "LoadImage",
    errors: [
      {
        type: "custom_validation_failed",
        message: "Custom validation failed for node",
        details: "image - Invalid image file: 8058752600640.JPG",
        extra_info: { input_name: "image" },
      },
    ],
    dependent_outputs: ["9"],
  },
});

/** A fetched Response reports the FINAL url after redirects; a constructed one
 *  reports "". Both shapes reach `buildEnqueueError`, so both are exercised. */
function withFinalUrl(r: Response, url: string): Response {
  Object.defineProperty(r, "url", { value: url, configurable: true });
  return r;
}

async function enqueueAgainst(body: RejectionBody): Promise<string> {
  comfyuiFetch.mockResolvedValueOnce(res(400, body));
  const err = await enqueuePrompt({ "5": { class_type: "LoadImage", inputs: {} } }).catch(
    (e: unknown) => e,
  );
  return (err as Error).message;
}

describe("#2673: a loader input naming a file the server does not have", () => {
  beforeEach(() => {
    comfyuiFetch.mockReset();
    setConnectedPanelOrigins(null);
  });
  afterEach(() => {
    setConnectedPanelOrigins(null);
    vi.clearAllMocks();
  });

  it("keeps ComfyUI's own diagnosis FIRST and whole", async () => {
    const message = await enqueueAgainst(MISSING_ATTACHMENT);
    expect(message).toContain("Prompt outputs failed validation");
    expect(message).toContain("LoadImage");
    expect(message).toContain("node 5");
    expect(message).toContain("Invalid image file: 8058752600640.JPG");
    // Appended, not substituted: the server's words precede ours.
    expect(message.indexOf("Invalid image file")).toBeLessThan(
      message.indexOf("names a FILE on the server"),
    );
  });

  it("names WHICH server was asked, and which node/input", async () => {
    const message = await enqueueAgainst(MISSING_ATTACHMENT);
    expect(message).toContain("LoadImage.image (node 5)");
    expect(message).toContain("http://127.0.0.1:8188");
  });

  it("gives the recovery calls and says a blind re-submit repeats the failure", async () => {
    const message = await enqueueAgainst(MISSING_ATTACHMENT);
    expect(message).toContain('upload_image (action:"image")');
    expect(message).toContain('upload_image (action:"stage")');
    expect(message).toContain("verbatim");
  });

  it("explains that a panel attachment is uploaded by the BROWSER, not by this process", async () => {
    const message = await enqueueAgainst(MISSING_ATTACHMENT);
    expect(message).toContain("BROWSER");
    expect(message).toContain("COMFYUI_URL");
  });

  describe("the panel-vs-headless comparison, which is the reason this note exists", () => {
    it("names a panel on a DIFFERENT ComfyUI — very likely the whole answer", async () => {
      setConnectedPanelOrigins(() => ["http://127.0.0.1:8199"]);
      const message = await enqueueAgainst(MISSING_ATTACHMENT);
      expect(message).toContain("http://127.0.0.1:8199");
      expect(message).toContain("a DIFFERENT ComfyUI from this target");
      // The recovery that actually works when the file is on the OTHER server.
      expect(message).toContain("panel_run");
    });

    it("RULES the split OUT when the panel is on the same ComfyUI", async () => {
      setConnectedPanelOrigins(() => ["http://127.0.0.1:8188"]);
      const message = await enqueueAgainst(MISSING_ATTACHMENT);
      expect(message).toContain("RULED OUT");
      expect(message).not.toContain("a DIFFERENT ComfyUI");
      // The transport-failure wording would be FALSE here: this process did
      // reach the server — it got a 400 back.
      expect(message).not.toContain("this process cannot");
    });

    it("#1175 parity: an ALIASED loopback spelling is the same server, and says so", async () => {
      setConnectedPanelOrigins(() => ["http://localhost:8188"]);
      const message = await enqueueAgainst(MISSING_ATTACHMENT);
      expect(message).toContain("RULED OUT");
      expect(message).toContain("http://localhost:8188");
      expect(message).toContain("the same host");
    });

    it("says NOTHING about drift when no panel is connected — an absent comparison is not a verdict", async () => {
      const message = await enqueueAgainst(MISSING_ATTACHMENT);
      expect(message).not.toContain("A connected panel is on");
      // …but the recovery, which does not depend on the comparison, still lands.
      expect(message).toContain("names a FILE on the server");
    });
  });

  describe("what must NOT collect the note", () => {
    it("a custom_validation_failed on a NON-loader input (a bad width)", async () => {
      const message = await enqueueAgainst(
        rejection({
          "7": {
            class_type: "EmptyLatentImage",
            errors: [
              {
                type: "custom_validation_failed",
                message: "Custom validation failed for node",
                details: "width - must be a multiple of 8",
                extra_info: { input_name: "width" },
              },
            ],
          },
        }),
      );
      expect(message).toContain("must be a multiple of 8");
      expect(message).not.toContain("names a FILE on the server");
    });

    it("a LOADER failing on one of its non-media inputs", async () => {
      const message = await enqueueAgainst(
        rejection({
          "5": {
            class_type: "LoadImage",
            errors: [
              {
                type: "custom_validation_failed",
                message: "Custom validation failed for node",
                details: "upload - nope",
                extra_info: { input_name: "upload" },
              },
            ],
          },
        }),
      );
      expect(message).not.toContain("names a FILE on the server");
    });

    it("a loader media input failing for a DIFFERENT reason (missing link, not missing file)", async () => {
      const message = await enqueueAgainst(
        rejection({
          "5": {
            class_type: "LoadImage",
            errors: [
              {
                type: "required_input_missing",
                message: "Required input is missing",
                details: "image",
                extra_info: { input_name: "image" },
              },
            ],
          },
        }),
      );
      expect(message).toContain("Required input is missing");
      expect(message).not.toContain("names a FILE on the server");
    });

    it("an unknown third-party loader — silence, never a guess", async () => {
      const message = await enqueueAgainst(
        rejection({
          "5": {
            class_type: "SomeVendorLoadImageFromPath",
            errors: [
              {
                type: "custom_validation_failed",
                message: "Custom validation failed for node",
                details: "image - Invalid image file: x.png",
                extra_info: { input_name: "image" },
              },
            ],
          },
        }),
      );
      expect(message).not.toContain("names a FILE on the server");
    });

    it("a node error with no machine `type` at all", async () => {
      const message = await enqueueAgainst(
        rejection({
          "5": {
            class_type: "LoadImage",
            errors: [{ message: "something", details: "image", extra_info: { input_name: "image" } }],
          },
        }),
      );
      expect(message).not.toContain("names a FILE on the server");
    });
  });

  // The OTHER error type is reachable for real: a loader that does NOT declare
  // the input in its own VALIDATE_INPUTS keeps ComfyUI's combo-membership check,
  // and a file absent from the input dir fails there instead. Same situation,
  // different token — matching only one would leave every video/audio loader out.
  it("fires on value_not_in_list too — the shape a video loader fails with", async () => {
    const message = await enqueueAgainst(
      rejection({
        "12": {
          class_type: "VHS_LoadVideo",
          errors: [
            {
              type: "value_not_in_list",
              message: "Value not in list",
              details: "video: 'clip.mp4' not in (list of length 41)",
              extra_info: { input_name: "video", input_config: null, received_value: "clip.mp4" },
            },
          ],
        },
      }),
    );
    expect(message).toContain("VHS_LoadVideo.video (node 12)");
    expect(message).toContain("names a FILE on the server");
  });

  // Every field the note interpolates comes out of the response body, so it goes
  // through the same #1191 scrub as the lines above it.
  it("routes its interpolated fields through the #1191 scrub", async () => {
    const message = await enqueueAgainst(MISSING_ATTACHMENT);
    expect(message).toContain("LoadImage.image (node 5)");
  });

  // Gate finding on the first round of this PR. `fetch` FOLLOWS redirects, so a
  // 307/308 in front of ComfyUI moves the POST to another origin — and the input
  // directory that was searched belongs to whoever ANSWERED. Naming the address
  // we posted to would point the reader at the proxy and compare the panel
  // against the wrong server, on the one message written to stop that guessing.
  describe("names the server that ANSWERED, not the one that was addressed", () => {
    it("uses the response's final URL when a redirect moved the request", async () => {
      comfyuiFetch.mockResolvedValueOnce(
        withFinalUrl(res(400, MISSING_ATTACHMENT), "http://gpu-box.lan:8188/prompt"),
      );
      const err = await enqueuePrompt({ "5": { class_type: "LoadImage", inputs: {} } }).catch(
        (e: unknown) => e,
      );
      const message = (err as Error).message;
      expect(message).toContain("http://gpu-box.lan:8188");
      expect(message).not.toContain("http://127.0.0.1:8188");
    });

    it("compares the PANEL against the responder, so a same-looking panel is not called a match", async () => {
      // The panel is on the address we posted to — but a redirect sent the prompt
      // somewhere else, so the split is REAL and must not read as ruled out.
      setConnectedPanelOrigins(() => ["http://127.0.0.1:8188"]);
      comfyuiFetch.mockResolvedValueOnce(
        withFinalUrl(res(400, MISSING_ATTACHMENT), "http://gpu-box.lan:8188/prompt"),
      );
      const err = await enqueuePrompt({ "5": { class_type: "LoadImage", inputs: {} } }).catch(
        (e: unknown) => e,
      );
      const message = (err as Error).message;
      expect(message).toContain("a DIFFERENT ComfyUI from this target");
      expect(message).not.toContain("RULED OUT");
    });

    it("falls back to the requested address when the response carries no url", async () => {
      // A constructed Response has url === "". Degrading to "" would name no
      // server at all — worse than naming the address we know we asked.
      const message = await enqueueAgainst(MISSING_ATTACHMENT);
      expect(message).toContain("http://127.0.0.1:8188");
    });
  });
});
