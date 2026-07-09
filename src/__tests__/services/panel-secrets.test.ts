import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildComfyuiMcpEnv,
  comfyuiSecretKeys,
  isAllowedComfyuiSecretKey,
  loadComfyuiSecretEnv,
  onComfyuiSecretsChanged,
  removeComfyuiSecret,
  setComfyuiSecret,
} from "../../services/panel-secrets.js";

let dir: string;
let secretsPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmcp-secrets-"));
  secretsPath = join(dir, "panel-secrets.json");
  process.env.COMFYUI_MCP_PANEL_SECRETS = secretsPath;
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_PANEL_SECRETS;
  rmSync(dir, { recursive: true, force: true });
});

describe("panel-secrets", () => {
  it("starts empty when no file exists", () => {
    expect(loadComfyuiSecretEnv()).toEqual({});
    expect(comfyuiSecretKeys()).toEqual([]);
    expect(existsSync(secretsPath)).toBe(false);
  });

  it("persists a saved secret and exposes it as a comfyui env var", () => {
    setComfyuiSecret("CIVITAI_API_TOKEN", "tok_abc123");
    expect(loadComfyuiSecretEnv()).toEqual({ CIVITAI_API_TOKEN: "tok_abc123" });
    expect(comfyuiSecretKeys()).toEqual(["CIVITAI_API_TOKEN"]);
  });

  it("round-trips the secret to disk so a respawned process reads it back", () => {
    setComfyuiSecret("HF_TOKEN", "hf_xyz");
    const raw = JSON.parse(readFileSync(secretsPath, "utf-8"));
    expect(raw.comfyuiEnv.HF_TOKEN).toBe("hf_xyz");
  });

  // THE BUG: a saved secret must land in the comfyui MCP server's SPAWN ENV.
  // buildComfyuiMcpEnv is the single env-builder both provider paths use, so this
  // proves request_secret → store → spawn env end-to-end (env-builder under test).
  it("injects a saved secret into the comfyui MCP server spawn env", () => {
    const base = { COMFYUI_URL: "http://127.0.0.1:8188", COMFYUI_MCP_PROGRESS_DIR: "/tmp/p" };
    // Before saving: the base env carries no token.
    expect(buildComfyuiMcpEnv(base).CIVITAI_API_TOKEN).toBeUndefined();

    setComfyuiSecret("CIVITAI_API_TOKEN", "tok_live_999");

    const env = buildComfyuiMcpEnv(base);
    // The secret is now present in the spawn env, alongside the base vars.
    expect(env.CIVITAI_API_TOKEN).toBe("tok_live_999");
    expect(env.COMFYUI_URL).toBe("http://127.0.0.1:8188");
    expect(env.COMFYUI_MCP_PROGRESS_DIR).toBe("/tmp/p");
    // The base object is not mutated.
    expect((base as Record<string, string>).CIVITAI_API_TOKEN).toBeUndefined();
  });

  it("lets a saved secret OVERRIDE a base env default of the same key", () => {
    const base = { CIVITAI_API_TOKEN: "from-process-env" };
    setComfyuiSecret("CIVITAI_API_TOKEN", "from-panel");
    expect(buildComfyuiMcpEnv(base).CIVITAI_API_TOKEN).toBe("from-panel");
  });

  it("supports multiple distinct secrets (generic, not civitai-only)", () => {
    setComfyuiSecret("CIVITAI_API_TOKEN", "a");
    setComfyuiSecret("HUGGINGFACE_TOKEN", "b");
    expect(loadComfyuiSecretEnv()).toEqual({ CIVITAI_API_TOKEN: "a", HUGGINGFACE_TOKEN: "b" });
  });

  it("fires the change event on save so the orchestrator can respawn", () => {
    const cb = vi.fn();
    const off = onComfyuiSecretsChanged(cb);
    setComfyuiSecret("CIVITAI_API_TOKEN", "tok");
    expect(cb).toHaveBeenCalledTimes(1);
    off();
    setComfyuiSecret("CIVITAI_API_TOKEN", "tok2");
    expect(cb).toHaveBeenCalledTimes(1); // unsubscribed → not called again
  });

  it("removes a secret and reports absence", () => {
    setComfyuiSecret("CIVITAI_API_TOKEN", "tok");
    expect(removeComfyuiSecret("CIVITAI_API_TOKEN")).toBe(true);
    expect(loadComfyuiSecretEnv()).toEqual({});
    expect(removeComfyuiSecret("CIVITAI_API_TOKEN")).toBe(false);
  });

  it("rejects an invalid env var name without writing", () => {
    expect(() => setComfyuiSecret("bad name", "x")).toThrow(/Invalid env var name/);
    expect(existsSync(secretsPath)).toBe(false);
  });

  // P1a — arbitrary env injection guard. The comfyui MCP child is a Node
  // subprocess; a non-allowlisted key (NODE_OPTIONS, PATH, COMFYUI_PATH, …) must
  // never reach its env — neither on SAVE nor on LOAD.
  describe("env-key allowlist (P1a)", () => {
    it("exposes the allowlist membership helper", () => {
      expect(isAllowedComfyuiSecretKey("CIVITAI_API_TOKEN")).toBe(true);
      expect(isAllowedComfyuiSecretKey("HUGGINGFACE_TOKEN")).toBe(true);
      expect(isAllowedComfyuiSecretKey("HF_TOKEN")).toBe(true);
      expect(isAllowedComfyuiSecretKey("NODE_OPTIONS")).toBe(false);
      expect(isAllowedComfyuiSecretKey("PATH")).toBe(false);
    });

    it("REJECTS a non-allowlisted key on save and writes nothing", () => {
      expect(() => setComfyuiSecret("NODE_OPTIONS", "--inspect-brk")).toThrow(/not an accepted comfyui tool secret/);
      expect(existsSync(secretsPath)).toBe(false);
      // A valid one still goes through.
      setComfyuiSecret("CIVITAI_API_TOKEN", "ok");
      expect(loadComfyuiSecretEnv()).toEqual({ CIVITAI_API_TOKEN: "ok" });
    });

    it("IGNORES a non-allowlisted key on load (corrupt/hand-edited file)", () => {
      // Simulate a tampered panel-secrets.json that smuggles NODE_OPTIONS/PATH in.
      writeFileSync(
        secretsPath,
        JSON.stringify({
          comfyuiEnv: {
            CIVITAI_API_TOKEN: "legit",
            NODE_OPTIONS: "--inspect-brk",
            PATH: "/evil/bin",
            COMFYUI_PATH: "/evil",
          },
        }),
      );
      const env = loadComfyuiSecretEnv();
      expect(env).toEqual({ CIVITAI_API_TOKEN: "legit" });
      // And it can never leak into the spawn env either.
      const spawnEnv = buildComfyuiMcpEnv({ COMFYUI_URL: "http://x" });
      expect(spawnEnv.NODE_OPTIONS).toBeUndefined();
      expect(spawnEnv.PATH).toBeUndefined();
      expect(spawnEnv.CIVITAI_API_TOKEN).toBe("legit");
    });
  });

  describe("agent-secret allowlist (provider keys, issue #162)", () => {
    it("accepts the custom-endpoint key and hydrates it into env", async () => {
      const { setAgentSecret, loadAgentSecretEnv, isAllowedAgentSecretKey } = await import(
        "../../services/panel-secrets.js"
      );
      expect(isAllowedAgentSecretKey("COMFYUI_MCP_CUSTOM_API_KEY")).toBe(true);
      expect(isAllowedAgentSecretKey("OPENROUTER_API_KEY")).toBe(true);
      expect(isAllowedAgentSecretKey("NODE_OPTIONS")).toBe(false);
      const prev = process.env.COMFYUI_MCP_CUSTOM_API_KEY;
      delete process.env.COMFYUI_MCP_CUSTOM_API_KEY;
      setAgentSecret("COMFYUI_MCP_CUSTOM_API_KEY", "sk-custom-1");
      expect(loadAgentSecretEnv().COMFYUI_MCP_CUSTOM_API_KEY).toBe("sk-custom-1");
      expect(process.env.COMFYUI_MCP_CUSTOM_API_KEY).toBe("sk-custom-1");
      if (prev === undefined) delete process.env.COMFYUI_MCP_CUSTOM_API_KEY;
      else process.env.COMFYUI_MCP_CUSTOM_API_KEY = prev;
    });
  });
});
