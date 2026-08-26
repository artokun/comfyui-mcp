#!/usr/bin/env node

import { spawnSync } from "node:child_process";

const checks = [
  { name: "vitest", cmd: "vitest", args: ["run", "--passWithNoTests"] },
  { name: "i18n:check", cmd: "npm", args: ["run", "i18n:check"] },
  { name: "check:docs-links", cmd: "npm", args: ["run", "check:docs-links"] },
  { name: "check:docs-locale", cmd: "npm", args: ["run", "check:docs-locale"] },
  { name: "check:docs-mdx", cmd: "npm", args: ["run", "check:docs-mdx"] },
  { name: "check:blog", cmd: "npm", args: ["run", "check:blog"] },
  { name: "check:blog-packs", cmd: "npm", args: ["run", "check:blog-packs"] },
  { name: "check:blog-stale", cmd: "npm", args: ["run", "check:blog-stale"] },
  { name: "check:blog-structure", cmd: "npm", args: ["run", "check:blog-structure"] },
  { name: "asset-counts", cmd: "node", args: ["scripts/asset-counts.mjs", "--check"] },
  { name: "check:vocabulary", cmd: "npm", args: ["run", "check:vocabulary"] },
  { name: "check:unknown-collapse", cmd: "npm", args: ["run", "check:unknown-collapse"] },
  { name: "vocab:export", cmd: "npm", args: ["run", "vocab:export", "--", "--check"] },
];

const results = [];

for (const check of checks) {
  console.log(`\n$ ${check.cmd} ${check.args.join(" ")}`);
  const result = spawnSync(check.cmd, check.args, {
    stdio: "inherit",
    shell: true,
  });

  const passed = result.status === 0;
  results.push({ name: check.name, passed });

  if (!passed) {
    console.error(`❌ ${check.name} failed with exit code ${result.status}`);
  } else {
    console.log(`✅ ${check.name} passed`);
  }
}

console.log("\n" + "=".repeat(60));
console.log("SUMMARY");
console.log("=".repeat(60));

const passed = results.filter((r) => r.passed);
const failed = results.filter((r) => !r.passed);

for (const r of passed) {
  console.log(`✅ ${r.name}`);
}

for (const r of failed) {
  console.log(`❌ ${r.name}`);
}

if (failed.length === 0) {
  console.log("\n✅ All checks passed!");
  process.exit(0);
} else {
  console.error(`\n❌ ${failed.length} check(s) failed: ${failed.map((r) => r.name).join(", ")}`);
  process.exit(1);
}
