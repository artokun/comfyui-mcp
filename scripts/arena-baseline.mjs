#!/usr/bin/env node
// Render the published community baseline table (#792 ask 3).
//
//   node scripts/arena-baseline.mjs
//   node scripts/arena-baseline.mjs path/to/arena-results.json
//   ARENA_VRAM_CAP_GIB=12 node scripts/arena-baseline.mjs
//
// Default input is benchmarks/arena-baseline.json — replace that file with a
// current-surface arena-results.json (VRAM/quant stamped) when a fresh ladder
// lands. The docs page embeds this function's output verbatim.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildCommunityBaseline } from "./arena-report.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const path = process.argv[2] ?? join(ROOT, "benchmarks", "arena-baseline.json");
const cap = Number(process.env.ARENA_VRAM_CAP_GIB ?? 8);
const data = JSON.parse(readFileSync(path, "utf8"));
process.stdout.write(buildCommunityBaseline(data, { capGiB: cap }));
