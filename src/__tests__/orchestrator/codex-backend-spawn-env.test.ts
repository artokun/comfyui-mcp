// SECURITY regression test (PR #251): the codex app-server is an LLM vendor's
// subprocess — it must NEVER inherit the user's TOOL secrets (RunPod/CivitAI/
// HuggingFace/Gemini tokens) from process.env. Those belong exclusively to the
// comfyui MCP tool child (buildComfyuiMcpEnv). CodexBackend.prepare() must spawn
// with buildAgentSpawnEnv() — process.env minus every tool-only secret key.
//
// The fake child dies immediately (we don't need the JSON-RPC handshake) — the
// spawn env is captured before prepare() rejects, which is all this test needs.

import { describe, expect, it, beforeEach, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  spawnEnvs: [] as Array<Record<string, string | undefined> | undefined>,
}));

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const { EventEmitter } = await import("node:events");
  const { PassThrough } = await import("node:stream");
  return {
    ...actual,
    spawn: (_cmd: string, _args: string[], opts?: { env?: Record<string, string | undefined> }) => {
      hoisted.spawnEnvs.push(opts?.env);
      const proc = new EventEmitter() as EventEmitter & Record<string, unknown>;
      proc.pid = 4243;
      proc.exitCode = null;
      proc.stdin = new PassThrough();
      proc.stdout = new PassThrough();
      proc.stderr = new PassThrough();
      proc.kill = () => {
        if (proc.exitCode === null) {
          proc.exitCode = 0;
          proc.emit("exit", 0, null);
        }
        return true;
      };
      // Die right away: initialize's pending request rejects via handleExit and
      // prepare() throws its friendly "could not start" error.
      setImmediate(() => {
        proc.exitCode = 1;
        proc.emit("exit", 1, null);
      });
      return proc;
    },
    // killProcessTree calls spawnSync("taskkill", …) on win32 — make it a no-op.
    spawnSync: () => ({ status: 0, pid: 1, stdout: "", stderr: "", signal: null, output: [] }),
  };
});

import { CodexBackend } from "../../orchestrator/codex-backend.js";

beforeEach(() => {
  hoisted.spawnEnvs.length = 0;
});

describe("CodexBackend spawn env (tool-secret scoping)", () => {
  it("never passes tool-only secrets (RunPod/CivitAI/HF/Gemini keys) to the codex app-server", async () => {
    const KEYS = [
      "RUNPOD_API_KEY",
      "CIVITAI_API_TOKEN",
      "HF_TOKEN",
      "HUGGINGFACE_TOKEN",
      "RUNCOMFY_API_KEY",
      "REGISTRY_ACCESS_TOKEN",
      "GEMINI_API_KEY",
    ];
    const saved: Record<string, string | undefined> = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
    for (const k of KEYS) process.env[k] = `secret-${k}`;
    try {
      const backend = new CodexBackend({});
      await backend.prepare().catch(() => {
        // expected: the fake child dies before the handshake — the spawn (and
        // therefore the env we assert on) already happened.
      });
      expect(hoisted.spawnEnvs.length).toBeGreaterThanOrEqual(1);
      const env = hoisted.spawnEnvs[0]!;
      for (const k of KEYS) {
        expect(env[k], `${k} must not reach the codex app-server env`).toBeUndefined();
      }
      // Non-secret env still passes through (the child needs PATH etc.).
      expect(env.PATH ?? env.Path).toBeDefined();
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});
