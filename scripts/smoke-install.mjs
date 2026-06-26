#!/usr/bin/env node
/**
 * Release smoke test: pack the package exactly as `npm publish` would, install
 * that tarball into a clean throwaway project (which RUNS the postinstall hook),
 * and verify the published layout + entrypoint actually boot.
 *
 * Catches the class of bug that shipped in 0.17.0: a `files` allowlist that
 * dropped `scripts/` while `package.json` still declared
 * `postinstall: node scripts/postinstall.mjs` — so every `npm install` / `npx`
 * crashed on a missing file. Unit tests (`npm test`) never exercise the packed
 * tarball, so this is the gap. Run in CI and as a pre-publish gate.
 */
import { execSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = (cmd, opts = {}) => {
  console.log(`$ ${cmd}${opts.cwd ? `  (cwd: ${opts.cwd})` : ""}`);
  execSync(cmd, { stdio: "inherit", ...opts });
};

// 1. Pack exactly what `npm publish` would upload.
const packDir = mkdtempSync(join(tmpdir(), "cmcp-pack-"));
run(`npm pack --pack-destination "${packDir}"`);
const tgz = readdirSync(packDir).find((f) => f.endsWith(".tgz"));
if (!tgz) throw new Error("npm pack produced no tarball");
const tarball = join(packDir, tgz);

// 2. Install the tarball in a clean project — this RUNS the postinstall hook.
const proj = mkdtempSync(join(tmpdir(), "cmcp-smoke-"));
writeFileSync(
  join(proj, "package.json"),
  JSON.stringify({ name: "comfyui-mcp-smoke", private: true, version: "0.0.0" }),
);
// --foreground-scripts surfaces postinstall output; a crashing hook exits non-zero.
run(`npm install --foreground-scripts --no-audit --no-fund "${tarball}"`, { cwd: proj });

// 3. Verify the published layout is intact (files the runtime/install need).
const pkg = join(proj, "node_modules", "comfyui-mcp");
for (const f of ["dist/index.js", "scripts/postinstall.mjs", "package.json"]) {
  if (!existsSync(join(pkg, f))) {
    console.error(`❌ published package is missing ${f}`);
    process.exit(1);
  }
}
if (!existsSync(join(proj, "node_modules", ".bin", "comfyui-mcp")) &&
    !existsSync(join(proj, "node_modules", ".bin", "comfyui-mcp.cmd"))) {
  console.error("❌ comfyui-mcp bin was not linked");
  process.exit(1);
}

// 4. Entrypoint parses (syntax) and boots without an immediate crash.
run(`node --check "${join(pkg, "dist/index.js")}"`);
const boot = spawnSync(process.execPath, [join(pkg, "dist/index.js")], {
  input: "",
  timeout: 8000,
  encoding: "utf8",
});
// Pass if it stayed up until the timeout (SIGTERM) or exited cleanly on stdin EOF.
if (boot.signal === "SIGTERM" || boot.status === 0) {
  console.log(`✅ entrypoint boots (signal=${boot.signal}, status=${boot.status})`);
} else {
  console.error(`❌ entrypoint crashed on boot (status=${boot.status}, signal=${boot.signal})`);
  if (boot.stdout) console.error("stdout:\n" + boot.stdout);
  if (boot.stderr) console.error("stderr:\n" + boot.stderr);
  process.exit(1);
}

console.log("✅ pack/install smoke passed — tarball installs cleanly and boots");
