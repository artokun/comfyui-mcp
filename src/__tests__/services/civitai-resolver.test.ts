import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Mock config so civitaiApiToken is controllable per test.
vi.mock("../../config.js", () => ({
  config: { civitaiApiToken: undefined as string | undefined },
}));

import { config } from "../../config.js";
import {
  resolveCivitaiModel,
  resolveCivitaiModelVersion,
  searchCivitaiModels,
  searchCivitaiCreators,
  fetchCivitaiTopCreators,
} from "../../services/civitai-resolver.js";
import { ModelError, ValidationError } from "../../utils/errors.js";

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 404 ? "Not Found" : "OK",
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

const fetchMock = vi.fn();

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  config.civitaiApiToken = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("resolveCivitaiModelVersion", () => {
  it("returns the primary file's download URL and filename", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 12345,
        name: "v1.0",
        files: [
          { name: "secondary.safetensors", downloadUrl: "https://civitai.com/api/download/models/999", primary: false },
          { name: "primary.safetensors", downloadUrl: "https://civitai.com/api/download/models/12345", primary: true },
        ],
      }),
    );

    const res = await resolveCivitaiModelVersion(12345);

    expect(fetchMock).toHaveBeenCalledWith(
      "https://civitai.com/api/v1/model-versions/12345",
      expect.objectContaining({ headers: {} }),
    );
    expect(res.downloadUrl).toBe("https://civitai.com/api/download/models/12345");
    expect(res.filename).toBe("primary.safetensors");
    expect(res.versionId).toBe(12345);
  });

  it("falls back to the first file when none is marked primary", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 7,
        files: [{ name: "a.safetensors", downloadUrl: "https://civitai.com/api/download/models/7" }],
      }),
    );

    const res = await resolveCivitaiModelVersion(7);
    expect(res.downloadUrl).toBe("https://civitai.com/api/download/models/7");
    expect(res.filename).toBe("a.safetensors");
  });

  it("synthesizes a download URL when no file URL is present", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 555, files: [] }));
    const res = await resolveCivitaiModelVersion(555);
    expect(res.downloadUrl).toBe("https://civitai.com/api/download/models/555");
    expect(res.filename).toBeUndefined();
  });

  it("sends the bearer header on the API request but never embeds the token in the download URL", async () => {
    config.civitaiApiToken = "secret-token";
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 42,
        files: [{ name: "m.safetensors", downloadUrl: "https://civitai.com/api/download/models/42", primary: true }],
      }),
    );

    const res = await resolveCivitaiModelVersion(42);

    // The API request carries the bearer header...
    expect(fetchMock).toHaveBeenCalledWith(
      "https://civitai.com/api/v1/model-versions/42",
      expect.objectContaining({ headers: { Authorization: "Bearer secret-token" } }),
    );
    // ...but the resolved download URL must NOT contain the token, so it cannot
    // leak into logs, errors, or redirect URLs. downloadModel attaches the token
    // as an Authorization header instead.
    expect(res.downloadUrl).toBe("https://civitai.com/api/download/models/42");
    expect(res.downloadUrl).not.toContain("token");
    expect(res.downloadUrl).not.toContain("secret-token");
  });

  it("returns the API-provided download URL unchanged when a token is set", async () => {
    config.civitaiApiToken = "tok";
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 1,
        files: [{ downloadUrl: "https://civitai.com/api/download/models/1?foo=bar", primary: true }],
      }),
    );
    const res = await resolveCivitaiModelVersion(1);
    expect(res.downloadUrl).toBe("https://civitai.com/api/download/models/1?foo=bar");
    expect(res.downloadUrl).not.toContain("tok");
  });

  it("throws ModelError on 404", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 404));
    await expect(resolveCivitaiModelVersion(404)).rejects.toBeInstanceOf(ModelError);
  });

  it("throws ModelError on other API errors", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 500));
    await expect(resolveCivitaiModelVersion(1)).rejects.toBeInstanceOf(ModelError);
  });
});

