#!/usr/bin/env node
/**
 * PostToolUse hook (unused — kept for reference).
 * Finds and opens the most recently generated image from ComfyUI's output directory.
 *
 * Environment: Receives tool result JSON on stdin.
 * Exit 0 = success (no blocking).
 */
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir, platform } from "node:os";
import { spawnSync } from "node:child_process";

// Read stdin (tool result JSON) — but we only care if it succeeded
let input = "";
process.stdin.setEncoding("utf-8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  try {
    const data = JSON.parse(input);
    // If tool returned an error, don't try to open anything
    if (data.isError) process.exit(0);
  } catch {
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
      // Keep the filename out of command syntax, including cmd.exe's parser.
      const powershell = join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      spawnSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", "Start-Process -FilePath $env:COMFYUI_MCP_OPEN_IMAGE"], {
        stdio: "ignore",
        shell: false,
        env: { ...process.env, COMFYUI_MCP_OPEN_IMAGE: newest.path },
      });
    } else if (os === "darwin") {
      spawnSync("open", [newest.path], { shell: false, stdio: "ignore" });
    } else {
      spawnSync("xdg-open", [newest.path], { shell: false, stdio: "ignore" });
    }
  } catch {
    // Silent failure — don't interrupt the user's workflow
  }

  process.exit(0);
});
