import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  searchNodes,
  getNodePackDetails,
  extractVersionString,
} from "../../services/registry-client.js";

const NODES = [
  {
    id: "ComfyUI-WanVideoWrapper",
    name: "WanVideoWrapper",
    description: "Wan Video diffusion nodes",
    author: "kijai",
    repository: "https://github.com/kijai/ComfyUI-WanVideoWrapper",
    latest_version: "1.0.0",
    total_install: 50_000,
  },
  {
    id: "PuLID-ComfyUI",
    name: "PuLID",
    description: "Identity-preserving generation",
    author: "cubiq",
    repository: "https://github.com/cubiq/PuLID_ComfyUI",
    latest_version: "1.0.0",
    total_install: 100_000,
  },
  {
    id: "some-other-pack",
    name: "Other",
    description: "Mentions wan in the description only",
    author: "nobody",
    repository: "https://github.com/nobody/other",
    latest_version: "0.1.0",
    total_install: 3,
  },
  {
    id: "unrelated-pack",
    name: "Unrelated",
    description: "Nothing matches",
    author: "x",
    repository: "https://github.com/x/unrelated",
    latest_version: "0.1.0",
    total_install: 1,
  },
];

describe("searchNodes (upstream-bug client-side filter)", () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    global.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ nodes: NODES }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    ) as unknown as typeof fetch;
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("filters and ranks client-side when upstream returns the full list", async () => {
    const results = await searchNodes("wan");
    // 'wan' appears in WanVideoWrapper id/name (high score) and in the
    // description of some-other-pack (low score). Unrelated and PuLID drop out.
    expect(results.map((r) => r.id)).toEqual([
      "ComfyUI-WanVideoWrapper",
      "some-other-pack",
    ]);
  });

  it("ranks id-exact above id-substring", async () => {
    const results = await searchNodes("pulid-comfyui");
    expect(results[0]?.id).toBe("PuLID-ComfyUI");
  });

  it("applies pagination after filtering", async () => {
    const results = await searchNodes("comfyui", { page: 2, limit: 1 });
    expect(results).toHaveLength(1);
  });

  it("requests a large fetch window so the client-side filter has data to rank", async () => {
    await searchNodes("anything");
    const call = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as string;
    expect(call).toMatch(/limit=100/);
    expect(call).toMatch(/page=1/);
  });

  it("returns the raw page when query is empty", async () => {
    const results = await searchNodes("");
    expect(results.length).toBeGreaterThan(0);
    // No filter applied — order matches input
    expect(results[0]?.id).toBe(NODES[0]!.id);
  });
});

describe("extractVersionString (registry version is an object, not a string)", () => {
  it("returns a bare string as-is", () => {
    expect(extractVersionString("1.2.3")).toBe("1.2.3");
  });

  it("pulls .version out of the registry's object shape", () => {
    expect(
      extractVersionString({ version: "8.28.3", changelog: "", createdAt: "x" }),
    ).toBe("8.28.3");
  });

  it("returns undefined for shapes with no usable version", () => {
    expect(extractVersionString(undefined)).toBeUndefined();
    expect(extractVersionString(null)).toBeUndefined();
    expect(extractVersionString({})).toBeUndefined();
    expect(extractVersionString({ version: 5 })).toBeUndefined();
  });
});

describe("getNodePackDetails version rendering (no more [object Object])", () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it("normalizes the object-shaped latest_version to a version string", async () => {
    global.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          id: "comfyui-impact-pack",
          name: "Impact Pack",
          description: "d",
          author: "a",
          repository: "https://github.com/ltdrdata/ComfyUI-Impact-Pack",
          // The real registry returns an OBJECT here, which used to stringify
          // to "[object Object]".
          latest_version: {
            version: "8.28.3",
            changelog: "",
            createdAt: "2026-04-19T17:08:04Z",
          },
          versions: [
            { version: "8.28.3", changelog: "latest" },
            { version: "8.0.0" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    ) as unknown as typeof fetch;

    const details = await getNodePackDetails("comfyui-impact-pack");
    expect(details.latest_version).toBe("8.28.3");
    expect(typeof details.latest_version).toBe("string");
    expect(details.versions).toEqual([
      { version: "8.28.3", changelog: "latest" },
      { version: "8.0.0", changelog: undefined },
    ]);
  });
});
