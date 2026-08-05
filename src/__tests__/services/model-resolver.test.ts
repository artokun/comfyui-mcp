import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { resolve } from "node:path";

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
const lstatMock = vi.fn();
const realpathMock = vi.fn();
vi.mock("node:fs/promises", () => ({
  copyFile: vi.fn(),
  link: vi.fn(),
  lstat: (...a: unknown[]) => lstatMock(...a),
  mkdir: (...a: unknown[]) => mkdirMock(...a),
  readdir: vi.fn(),
  readFile: vi.fn(),
  realpath: (...a: unknown[]) => realpathMock(...a),
  rename: vi.fn(),
  rm: (...a: unknown[]) => rmMock(...a),
  stat: (...a: unknown[]) => statMock(...a),
  utimes: vi.fn(),
  writeFile: vi.fn(),
}));

// downloadModel now roots the destination at the LIVE server's models dir
// (resolveModelsDir, from /system_stats argv). Stub it to the COMFYUI_PATH-based
// dir so these path-safety tests stay hermetic (no real ComfyUI connection).
/** Successive models roots resolveModelsDirWithBases hands out (see the mock). */
const liveRoots = vi.hoisted(() => ({ queue: [] as string[] }));
vi.mock("../../services/output-dir.js", () => ({
  resolveModelsDir: vi.fn(async () => "/comfy/models"),
  // The download resolver now derives the models dir AND the base-install dirs
  // (for the code-root veto) from ONE call. No base dirs here → the symlink-escape
  // guard falls back to the models-root sibling (#633 codex r4).
  resolveModelsDirWithBases: vi.fn(async () => ({
    // Successive values let a test model the live server being REPLACED between the
    // destination resolution and the write (#369 write-time binding). Defaults to a
    // single stable root.
    modelsDir: liveRoots.queue.shift() ?? "/comfy/models",
    baseDirs: [],
    snapshot: { reachable: false },
    // Live-authoritative: these path-safety tests are about containment, not about
    // the #369 stale-install check (which only runs for a locally-configured root).
    source: "live-root" as const,
  })),
  isLiveAuthoritativeModelsDir: (s: string) =>
    s === "argv-flag" || s === "live-root" || s === "observed-root",
}));

// The symlink-escape guard consults registered extra_model_paths roots (#633).
// Stub to none (and non-authoritative live roots) so these path-safety tests stay
// hermetic and an escaping symlink is still refused (nothing authorizes an escape).
// The #633 allowance + fail-closed authorization are covered in a dedicated file.
vi.mock("../../services/extra-paths.js", () => ({
  getExtraModelRoots: vi.fn(async () => []),
  getLiveExtraModelRoots: vi.fn(async () => ({ authoritative: false, roots: [] })),
}));

import { config } from "../../config.js";
import { downloadModel, resolveDownloadTarget } from "../../services/model-resolver.js";
import { setDownloadRetryPolicyForTests } from "../../services/download-retry.js";
import { ModelError } from "../../utils/errors.js";
import { logger } from "../../utils/logger.js";

const fetchMock = vi.fn();

function headersOf(callIndex = 0): Record<string, string> {
  const opts = fetchMock.mock.calls[callIndex][1] as { headers: Record<string, string> };
  return opts.headers;
}

