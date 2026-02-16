#!/usr/bin/env node
/**
 * PreToolUse hook for run_workflow.
 * Checks available VRAM before execution and warns if it's critically low.
 *
 * Exit 0 = allow tool execution.
 * Exit 2 = block with message (returned as JSON on stdout).
 */

const VRAM_WARNING_MB = 1024; // Warn if less than 1GB free

async function checkVram() {
  try {
    // Try common ComfyUI ports
    const ports = [8188, 8000];
    let stats;

    for (const port of ports) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const res = await fetch(`http://127.0.0.1:${port}/system_stats`, {
          signal: controller.signal,
        });
        clearTimeout(timeout);
        if (res.ok) {
          stats = await res.json();
          break;
        }
      } catch {
        continue;
      }
    }

    if (!stats?.devices?.[0]) {
      // Can't reach ComfyUI or no GPU info — allow execution
      process.exit(0);
    }

    const gpu = stats.devices[0];
    const vramFreeMB = gpu.vram_free / 1024 / 1024;

    if (vramFreeMB < VRAM_WARNING_MB) {
      // Output warning as JSON for Claude Code to display
      console.log(
        JSON.stringify({
          decision: "allow",
          reason: `Warning: Only ${vramFreeMB.toFixed(0)}MB VRAM free. Consider running clear_vram first to avoid OOM errors.`,
        }),
      );
    }

    process.exit(0);
  } catch {
    // On any error, don't block execution
    process.exit(0);
  }
}

checkVram();
