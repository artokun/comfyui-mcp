import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";

// Control config (comfyuiPath + tokens) per test.
vi.mock("../../config.js", () => {
  const config = {
    comfyuiPath: "/comfy" as string | undefined,
    huggingfaceToken: undefined as string | undefined,
    civitaiApiToken: undefined as string | undefined,
  };
  // downloadModel routes to the Manager install-model path in remote mode
  // (comfyuiPath unset). Most tests set comfyuiPath, so this is false for them.
  return { config, isRemoteMode: () => !config.comfyuiPath };
});

// Stub the Manager install-model dispatch so remote-mode downloadModel can be
// asserted without a live ComfyUI-Manager.
const installModelViaManagerMock = vi.fn();
vi.mock("../../services/node-management.js", () => ({
  installModelViaManager: (...a: unknown[]) => installModelViaManagerMock(...a),
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
  installModelViaManagerMock.mockReset().mockResolvedValue({
    mechanism: "manager-http",
    message: "queued",
  });
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

describe("downloadModel — remote mode (Manager install-model dispatch)", () => {
  beforeEach(() => {
    config.comfyuiPath = undefined; // remote mode
  });

  it("dispatches a top-level download via installModelViaManager (no save_path) and never touches disk", async () => {
    const out = await downloadModel(
      "https://example.com/model.safetensors",
      "checkpoints",
      "model.safetensors",
    );

    expect(installModelViaManagerMock).toHaveBeenCalledTimes(1);
    // name + a "default" save_path are ALWAYS sent (the two fields that were
    // missing and made the install a silent no-op); checkpoints maps 1:1.
    expect(installModelViaManagerMock).toHaveBeenCalledWith({
      name: "model.safetensors",
      url: "https://example.com/model.safetensors",
      filename: "model.safetensors",
      type: "checkpoints",
      save_path: "default",
    });
    // No local-disk work in remote mode.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(out).toContain("checkpoints/model.safetensors");
    expect(out).toContain("ComfyUI-Manager");
  });

  it("passes save_path for a nested subfolder", async () => {
    await downloadModel(
      "https://example.com/lora.safetensors",
      "loras/pusa",
      "lora.safetensors",
    );

    // Nested target → Manager gets the explicit relative path verbatim; our
    // "loras" category maps to Manager's singular "lora" type key.
    expect(installModelViaManagerMock).toHaveBeenCalledWith({
      name: "lora.safetensors",
      url: "https://example.com/lora.safetensors",
      filename: "lora.safetensors",
      type: "lora",
      save_path: "loras/pusa",
    });
  });

  it("maps a top-level 'loras' category to Manager 'lora' with a 'default' save_path", async () => {
    await downloadModel(
      "https://example.com/solo.safetensors",
      "loras",
      "solo.safetensors",
    );

    expect(installModelViaManagerMock).toHaveBeenCalledWith({
      name: "solo.safetensors",
      url: "https://example.com/solo.safetensors",
      filename: "solo.safetensors",
      type: "lora",
      save_path: "default",
    });
  });

  it("sends the folder name as save_path for a category with no Manager type-map key", async () => {
    await downloadModel(
      "https://example.com/style.safetensors",
      "style_models",
      "style.safetensors",
    );

    // style_models has no model_dir_name_map key, so we route by explicit folder.
    expect(installModelViaManagerMock).toHaveBeenCalledWith({
      name: "style.safetensors",
      url: "https://example.com/style.safetensors",
      filename: "style.safetensors",
      type: "style_models",
      save_path: "style_models",
    });
  });

  it("derives the filename from the URL when omitted", async () => {
    await downloadModel("https://example.com/path/cool.safetensors", "vae");

    expect(installModelViaManagerMock).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "cool.safetensors",
        filename: "cool.safetensors",
        type: "vae",
        save_path: "default",
      }),
    );
  });

  it("still rejects a traversal-escaping subfolder before dispatch", async () => {
    await expect(
      downloadModel("https://example.com/m.safetensors", "../../etc", "m.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);
    expect(installModelViaManagerMock).not.toHaveBeenCalled();
  });

  it("still rejects a filename with a path separator before dispatch", async () => {
    await expect(
      downloadModel("https://example.com/m.safetensors", "checkpoints", "sub/evil.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);
    expect(installModelViaManagerMock).not.toHaveBeenCalled();
  });

  it("folds query auth into the dispatched URL (Manager fetches server-side) and redacts the secret from the debug log", async () => {
    const infoSpy = vi.spyOn(logger, "info").mockImplementation(() => undefined);
    const out = await downloadModel(
      "https://example.com/model.safetensors",
      "checkpoints",
      "model.safetensors",
      { type: "query", query_param: "download_key", query_value: "query-secret" },
    );

    const calledUrl = installModelViaManagerMock.mock.calls[0][0].url as string;
    // The real (unredacted) secret IS sent to Manager (server-side fetch needs it)…
    expect(calledUrl).toContain("download_key=query-secret");
    // …but the dispatch log must NOT leak it — it is redacted in the logged URL.
    const logged = JSON.stringify(infoSpy.mock.calls);
    expect(logged).not.toContain("query-secret");
    expect(logged).toContain("download_key=%5BREDACTED%5D");
    // Success descriptor, no auth warning for query auth.
    expect(out).toContain("ComfyUI-Manager");
    expect(out).not.toMatch(/WARNING/i);
  });

  it("warns (does not silently succeed) when header/basic/bearer/s3 auth can't reach Manager", async () => {
    for (const auth of [
      { type: "bearer", token: "t" } as const,
      { type: "basic", username: "u", password: "p" } as const,
      { type: "header", header_name: "X-Key", header_value: "v" } as const,
      // s3 SigV4 creds can't be handed to Manager's server-side fetch either, so
      // it must surface the same kind of warning rather than report a clean success.
      { type: "s3", access_key_id: "AKIA", secret_access_key: "shh" } as const,
    ]) {
      installModelViaManagerMock.mockClear();
      const out = await downloadModel(
        "https://example.com/model.safetensors",
        "checkpoints",
        "model.safetensors",
        auth,
      );
      // Still dispatched, but the URL is unmodified (no header forwarding possible)…
      expect(installModelViaManagerMock).toHaveBeenCalledWith(
        expect.objectContaining({ url: "https://example.com/model.safetensors" }),
      );
      // …and we surface a clear warning rather than reporting a clean success.
      expect(out).toMatch(/WARNING/i);
      expect(out).toContain(auth.type);
    }
  });
});
