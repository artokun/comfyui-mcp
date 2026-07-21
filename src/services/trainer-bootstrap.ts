// Trainer bootstrap — the one-time setup that makes NATIVE (dockerless)
// training possible on this machine: clone ostris ai-toolkit at the pinned
// commit into <trainingRoot>/ai-toolkit, create its venv, and install torch +
// requirements. Idempotent: a ready checkout+venv is left alone; a partial one
// is repaired. Needed on RunPod pods (no nested docker) and dockerless rigs.
//
// Everything lives under the training root, so a pod whose root is the
// persistent /workspace only pays the ~10min install ONCE across restarts.

import childProcess from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  AI_TOOLKIT_REF,
  AI_TOOLKIT_REPO,
  nativeToolkitReady,
  resolveAiToolkitDir,
  resolveAiToolkitPython,
  type TrainerEnvelope,
} from "./ai-toolkit.js";

const TORCH_PACKAGES = ["torch==2.9.1", "torchvision==0.24.1", "torchaudio==2.9.1"];
const TORCH_INDEX = "https://download.pytorch.org/whl/cu128";

export interface BootstrapStatus {
  dir: string;
  python: string;
  ref: string;
  cloned: boolean;
  venv: boolean;
  ready: boolean;
}

export async function bootstrapStatus(): Promise<BootstrapStatus> {
  const dir = resolveAiToolkitDir();
  const cloned = existsSync(join(dir, "run.py"));
  const venv = existsSync(resolveAiToolkitPython());
  return { dir, python: resolveAiToolkitPython(), ref: AI_TOOLKIT_REF, cloned, venv, ready: await nativeToolkitReady() };
}

function ok<T>(command: string, data?: T): TrainerEnvelope<T> {
  return { ok: true, command, data };
}
function fail(command: string, code: string, message: string, stderr?: string): TrainerEnvelope<never> {
  return { ok: false, command, error: { code, message }, stderr };
}

/** Run one command, streaming output via onLog; resolves with the exit code + tail. */
function stream(cmd: string, args: string[], cwd: string | undefined, onLog?: (line: string) => void): Promise<{ code: number; tail: string }> {
  return new Promise((resolve) => {
    const child = childProcess.spawn(cmd, args, { cwd, windowsHide: true, env: { ...process.env } });
    const tail: string[] = [];
    const onLine = (line: string) => {
      tail.push(line);
      if (tail.length > 200) tail.shift();
      onLog?.(line);
    };
    for (const s of [child.stdout, child.stderr]) {
      if (!s) continue;
      s.setEncoding("utf8");
      let buf = "";
      s.on("data", (chunk: string) => {
        buf += chunk;
        const parts = buf.split(/\r\n|\r|\n/);
        buf = parts.pop() ?? "";
        for (const line of parts) if (line.trim()) onLine(line);
      });
      s.on("end", () => {
        if (buf.trim()) onLine(buf);
      });
    }
    child.on("close", (code) => resolve({ code: code ?? 1, tail: tail.slice(-30).join("\n") }));
    child.on("error", (err) => resolve({ code: 1, tail: String(err) }));
  });
}

function basePython(): string {
  return process.platform === "win32" ? "python" : "python3";
}

/**
 * Bootstrap the native trainer. Steps (each idempotent):
 *  1. clone ai-toolkit @ AI_TOOLKIT_REF (or `git fetch + checkout` an existing clone)
 *  2. create the venv
 *  3. pip install torch (cu128 index) + hf_transfer
 *  4. pip install -r requirements.txt
 * Long (~10 min on a fresh box, dominated by torch). Streams every command's
 * output via onLog.
 */
export async function bootstrapToolkit(opts: { onLog?: (line: string) => void } = {}): Promise<TrainerEnvelope<BootstrapStatus>> {
  const dir = resolveAiToolkitDir();
  const log = opts.onLog;
  try {
    mkdirSync(dir, { recursive: true });

    if (!existsSync(join(dir, ".git"))) {
      // Clone into a temp sibling then move in, so a failed clone doesn't leave
      // a half repo at the real path.
      const tmp = `${dir}.clone-${process.pid}`;
      const r = await stream("git", ["clone", "--recurse-submodules", AI_TOOLKIT_REPO, tmp], undefined, log);
      if (r.code !== 0) {
        // Clean the failed clone so a retry isn't blocked by its leftovers
        // (codex finding: the stale temp dir made every retry fail instantly).
        const { rmSync: rmTmp } = await import("node:fs");
        rmTmp(tmp, { recursive: true, force: true });
        return fail("train_bootstrap", "clone_failed", `git clone exited ${r.code}`, r.tail);
      }
      const { renameSync, rmSync } = await import("node:fs");
      rmSync(dir, { recursive: true, force: true });
      renameSync(tmp, dir);
    }
    let r = await stream("git", ["fetch", "--all"], dir, log);
    if (r.code !== 0) return fail("train_bootstrap", "fetch_failed", `git fetch exited ${r.code}`, r.tail);
    r = await stream("git", ["checkout", AI_TOOLKIT_REF], dir, log);
    if (r.code !== 0) return fail("train_bootstrap", "checkout_failed", `git checkout ${AI_TOOLKIT_REF} exited ${r.code}`, r.tail);
    r = await stream("git", ["submodule", "update", "--init", "--recursive"], dir, log);
    if (r.code !== 0) return fail("train_bootstrap", "submodule_failed", `submodule update exited ${r.code}`, r.tail);

    if (!existsSync(resolveAiToolkitPython())) {
      r = await stream(basePython(), ["-m", "venv", "venv"], dir, log);
      if (r.code !== 0) return fail("train_bootstrap", "venv_failed", `venv creation exited ${r.code}`, r.tail);
    }

    const pip = [resolveAiToolkitPython(), "-m", "pip", "install", "--no-cache-dir"];
    r = await stream(pip[0], [...pip.slice(1), ...TORCH_PACKAGES, "--index-url", TORCH_INDEX], dir, log);
    if (r.code !== 0) return fail("train_bootstrap", "torch_failed", `torch install exited ${r.code} (index ${TORCH_INDEX})`, r.tail);
    r = await stream(pip[0], [...pip.slice(1), "hf_transfer"], dir, log);
    if (r.code !== 0) return fail("train_bootstrap", "hf_transfer_failed", `hf_transfer install exited ${r.code}`, r.tail);
    r = await stream(pip[0], [...pip.slice(1), "-r", "requirements.txt"], dir, log);
    if (r.code !== 0) return fail("train_bootstrap", "requirements_failed", `requirements install exited ${r.code}`, r.tail);

    const status = await bootstrapStatus();
    if (!status.ready) {
      return fail("train_bootstrap", "verify_failed", "bootstrap finished but run.py/venv python are still missing");
    }
    return ok("train_bootstrap", status);
  } catch (err) {
    return fail("train_bootstrap", "error", err instanceof Error ? err.message : String(err));
  }
}

/** homedir re-export for tests overriding the training root. */
export function _bootstrapDefaultDir(): string {
  return join(process.env.COMFYUI_MCP_DATA_DIR?.trim() || join(homedir(), ".comfyui-mcp"), "training", "ai-toolkit");
}
