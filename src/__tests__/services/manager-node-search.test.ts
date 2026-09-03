// #1669 — panel_search_nodes failed the whole search when Manager's
// `customnode/getmappings?mode=cache` answered HTTP 500. A 500 is a Manager
// outage on one source, not a missing pack. searchNodesViaMappings must keep
// searching (remote/local) or name the outage.

import { afterEach, describe, expect, it } from "vitest";
import {
  HOST_HTTP_SEARCH_NOTE,
  dualCauseSearchFailure,
  isManagerMappingsServerError,
  isManagerTransportFetchFailure,
  managerMappingsOutageResult,
  GIT_ONLY_SEARCH_NOTE,
  gitMappingRepoName,
  isRawGitUrlInstallId,
  parseNodeMappings,
  sanitizeSearchInstallIds,
  searchNodesViaMappings,
  searchPanelNodes,
  setFetchMappingsForTests,
  type FetchMappings,
} from "../../services/manager-node-search.js";

afterEach(() => setFetchMappingsForTests(undefined));

const CACHE_500 = new Error("Manager customnode/getmappings?mode=cache: HTTP 500");

const REPORTER_SEARCH_FETCH =
  "ComfyUI-Manager request to /v2/customnode/getmappings?mode=cache did not complete: Failed to fetch.";

const CATALOGUE = {
  "https://github.com/someone/ComfyUI-SolAttn": [
    ["SolAttnPatch"],
    { title: "SolAttn", description: "Sage-attention patch node" },
  ],
  "https://github.com/ltdrdata/ComfyUI-Impact-Pack": [
    ["ImpactSomething"],
    { title: "ComfyUI-Impact-Pack", description: "impact pack" },
  ],
};

function fetchByMode(table: Partial<Record<string, unknown | Error>>): FetchMappings {
  return async (mode) => {
    const row = table[mode];
    if (row instanceof Error) throw row;
    if (row !== undefined) return row;
    throw new Error(`Manager customnode/getmappings?mode=${mode}: HTTP 500`);
  };
}

describe("isManagerMappingsServerError", () => {
  it("matches the reported panel error text", () => {
    expect(isManagerMappingsServerError(CACHE_500)).toBe(true);
    expect(
      isManagerMappingsServerError({
        isError: true,
        content: [{ type: "text", text: `Error: ${CACHE_500.message}` }],
      }),
    ).toBe(true);
  });

  it("does not treat 403, 404, or a no-match as a mappings 500", () => {
    expect(isManagerMappingsServerError(new Error("Manager customnode/getmappings: HTTP 403"))).toBe(false);
    expect(isManagerMappingsServerError(new Error("Manager customnode/getmappings: HTTP 404"))).toBe(false);
    expect(isManagerMappingsServerError({ count: 0, results: [] })).toBe(false);
  });
});

describe("isManagerTransportFetchFailure (#2492)", () => {
  it("matches the reporter getmappings wrap, including fail() ToolResult", () => {
    expect(isManagerTransportFetchFailure(new Error(REPORTER_SEARCH_FETCH))).toBe(true);
    expect(
      isManagerTransportFetchFailure({
        isError: true,
        content: [{ type: "text", text: `Error: ${REPORTER_SEARCH_FETCH}` }],
      }),
    ).toBe(true);
  });

  it("matches the reporter installed wrap and other browser transport causes", () => {
    expect(
      isManagerTransportFetchFailure(
        new Error(
          "ComfyUI-Manager request to /v2/customnode/installed?mode=default did not complete: Failed to fetch.",
        ),
      ),
    ).toBe(true);
    expect(
      isManagerTransportFetchFailure(
        new Error(
          "ComfyUI-Manager request to /v2/customnode/getmappings?mode=cache did not complete: NetworkError when attempting to fetch resource.",
        ),
      ),
    ).toBe(true);
    expect(
      isManagerTransportFetchFailure(
        new Error(
          "ComfyUI-Manager request to /customnode/getmappings?mode=cache did not complete: fetch failed",
        ),
      ),
    ).toBe(true);
  });

  it("does not treat HTTP status, AbortError, bare Failed to fetch, or a mid-sentence mention as transport", () => {
    expect(isManagerTransportFetchFailure(CACHE_500)).toBe(false);
    expect(isManagerTransportFetchFailure(new Error("Failed to fetch"))).toBe(false);
    expect(
      isManagerTransportFetchFailure(
        new Error(
          "ComfyUI-Manager request to /v2/customnode/getmappings?mode=cache did not complete: AbortError",
        ),
      ),
    ).toBe(false);
    expect(
      isManagerTransportFetchFailure(
        new Error(
          "ComfyUI-Manager request to /v2/manager/queue/task did not complete: Failed to fetch.",
        ),
      ),
    ).toBe(false);
    expect(
      isManagerTransportFetchFailure(
        new Error("Package validation failed: NetworkError in dependency metadata"),
      ),
    ).toBe(false);
    expect(
      isManagerTransportFetchFailure(
        new Error("fetch failed for upstream registry"),
      ),
    ).toBe(false);
    expect(isManagerTransportFetchFailure({ count: 1, results: [] })).toBe(false);
  });
});

