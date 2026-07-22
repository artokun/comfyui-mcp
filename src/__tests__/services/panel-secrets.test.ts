import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, existsSync } from "node:fs";
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
  COMFYUI_SECRET_ENV_ALLOWLIST,
  AGENT_SECRET_ENV_ALLOWLIST,
  envFilePath,
} from "../../services/panel-secrets.js";

// The canonical store is now ~/.comfyui-mcp/.env (a real dotenv), so these tests
// point COMFYUI_MCP_ENV_FILE at a temp file AND isolate process.env: the real
// ~/.comfyui-mcp/.env is loaded at import, so allowlisted keys (HF_TOKEN, …) may
// already be present and would pollute exact-match assertions.
const ALL_KEYS = [...new Set([...COMFYUI_SECRET_ENV_ALLOWLIST, ...AGENT_SECRET_ENV_ALLOWLIST])];

let dir: string;
let envPath: string;
let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmcp-secrets-"));
  envPath = join(dir, ".env");
  process.env.COMFYUI_MCP_ENV_FILE = envPath;
  savedEnv = {};
  for (const k of ALL_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_ENV_FILE;
  for (const k of ALL_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  rmSync(dir, { recursive: true, force: true });
});

describe("panel-secrets (canonical .env store)", () => {
  it("starts empty when no file exists", () => {
    expect(loadComfyuiSecretEnv()).toEqual({});
    expect(comfyuiSecretKeys()).toEqual([]);
    expect(existsSync(envPath)).toBe(false);
  });

  it("persists a saved secret and exposes it as a comfyui env var", () => {
    setComfyuiSecret("CIVITAI_API_TOKEN", "tok_abc123");
    expect(loadComfyuiSecretEnv()).toEqual({ CIVITAI_API_TOKEN: "tok_abc123" });
    expect(comfyuiSecretKeys()).toEqual(["CIVITAI_API_TOKEN"]);
    expect(process.env.CIVITAI_API_TOKEN).toBe("tok_abc123"); // live in-process too
  });

  it("round-trips the secret to ~/.comfyui-mcp/.env so a respawned process reads it back", () => {
    setComfyuiSecret("HF_TOKEN", "hf_xyz");
    expect(envFilePath()).toBe(envPath);
    const raw = readFileSync(envPath, "utf-8");
    expect(raw).toMatch(/^HF_TOKEN=hf_xyz$/m);
  });

  it("upserts a single line, preserving the rest of the user's .env", () => {
    // A hand-written .env with comments + unrelated keys must survive a save.
    const { writeFileSync } = require("node:fs");
    writeFileSync(envPath, "# my env\nCOMFYUI_HOST=127.0.0.1\nHF_TOKEN=old\n");
    setComfyuiSecret("HF_TOKEN", "new");
    setComfyuiSecret("CIVITAI_API_TOKEN", "civ");
    const raw = readFileSync(envPath, "utf-8");
    expect(raw).toMatch(/^# my env$/m); // comment preserved
    expect(raw).toMatch(/^COMFYUI_HOST=127\.0\.0\.1$/m); // unrelated key preserved
    expect(raw).toMatch(/^HF_TOKEN=new$/m); // replaced in place
    expect(raw).not.toMatch(/HF_TOKEN=old/); // old value gone
    expect(raw).toMatch(/^CIVITAI_API_TOKEN=civ$/m); // new key appended
  });

  // A saved secret must land in the comfyui MCP server's SPAWN ENV (both provider
  // paths use buildComfyuiMcpEnv), proving request_secret → .env/process.env → spawn.
  it("injects a saved secret into the comfyui MCP server spawn env", () => {
    const base = { COMFYUI_URL: "http://127.0.0.1:8188", COMFYUI_MCP_PROGRESS_DIR: "/tmp/p" };
    expect(buildComfyuiMcpEnv(base).CIVITAI_API_TOKEN).toBeUndefined();
    setComfyuiSecret("CIVITAI_API_TOKEN", "tok_live_999");
    const env = buildComfyuiMcpEnv(base);
    expect(env.CIVITAI_API_TOKEN).toBe("tok_live_999");
    expect(env.COMFYUI_URL).toBe("http://127.0.0.1:8188");
    expect(env.COMFYUI_MCP_PROGRESS_DIR).toBe("/tmp/p");
    expect((base as Record<string, string>).CIVITAI_API_TOKEN).toBeUndefined();
  });

  it("lets a saved secret OVERRIDE a base env default of the same key", () => {
    const base = { CIVITAI_API_TOKEN: "from-process-env" };
    setComfyuiSecret("CIVITAI_API_TOKEN", "from-panel");
    expect(buildComfyuiMcpEnv(base).CIVITAI_API_TOKEN).toBe("from-panel");
  });

  it("supports multiple distinct secrets", () => {
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
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("removes a secret from .env + process.env and reports absence", () => {
    setComfyuiSecret("CIVITAI_API_TOKEN", "tok");
    expect(removeComfyuiSecret("CIVITAI_API_TOKEN")).toBe(true);
    expect(loadComfyuiSecretEnv()).toEqual({});
    expect(process.env.CIVITAI_API_TOKEN).toBeUndefined();
    expect(readFileSync(envPath, "utf-8")).not.toMatch(/CIVITAI_API_TOKEN/);
    expect(removeComfyuiSecret("CIVITAI_API_TOKEN")).toBe(false);
  });

  it("rejects an invalid env var name without writing", () => {
    expect(() => setComfyuiSecret("bad name", "x")).toThrow(/Invalid env var name/);
    expect(existsSync(envPath)).toBe(false);
  });

  describe("env-key allowlist (P1a — no arbitrary env injection)", () => {
    it("exposes the allowlist membership helper", () => {
      expect(isAllowedComfyuiSecretKey("CIVITAI_API_TOKEN")).toBe(true);
      expect(isAllowedComfyuiSecretKey("HUGGINGFACE_TOKEN")).toBe(true);
      expect(isAllowedComfyuiSecretKey("HF_TOKEN")).toBe(true);
      expect(isAllowedComfyuiSecretKey("NODE_OPTIONS")).toBe(false);
      expect(isAllowedComfyuiSecretKey("PATH")).toBe(false);
    });

    it("REJECTS a non-allowlisted key on save and writes nothing", () => {
      expect(() => setComfyuiSecret("NODE_OPTIONS", "--inspect-brk")).toThrow(/not an accepted comfyui tool secret/);
      expect(existsSync(envPath)).toBe(false);
      setComfyuiSecret("CIVITAI_API_TOKEN", "ok");
      expect(loadComfyuiSecretEnv()).toEqual({ CIVITAI_API_TOKEN: "ok" });
    });

    it("IGNORES a non-allowlisted key on load (even if present in process.env)", () => {
      // A stray/dangerous key in the environment must never reach the spawn env —
      // loadComfyuiSecretEnv only ever reads ALLOWLISTED keys.
      process.env.NODE_OPTIONS = "--inspect-brk";
      process.env.CIVITAI_API_TOKEN = "legit";
      try {
        expect(loadComfyuiSecretEnv()).toEqual({ CIVITAI_API_TOKEN: "legit" });
        const spawnEnv = buildComfyuiMcpEnv({ COMFYUI_URL: "http://x" });
        expect(spawnEnv.NODE_OPTIONS).toBeUndefined();
        expect(spawnEnv.CIVITAI_API_TOKEN).toBe("legit");
      } finally {
        delete process.env.NODE_OPTIONS;
      }
    });
  });

  describe("migration: legacy panel-secrets.json → .env (non-destructive)", () => {
    it("moves legacy tokens into .env without clobbering existing .env content", async () => {
      const { writeFileSync } = require("node:fs");
      // A legacy JSON store with tokens in both maps.
      const jsonPath = join(dir, "panel-secrets.json");
      process.env.COMFYUI_MCP_PANEL_SECRETS = jsonPath;
      writeFileSync(
        jsonPath,
        JSON.stringify({
          comfyuiEnv: { CIVITAI_API_TOKEN: "civ-legacy", NODE_OPTIONS: "--evil" },
          agentEnv: { OPENROUTER_API_KEY: "or-legacy" },
        }),
      );
      // A pre-existing .env with a comment + an unrelated key + one key that must WIN.
      writeFileSync(envPath, "# keep me\nCOMFYUI_HOST=1.2.3.4\nCIVITAI_API_TOKEN=civ-newer\n");
      process.env.CIVITAI_API_TOKEN = "civ-newer"; // .env already loaded → must not be overwritten

      const { migrateSecretsToEnv } = await import("../../services/panel-secrets.js");
      const migrated = migrateSecretsToEnv();

      const raw = readFileSync(envPath, "utf-8");
      expect(raw).toMatch(/^# keep me$/m); // comment preserved
      expect(raw).toMatch(/^COMFYUI_HOST=1\.2\.3\.4$/m); // unrelated key preserved
      expect(raw).toMatch(/^CIVITAI_API_TOKEN=civ-newer$/m); // existing value NOT overwritten
      expect(raw).toMatch(/^OPENROUTER_API_KEY=or-legacy$/m); // legacy agent key migrated in
      expect(raw).not.toMatch(/NODE_OPTIONS/); // non-allowlisted legacy key NOT migrated
      expect(process.env.OPENROUTER_API_KEY).toBe("or-legacy");
      expect(migrated).toContain("OPENROUTER_API_KEY");
      expect(migrated).not.toContain("CIVITAI_API_TOKEN"); // skipped (already present)
      delete process.env.COMFYUI_MCP_PANEL_SECRETS;
    });

    it("removeEnvSecret PURGES the legacy JSON so a revoked key can't resurrect (#269)", async () => {
      const { writeFileSync } = require("node:fs");
      const jsonPath = join(dir, "panel-secrets.json");
      process.env.COMFYUI_MCP_PANEL_SECRETS = jsonPath;
      writeFileSync(
        jsonPath,
        JSON.stringify({ comfyuiEnv: { CIVITAI_API_TOKEN: "civ-legacy" }, agentEnv: { OPENROUTER_API_KEY: "or-legacy" } }),
      );
      writeFileSync(envPath, "CIVITAI_API_TOKEN=civ-legacy\n");
      process.env.CIVITAI_API_TOKEN = "civ-legacy";

      const { removeEnvSecret, migrateSecretsToEnv } = await import("../../services/panel-secrets.js");
      expect(removeEnvSecret("CIVITAI_API_TOKEN")).toBe(true);
      // Gone from .env AND from the JSON map.
      expect(readFileSync(envPath, "utf-8")).not.toMatch(/CIVITAI_API_TOKEN/);
      const json = JSON.parse(readFileSync(jsonPath, "utf-8"));
      expect(json.comfyuiEnv.CIVITAI_API_TOKEN).toBeUndefined();
      expect(json.agentEnv.OPENROUTER_API_KEY).toBe("or-legacy"); // untouched
      // A subsequent boot migration must NOT bring the revoked key back.
      delete process.env.CIVITAI_API_TOKEN;
      const migrated = migrateSecretsToEnv();
      expect(migrated).not.toContain("CIVITAI_API_TOKEN");
      expect(process.env.CIVITAI_API_TOKEN).toBeUndefined();
      delete process.env.COMFYUI_MCP_PANEL_SECRETS;
    });
  });

  describe("agent-secret allowlist (provider keys)", () => {
    it("accepts the custom-endpoint key and applies it to env", async () => {
      const { setAgentSecret, loadAgentSecretEnv, isAllowedAgentSecretKey } = await import(
        "../../services/panel-secrets.js"
      );
      expect(isAllowedAgentSecretKey("COMFYUI_MCP_CUSTOM_API_KEY")).toBe(true);
      expect(isAllowedAgentSecretKey("OPENROUTER_API_KEY")).toBe(true);
      expect(isAllowedAgentSecretKey("NODE_OPTIONS")).toBe(false);
      setAgentSecret("COMFYUI_MCP_CUSTOM_API_KEY", "sk-custom-1");
      expect(loadAgentSecretEnv().COMFYUI_MCP_CUSTOM_API_KEY).toBe("sk-custom-1");
      expect(process.env.COMFYUI_MCP_CUSTOM_API_KEY).toBe("sk-custom-1");
      expect(readFileSync(envPath, "utf-8")).toMatch(/^COMFYUI_MCP_CUSTOM_API_KEY=sk-custom-1$/m);
    });
  });

  describe("buildAgentSpawnEnv (tool secrets NEVER reach agent-provider subprocesses)", () => {
    it("strips tool-only secrets from the agent spawn env while the tool server still gets them", async () => {
      const { buildAgentSpawnEnv } = await import("../../services/panel-secrets.js");
      // A user saves tool secrets via the panel → they land in process.env.
      setComfyuiSecret("RUNPOD_API_KEY", "rp-secret");
      setComfyuiSecret("CIVITAI_API_TOKEN", "civ-secret");
      setComfyuiSecret("HF_TOKEN", "hf-secret");

      // TOOL SERVER (comfyui MCP child): gets the secrets — that's its job.
      const toolEnv = buildComfyuiMcpEnv({ COMFYUI_URL: "http://127.0.0.1:8188" });
      expect(toolEnv.RUNPOD_API_KEY).toBe("rp-secret");
      expect(toolEnv.CIVITAI_API_TOKEN).toBe("civ-secret");
      expect(toolEnv.HF_TOKEN).toBe("hf-secret");

      // AGENT SPAWN ENV (codex app-server / gemini / grok CLI): NO tool secrets.
      const agentEnv = buildAgentSpawnEnv();
      expect(agentEnv.RUNPOD_API_KEY).toBeUndefined();
      expect(agentEnv.CIVITAI_API_TOKEN).toBeUndefined();
      expect(agentEnv.HF_TOKEN).toBeUndefined();
      expect(agentEnv.HUGGINGFACE_TOKEN).toBeUndefined();
      expect(agentEnv.RUNCOMFY_API_KEY).toBeUndefined();
      expect(agentEnv.REGISTRY_ACCESS_TOKEN).toBeUndefined();
      // Non-secret env passes through untouched (the child still needs PATH etc.).
      expect(agentEnv.PATH ?? agentEnv.Path).toBeDefined();
    });

    it("keeps agent-provider keys and honors the per-provider keep list (gemini's own key)", async () => {
      const { buildAgentSpawnEnv, setAgentSecret } = await import("../../services/panel-secrets.js");
      setAgentSecret("OPENROUTER_API_KEY", "or-key"); // agent secret — allowed through
      setComfyuiSecret("GEMINI_API_KEY", "gm-key"); // tool secret, but ALSO gemini's own credential
      setComfyuiSecret("RUNPOD_API_KEY", "rp-secret");

      const codexEnv = buildAgentSpawnEnv();
      expect(codexEnv.OPENROUTER_API_KEY).toBe("or-key");
      expect(codexEnv.GEMINI_API_KEY).toBeUndefined(); // codex must not see it

      const geminiEnv = buildAgentSpawnEnv(process.env, {
        keep: ["GEMINI_API_KEY", "GOOGLE_GENERATIVE_AI_API_KEY", "GOOGLE_API_KEY"],
      });
      expect(geminiEnv.GEMINI_API_KEY).toBe("gm-key"); // its own vendor's key survives
      expect(geminiEnv.RUNPOD_API_KEY).toBeUndefined(); // foreign tool secret still stripped
    });

    it("does not mutate process.env", async () => {
      const { buildAgentSpawnEnv } = await import("../../services/panel-secrets.js");
      setComfyuiSecret("RUNPOD_API_KEY", "rp-secret");
      buildAgentSpawnEnv();
      expect(process.env.RUNPOD_API_KEY).toBe("rp-secret");
    });
  });
});
