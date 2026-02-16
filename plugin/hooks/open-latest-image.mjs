#!/usr/bin/env node
/**
 * PostToolUse hook for run_workflow.
 * Finds and opens the most recently generated image from ComfyUI's output directory.
 *
 * Environment: Receives TOOL_USE_ID, TOOL_INPUT on stdin.
 * Exit 0 = success (no blocking), non-zero = block (but we never block PostToolUse).
 */
import { readdirSync, statSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { homedir, platform, tmpdir } from "node:os";
import { execSync } from "node:child_process";

const LOG = join(tmpdir(), "comfyui-hook-debug.log");
function log(msg) {
  appendFileSync(LOG, `[open-image ${new Date().toISOString()}] ${msg}\n`);
}

log(`CLAUDE_PLUGIN_ROOT=${process.env.CLAUDE_PLUGIN_ROOT}`);
log(`cwd=${process.cwd()}`);

// Read stdin (tool result JSON) — but we only care if it succeeded
let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => { input += chunk; });
process.stdin.on("end", () => {
  log(`stdin length: ${input.length}`);
  try {
    const data = JSON.parse(input);
    log(`parsed stdin ok, isError=${data.isError}`);
    // If tool returned an error, don't try to open anything
    if (data.isError) process.exit(0);
  } catch (e) {
    log(`stdin parse error: ${e.message}`);
    // Can't parse — proceed anyway
  }

  // Find ComfyUI output directory
  const home = homedir();
  const candidates = [
    join(home, "Documents", "ComfyUI", "output"),
    join(home, "My Documents", "ComfyUI", "output"),
    join(home, "ComfyUI", "output"),
    join(home, "AppData", "Local", "Programs", "ComfyUI", "resources", "ComfyUI", "output"),
  ];

  let outputDir;
  for (const dir of candidates) {
    try {
      statSync(dir);
      outputDir = dir;
      break;
    } catch {
      continue;
    }
  }

  if (!outputDir) {
    // Can't find output dir — silently exit
    process.exit(0);
  }

  // Find newest image
  try {
    const files = readdirSync(outputDir)
      .filter((f) => /\.(png|jpg|jpeg|webp)$/i.test(f))
      .map((f) => {
        const p = join(outputDir, f);
        return { path: p, mtime: statSync(p).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) process.exit(0);

    const newest = files[0];
    // Only open if it was modified in the last 30 seconds (likely from this generation)
    if (Date.now() - newest.mtime > 30000) process.exit(0);

    const os = platform();
    if (os === "win32") {
      execSync(`start "" "${newest.path}"`, { shell: true, stdio: "ignore" });
    } else if (os === "darwin") {
      execSync(`open "${newest.path}"`, { stdio: "ignore" });
    } else {
      execSync(`xdg-open "${newest.path}"`, { stdio: "ignore" });
    }
  } catch (e) {
    log(`image open error: ${e.message}`);
    // Silent failure — don't interrupt the user's workflow
  }

  log("exiting 0");
  process.exit(0);
});
