// #918 — "No local models found." was printed for three different situations, one
// of which was "we never got an answer".
//
// Against a remote ComfyUI that was still warming up, every `/models/<dir>` read
// failed silently, `httpReturnedAny` stayed false, the filesystem fallback returned
// [] because a remote setup has no comfyuiPath, and the tool printed the empty
// install sentence. A reporter read it as a misconfigured URL and told the user so.
// The same call returned the full list minutes later.
//
// The listing therefore has to carry HOW it knows, and the renderer has to decline
// to claim "none" when nothing answered.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mode = vi.hoisted(() => ({ remote: false }));
vi.mock("../../config.js", () => ({
  config: { comfyuiPath: "/comfy" as string | undefined },
  isRemoteMode: () => mode.remote,
}));

const fetchApi = vi.fn();
const getClient = vi.fn();
vi.mock("../../comfyui/client.js", () => ({
  getClient: (...args: unknown[]) => getClient(...args),
  // #385 — call sites moved from `client.fetchApi` to `comfyApiFetch`, which
  // returns a 4xx instead of throwing. Routed through the SAME double so every
  // existing impl and route assertion in this file keeps pinning the same thing.
  comfyApiFetch: (...a: unknown[]) =>
    (getClient() as { fetchApi: (...x: unknown[]) => unknown }).fetchApi(...a),
}));

const readdir = vi.fn();
const stat = vi.fn();
const readFile = vi.fn();
vi.mock("node:fs/promises", () => ({
  readdir: (...a: unknown[]) => readdir(...a),
  stat: (...a: unknown[]) => stat(...a),
  readFile: (...a: unknown[]) => readFile(...a),
  copyFile: vi.fn(),
  link: vi.fn(),
  mkdir: vi.fn(),
  rename: vi.fn(),
  rm: vi.fn(),
  utimes: vi.fn(),
}));

const { config } = await import("../../config.js");
const { listLocalModelsWithCoverage, describeUnparsableBody } = await import(
  "../../services/model-resolver.js"
);
const { describeEmptyModelListing } = await import("../../tools/model-management.js");

beforeEach(() => {
  getClient.mockReset();
  fetchApi.mockReset();
  readdir.mockReset();
  stat.mockReset();
  readFile.mockReset();
  readFile.mockRejectedValue(new Error("ENOENT"));
  config.comfyuiPath = "/comfy";
  mode.remote = false;
});

afterEach(() => vi.clearAllMocks());