describe("civitai request error surfacing (distinct failure modes)", () => {
  // Each failure mode must surface as a DISTINCT, actionable message — never a
  // swallowed empty and never conflated with a neighbouring status (WS-6 #204).
  it("401 without a token → 'requires authentication' (set the token)", async () => {
    config.civitaiApiToken = undefined;
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    await expect(resolveCivitaiModelVersion(1)).rejects.toThrow(
      /requires authentication.*set CIVITAI_API_TOKEN/i,
    );
  });

  it("401 WITH a token → 'token invalid or expired' (refresh it)", async () => {
    config.civitaiApiToken = "stale-token";
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    await expect(resolveCivitaiModelVersion(1)).rejects.toThrow(
      /invalid or expired.*refresh CIVITAI_API_TOKEN/i,
    );
  });

  it("403 → 'forbidden' (permission or region), distinct from 401", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 403));
    await expect(resolveCivitaiModelVersion(1)).rejects.toThrow(
      /403 Forbidden.*permission.*region/i,
    );
  });

  it("429 → 'rate-limited' (back off and retry), distinct from an upstream 5xx", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 429));
    await expect(resolveCivitaiModelVersion(1)).rejects.toThrow(
      /rate-limited.*429.*retry/i,
    );
  });

  it("5xx → 'upstream error' flagged transient", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
    await expect(resolveCivitaiModelVersion(1)).rejects.toThrow(
      /upstream error.*503.*transient/i,
    );
  });

  it("our own timeout abort → distinct 'timed out' message (not a hang, not empty)", async () => {
    const timeoutErr = Object.assign(new Error("The operation timed out."), {
      name: "TimeoutError",
    });
    fetchMock.mockRejectedValueOnce(timeoutErr);
    await expect(resolveCivitaiModelVersion(1)).rejects.toThrow(
      /timed out.*unreachable/i,
    );
    await expect(
      (async () => {
        fetchMock.mockRejectedValueOnce(timeoutErr);
        return resolveCivitaiModelVersion(1);
      })(),
    ).rejects.toBeInstanceOf(ModelError);
  });

  it("network failure (fetch rejects TypeError) → distinct 'unreachable' message", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    await expect(resolveCivitaiModelVersion(1)).rejects.toThrow(
      /unreachable.*network error/i,
    );
  });

  it("2xx that is NOT JSON (bot-gate/interstitial) → distinct non-JSON error, not a garbage empty", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw new SyntaxError("Unexpected token < in JSON");
      },
      text: async () => "<html>Just a moment…</html>",
    } as unknown as Response);
    await expect(resolveCivitaiModelVersion(1)).rejects.toThrow(
      /non-JSON response.*bot-gate|interstitial/i,
    );
  });

  it("an abort DURING the body read is classified as a timeout, NOT a non-JSON bot-gate", async () => {
    // Headers arrived (2xx), then the connection aborts while draining the body.
    const abortErr = Object.assign(new Error("The operation was aborted."), {
      name: "AbortError",
    });
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw abortErr;
      },
      text: async () => "",
    } as unknown as Response);
    await expect(resolveCivitaiModelVersion(1)).rejects.toThrow(/timed out/i);
    // Distinctly NOT the non-JSON category.
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw abortErr;
      },
      text: async () => "",
    } as unknown as Response);
    await expect(resolveCivitaiModelVersion(1)).rejects.not.toThrow(/non-JSON/i);
  });

  it("a network failure DURING the body read is classified as unreachable, NOT non-JSON", async () => {
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => {
        throw new TypeError("terminated");
      },
      text: async () => "",
    } as unknown as Response);
    await expect(resolveCivitaiModelVersion(1)).rejects.toThrow(
      /unreachable.*network error/i,
    );
  });

  it("applies a request timeout signal to every civitai fetch", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 1, files: [] }));
    await resolveCivitaiModelVersion(1);
    const opts = fetchMock.mock.calls[0][1] as { signal?: AbortSignal };
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});

describe("resolveCivitaiModel", () => {
  it("picks the first (latest) version by default", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 100,
        name: "Cool Model",
        modelVersions: [
          { id: 201, files: [{ name: "latest.safetensors", downloadUrl: "https://civitai.com/api/download/models/201", primary: true }] },
          { id: 200, files: [{ name: "older.safetensors", downloadUrl: "https://civitai.com/api/download/models/200", primary: true }] },
        ],
      }),
    );

    const res = await resolveCivitaiModel(100);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://civitai.com/api/v1/models/100",
      expect.anything(),
    );
    expect(res.versionId).toBe(201);
    expect(res.filename).toBe("latest.safetensors");
    expect(res.modelName).toBe("Cool Model");
  });

  it("selects a specific version when versionId is provided", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        id: 100,
        modelVersions: [
          { id: 201, files: [{ downloadUrl: "https://civitai.com/api/download/models/201", primary: true }] },
          { id: 200, files: [{ name: "older.safetensors", downloadUrl: "https://civitai.com/api/download/models/200", primary: true }] },
        ],
      }),
    );

    const res = await resolveCivitaiModel(100, 200);
    expect(res.versionId).toBe(200);
    expect(res.filename).toBe("older.safetensors");
  });

  it("throws ValidationError when the requested version is absent", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ id: 100, modelVersions: [{ id: 201, files: [] }] }),
    );
    await expect(resolveCivitaiModel(100, 999)).rejects.toBeInstanceOf(ValidationError);
  });

  it("throws ModelError when the model has no versions", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ id: 100, modelVersions: [] }));
    await expect(resolveCivitaiModel(100)).rejects.toBeInstanceOf(ModelError);
  });
});