// #473 remote residual: the remote (Manager) dispatch path now PROBES the exact URL
// Manager will fetch (unauthenticated) before dispatching, and refuses on a definitive
// auth/error payload. These build the probe responses the mocked fetch returns.
/** Non-text first bytes + octet-stream → classifier "binary" → probe verdict "model". */
function binaryProbeResponse(): Response {
  return new Response(new Uint8Array([0, 1, 2, 3, 0xff, 0x80, 0x12, 0x34]), {
    status: 200,
    headers: { "content-type": "application/octet-stream" },
  });
}
/** An HTML login page (200) — the exact #473 poison shape → probe verdict "non-model". */
function htmlProbeResponse(): Response {
  return new Response("<!doctype html><html><body>Please log in</body></html>", {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}
/** A JSON auth error (401). */
function jsonAuthProbeResponse(): Response {
  return new Response(JSON.stringify({ error: "unauthorized" }), {
    status: 401,
    headers: { "content-type": "application/json" },
  });
}
/** Flip-aware fetch: an UNAUTHENTICATED probe (no Authorization) gets `pageResp` (an
 *  auth/error page — what Manager would land), a CREDENTIALED probe gets a real model.
 *  This is the auth-gated shape the #473 gate must refuse. */
function flipFetch(pageResp: () => Response): void {
  fetchMock.mockImplementation((_url: string, opts?: { headers?: Record<string, string> }) => {
    const authed = !!opts?.headers?.Authorization;
    return Promise.resolve(authed ? binaryProbeResponse() : pageResp());
  });
}

beforeEach(() => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockReset();
  mkdirMock.mockReset().mockResolvedValue(undefined);
  rmMock.mockReset().mockResolvedValue(undefined);
  // ENOENT, not a bare Error: this stub means "the file is ABSENT", and the code
  // now distinguishes that (knowably nothing staged → a fresh download) from "the
  // stat FAILED" (unknown → refuse rather than truncate someone else's bytes).
  // A codeless rejection asserted the wrong thing about reality.
  statMock
    .mockReset()
    .mockRejectedValue(Object.assign(new Error("ENOENT: missing"), { code: "ENOENT" }));
  // Default: nothing in the path is a symlink (best-effort guard is inert).
  lstatMock.mockReset().mockResolvedValue({ isSymbolicLink: () => false });
  realpathMock.mockReset().mockImplementation((p: string) => Promise.resolve(p));
  installModelViaManagerMock.mockReset().mockResolvedValue({
    mechanism: "manager-http",
    message: "queued",
  });
  config.comfyuiPath = "/comfy";
  config.huggingfaceToken = undefined;
  config.civitaiApiToken = undefined;
  // These tests assert routing / auth-header / destination behaviour with
  // single-shot fetch mocks. #470 added automatic retry on transient failures
  // (a 500 IS transient), which would re-enter the stream with no queued
  // response. Pin ONE attempt so each assertion stays about its own subject;
  // retry has dedicated coverage in download-retry.test.ts.
  setDownloadRetryPolicyForTests({ maxAttempts: 1, stallTimeoutMs: 0 });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("downloadModel — the destination is BOUND to the server it was resolved for (#369)", () => {
  it("REFUSES to start when the live server changes between resolving and writing", async () => {
    // Calls: (1) resolveDownloadTarget — which now ALSO yields the root it bound to,
    // so there is no separate capture to race — and (2) the root re-checked
    // immediately before the first byte. A ComfyUI replaced during the mkdir must not
    // take the bytes into the PREVIOUS server's tree.
    liveRoots.queue = ["/comfy/models", "/other/models"];

    await expect(
      downloadModel("https://example.com/x.safetensors", "checkpoints", "x.safetensors"),
    ).rejects.toThrow(/changed while the destination was being prepared/);
    // The refusal happens BEFORE any bytes move.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("proceeds when the live server is the same one throughout", async () => {
    liveRoots.queue = ["/comfy/models", "/comfy/models"];
    // Reaches the transfer (which this suite's fetch mock then governs) rather than
    // refusing — a stable server must never be mistaken for a swap.
    await downloadModel(
      "https://example.com/x.safetensors",
      "checkpoints",
      "x.safetensors",
    ).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalled();
  });
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

  it("rejects a destination whose ancestor is a symlink escaping the models dir, and never fetches (#490)", async () => {
    // The write-target resolver must guard the ACTUAL destination: a symlinked
    // subfolder that realpaths OUTSIDE models/ can't be used as a write root even
    // though the path string stays within models/.
    const escapeDir = resolve("/comfy/models/checkpoints");
    lstatMock.mockImplementation((p: string) =>
      Promise.resolve({ isSymbolicLink: () => p === escapeDir }),
    );
    realpathMock.mockImplementation((p: string) =>
      Promise.resolve(p === escapeDir ? resolve("/tmp/outside") : p),
    );

    await expect(
      downloadModel("https://example.com/x.safetensors", "checkpoints", "x.safetensors"),
    ).rejects.toThrow(/symlink in the path escapes it|outside the models/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("allows a models ROOT that is itself a symlink/junction to another location", async () => {
    // A ComfyUI install may legitimately junction its whole models dir onto
    // another drive. The root canonicalizes elsewhere BY DESIGN — that must not
    // be treated as an escape (only DESCENDANTS are checked, against the canonical
    // root).
    const modelsRoot = resolve("/comfy/models");
    const realModelsRoot = resolve("/mnt/big/models");
    lstatMock.mockImplementation((p: string) =>
      Promise.resolve({ isSymbolicLink: () => p === modelsRoot }),
    );
    realpathMock.mockImplementation((p: string) =>
      Promise.resolve(p === modelsRoot ? realModelsRoot : p),
    );
    const target = await resolveDownloadTarget(
      "https://example.com/x.safetensors",
      "checkpoints",
      "x.safetensors",
    );
    expect(target.targetDir).toBe(resolve("/comfy/models/checkpoints"));
  });

  it("allows a symlinked subfolder that stays inside the models dir", async () => {
    const linkDir = resolve("/comfy/models/checkpoints");
    lstatMock.mockImplementation((p: string) =>
      Promise.resolve({ isSymbolicLink: () => p === linkDir }),
    );
    // realpath resolves to another location STILL under models/ → allowed.
    realpathMock.mockImplementation((p: string) =>
      Promise.resolve(p === linkDir ? resolve("/comfy/models/_real_ckpts") : p),
    );
    const target = await resolveDownloadTarget(
      "https://example.com/x.safetensors",
      "checkpoints",
      "x.safetensors",
    );
    expect(target.targetDir).toBe(resolve("/comfy/models/checkpoints"));
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

  it("does NOT leak the HF token on the LOCAL path to an attacker host whose URL merely CONTAINS 'huggingface.co' (#590 P0)", async () => {
    config.huggingfaceToken = "hf";
    failingFetch();

    await expect(
      downloadModel("https://evil.example/m.safetensors?ref=huggingface.co", "checkpoints", "m.safetensors"),
    ).rejects.toBeInstanceOf(ModelError);

    // Parsed host is evil.example → NO token. A substring `includes` would have leaked it.
    expect(headersOf().Authorization).toBeUndefined();
  });

  it("does NOT leak the HF token on the LOCAL path to a look-alike subdomain (huggingface.co.evil.com)", async () => {
    config.huggingfaceToken = "hf";
    failingFetch();

    await expect(
      downloadModel("https://huggingface.co.evil.com/m.safetensors", "checkpoints", "m.safetensors"),
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
    // #473: the remote dispatch probes the URL Manager will fetch first. Default to a
    // benign binary payload → verdict "model" → dispatch proceeds, so the existing
    // dispatch assertions hold; refusal tests below override to an auth/error payload.
    fetchMock.mockResolvedValue(binaryProbeResponse());
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
      trayCategory: "checkpoints",
    });
    // The pre-dispatch probe fetched the URL Manager will fetch (#473), but NO local
    // disk work happened — the probe is a network read, never a file write.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://example.com/model.safetensors");
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
      trayCategory: "loras",
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
      trayCategory: "loras",
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
      trayCategory: "style_models",
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

  // ── #473 remote residual: WARN LOUDLY (never block) when a credential flip proves the
  //    URL is AUTH-GATED — so a dispatched auth page isn't mistaken for a real model, while
  //    a legitimate download is NEVER refused (the host's fetch vantage may differ). ──
  it("WARNS but still dispatches when the URL is auth-gated — an HTML page that flips with the token", async () => {
    config.civitaiApiToken = "tok"; // the local token that Manager can't receive
    flipFetch(htmlProbeResponse); // unauth → login HTML; with the token → real model
    const out = await downloadModel(
      "https://civitai.com/api/download/models/627113",
      "loras",
      "KNP.safetensors",
    );
    // NEVER blocks — the dispatch still happens (the host may succeed from its own vantage)…
    expect(installModelViaManagerMock).toHaveBeenCalledTimes(1);
    // …but a loud, specific warning is surfaced so the auth page isn't trusted as a model.
    expect(out).toMatch(/AUTHENTICATION-GATED/i);
    expect(out).toMatch(/CORRUPT model/i);
  });

  it("WARNS when an auth-gated URL returns a JSON error unauthenticated but flips with the token", async () => {
    config.civitaiApiToken = "tok";
    flipFetch(jsonAuthProbeResponse);
    const out = await downloadModel(
      "https://civitai.com/api/download/models/9",
      "checkpoints",
      "gated.safetensors",
    );
    expect(installModelViaManagerMock).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/AUTHENTICATION-GATED/i);
  });

  it("names the CivitAI host-token remediation in the auth-gated warning", async () => {
    config.civitaiApiToken = "tok";
    flipFetch(htmlProbeResponse);
    const out = await downloadModel(
      "https://civitai.com/api/download/models/1",
      "loras",
      "x.safetensors",
    );
    expect(out).toMatch(/CIVITAI_API_TOKEN on the ComfyUI HOST/i);
  });

  it("does NOT warn (no false alarm) on a location interstitial that does NOT flip with the token", async () => {
    // The Codex vantage P0: a WAF/geo interstitial can reach the MCP as 200 HTML while the
    // host gets a real model. It ignores the bearer, so BOTH probes return HTML → no flip →
    // no auth-gated warning, and (as always) the dispatch proceeds.
    config.civitaiApiToken = "tok";
    fetchMock.mockResolvedValue(htmlProbeResponse()); // same page with or without auth
    const out = await downloadModel("https://civitai.com/api/download/models/1", "loras", "x.safetensors");
    expect(installModelViaManagerMock).toHaveBeenCalledTimes(1);
    expect(out).not.toMatch(/AUTHENTICATION-GATED/i);
  });

  it("does NOT warn when an HTML page appears but NO credential is configured (can't prove auth-gating)", async () => {
    config.civitaiApiToken = undefined;
    fetchMock.mockResolvedValue(htmlProbeResponse());
    const out = await downloadModel("https://civitai.com/api/download/models/1", "loras", "x.safetensors");
    expect(installModelViaManagerMock).toHaveBeenCalledTimes(1);
    expect(out).not.toMatch(/AUTHENTICATION-GATED/i);
  });

  it("dispatches normally (no warning) when the probe is INCONCLUSIVE (network error)", async () => {
    fetchMock.mockRejectedValue(new Error("connreset"));
    const out = await downloadModel(
      "https://example.com/m.safetensors",
      "checkpoints",
      "m.safetensors",
    );
    expect(installModelViaManagerMock).toHaveBeenCalledTimes(1);
    expect(out).toContain("ComfyUI-Manager");
    expect(out).not.toMatch(/AUTHENTICATION-GATED/i);
  });

  it("does NOT leak the HF token to an attacker host whose URL merely CONTAINS 'huggingface.co' (#590 P0)", async () => {
    config.huggingfaceToken = "hf-secret";
    // unauth → auth page (would drive a flip IF a credential were derived); but the PARSED
    // host is attacker.example, so no HF token is derived and no request carries it.
    fetchMock.mockImplementation((_url: string, opts?: { headers?: Record<string, string> }) =>
      Promise.resolve(opts?.headers?.Authorization ? binaryProbeResponse() : htmlProbeResponse()),
    );
    await downloadModel(
      "https://attacker.example/m.safetensors?ref=huggingface.co",
      "checkpoints",
      "m.safetensors",
    );
    expect(installModelViaManagerMock).toHaveBeenCalledTimes(1); // never blocked
    const leaked = fetchMock.mock.calls.some((c) =>
      String((c[1] as { headers?: Record<string, string> } | undefined)?.headers?.Authorization ?? "").includes("hf-secret"),
    );
    expect(leaked).toBe(false);
  });

  it("attaches the HF token by PARSED host for a genuine huggingface.co gated URL and warns on the flip", async () => {
    config.huggingfaceToken = "hf-secret";
    fetchMock.mockImplementation((_url: string, opts?: { headers?: Record<string, string> }) =>
      Promise.resolve(opts?.headers?.Authorization ? binaryProbeResponse() : htmlProbeResponse()),
    );
    const out = await downloadModel(
      "https://huggingface.co/org/repo/resolve/main/m.safetensors",
      "checkpoints",
      "m.safetensors",
    );
    expect(installModelViaManagerMock).toHaveBeenCalledTimes(1);
    expect(out).toMatch(/AUTHENTICATION-GATED/i);
    const sentHf = fetchMock.mock.calls.some(
      (c) => (c[1] as { headers?: Record<string, string> } | undefined)?.headers?.Authorization === "Bearer hf-secret",
    );
    expect(sentHf).toBe(true);
  });

  it("keeps the HF token flowing to an HF_ENDPOINT mirror (pre-rewrite wasHfUrl threaded) — #590 P1", async () => {
    const prev = process.env.HF_ENDPOINT;
    process.env.HF_ENDPOINT = "https://hf-mirror.example";
    try {
      config.huggingfaceToken = "hf-secret";
      fetchMock.mockImplementation((_url: string, opts?: { headers?: Record<string, string> }) =>
        Promise.resolve(opts?.headers?.Authorization ? binaryProbeResponse() : htmlProbeResponse()),
      );
      const out = await downloadModel(
        "https://huggingface.co/org/repo/resolve/main/m.safetensors",
        "checkpoints",
        "m.safetensors",
      );
      expect(installModelViaManagerMock).toHaveBeenCalledTimes(1);
      // The URL was rewritten to the mirror, yet the HF token still applies (threaded
      // wasHfUrl) → the flip is detected and the auth-gated warning fires.
      expect(out).toMatch(/AUTHENTICATION-GATED/i);
      const sentToMirror = fetchMock.mock.calls.some(
        (c) =>
          String(c[0]).startsWith("https://hf-mirror.example") &&
          (c[1] as { headers?: Record<string, string> } | undefined)?.headers?.Authorization === "Bearer hf-secret",
      );
      expect(sentToMirror).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.HF_ENDPOINT;
      else process.env.HF_ENDPOINT = prev;
    }
  });

  it("does NOT probe a NON-model-binary destination (.zip) — dispatch proceeds, no warning", async () => {
    // A .zip is not a model-binary ext, so the probe short-circuits to inconclusive WITHOUT
    // fetching and the dispatch proceeds unchanged.
    fetchMock.mockResolvedValue(htmlProbeResponse());
    const out = await downloadModel("https://example.com/pack.zip", "loras", "pack.zip");
    expect(installModelViaManagerMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(out).not.toMatch(/AUTHENTICATION-GATED/i);
  });
});

describe("downloadModel — threaded routing decision (#420 split-brain guard)", () => {
  it("forces the Manager dispatch when dispatchToManager=true, even with a LOCAL config", async () => {
    // config.comfyuiPath is set (local mode), so self-evaluation would stream to
    // disk. Passing the job's already-decided route must WIN — the writer follows
    // the decision the job id was keyed on, never a fresh evaluation.
    config.comfyuiPath = "/comfy";
    fetchMock.mockResolvedValue(binaryProbeResponse()); // #473 pre-dispatch probe
    const out = await downloadModel(
      "https://example.com/model.safetensors",
      "checkpoints",
      "model.safetensors",
      undefined,
      true, // dispatchToManager — decided upstream by startDownloadJob
    );
    expect(installModelViaManagerMock).toHaveBeenCalledTimes(1);
    // The one fetch is the pre-dispatch probe (a network read), NOT local streaming —
    // no disk work happened in the Manager route.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(mkdirMock).not.toHaveBeenCalled();
    expect(out).toContain("ComfyUI-Manager");
  });

  it("forces local streaming when dispatchToManager=false, even in remote-like config", async () => {
    // Even with comfyuiPath unset (self-eval would pick Manager), an explicit
    // false route makes the writer take the local path (and here fail at fetch),
    // proving the passed decision overrides self-evaluation both ways.
    config.comfyuiPath = undefined;
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, statusText: "err" });
    await expect(
      downloadModel(
        "https://example.com/model.safetensors",
        "checkpoints",
        "model.safetensors",
        undefined,
        false, // dispatchToManager=false → local writer
      ),
    ).rejects.toBeInstanceOf(ModelError);
    expect(installModelViaManagerMock).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("resolveDownloadTarget (shared destination resolver)", () => {
  const URL = "https://example.com/path/big.safetensors";

  it("collapses '..' so paths landing in one dir resolve to one targetPath", async () => {
    const a = await resolveDownloadTarget(URL, "loras", "m.safetensors");
    const b = await resolveDownloadTarget(URL, "checkpoints/../loras", "m.safetensors");
    expect(a.targetPath).toBe(b.targetPath);
  });

  it("trims the subfolder ('  loras  ' == 'loras')", async () => {
    const a = await resolveDownloadTarget(URL, "  loras  ", "m.safetensors");
    const b = await resolveDownloadTarget(URL, "loras", "m.safetensors");
    expect(a.targetPath).toBe(b.targetPath);
  });

  it("identity is the destination, NOT the URL — different URLs, same targetPath", async () => {
    const a = await resolveDownloadTarget("https://a.example/x/m.safetensors", "loras", "m.safetensors");
    const b = await resolveDownloadTarget("https://b.example/y/m.safetensors", "loras", "m.safetensors");
    expect(a.targetPath).toBe(b.targetPath);
  });

  it("an omitted filename derives from the URL basename", async () => {
    const t = await resolveDownloadTarget(URL, "checkpoints");
    expect(t.filename).toBe("big.safetensors");
  });

  it("rejects a path-ful filename (does NOT basename it into a collision)", async () => {
    await expect(resolveDownloadTarget(URL, "loras", "dir/big.safetensors")).rejects.toThrow(ModelError);
  });

  it("rejects a defined-but-blank filename", async () => {
    await expect(resolveDownloadTarget(URL, "loras", "")).rejects.toThrow(ModelError);
  });

  it("rejects a subfolder that escapes the models dir", async () => {
    await expect(resolveDownloadTarget(URL, "../evil", "m.safetensors")).rejects.toThrow(ModelError);
  });
});