describe("#918: the listing records whether ComfyUI actually answered", () => {
  it("an OK empty array is an ANSWER — emptiness here is a verified fact", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response("[]", { status: 200 }));
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { models, coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(models).toEqual([]);
    expect(coverage.answered).toEqual(["checkpoints"]);
    expect(coverage.unanswered).toEqual([]);
  });

  it("a non-OK status is NOT an answer, and the status is kept", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response("nope", { status: 503 }));
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(coverage.answered).toEqual([]);
    expect(coverage.unanswered).toEqual([{ dir: "checkpoints", reason: "HTTP 503" }]);
  });

  // The reported shape: a proxy or a still-starting server answers 200 with an
  // HTML login/placeholder page. The old code `continue`d and the category
  // vanished without trace; res.json() would have raised the bare
  // `Unexpected token '<', "<!doctype "...` the reporter flagged on the sibling
  // tool. Name the condition instead of leaking the parser's message.
  it("a 200 carrying HTML is reported as HTML, not as a JSON parser error", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response("<!doctype html><html>…", { status: 200 }));
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(coverage.answered).toEqual([]);
    expect(coverage.unanswered[0].reason).toMatch(/returned HTML instead of JSON/);
    expect(coverage.unanswered[0].reason).toMatch(/still starting/);
    expect(coverage.unanswered[0].reason).not.toMatch(/Unexpected token/);
  });

  it("valid JSON of the wrong shape is distinguished from HTML", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockResolvedValue(new Response('{"error":"unauthorized"}', { status: 200 }));
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(coverage.unanswered[0].reason).toMatch(/JSON but not an array/);
  });

  it("a thrown fetch is recorded with its message, not swallowed", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockRejectedValue(new Error("connect ECONNREFUSED 10.0.0.4:8188"));
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(coverage.unanswered[0].reason).toMatch(/ECONNREFUSED/);
  });

  // The exact #918 shape: remote (no comfyuiPath), so there is no second source
  // to consult, and the empty array carries no information whatsoever.
  it("remote + no answer sets noSourceAvailable — nothing was learned at all", async () => {
    config.comfyuiPath = undefined;
    mode.remote = true;
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockRejectedValue(new Error("fetch failed"));
    const { models, coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(models).toEqual([]);
    expect(coverage.noSourceAvailable).toBe(true);
    expect(coverage.unanswered).toHaveLength(1);
  });

  it("a local install with an unreachable server still reports the categories it could not read", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockRejectedValue(new Error("fetch failed"));
    readdir.mockResolvedValue(["sd_xl.safetensors"]);
    stat.mockResolvedValue({ isFile: () => true, size: 1024, mtime: new Date(0) });
    const { models, coverage } = await listLocalModelsWithCoverage("checkpoints");
    expect(models).toHaveLength(1); // the FS scan saved it
    expect(coverage.usedFilesystem).toBe(true);
    expect(coverage.noSourceAvailable).toBeUndefined();
    expect(coverage.unanswered).toHaveLength(1);
  });

  // getClient throws in cloud mode, before any per-category read runs. Every
  // requested category is then unanswered — not answered-and-empty.
  it("an outright unavailable client marks EVERY requested category unanswered", async () => {
    config.comfyuiPath = undefined;
    mode.remote = true;
    getClient.mockImplementation(() => {
      throw new Error("CLOUD_UNSUPPORTED");
    });
    const { coverage } = await listLocalModelsWithCoverage();
    expect(coverage.httpUnavailable).toMatch(/CLOUD_UNSUPPORTED/);
    expect(coverage.answered).toEqual([]);
    expect(coverage.unanswered.length).toBeGreaterThan(10); // all of MODEL_SUBDIRS
    expect(coverage.noSourceAvailable).toBe(true);
  });
});

describe("#918: what an empty listing is allowed to say", () => {
  const empty = { answered: [] as string[], unanswered: [], usedFilesystem: false };

  it("says 'no models' ONLY when every category answered", () => {
    expect(describeEmptyModelListing(undefined, { ...empty, answered: ["checkpoints"] })).toBe(
      "No local models found.",
    );
    expect(describeEmptyModelListing("loras", { ...empty, answered: ["loras"] })).toBe(
      "No loras models found.",
    );
  });

  // THE fix. The old text asserted an empty install from zero information.
  it("refuses to claim 'none' when nothing answered", () => {
    const text = describeEmptyModelListing("checkpoints", {
      ...empty,
      unanswered: [{ dir: "checkpoints", reason: "fetch failed" }],
      noSourceAvailable: true,
    });
    expect(text).toMatch(/Could not determine/);
    expect(text).toMatch(/NOT the same as having none/);
    expect(text).not.toMatch(/^No checkpoints models found\.$/);
    // and it names the reason, so the reader can act instead of guessing
    expect(text).toMatch(/fetch failed/);
    expect(text).toMatch(/get_system_stats/);
  });

  it("names the missing fallback so remote isn't mistaken for a bad path", () => {
    const text = describeEmptyModelListing(undefined, {
      ...empty,
      unanswered: [{ dir: "checkpoints", reason: "HTTP 502" }],
      noSourceAvailable: true,
    });
    expect(text).toMatch(/no local ComfyUI path to scan/);
  });

  it("calls a mixed result PARTIAL rather than empty", () => {
    const text = describeEmptyModelListing(undefined, {
      answered: ["checkpoints", "loras"],
      unanswered: [{ dir: "vae", reason: "HTTP 500" }],
      usedFilesystem: false,
    });
    expect(text).toMatch(/PARTIAL/);
    expect(text).toMatch(/checkpoints, loras/);
    expect(text).toMatch(/vae: HTTP 500/);
    expect(text).toMatch(/before concluding they are absent/);
  });

  it("does not dump an unbounded list of failed categories", () => {
    const text = describeEmptyModelListing(undefined, {
      ...empty,
      unanswered: Array.from({ length: 15 }, (_, i) => ({ dir: `d${i}`, reason: "fetch failed" })),
    });
    expect(text).toMatch(/…and 7 more/);
  });
});