describe("searchCivitaiModels", () => {
  const SEARCH_BODY = {
    items: [
      {
        id: 685874,
        name: "Flux Detailer",
        type: "LORA",
        nsfw: false,
        creator: { username: "jed" },
        stats: { downloadCount: 15155, thumbsUpCount: 1200 },
        modelVersions: [
          {
            id: 1374948,
            name: "v3",
            baseModel: "Flux.1 D",
            trainedWords: ["Jeddtlv3"],
            files: [{ name: "flux-detailer.safetensors", primary: true, sizeKB: 300000 }],
          },
        ],
      },
    ],
  };

  it("builds the query (types/baseModels/sort/nsfw pinned) and maps the download handoff fields", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_BODY));
    const { hits } = await searchCivitaiModels("flux detail", {
      types: ["LORA"],
      baseModels: ["Flux.1 D"],
    });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/models?");
    expect(url).toContain("query=flux+detail");
    expect(url).toContain("types=LORA");
    expect(url).toContain("baseModels=Flux.1+D");
    expect(url).toContain("nsfw=false"); // SFW pinned by default
    expect(url).toContain("sort=Highest+Rated");
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      model_id: 685874,
      version_id: 1374948,
      base_model: "Flux.1 D",
      trained_words: ["Jeddtlv3"],
      size_mb: 293,
      creator: "jed",
    });
  });

  it("nsfw: true opts in on the wire", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));
    await searchCivitaiModels("x", { nsfw: true });
    expect(String(fetchMock.mock.calls[0][0])).toContain("nsfw=true");
  });

  it("nsfw:false selects the newest PG-13 version, not the latest mixed-NSFW one (#664)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            id: 1403959,
            name: "Camera Motion",
            type: "LORA",
            nsfw: false, // model-level flag is clean — the API lets it through
            creator: { username: "someone" },
            modelVersions: [
              {
                id: 1666048, // latest version fronts explicit previews + adult words
                name: "v3",
                baseModel: "Wan Video",
                trainedWords: ["explicit adult phrase", "camera motion"],
                images: [
                  { url: "a", nsfwLevel: 1 },
                  { url: "b", nsfwLevel: 2 },
                  { url: "c", nsfwLevel: 8 },
                ],
              },
              {
                id: 1599906, // older version stays at/below PG-13 (levels 1-2)
                name: "v2",
                baseModel: "Wan Video",
                trainedWords: ["subtle camera motion"],
                images: [
                  { url: "d", nsfwLevel: 1 },
                  { url: "e", nsfwLevel: 2 },
                ],
              },
            ],
          },
        ],
      }),
    );
    const { hits } = await searchCivitaiModels("subtle camera motion cinematic", { nsfw: false });
    expect(hits[0].version_id).toBe(1599906);
    expect(hits[0].version_name).toBe("v2");
    expect(hits[0].trained_words).toEqual(["subtle camera motion"]);
  });

  it("nsfw:false never serializes trained words when NO version is clean (#664)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            id: 1,
            name: "Mixed Pack",
            nsfw: false,
            modelVersions: [
              {
                id: 1666048,
                name: "v1",
                trainedWords: ["explicit adult phrase"],
                images: [{ url: "a", nsfwLevel: 8 }],
              },
            ],
          },
        ],
      }),
    );
    const { hits } = await searchCivitaiModels("mixed", { nsfw: false });
    // The download handoff is preserved (the model itself is flagged SFW)…
    expect(hits[0].version_id).toBe(1666048);
    // …but trigger words from an adult-preview version are never vouched for.
    expect(hits[0].trained_words).toBeUndefined();
  });

  it("nsfw:true keeps the latest version and its words regardless of preview levels", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          {
            id: 1403959,
            name: "Camera Motion",
            nsfw: true,
            modelVersions: [
              {
                id: 1666048,
                name: "v3",
                trainedWords: ["camera motion"],
                images: [{ url: "a", nsfwLevel: 8 }],
              },
              {
                id: 1599906,
                name: "v2",
                trainedWords: ["subtle camera motion"],
                images: [{ url: "b", nsfwLevel: 1 }],
              },
            ],
          },
        ],
      }),
    );
    const { hits } = await searchCivitaiModels("camera motion", { nsfw: true });
    expect(hits[0].version_id).toBe(1666048);
    expect(hits[0].trained_words).toEqual(["camera motion"]);
  });

  it("fails FAST with the config message when CIVITAI_ENABLED=0 (kill-switch, #127)", async () => {
    process.env.CIVITAI_ENABLED = "0";
    try {
      await expect(searchCivitaiModels("anything")).rejects.toThrow(/disabled by config/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.CIVITAI_ENABLED;
    }
  });

  it("sends the bearer token when configured (gated results)", async () => {
    config.civitaiApiToken = "civ_tok";
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));
    await searchCivitaiModels("y");
    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers["Authorization"]).toBe("Bearer civ_tok");
  });

  it("creator mode sends username INSTEAD of query (combined = empty page, live-verified quirk)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(SEARCH_BODY));
    await searchCivitaiModels("", { creator: "jed" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("username=jed");
    expect(url).not.toContain("query=");
  });

  it("creator + keyword: over-fetches, filters client-side on name/tags, no cap on a single page", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          { id: 1, name: "Flux Detailer", modelVersions: [] },
          { id: 2, name: "Anime Style", tags: ["style"], modelVersions: [] },
          { id: 3, name: "Portrait Pack", tags: ["detail", "portrait"], modelVersions: [] },
        ],
      }),
    );
    const { hits, scanned, scanCapped } = await searchCivitaiModels("detail", { creator: "jed" });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("username=jed");
    expect(url).not.toContain("query=");
    expect(url).toContain("limit=100"); // over-fetch for the client-side filter
    // "Flux Detailer" matches on name, "Portrait Pack" on the "detail" tag.
    expect(hits.map((h) => h.model_id)).toEqual([1, 3]);
    expect(scanned).toBe(3);
    expect(scanCapped).toBe(false); // no nextCursor → the whole catalog was scanned
  });

  it("creator + keyword: follows cursor pagination so a match past page one is found", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: 1, name: "Anime Style", modelVersions: [] }],
          metadata: { nextCursor: "abc" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: 2, name: "Detail Slider", modelVersions: [] }],
        }),
      );
    const { hits, scanned, scanCapped } = await searchCivitaiModels("detail", { creator: "prolific" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(String(fetchMock.mock.calls[1][0])).toContain("cursor=abc");
    expect(hits.map((h) => h.model_id)).toEqual([2]);
    expect(scanned).toBe(2);
    expect(scanCapped).toBe(false);
  });

  it("creator + keyword: stops at the page cap and reports scanCapped when short of limit", async () => {
    // 4 pages (the cap), every page keeps offering a next cursor, zero matches.
    for (let i = 0; i < 4; i++) {
      fetchMock.mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: 100 + i, name: "Unrelated", modelVersions: [] }],
          metadata: { nextCursor: `c${i}` },
        }),
      );
    }
    const { hits, scanned, scanCapped } = await searchCivitaiModels("detail", { creator: "prolific" });
    expect(fetchMock).toHaveBeenCalledTimes(4); // bounded — never a 5th page
    expect(hits).toEqual([]);
    expect(scanned).toBe(4);
    expect(scanCapped).toBe(true); // pages remained unscanned → the miss is not definitive
  });

  it("creator + keyword: stops paging early once limit matches are found (no cap flag)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          { id: 1, name: "Detail A", modelVersions: [] },
          { id: 2, name: "Detail B", modelVersions: [] },
        ],
        metadata: { nextCursor: "more" },
      }),
    );
    const { hits, scanCapped } = await searchCivitaiModels("detail", {
      creator: "prolific",
      limit: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1); // limit filled on page one
    expect(hits).toHaveLength(2);
    expect(scanCapped).toBe(false);
  });

  it("creator + keyword: an empty-string nextCursor terminates the scan (full scan, no cap)", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [{ id: 1, name: "Detail A", modelVersions: [] }],
        metadata: { nextCursor: "" }, // degenerate: falsy, not just missing
      }),
    );
    const { hits, scanCapped } = await searchCivitaiModels("detail", { creator: "jed" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(hits).toHaveLength(1);
    expect(scanCapped).toBe(false); // exhausted, not capped
  });

  it("creator + keyword: a REPEATED cursor breaks out instead of looping, and reports the cap", async () => {
    // Page 1 → cursor "stuck"; page 2 replays the SAME items and the SAME cursor.
    const page = {
      items: [{ id: 1, name: "Unrelated", modelVersions: [] }],
      metadata: { nextCursor: "stuck" },
    };
    fetchMock.mockResolvedValueOnce(jsonResponse(page)).mockResolvedValueOnce(jsonResponse(page));
    const { hits, scanned, scanCapped } = await searchCivitaiModels("detail", { creator: "jed" });
    expect(fetchMock).toHaveBeenCalledTimes(2); // followed "stuck" once, then refused the repeat
    expect(hits).toEqual([]);
    expect(scanned).toBe(1); // the replayed page is NOT double-counted
    expect(scanCapped).toBe(true); // stuck mid-catalog → the miss is not definitive
  });

  it("creator + keyword: a LONGER cursor cycle (A→B→A) breaks out and reports the cap", async () => {
    // A two-cursor cycle: a previous-cursor-only check would follow A→B→A→B…
    // until the page cap; the seen-cursors set refuses A the second time.
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: 1, name: "Unrelated 1", modelVersions: [] }],
          metadata: { nextCursor: "A" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: 2, name: "Unrelated 2", modelVersions: [] }],
          metadata: { nextCursor: "B" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: 3, name: "Unrelated 3", modelVersions: [] }],
          metadata: { nextCursor: "A" }, // cycles back — already followed
        }),
      );
    const { hits, scanned, scanCapped } = await searchCivitaiModels("detail", { creator: "jed" });
    expect(fetchMock).toHaveBeenCalledTimes(3); // start → A → B, then A is refused
    expect(hits).toEqual([]);
    expect(scanned).toBe(3);
    expect(scanCapped).toBe(true); // cycling mid-catalog → the miss is not definitive
  });

  it("creator + keyword: duplicate model ids across pages are deduped (never fill limit twice)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          items: [
            { id: 1, name: "Detail A", modelVersions: [] },
            { id: 2, name: "Other", modelVersions: [] },
          ],
          metadata: { nextCursor: "p2" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          // id 1 replayed by a misbehaving cursor + one genuinely new match.
          items: [
            { id: 1, name: "Detail A", modelVersions: [] },
            { id: 3, name: "Detail B", modelVersions: [] },
          ],
        }),
      );
    const { hits, scanned, scanCapped } = await searchCivitaiModels("detail", {
      creator: "jed",
      limit: 2,
    });
    expect(hits.map((h) => h.model_id)).toEqual([1, 3]); // no duplicate id 1
    expect(scanned).toBe(3); // unique models only
    expect(scanCapped).toBe(false);
  });

  it("creator-only mode uses the caller's limit (no over-fetch)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ items: [] }));
    await searchCivitaiModels("", { creator: "jed", limit: 5 });
    expect(String(fetchMock.mock.calls[0][0])).toContain("limit=5");
  });

  it("rejects an empty query with no creator", async () => {
    await expect(searchCivitaiModels("  ")).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("creator + keyword: a FIRST-page failure THROWS (a broken scan must never read as empty)", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 503));
    await expect(
      searchCivitaiModels("detail", { creator: "jed" }),
    ).rejects.toThrow(/upstream error.*503/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("creator + keyword: a LATER-page failure surfaces partial hits + scanError (not a silent truncation)", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({
          items: [{ id: 1, name: "Detail A", modelVersions: [] }],
          metadata: { nextCursor: "p2" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({}, 429)); // page 2 rate-limited
    const { hits, scanned, scanCapped, scanError } = await searchCivitaiModels(
      "detail",
      { creator: "prolific" },
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(hits.map((h) => h.model_id)).toEqual([1]); // page-1 match retained
    expect(scanned).toBe(1);
    expect(scanCapped).toBe(true); // pages remained → result is not definitive
    expect(scanError).toMatch(/rate-limited.*429/i); // the miss is attributable
  });

  it("creator + keyword: no scanError field on a clean full scan", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ items: [{ id: 1, name: "Detail A", modelVersions: [] }] }),
    );
    const result = await searchCivitaiModels("detail", { creator: "jed" });
    expect(result.scanError).toBeUndefined();
  });
});

