import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Control config (comfyuiPath + tokens) per test.
vi.mock("../../config.js", () => ({
  config: {
    comfyuiPath: "/comfy" as string | undefined,
    huggingfaceToken: undefined as string | undefined,
    civitaiApiToken: undefined as string | undefined,
  },
}));

// Avoid touching the real filesystem. createWriteStream / pipeline are only
// reached on a successful download, which these tests deliberately don't do.
const mkdirMock = vi.fn();
const rmMock = vi.fn();
const statMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  copyFile: vi.fn(),
  link: vi.fn(),
  mkdir: (...a: unknown[]) => mkdirMock(...a),
  readdir: vi.fn(),
  rename: vi.fn(),
  rm: (...a: unknown[]) => rmMock(...a),
  stat: (...a: unknown[]) => statMock(...a),
  utimes: vi.fn(),
}));

import { config } from "../../config.js";
import { downloadModel } from "../../services/model-resolver.js";
import { ModelError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";

const fetchMock = vi.fn();

function headersOf(callIndex = 0): Record<string, string> {
  const opts = fetchMock.mock.calls[callIndex][1] as { headers: Record<string, string> };
  return opts.headers;
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  mkdirMock.mockReset().mockResolvedValue(undefined);
  rmMock.mockReset().mockResolvedValue(undefined);
  statMock.mockReset().mockRejectedValue(new Error("missing"));
  config.comfyuiPath = "/comfy";
  config.huggingfaceToken = undefined;
  config.civitaiApiToken = undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("downloadModel — filename path safety", () => {
  it("rejects a filename with parent traversal and never fetches", async () => {
    await expect(
      downloadModel("https://example.com/x.safetensors", "checkpoints", "../evil.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a filename containing a path separator", async () => {
    await expect(
      downloadModel("https://example.com/x.safetensors", "checkpoints", "sub/evil.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects '..' as a filename", async () => {
    await expect(
      downloadModel("https://example.com/x", "checkpoints", ".."),
    ).rejects.toBeInstanceOf(ModelError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("downloadModel — target subfolder (arbitrary + nested, guarded)", () => {
  function failingFetch() {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: "err" });
  }

  it("accepts a NESTED subfolder and mkdir's it under models/", async () => {
    failingFetch();
    // Reaches the network (subfolder accepted) — fails only at the fetch.
    await expect(
      downloadModel("https://example.com/lora.safetensors", "loras/pusa", "lora.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The target dir mkdir'd is models/loras/pusa.
    const mkdirArg = String(mkdirMock.mock.calls[0][0]);
    expect(mkdirArg.replace(/\\/g, "/")).toContain("/comfy/models/loras/pusa");
  });

  it("accepts a NON-standard (not-in-enum) subfolder name", async () => {
    failingFetch();
    await expect(
      downloadModel("https://example.com/m.safetensors", "some_new_model_type", "m.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const mkdirArg = String(mkdirMock.mock.calls[0][0]);
    expect(mkdirArg.replace(/\\/g, "/")).toContain("/comfy/models/some_new_model_type");
  });

  it("REJECTS a traversal-escaping subfolder and never fetches", async () => {
    await expect(
      downloadModel("https://example.com/m.safetensors", "../../etc", "m.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("REJECTS an absolute subfolder and never fetches", async () => {
    await expect(
      downloadModel("https://example.com/m.safetensors", "/abs/path", "m.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("downloadModel — auth headers (token never in URL)", () => {
  // fetch returns not-ok so downloadModel stops right after the request (before
  // streaming) — enough to assert the headers/URL the request was made with.
  function failingFetch() {
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: "err" });
  }

  it("attaches a CivitAI bearer header (and keeps the token out of the URL) for civitai.com", async () => {
    config.civitaiApiToken = "secret";
    failingFetch();

    await expect(
      downloadModel("https://civitai.com/api/download/models/42", "checkpoints", "m.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toBe("https://civitai.com/api/download/models/42");
    expect(calledUrl).not.toContain("secret");
    expect(headersOf().Authorization).toBe("Bearer secret");
  });

  it("does NOT send the CivitAI token to a non-civitai host", async () => {
    config.civitaiApiToken = "secret";
    failingFetch();

    await expect(
      downloadModel("https://evil.example.com/path/civitai.com/x.safetensors", "checkpoints", "x.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);

    expect(headersOf().Authorization).toBeUndefined();
  });

  it("attaches a HuggingFace bearer header for huggingface.co", async () => {
    config.huggingfaceToken = "hf";
    failingFetch();

    await expect(
      downloadModel("https://huggingface.co/org/repo/resolve/main/m.safetensors", "checkpoints", "m.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);

    expect(headersOf().Authorization).toBe("Bearer hf");
  });

  it("uses explicit bearer auth instead of default host auth", async () => {
    config.huggingfaceToken = "default-hf";
    failingFetch();

    await expect(
      downloadModel(
        "https://huggingface.co/org/repo/resolve/main/m.safetensors",
        "checkpoints",
        "m.safetensors",
        { type: "bearer", token: "explicit" },
      ),
    ).rejects.toBeInstanceOf(ModelError);

    expect(headersOf().Authorization).toBe("Bearer explicit");
  });

  it("uses explicit basic auth", async () => {
    failingFetch();

    await expect(
      downloadModel(
        "https://private.example.com/model.safetensors",
        "checkpoints",
        "model.safetensors",
        { type: "basic", username: "alice", password: "secret" },
      ),
    ).rejects.toBeInstanceOf(ModelError);

    expect(headersOf().Authorization).toBe(
      `Basic ${Buffer.from("alice:secret").toString("base64")}`,
    );
  });

  it("uses explicit custom header auth", async () => {
    failingFetch();

    await expect(
      downloadModel(
        "https://private.example.com/model.safetensors",
        "checkpoints",
        "model.safetensors",
        { type: "header", header_name: "X-Api-Key", header_value: "secret-key" },
      ),
    ).rejects.toBeInstanceOf(ModelError);

    expect(headersOf()["X-Api-Key"]).toBe("secret-key");
    expect(headersOf().Authorization).toBeUndefined();
  });

  it("uses explicit query auth and redacts query secrets from logs and errors", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    failingFetch();

    await expect(
      downloadModel(
        "https://private.example.com/model.safetensors?access_token=existing",
        "checkpoints",
        "model.safetensors",
        { type: "query", query_param: "download_key", query_value: "query-secret" },
      ),
    ).rejects.toMatchObject({
      details: {
        url: "https://private.example.com/model.safetensors?access_token=%5BREDACTED%5D&download_key=%5BREDACTED%5D",
      },
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const calledUrl = fetchMock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("download_key=query-secret");
    expect(calledUrl).toContain("access_token=existing");
    expect(headersOf().Authorization).toBeUndefined();

    const logged = JSON.stringify(infoSpy.mock.calls);
    expect(logged).not.toContain("query-secret");
    expect(logged).not.toContain("existing");
    expect(logged).toContain("%5BREDACTED%5D");
  });

  it("redacts query secrets in the download-cache fallback log", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    vi.spyOn(logger, "info").mockImplementation(() => undefined);
    mkdirMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("cache unavailable"));
    failingFetch();

    await expect(
      downloadModel(
        "https://private.example.com/model.safetensors",
        "checkpoints",
        "model.safetensors",
        { type: "query", query_param: "token", query_value: "query-secret" },
      ),
    ).rejects.toBeInstanceOf(ModelError);

    const logged = JSON.stringify(warnSpy.mock.calls);
    expect(logged).not.toContain("query-secret");
    expect(logged).toContain("token=%5BREDACTED%5D");
  });
});
