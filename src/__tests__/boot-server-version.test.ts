// #1447 — `serverInfo.version` advertised a hardcoded `0.1.0`, a version this package has
// never shipped. That string is what an MCP client displays and what a bug report quotes,
// so it made every report ambiguous about which build produced it — the reporter found it
// while filing a report about something else entirely.
//
// ASSERTED ON THE SOURCE, deliberately. The obvious functional test — start the server and
// read its initialize response — cannot run here: `boot.ts` is a program, not a module you
// can import without it taking over stdio. And the failure mode being guarded is a literal
// creeping back into one specific object, which the source is the honest place to check.
// (The behaviour itself was verified live: a real `initialize` against the built server
// returns the package version, where it returned "0.1.0" before this change.)
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

const bootSrc = readFileSync(new URL("../boot.ts", import.meta.url), "utf-8");

describe("the MCP server advertises its REAL version (#1447)", () => {
  it("the McpServer identity block carries no hardcoded version literal", () => {
    // Anchor on the construction itself rather than scanning the whole file: a version
    // string elsewhere (a comment, a compatibility floor) is not this bug.
    const at = bootSrc.indexOf('name: "comfyui-mcp",');
    expect(at, "the McpServer identity block moved — re-anchor this test").toBeGreaterThan(-1);
    const block = bootSrc.slice(at, at + 200);

    expect(block).toMatch(/version:\s*SERVER_VERSION/);
    // The specific regression: any quoted semver back in that slot.
    expect(block).not.toMatch(/version:\s*["'`]\d+\.\d+\.\d+/);
  });

  it("SERVER_VERSION is resolved from the install, not written down", () => {
    const at = bootSrc.indexOf("const SERVER_VERSION");
    expect(at, "SERVER_VERSION was removed or renamed").toBeGreaterThan(-1);
    const decl = bootSrc.slice(at, at + 400);

    // It must READ the running install — the same source the orchestrator and the issue
    // reporter already use, so all three cannot disagree about which build is running.
    expect(decl).toMatch(/detectInstallMode\(\)\.currentVersion/);
    // And its fallback must be an OBVIOUSLY impossible version. A plausible-looking one
    // (like the 0.1.0 this replaced) is a lie that reads as data.
    expect(decl).toMatch(/["'`]0\.0\.0["'`]/);
    expect(decl).not.toMatch(/["'`]0\.1\.0["'`]/);
  });

  it("the resolution happens ONCE, at module load", () => {
    // A per-call read could only ever differ if the files changed under a running
    // process, which would report a version this process is not executing.
    const at = bootSrc.indexOf("const SERVER_VERSION");
    const decl = bootSrc.slice(at, at + 400);
    expect(decl).toMatch(/const SERVER_VERSION: string = \(\(\)/);
  });
});
