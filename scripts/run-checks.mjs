#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { platform } from "node:os";

const checks = [
  { name: "vitest", cmd: "npm", args: ["run", "test:vitest"] },
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
  { name: "check:env-advice", cmd: "node", args: ["scripts/check-env-advice.mjs"] },
  { name: "vocab:export", cmd: "npm", args: ["run", "vocab:export", "--", "--check"] },
  // #2407 — the release notes are the ONE artefact nothing verified. Three cuts in
  // one evening shipped a fix they did not list (0.52.133/#2378, 0.52.138/#2400)
  // or listed one that had already shipped (0.52.134, a whole no-op version).
  // Ancestry resolves itself in every case — the release branch merges into main,
  // so the tag gets the code — so the gap is silent and only the changelog is
  // wrong. This runs HERE rather than in a workflow on purpose: `npm test` is
  // invoked by both ci.yml and release.yml, so the same guard gates a pull request
  // and the publish, and a release path that enforced less than CI is what made
  // three other gates advisory before they were copied into release.yml by hand.
  { name: "check:changelog", cmd: "node", args: ["scripts/check-changelog.mjs"] },
];

const results = [];

for (const check of checks) {
  console.log(`\n$ ${check.cmd} ${check.args.join(" ")}`);
  const result = spawnSync(check.cmd, check.args, {
    stdio: "inherit",
    shell: platform() === "win32",
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
