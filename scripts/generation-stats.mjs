#!/usr/bin/env node

/**
 * CLI script: npm run generations:stats
 *
 * Shows local generation tracking statistics.
 */

import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const __dirname = dirname(fileURLToPath(import.meta.url));

// Find the generations.db — same logic as generation-tracker.ts
function findDb() {
  const home = homedir();

  // Check common ComfyUI data paths
  const candidates = [
    join(home, "Documents", "ComfyUI", "comfyui-mcp", "generations.db"),
    join(home, "My Documents", "ComfyUI", "comfyui-mcp", "generations.db"),
    join(home, "AppData", "Local", "Programs", "ComfyUI", "resources", "ComfyUI", "comfyui-mcp", "generations.db"),
    join(home, "ComfyUI", "comfyui-mcp", "generations.db"),
    // Fallback: next to the package
    join(__dirname, "..", "generations.db"),
  ];

  // COMFYUI_PATH env override
  if (process.env.COMFYUI_PATH) {
    candidates.unshift(
      join(process.env.COMFYUI_PATH, "comfyui-mcp", "generations.db"),
    );
  }

  for (const path of candidates) {
    if (existsSync(path)) return path;
  }

  return null;
}

function main() {
  const dbPath = findDb();

  if (!dbPath) {
    console.log("\n  No generations.db found. Run some workflows first!\n");
    process.exit(0);
  }

  const db = new Database(dbPath, { readonly: true });

  const totalRow = db
    .prepare("SELECT COALESCE(SUM(reuse_count), 0) AS total FROM generations")
    .get();
  const uniqueRow = db
    .prepare("SELECT COUNT(*) AS cnt FROM generations")
    .get();

  console.log("\n  === Generation Stats ===\n");
  console.log(`  Database: ${dbPath}`);
  console.log(`  Total generations: ${totalRow.total}`);
  console.log(`  Unique setting combos: ${uniqueRow.cnt}`);

  // Breakdown by model family
  const breakdown = db
    .prepare(
      `SELECT model_family, SUM(reuse_count) AS total, COUNT(*) AS combos
       FROM generations
       GROUP BY model_family
       ORDER BY total DESC`,
    )
    .all();

  if (breakdown.length > 0) {
    console.log("\n  Model Family          Generations  Combos");
    console.log("  " + "─".repeat(50));
    for (const row of breakdown) {
      const family = row.model_family.padEnd(22);
      const total = String(row.total).padStart(11);
      const combos = String(row.combos).padStart(7);
      console.log(`  ${family}${total}${combos}`);
    }
  }

  // Top 10 settings
  const top = db
    .prepare(
      `SELECT model_family, model_name, sampler, scheduler, steps, cfg, shift,
              lora_name, lora_strength, reuse_count
       FROM generations
       ORDER BY reuse_count DESC, created_at DESC
       LIMIT 10`,
    )
    .all();

  if (top.length > 0) {
    console.log("\n  Top Settings:\n");
    for (const [i, row] of top.entries()) {
      const lora = row.lora_name
        ? ` + ${row.lora_name} (${row.lora_strength})`
        : "";
      const shiftStr = row.shift != null ? `, shift ${row.shift}` : "";
      console.log(
        `  ${i + 1}. ${row.model_family} / ${row.sampler}/${row.scheduler} / ` +
          `${row.steps} steps / CFG ${row.cfg}${shiftStr}${lora}` +
          ` — ${row.reuse_count}x`,
      );
      if (row.model_name) {
        console.log(`     Model: ${row.model_name}`);
      }
    }
  }

  // File hash cache stats
  try {
    const hashCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM file_hashes")
      .get();
    const civitaiCount = db
      .prepare("SELECT COUNT(*) AS cnt FROM file_hashes WHERE civitai_id IS NOT NULL")
      .get();
    console.log(
      `\n  File hashes cached: ${hashCount.cnt} (${civitaiCount.cnt} matched on CivitAI)`,
    );
  } catch {
    // file_hashes table may not exist yet
  }

  console.log("");
  db.close();
}

main();