// #1015 — the follow-on. Coverage correctly refused to call these categories
// empty, but described WHY in the vaguest available terms: an EMPTY body was
// reported as "a non-JSON body (a proxy, login page, or a server still starting
// answers this way)". None of those three produces zero bytes, and the status
// — which the reporter explicitly asked for, to tell an empty category apart
// from a transport failure — was dropped on every parse-failure branch.
//
// What must NOT change: an unparsable answer still leaves the category
// UNANSWERED. This is about the accuracy of the reason, not the verdict.
describe("#1015: an unparsable category body is described from what was observed", () => {
  it("names an EMPTY body as empty, and does not offer proxy/login/starting guesses", () => {
    const reason = describeUnparsableBody(200, "");
    expect(reason).toMatch(/EMPTY body/);
    expect(reason).toMatch(/0 bytes/);
    expect(reason).toMatch(/HTTP 200/);
    // The three causes that cannot produce an empty body.
    expect(reason).not.toMatch(/proxy/);
    expect(reason).not.toMatch(/login/);
    expect(reason).not.toMatch(/still starting/);
    // And never the raw parser message the reporter saw on 0.50.2.
    expect(reason).not.toMatch(/Unexpected end of JSON input/);
  });

  it("treats a whitespace-only body as empty too", () => {
    expect(describeUnparsableBody(200, "\r\n  \n")).toMatch(/EMPTY body/);
  });

  it("keeps the HTML reading, and now carries the status with it", () => {
    const reason = describeUnparsableBody(200, "<!doctype html><html><body>Sign in</body></html>");
    expect(reason).toMatch(/returned HTML instead of JSON/);
    expect(reason).toMatch(/still starting/);
    expect(reason).toMatch(/HTTP 200/);
  });

  it("quotes a bounded excerpt for a body that is neither empty nor markup", () => {
    const reason = describeUnparsableBody(200, "not json at all");
    expect(reason).toMatch(/not JSON/);
    expect(reason).toMatch(/15 bytes/);
    expect(reason).toMatch(/not json at all/);
  });

  it("bounds the excerpt so a large body cannot flood the tool result", () => {
    const reason = describeUnparsableBody(500, "x".repeat(50_000));
    expect(reason.length).toBeLessThan(200);
    expect(reason).toMatch(/50000 bytes/);
    expect(reason).toMatch(/HTTP 500/);
  });

  it("collapses a multi-line body onto one line", () => {
    expect(describeUnparsableBody(200, "line one\nline two")).not.toMatch(/\n/);
  });

  // The end-to-end shape the reporter hit: two categories answer 200 with an
  // empty body while the rest answer normally.
  it("leaves an empty-bodied category UNANSWERED, never empty", async () => {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (url: string) =>
      url.endsWith("/models/clip")
        ? new Response("", { status: 200 })
        : new Response(JSON.stringify(["m.safetensors"]), { status: 200 }),
    );
    readdir.mockRejectedValue(new Error("ENOENT"));

    const { coverage } = await listLocalModelsWithCoverage("clip");
    expect(coverage.answered).toEqual([]);
    expect(coverage.unanswered).toHaveLength(1);
    expect(coverage.unanswered[0].dir).toBe("clip");
    expect(coverage.unanswered[0].reason).toMatch(/EMPTY body/);
    expect(coverage.unanswered[0].reason).not.toMatch(/Unexpected end of JSON input/);
  });
});

