#!/usr/bin/env node
/**
 * #1447 — plugin MCP server launcher.
 *
 * The plugin's .mcp.json used to be `npx -y comfyui-mcp --full` directly. On a
 * cold npx cache that downloads the whole ~900 MB dependency tree INSIDE the
 * client's MCP handshake timeout; the client kills the attempt, nothing is
 * persisted, and every retry pays the full cost again (the measured `_npx`
 * cache timestamped to a manual run, never to a client attempt).
 *
 * This wrapper is the warm path: when `comfyui-mcp` is installed globally
 * (`npm install -g comfyui-mcp`), it resolves `<npm root -g>/comfyui-mcp/
 * dist/index.js` and runs it with this same node — sub-second start, no
 * registry round-trip, and a killed handshake cannot discard an install that
 * already happened. With no global install it falls back to the original
 * `npx -y comfyui-mcp` behaviour, so the plugin works identically for anyone
 * who never installs globally.
 *
 * STDIO IS THE MCP TRANSPORT. Everything the child says on stdout/stderr is
 * the protocol — the wrapper inherits stdio verbatim and must never write to
 * stdout itself. Diagnostics (there is exactly one, a spawn failure) go to
 * stderr via console.error.
 *
 * Import-safe: nothing here runs on import. The resolution decisions are pure
 * exports so the tests can call the real thing instead of reimplementing it
 * (the #1385 lesson — a test of a copy is a test of nothing).
 */

import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

/** `npm root -g` is normally ~100 ms; 5 s bounds a wedged npm without hanging the handshake. */
const NPM_ROOT_TIMEOUT_MS = 5000;

/**
 * `npm root -g` stdout → the global install's entry point, or null when the
 * output is unusable or the install is absent/incomplete (no dist/index.js).
 * null is not an error here — it means "take the npx path".
 */
export function globalEntry(npmRootStdout, { exists = existsSync } = {}) {
  const root = typeof npmRootStdout === "string" ? npmRootStdout.trim() : "";
  if (!root) return null;
  const entry = join(root, "comfyui-mcp", "dist", "index.js");
  return exists(entry) ? entry : null;
}

/**
 * Tokens the shell form may contain. The fallback's args come from the
 * plugin's own .mcp.json (today: `--full`), never from user input — but a
 * shell command is string concatenation, so anything outside this alphabet
 * (whitespace, quotes, metacharacters) is REFUSED rather than passed through
 * to be silently misparsed.
 */
const SHELL_SAFE_TOKEN = /^[A-Za-z0-9@._~:/=-]+$/;

/**
 * The spawn spec for the resolved server. `extraArgs` are the plugin's own
 * args from .mcp.json (`--full`), forwarded to whichever server runs so the
 * manifest stays the declarative source of how the server is started.
 *
 * With an entry point we spawn node directly — no shell, no shim resolution.
 *
 * The npx fallback differs by platform:
 *  - POSIX: spawn npx with an args array, no shell.
 *  - Windows: npx is npx.cmd, which Node refuses to spawn without a shell
 *    since the 18.20.2/20.12.2 bat-file fix — but `shell` + an args array
 *    triggers DEP0190 (args are concatenated UNESCAPED, and Node warns every
 *    launch). So the Windows spec is one pre-validated command string instead:
 *    same concatenation, but every token is checked against SHELL_SAFE_TOKEN
 *    first, so what the shell parses is exactly what was written.
 */
export function serverSpec(entry, extraArgs, { platform = process.platform, node = process.execPath } = {}) {
  if (entry) return { command: node, args: [entry, ...extraArgs], shell: false };
  const npxArgs = ["-y", "comfyui-mcp", ...extraArgs];
  if (platform !== "win32") return { command: "npx", args: npxArgs, shell: false };
  for (const token of ["npx", ...npxArgs]) {
    if (!SHELL_SAFE_TOKEN.test(token)) {
      throw new Error(`[comfyui-mcp launcher] refusing to pass unsafe shell token to npx: ${JSON.stringify(token)}`);
    }
  }
  return { command: ["npx", ...npxArgs].join(" "), args: [], shell: true };
}

/** Ask npm where global packages live. String-command form on Windows for the
 *  same DEP0190 reason as serverSpec; the command is a fixed literal, so there
 *  is nothing to inject. Resolves null on any failure — the npx fallback is
 *  the original behaviour, so a failed probe degrades to exactly what the
 *  plugin did before this wrapper existed. */
function probeGlobalRoot() {
  const isWin = process.platform === "win32";
  return new Promise((resolve) => {
    execFile(
      isWin ? "npm root -g" : "npm",
      isWin ? [] : ["root", "-g"],
      { shell: isWin, timeout: NPM_ROOT_TIMEOUT_MS },
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

function run(spec) {
  const child = spawn(spec.command, spec.args, { stdio: "inherit", shell: spec.shell });

  // The client kills the WRAPPER when it shuts the server down; without
  // forwarding, the real server would be orphaned holding stdio. Killing the
  // child on signal makes its `exit` fire, which is what exits the wrapper.
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => child.kill(sig));
  }

  child.on("exit", (code, signal) => {
    // A signal death has no code; 1 keeps the client from reading it as clean.
    process.exit(code ?? (signal ? 1 : 0));
  });
  child.on("error", (err) => {
    // Honest failure, loudly: a server that never started must not look like
    // one that exited cleanly. stderr, never stdout — see the header.
    console.error(`[comfyui-mcp launcher] failed to start ${spec.command}: ${err.message}`);
    process.exit(1);
  });
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const extraArgs = process.argv.slice(2);
  const entry = globalEntry(await probeGlobalRoot());
  run(serverSpec(entry, extraArgs));
}
