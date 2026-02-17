#!/usr/bin/env node
/**
 * PostToolUse hook: checks for ComfyUI workflow completion notifications.
 *
 * Fires after every comfyui MCP tool call. Reads completion files written
 * by the background JobWatcher service. Outputs summaries to stdout
 * (visible to Claude), then marks files as reported.
 *
 * Exit 0 always — never block tool execution.
 */
import { readdirSync, readFileSync, renameSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const COMPLETIONS_DIR = join(tmpdir(), "comfyui-mcp-completions");

function formatNotification(n) {
  const lines = [];

  const icon = n.status === "success" ? "+" : n.status === "error" ? "!" : "?";
  const durationSec = (n.duration_ms / 1000).toFixed(1);

  lines.push(
    `[${icon}] Workflow ${n.status}: ${n.prompt_id.slice(0, 8)}... (${durationSec}s)`,
  );

  if (n.error) {
    lines.push(`  Error in node ${n.error.node_id} (${n.error.node_type}):`);
    lines.push(`    ${n.error.exception_message}`);
    if (n.error.traceback) {
      // Show last 3 lines of traceback for context
      const tbLines = n.error.traceback.trim().split("\n");
      const tail = tbLines.slice(-3);
      for (const line of tail) {
        lines.push(`    ${line}`);
      }
    }
  }

  if (n.cached_nodes && n.cached_nodes.length > 0) {
    lines.push(`  Cached ${n.cached_nodes.length} nodes`);
  }

  if (n.outputs && n.outputs.length > 0) {
    const totalImages = n.outputs.reduce(
      (sum, o) => sum + o.images.length,
      0,
    );
    lines.push(`  Output: ${totalImages} image(s)`);
    for (const output of n.outputs) {
      for (const img of output.images) {
        lines.push(`    - ${img.filename} (node ${output.node_id})`);
      }
    }
  }

  return lines.join("\n");
}

function main() {
  // Drain stdin (required for hook protocol) but don't use it
  process.stdin.resume();
  process.stdin.on("data", () => {});
  process.stdin.on("end", () => {
    try {
      if (!existsSync(COMPLETIONS_DIR)) {
        process.exit(0);
      }

      // Find unreported completion files
      const files = readdirSync(COMPLETIONS_DIR)
        .filter((f) => f.endsWith(".json") && !f.includes(".reported"))
        .sort();

      if (files.length === 0) {
        process.exit(0);
      }

      const notifications = [];
      for (const file of files) {
        const filePath = join(COMPLETIONS_DIR, file);
        try {
          const content = readFileSync(filePath, "utf-8");
          const notification = JSON.parse(content);
          notifications.push(formatNotification(notification));

          // Mark as reported (atomic rename)
          renameSync(filePath, filePath + ".reported");
        } catch {
          // Skip malformed files
          continue;
        }
      }

      if (notifications.length > 0) {
        console.log(
          "\n--- ComfyUI Job Completion ---\n" +
            notifications.join("\n\n") +
            "\n------------------------------",
        );
      }
    } catch {
      // Silent failure — never block
    }

    process.exit(0);
  });
}

main();