describe("searchCivitaiCreators", () => {
  it("builds the /creators query and maps username/model_count/profile_url + total", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        items: [
          { username: "jedikun", modelCount: 18, link: "https://civitai.com/api/v1/models?username=jedikun" },
          { username: "techjedi", link: "https://civitai.com/api/v1/models?username=techjedi" },
        ],
        metadata: { totalItems: 6 },
      }),
    );
    const { hits, total } = await searchCivitaiCreators("jed", { limit: 5 });
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("/creators?");
    expect(url).toContain("query=jed");
    expect(url).toContain("limit=5");
    expect(total).toBe(6);
    expect(hits).toEqual([
      {
        username: "jedikun",
        profile_url: "https://civitai.com/user/jedikun",
        model_count: 18,
      },
      {
        username: "techjedi",
        profile_url: "https://civitai.com/user/techjedi",
        model_count: 0, // API omits modelCount for creators with none visible
      },
    ]);
  });

  it("fails FAST when CIVITAI_ENABLED=0 (kill-switch, #127)", async () => {
    process.env.CIVITAI_ENABLED = "0";
    try {
      await expect(searchCivitaiCreators("x")).rejects.toThrow(/disabled by config/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.CIVITAI_ENABLED;
    }
  });
});

describe("fetchCivitaiTopCreators", () => {
  const BOARD_BODY = {
    result: {
      data: {
        json: [
          {
            position: 1,
            score: 81140,
            user: { username: "alcaitiff", deletedAt: null },
            metrics: [
              { type: "downloadCount", value: 42294 },
              { type: "entries", value: 13 },
              { type: "thumbsUpCount", value: 2253 },
              { type: "generationCount", value: 719 },
            ],
          },
          {
            position: 2,
            score: 100,
            user: { username: "ghost", deletedAt: "2026-01-01T00:00:00Z" },
            metrics: [],
          },
          {
            position: 3,
            score: 75439,
            user: { username: "circlestone_labs", deletedAt: null },
            metrics: [{ type: "downloadCount", value: 39000 }],
          },
        ],
      },
    },
  };

  it("hits the tRPC leaderboard with browser-shaped headers (bot gate) and NO bearer token", async () => {
    config.civitaiApiToken = "civ_tok";
    fetchMock.mockResolvedValueOnce(jsonResponse(BOARD_BODY));
    await fetchCivitaiTopCreators();
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain("civitai.com/api/trpc/leaderboard.getLeaderboard");
    expect(url).toContain(encodeURIComponent(JSON.stringify({ json: { id: "overall" } })));
    const headers = (fetchMock.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers["User-Agent"]).toContain("Mozilla/5.0"); // bot gate 401s a plain fetch UA
    expect(headers["Authorization"]).toBeUndefined(); // token stays on the v1 API surface
  });

  it("maps rank/score/metrics, skips deleted users, and respects limit + board", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse(BOARD_BODY));
    const hits = await fetchCivitaiTopCreators({ board: "new_creators", limit: 2 });
    expect(String(fetchMock.mock.calls[0][0])).toContain(
      encodeURIComponent(JSON.stringify({ json: { id: "new_creators" } })),
    );
    expect(hits).toHaveLength(2); // deleted "ghost" is skipped, then limit applies
    expect(hits[0]).toEqual({
      username: "alcaitiff",
      profile_url: "https://civitai.com/user/alcaitiff",
      position: 1,
      score: 81140,
      downloads: 42294,
      thumbs_up: 2253,
      generations: 719,
      entries: 13,
    });
    expect(hits[1].username).toBe("circlestone_labs");
    expect(hits[1].thumbs_up).toBeUndefined();
  });

  it("bot-gate 401 reads as 'auth required', NOT 'your token is invalid' — the leaderboard sends no token even when one is configured", async () => {
    config.civitaiApiToken = "a-valid-v1-token"; // configured, but NOT sent here
    fetchMock.mockResolvedValueOnce(jsonResponse({}, 401));
    const err = await fetchCivitaiTopCreators().catch((e) => e);
    expect(err).toBeInstanceOf(ModelError);
    // Must NOT blame the configured token, since this request never sent it.
    expect(err.message).toMatch(/requires authentication.*set CIVITAI_API_TOKEN/i);
    expect(err.message).not.toMatch(/invalid or expired/i);
  });

  it("fails FAST when CIVITAI_ENABLED=0 (kill-switch, #127)", async () => {
    process.env.CIVITAI_ENABLED = "0";
    try {
      await expect(fetchCivitaiTopCreators()).rejects.toThrow(/disabled by config/);
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      delete process.env.CIVITAI_ENABLED;
    }
  });
});
