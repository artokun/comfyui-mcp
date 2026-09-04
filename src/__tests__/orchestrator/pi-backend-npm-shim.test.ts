// #2835 — pi installed from npm is unusable on Windows.
//
// `npm i -g pi` writes `pi` (an extensionless bash script), `pi.cmd` and `pi.ps1`,
// and no `pi.exe`. Measured on Windows 11 / Node 24:
//
//     spawn(<extensionless shim>) -> ENOENT
//     spawn(<.cmd>)               -> EINVAL
//
// So discovery found the extensionless shim, returned it, and the spawn failed —
// while COMFYUI_MCP_PI_PATH pointed at the .cmd was refused outright. The reporter
// was told to point at "the real pi/pi.exe", which the npm package does not ship.
//
// The fix is NOT `shell: true`. The prompt reaches these spawns as an argv element,
// so routing it through cmd.exe would make every prompt a potential command line —
// the exact thing this module's no-shell rule exists to prevent. npm's shim names
// its own entry point, so it resolves to a script `node` can run with no shell.
//
// The shim text below is a faithful copy of what npm writes, taken from a real
// global install on this machine, not an invention.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveNpmShimTarget, resolvePiLaunch } from "../../orchestrator/pi-backend.js";

const S = String.fromCharCode(92);
const NL = String.fromCharCode(10);
const REL = ["node_modules", "pi", "bin", "pi.js"].join(S);

/** Exactly npm's generated .cmd, with the entry point on the last line. */
function npmCmdShim(relScript: string): string {
  return [
    "@ECHO off",
    "GOTO start",
    ":find_dp0",
    "SET dp0=%~dp0",
    "EXIT /b",
    ":start",
    "SETLOCAL",
    "CALL :find_dp0",
    "",
    'IF EXIST "%dp0%' + S + 'node.exe" (',
    '  SET "_prog=%dp0%' + S + 'node.exe"',
    ") ELSE (",
    '  SET "_prog=node"',
    ")",
    "",
    'endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%' + S + relScript + '" %*',
  ].join(NL);
}

let dir: string;
const savedPath = process.env.PATH;
const savedOverride = process.env.COMFYUI_MCP_PI_PATH;

function seedScript(): string {
  mkdirSync(join(dir, "node_modules", "pi", "bin"), { recursive: true });
  const script = join(dir, "node_modules", "pi", "bin", "pi.js");
  writeFileSync(script, "#!/usr/bin/env node");
  return script;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmcp-2835-"));
  delete process.env.COMFYUI_MCP_PI_PATH;
});

afterEach(() => {
  process.env.PATH = savedPath;
  if (savedOverride === undefined) delete process.env.COMFYUI_MCP_PI_PATH;
  else process.env.COMFYUI_MCP_PI_PATH = savedOverride;
  rmSync(dir, { recursive: true, force: true });
});

describe("#2835 an npm shim resolves to the script it runs", () => {
  it("extracts the entry point npm names in the .cmd", () => {
    const script = seedScript();
    writeFileSync(join(dir, "pi.cmd"), npmCmdShim(REL));
    expect(resolveNpmShimTarget(join(dir, "pi.cmd"))).toBe(script);
  });

  it("returns null when the named script is NOT on disk", () => {
    // A shim we cannot resolve stays unusable rather than becoming a guess: a
    // command built from a path that does not exist fails at spawn with a worse
    // message than "not found".
    writeFileSync(join(dir, "pi.cmd"), npmCmdShim(REL));
    expect(resolveNpmShimTarget(join(dir, "pi.cmd"))).toBeNull();
  });

  it("returns null for a file that is not a shim at all", () => {
    writeFileSync(join(dir, "pi.cmd"), "@echo off" + NL + "echo hi");
    expect(resolveNpmShimTarget(join(dir, "pi.cmd"))).toBeNull();
  });

  it("returns null for a path that does not exist", () => {
    expect(resolveNpmShimTarget(join(dir, "nope.cmd"))).toBeNull();
  });
});

describe("#2835 resolvePiLaunch prefers a runnable script over an unspawnable shim", () => {
  it("launches an npm install as `node <script>`, with NO shell", () => {
    const script = seedScript();
    writeFileSync(join(dir, "pi.cmd"), npmCmdShim(REL));
    // The extensionless bash shim npm also writes — what discovery used to return,
    // and the file that spawns ENOENT on Windows.
    writeFileSync(join(dir, "pi"), "#!/bin/sh");
    process.env.PATH = dir;

    const launch = resolvePiLaunch();
    expect(launch).not.toBeNull();
    expect(launch?.command).toBe(process.execPath);
    expect(launch?.prefixArgs).toEqual([script]);
  });

  it("accepts COMFYUI_MCP_PI_PATH pointing at a shim it CAN resolve", () => {
    // The old refusal said to point this at "the real pi/pi.exe", which an npm
    // install does not ship. The objection was never the extension; it was the
    // shell — and there is no shell in `node <script>`.
    const script = seedScript();
    writeFileSync(join(dir, "pi.cmd"), npmCmdShim(REL));
    process.env.COMFYUI_MCP_PI_PATH = join(dir, "pi.cmd");
    process.env.PATH = "";

    const launch = resolvePiLaunch();
    expect(launch?.command).toBe(process.execPath);
    expect(launch?.prefixArgs).toEqual([script]);
  });

  it("still refuses a .cmd whose target cannot be resolved", () => {
    writeFileSync(join(dir, "pi.cmd"), "@echo off");
    process.env.COMFYUI_MCP_PI_PATH = join(dir, "pi.cmd");
    process.env.PATH = "";
    expect(resolvePiLaunch()).toBeNull();
  });

  it("a real executable still launches as itself, with no prefix", () => {
    const exe = join(dir, process.platform === "win32" ? "pi.exe" : "pi");
    writeFileSync(exe, "");
    process.env.PATH = dir;
    const launch = resolvePiLaunch();
    expect(launch?.command).toBe(exe);
    expect(launch?.prefixArgs).toEqual([]);
  });
});
