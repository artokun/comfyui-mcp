import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { jsonResponse, type JsonValue } from "../helpers/fake-fetch.js";

// backfillObjectInfo honors the LIVE /object_info/<Type> registration key even
// when it differs from the requested string in case, namespace, or
// display-vs-class name (#404: create_workflow (action:"node_info") reported "no match" for the
// clearly-registered DetectorForNSFW because the strict def[t] guard narrowed
// away the node whose returned key differed).

vi.mock("../../config.js", async () => {
  const actual = await vi.importActual<typeof import("../../config.js")>(
    "../../config.js",
  );
  return {
    ...actual,
    isCloudMode: () => false,
    getComfyUIBaseUrl: () => "http://127.0.0.1:8188",
  };
});

const comfyuiFetch = vi.fn();
vi.mock("../../comfyui/fetch.js", () => ({
  comfyuiFetch: (...a: unknown[]) => comfyuiFetch(...a),
}));

const { backfillObjectInfo } = await import("../../comfyui/client.js");

function okJson(body: JsonValue): Response {
  return jsonResponse(body);
}

describe("backfillObjectInfo (#404)", () => {
  beforeEach(() => comfyuiFetch.mockReset());
  afterEach(() => vi.clearAllMocks());

  it("backfills a node absent from bulk when the endpoint returns it under the exact key", async () => {
    comfyuiFetch.mockResolvedValueOnce(
      okJson({ DetectorForNSFW: { input: {}, name: "DetectorForNSFW" } }),
    );
    const merged = await backfillObjectInfo({} as never, ["DetectorForNSFW"]);
    expect(merged.DetectorForNSFW).toBeDefined();
  });

  it("still merges the node when the live registration key differs (case/namespace/display)", async () => {
    // The requested string is `DetectorForNSFW` but the server returns the def
    // under a namespaced/canonical key. The old `def[t]`-only guard dropped it,
    // making create_workflow (action:"node_info") report no match. Now we honor whatever key comes back.
    comfyuiFetch.mockResolvedValueOnce(
      okJson({
        "utils-nodes/DetectorForNSFW": { input: {}, name: "DetectorForNSFW" },
      }),
    );
    const merged = await backfillObjectInfo({} as never, ["DetectorForNSFW"]);
    expect(merged["utils-nodes/DetectorForNSFW"]).toBeDefined();
    // A case-insensitive substring filter (what create_workflow (action:"node_info") uses) now finds it.
    const hit = Object.keys(merged).some((k) =>
      k.toLowerCase().includes("detectorfornsfw"),
    );
    expect(hit).toBe(true);
  });

  it("skips node types already present in the bulk payload (no fetch)", async () => {
    const merged = await backfillObjectInfo(
      { DetectorForNSFW: { input: {} } } as never,
      ["DetectorForNSFW"],
    );
    expect(comfyuiFetch).not.toHaveBeenCalled();
    expect(merged).toEqual({ DetectorForNSFW: { input: {} } });
  });

  it("leaves the node missing when the endpoint returns an empty object", async () => {
    comfyuiFetch.mockResolvedValueOnce(okJson({}));
    const merged = await backfillObjectInfo({} as never, ["Ghost"]);
    expect(Object.keys(merged)).toHaveLength(0);
  });
});