// #962 — a filtered empty is a true statement about the WRONG folder.
//
// A reporter called list_local_models({model_type:"diffusion_models"}) and
// {"unet"} against a remote server whose UNETLoader was loading
// krastBf16_v3.safetensors at that moment. Both answered 200 with [], honestly:
// the weights are registered under neither name. The unfiltered path discovers
// every registered category; a filtered one skips discovery precisely because it
// "already names its exact category" — which is what makes the answer misleading.
describe("#962: a filtered empty says where else to look", () => {
  /** `/models` lists categories; `/models/<dir>` lists that category's files. */
  function serverWith(categories: string[], filesByCat: Record<string, string[]> = {}) {
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) => {
      if (path === "/models") return new Response(JSON.stringify(categories), { status: 200 });
      const cat = path.replace(/^\/models\//, "");
      return new Response(JSON.stringify(filesByCat[cat] ?? []), { status: 200 });
    });
    readdir.mockRejectedValue(new Error("ENOENT"));
  }

  it("collects the OTHER registered categories when the asked-for one is empty", async () => {
    serverWith(["diffusion_models", "unet_gguf", "checkpoints"]);
    const { models, coverage } = await listLocalModelsWithCoverage("diffusion_models");
    expect(models).toEqual([]);
    // The asked-for category is excluded — repeating it back is not a lead.
    expect(coverage.otherRegisteredCategories).toEqual(["unet_gguf", "checkpoints"]);
  });

  it("does NOT pay for the extra call when the listing found something", async () => {
    serverWith(["diffusion_models", "checkpoints"], { diffusion_models: ["a.safetensors"] });
    const { models, coverage } = await listLocalModelsWithCoverage("diffusion_models");
    expect(models.length).toBe(1);
    expect(coverage.otherRegisteredCategories).toBeUndefined();
    expect(fetchApi.mock.calls.filter((c) => c[0] === "/models")).toHaveLength(0);
  });

  it("leaves it UNDEFINED when the category list cannot be read", async () => {
    // "Could not ask" must not render as "there is nowhere else to look" — the
    // same fold this coverage type exists to prevent.
    getClient.mockReturnValue({ fetchApi });
    fetchApi.mockImplementation(async (path: string) =>
      path === "/models"
        ? new Response("nope", { status: 503 })
        : new Response("[]", { status: 200 }),
    );
    readdir.mockRejectedValue(new Error("ENOENT"));
    const { coverage } = await listLocalModelsWithCoverage("diffusion_models");
    expect(coverage.otherRegisteredCategories).toBeUndefined();
  });

  it("does not ask at all for an UNFILTERED call — it already discovers them", async () => {
    serverWith(["diffusion_models", "unet_gguf"]);
    const { coverage } = await listLocalModelsWithCoverage();
    expect(coverage.otherRegisteredCategories).toBeUndefined();
  });
});

describe("#962: the message names the other categories instead of claiming none", () => {
  const base = { answered: ["diffusion_models"], unanswered: [], usedFilesystem: false };

  it("stops asserting an empty install, and points at the real folders", () => {
    const text = describeEmptyModelListing("diffusion_models", {
      ...base,
      otherRegisteredCategories: ["unet_gguf", "checkpoints"],
    });
    // The sentence the reporter acted on.
    expect(text).not.toMatch(/^No diffusion_models models found\.$/);
    expect(text).toMatch(/fact about ONE folder, not about this install/);
    expect(text).toMatch(/unet_gguf/);
    expect(text).toMatch(/checkpoints/);
    // And the two ways out.
    expect(text).toMatch(/NO model_type/);
  });

  it("keeps the plain sentence when the server registers nothing else", () => {
    // Genuinely the only category: "none" is then the whole truth and extra
    // hedging would be noise.
    const text = describeEmptyModelListing("diffusion_models", {
      ...base,
      otherRegisteredCategories: [],
    });
    expect(text).toBe("No diffusion_models models found.");
  });

  it("keeps the plain sentence when the category list could not be read", () => {
    expect(describeEmptyModelListing("diffusion_models", base)).toBe(
      "No diffusion_models models found.",
    );
  });

  it("an UNANSWERED category still wins — that path says 'could not determine'", () => {
    const text = describeEmptyModelListing("diffusion_models", {
      answered: [],
      unanswered: [{ dir: "diffusion_models", reason: "HTTP 503" }],
      usedFilesystem: false,
      otherRegisteredCategories: ["checkpoints"],
    });
    expect(text).toMatch(/Could not determine/);
    expect(text).not.toMatch(/fact about ONE folder/);
  });
});