describe("searchNodesViaMappings (#1669)", () => {
  it("keeps searching when cache mappings return HTTP 500", async () => {
    const res = await searchNodesViaMappings({
      query: "SolAttnPatch",
      fetchMappings: fetchByMode({
        cache: CACHE_500,
        remote: CATALOGUE,
      }),
    });
    expect(res.count).toBe(1);
    expect(res.results[0]?.id).toBe("ComfyUI-SolAttn");
    expect(res.results[0]?.id).not.toMatch(/^https?:\/\//i);
    expect(res.requested_mode).toBe("remote");
    expect(res.degraded_from).toBe("cache");
    expect(res.message).toMatch(/Manager outage/i);
    expect(res.message).not.toMatch(/does not exist|not found|missing pack/i);
  });

  it("names an all-modes 500 as a Manager outage, not a missing pack", async () => {
    const res = await searchNodesViaMappings({
      query: "SolAttnPatch",
      fetchMappings: fetchByMode({
        cache: CACHE_500,
        remote: new Error("Manager customnode/getmappings?mode=remote: HTTP 500"),
        local: new Error("Manager customnode/getmappings?mode=local: HTTP 502"),
      }),
    });
    expect(res.manager_outage).toBe(true);
    expect(res.supported).toBe(false);
    expect(res.count).toBe(0);
    expect(res.results).toEqual([]);
    expect(res.message).toMatch(/Manager outage/i);
    expect(res.message).not.toMatch(/does not exist|not found|missing pack/i);
    expect(res.reason).toMatch(/HTTP 50/);
  });

  it("does not retry when cache succeeds", async () => {
    const seen: string[] = [];
    const res = await searchNodesViaMappings({
      query: "impact",
      fetchMappings: async (mode) => {
        seen.push(mode);
        if (mode !== "cache") throw new Error("should not be asked");
        return CATALOGUE;
      },
    });
    expect(seen).toEqual(["cache"]);
    expect(res.count).toBe(1);
    expect(res.degraded_from).toBeUndefined();
    expect(res.manager_outage).toBeUndefined();
  });

  it("propagates a non-5xx mappings error from the first mode", async () => {
    await expect(
      searchNodesViaMappings({
        query: "x",
        fetchMappings: fetchByMode({
          cache: new Error("Manager customnode/getmappings?mode=cache: HTTP 403"),
        }),
      }),
    ).rejects.toThrow(/HTTP 403/);
  });
});

describe("searchPanelNodes (#1669)", () => {
  it("degrades to mappings search when the panel fail()s a cache 500", async () => {
    const out = await searchPanelNodes({
      query: "SolAttnPatch",
      panelSearch: async () => ({
        isError: true,
        content: [{ type: "text", text: `Error: ${CACHE_500.message}` }],
      }),
      fetchMappings: fetchByMode({ cache: CACHE_500, remote: CATALOGUE }),
    });
    expect(out.via).toBe("fallback");
    if (out.via !== "fallback") throw new Error("expected fallback");
    expect(out.value.count).toBe(1);
    expect(out.value.results[0]?.title).toBe("SolAttn");
  });

  it("degrades when the panel throws the same 500", async () => {
    const out = await searchPanelNodes({
      query: "SolAttnPatch",
      panelSearch: async () => {
        throw CACHE_500;
      },
      fetchMappings: fetchByMode({ cache: CACHE_500, local: CATALOGUE }),
    });
    expect(out.via).toBe("fallback");
    if (out.via !== "fallback") throw new Error("expected fallback");
    expect(out.value.requested_mode).toBe("local");
    expect(out.value.count).toBe(1);
  });

  it("passes a successful panel result through", async () => {
    const panel = { count: 1, results: [{ id: "a", title: "A", description: "" }] };
    const out = await searchPanelNodes({
      query: "A",
      panelSearch: async () => panel,
      fetchMappings: async () => {
        throw new Error("fallback must not run");
      },
    });
    expect(out).toEqual({ via: "panel", value: panel });
  });

  it("rewrites a panel hit whose id is the reporter GitHub URL (#1539)", async () => {
    const url = "https://github.com/Slimy-Comfy/Slimy_ImageComparer";
    const panel = {
      count: 1,
      results: [{ id: url, title: "ImageComparer", description: "compare images" }],
    };
    const out = await searchPanelNodes({
      query: "ImageComparer",
      panelSearch: async () => panel,
      fetchMappings: async () => {
        throw new Error("fallback must not run");
      },
    });
    expect(out.via).toBe("panel");
    if (out.via !== "panel") throw new Error("expected panel");
    const value = out.value as {
      results: Array<{ id: string; repository?: string; git?: true }>;
      note?: string;
    };
    expect(value.results[0]?.id).toBe("Slimy_ImageComparer");
    expect(isRawGitUrlInstallId(value.results[0]!.id)).toBe(false);
    expect(value.results[0]?.repository).toBe(url);
    expect(value.results[0]?.git).toBe(true);
    expect(value.note).toBe(GIT_ONLY_SEARCH_NOTE);
  });
});

describe("sanitizeSearchInstallIds (#1539)", () => {
  it("rewrites Git URL ids inside a ToolResult JSON body", () => {
    const url = "https://github.com/Slimy-Comfy/Slimy_ImageComparer";
    const sanitized = sanitizeSearchInstallIds({
      content: [{ type: "text", text: JSON.stringify({ count: 1, results: [{ id: url, title: "ImageComparer", description: "" }] }) }],
    }) as { content: Array<{ text: string }> };
    const body = JSON.parse(sanitized.content[0]!.text) as {
      results: Array<{ id: string; git?: true }>;
    };
    expect(body.results[0]?.id).toBe(gitMappingRepoName(url));
    expect(body.results[0]?.git).toBe(true);
  });
});

describe("searchPanelNodes (#2492 transport Failed to fetch)", () => {
  it("live tab + panel Manager fetch fail + host mappings → packs, source host_http", async () => {
    const out = await searchPanelNodes({
      query: "SolAttnPatch",
      panelSearch: async () => ({
        isError: true,
        content: [{ type: "text", text: `Error: ${REPORTER_SEARCH_FETCH}` }],
      }),
      fetchMappings: fetchByMode({ cache: CATALOGUE }),
    });
    expect(out.via).toBe("fallback");
    if (out.via !== "fallback") throw new Error("expected fallback");
    expect(out.value.source).toBe("host_http");
    expect(out.value.note).toContain(HOST_HTTP_SEARCH_NOTE);
    expect(out.value.note).toMatch(/not a Manager outage/i);
    expect(out.value.note).not.toMatch(/does not exist|not found/i);
    expect(out.value.manager_outage).toBeUndefined();
    expect(out.value.count).toBe(1);
    expect(out.value.results[0]?.title).toBe("SolAttn");
  });

  it("falls back when the panel throws the reporter wrap", async () => {
    const out = await searchPanelNodes({
      query: "impact",
      panelSearch: async () => {
        throw new Error(REPORTER_SEARCH_FETCH);
      },
      fetchMappings: fetchByMode({ cache: CATALOGUE }),
    });
    expect(out.via).toBe("fallback");
    if (out.via !== "fallback") throw new Error("expected fallback");
    expect(out.value.source).toBe("host_http");
    expect(out.value.count).toBe(1);
  });

  it("transport + host HTTP failure → dual cause, not a missing pack, not outage-from-transport", async () => {
    const out = await searchPanelNodes({
      query: "ComfyUI-Lightning",
      panelSearch: async () => {
        throw new Error(REPORTER_SEARCH_FETCH);
      },
      fetchMappings: async () => {
        throw new Error("Manager customnode/getmappings?mode=cache: HTTP 403");
      },
    });
    expect(out.via).toBe("fallback");
    if (out.via !== "fallback") throw new Error("expected fallback");
    expect(out.value.count).toBe(0);
    expect(out.value.results).toEqual([]);
    expect(out.value.manager_outage).toBeUndefined();
    expect(out.value.message).toMatch(/did not complete/i);
    expect(out.value.message).toMatch(/HTTP 403/);
    expect(out.value.message).toMatch(/not a Manager outage inferred from a transport-only fetch failure/i);
    expect(out.value.message).not.toMatch(/does not exist|not found/i);
    expect(out.value.message).not.toMatch(/Manager down/i);
  });

  it("does not host-fallback a live-tab mappings HTTP 403", async () => {
    await expect(
      searchPanelNodes({
        query: "x",
        panelSearch: async () => {
          throw new Error("Manager customnode/getmappings?mode=cache: HTTP 403");
        },
        fetchMappings: fetchByMode({ cache: CATALOGUE }),
      }),
    ).rejects.toThrow(/HTTP 403/);
  });
});

describe("parseNodeMappings / outage copy", () => {
  it("does not return a raw Git URL as the install id (#1539)", () => {
    const res = parseNodeMappings(CATALOGUE, "SolAttn", 15);
    expect(res.results[0]?.id).toBe("ComfyUI-SolAttn");
    expect(res.results[0]?.id).not.toMatch(/^https?:\/\//i);
    expect(res.results[0]?.repository).toBe("https://github.com/someone/ComfyUI-SolAttn");
    expect(res.results[0]?.git).toBe(true);
    expect(res.results[0]?.title).toBe("SolAttn");
    expect(res.note).toBe(GIT_ONLY_SEARCH_NOTE);
  });

  it("prefers a CNR id over the git mapping key", () => {
    const res = parseNodeMappings(
      {
        "https://github.com/ltdrdata/ComfyUI-Impact-Pack": [
          ["ImpactSomething"],
          { id: "comfyui-impact-pack", title: "ComfyUI-Impact-Pack", description: "impact pack" },
        ],
      },
      "impact",
      15,
    );
    expect(res.results[0]?.id).toBe("comfyui-impact-pack");
    expect(res.results[0]?.git).toBeUndefined();
    expect(res.results[0]?.repository).toBe("https://github.com/ltdrdata/ComfyUI-Impact-Pack");
  });

  it("does not return the reporter's ImageComparer GitHub URL as id", () => {
    const url = "https://github.com/Slimy-Comfy/Slimy_ImageComparer";
    const res = parseNodeMappings(
      {
        [url]: [["ImageComparer"], { title: "Slimy Image Comparer", description: "compare images" }],
      },
      "ImageComparer",
      15,
    );
    expect(res.count).toBe(1);
    expect(res.results[0]?.id).toBe("Slimy_ImageComparer");
    expect(isRawGitUrlInstallId(res.results[0]!.id)).toBe(false);
    expect(res.results[0]?.repository).toBe(url);
    expect(res.results[0]?.git).toBe(true);
  });

  it("matches a node CLASS name in the mappings first array", () => {
    // The reporter searched SolAttnPatch — a class_type, not a pack title.
    const res = parseNodeMappings(CATALOGUE, "SolAttnPatch", 15);
    expect(res.count).toBe(1);
    expect(res.results[0]?.id).toBe("ComfyUI-SolAttn");
  });

  it("outage copy names Manager, not a missing pack", () => {
    const res = managerMappingsOutageResult("SolAttnPatch", CACHE_500);
    expect(res.manager_outage).toBe(true);
    expect(res.message).toMatch(/Manager outage/);
    expect(res.message).not.toMatch(/does not exist/);
  });

  it("dual-cause transport copy names both fetches, not a missing pack", () => {
    const res = dualCauseSearchFailure(
      "ComfyUI-Lightning",
      new Error(REPORTER_SEARCH_FETCH),
      new Error("unreadable payload"),
    );
    expect(res.query).toBe("ComfyUI-Lightning");
    expect(res.message).toMatch(/Failed to fetch/);
    expect(res.message).toMatch(/unreadable payload/);
    expect(res.message).toMatch(/not a Manager outage inferred from a transport-only fetch failure/);
    expect(res.message).not.toMatch(/does not exist/);
    expect(res.manager_outage).toBeUndefined();
  });
});
