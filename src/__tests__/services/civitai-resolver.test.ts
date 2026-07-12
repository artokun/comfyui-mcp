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
    const hits = await searchCivitaiModels("flux detail", {
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
});
