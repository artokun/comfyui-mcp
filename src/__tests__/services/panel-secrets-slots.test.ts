import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { COMFYUI_SECRET_ENV_ALLOWLIST, AGENT_SECRET_ENV_ALLOWLIST } from "../../services/panel-secrets.js";

// Canonical store = ~/.comfyui-mcp/.env. Every slot (comfyui or agent) now writes
// its env keys there + into process.env; the old comfyuiEnv/agentEnv JSON split is
// gone. Isolate process.env so real ~/.comfyui-mcp/.env values don't pollute asserts.
const ALL_KEYS = [...new Set([...COMFYUI_SECRET_ENV_ALLOWLIST, ...AGENT_SECRET_ENV_ALLOWLIST])];
let envPath: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  envPath = join(tmpdir(), `cmcp-${randomUUID()}.env`);
  process.env.COMFYUI_MCP_ENV_FILE = envPath;
  saved = {};
  for (const k of ALL_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  delete process.env.COMFYUI_MCP_ENV_FILE;
  for (const k of ALL_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  if (existsSync(envPath)) require("node:fs").rmSync(envPath, { force: true });
});

describe("panel-secrets credential slots (canonical .env)", () => {
  it("fans a slot out to ALL its env keys in .env + process.env", async () => {
    const m = await import("../../services/panel-secrets.js");
    m.setPanelSecret("huggingface", "hf_abc123456789");
    expect(process.env.HF_TOKEN).toBe("hf_abc123456789");
    expect(process.env.HUGGINGFACE_TOKEN).toBe("hf_abc123456789");
    const raw = readFileSync(envPath, "utf-8");
    expect(raw).toMatch(/^HF_TOKEN=hf_abc123456789$/m);
    expect(raw).toMatch(/^HUGGINGFACE_TOKEN=hf_abc123456789$/m);
  });

  it("a provider slot lands in .env + process.env (for live readiness)", async () => {
    const m = await import("../../services/panel-secrets.js");
    m.setPanelSecret("glm", "glm-secret-xyz789");
    expect(process.env.GLM_API_KEY).toBe("glm-secret-xyz789");
    expect(readFileSync(envPath, "utf-8")).toMatch(/^GLM_API_KEY=glm-secret-xyz789$/m);
  });

  it("the runpod slot writes RUNPOD_API_KEY", async () => {
    const m = await import("../../services/panel-secrets.js");
    m.setPanelSecret("runpod", "rp-secret-abc");
    expect(process.env.RUNPOD_API_KEY).toBe("rp-secret-abc");
    expect(readFileSync(envPath, "utf-8")).toMatch(/^RUNPOD_API_KEY=rp-secret-abc$/m);
  });

  it("the moonshot slot writes MOONSHOT_API_KEY", async () => {
    const m = await import("../../services/panel-secrets.js");
    m.setPanelSecret("moonshot", "sk-moonshot-abc123");
    expect(process.env.MOONSHOT_API_KEY).toBe("sk-moonshot-abc123");
  });

  it("the minimax slot writes MINIMAX_API_KEY", async () => {
    const m = await import("../../services/panel-secrets.js");
    m.setPanelSecret("minimax", "minimax-abc123");
    expect(process.env.MINIMAX_API_KEY).toBe("minimax-abc123");
  });

  it("rejects an unknown slot", async () => {
    const m = await import("../../services/panel-secrets.js");
    expect(() => m.setPanelSecret("not-a-slot", "x")).toThrow(/unknown credential slot/i);
  });

  it("lists masked state (from process.env) without leaking values", async () => {
    const m = await import("../../services/panel-secrets.js");
    m.setPanelSecret("openrouter", "sk-or-v1-abcdef123456");
    const rows = m.listPanelSecretsMasked();
    const or = rows.find((r) => r.id === "openrouter")!;
    expect(or.set).toBe(true);
    expect(or.masked).toBe("sk-o…456");
    expect(JSON.stringify(rows)).not.toContain("abcdef");
    const civ = rows.find((r) => r.id === "civitai")!;
    expect(civ.set).toBe(false);
    expect(civ.masked).toBeNull();
    // The new runpod slot is listed too.
    expect(rows.some((r) => r.id === "runpod")).toBe(true);
  });
});
