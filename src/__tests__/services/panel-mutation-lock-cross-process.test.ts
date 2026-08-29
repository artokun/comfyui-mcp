import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

interface ChildRun {
  child: ChildProcessWithoutNullStreams;
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
  get stdout(): string;
}

function spawnLockChild(source: string, lockPath: string): ChildRun {
  const child = spawn(process.execPath, ["--import", "tsx", "--eval", source], {
    cwd: process.cwd(),
    env: { ...process.env, COMFYUI_MCP_PANEL_LOCK: lockPath },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
  });
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code, stdout, stderr }));
    },
  );
  return { child, done, get stdout() { return stdout; } };
}

async function waitForMarker(run: ChildRun, marker: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    if (run.stdout.includes(marker)) return;
    const finished = await Promise.race([
      run.done.then(() => true, () => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 20)),
    ]);
    if (finished) {
      const result = await run.done.catch((error: unknown) => ({
        code: null,
        stdout: run.stdout,
        stderr: String(error),
      }));
      throw new Error(
        `child exited before ${marker}: code=${result.code}\nstdout=${result.stdout}\nstderr=${result.stderr}`,
      );
    }
  }
  throw new Error(`timed out waiting for child marker ${marker}; stdout=${run.stdout}`);
}

function stopChild(run: ChildRun): void {
  if (run.child.exitCode === null) run.child.kill();
}

describe("panel mutation lock across processes", () => {
  it("waits for a holder near the full local install ceiling", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmcp-lock-cross-process-"));
    const lockPath = join(dir, "panel-op.lock");
    const moduleUrl = JSON.stringify(
      pathToFileURL(resolve(process.cwd(), "src/services/panel-pin-guard.ts")).href,
    );
    // Scale only the waiter's Date.now clock. A 4.25s real holder represents
    // 2,550s of production budget: beyond the previous 2,520s ceiling, but
    // inside the corrected 2,640s budget, which includes in-lock /system_stats.
    const clockRate = 600;
    const holderDurationMs = 4_250;
    const holder = spawnLockChild(
      `import { withPanelMutationLock } from ${moduleUrl};
       await withPanelMutationLock(async () => {
         console.log("holder-acquired");
         await new Promise((resolve) => setTimeout(resolve, ${holderDurationMs}));
         console.log("holder-releasing");
       });`,
      lockPath,
    );

    try {
      await waitForMarker(holder, "holder-acquired");
      const waiter = spawnLockChild(
        `const realNow = Date.now;
         const startedAt = realNow();
         Date.now = () => startedAt + (realNow() - startedAt) * ${clockRate};
         const { withPanelMutationLock } = await import(${moduleUrl});
         try {
           await withPanelMutationLock(async () => console.log("waiter-acquired"));
           console.log("waiter-complete");
         } catch (error) {
           console.error(String(error instanceof Error ? error.message : error));
           process.exitCode = 1;
         }`,
        lockPath,
      );
      const [holderResult, waiterResult] = await Promise.all([holder.done, waiter.done]);

      expect(holderResult.code).toBe(0);
      expect(waiterResult.code).toBe(0);
      expect(waiterResult.stdout).toContain("waiter-acquired");
      expect(waiterResult.stdout).toContain("waiter-complete");
      expect(waiterResult.stderr).not.toMatch(/Timed out .* panel operation lock/);
    } finally {
      stopChild(holder);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
