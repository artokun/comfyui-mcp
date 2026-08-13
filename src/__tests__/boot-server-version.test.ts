// #1447 — `serverInfo.version` advertised a hardcoded `0.1.0`, a version this package has
// never shipped. That string is what an MCP client displays and what a bug report quotes,
// so it made every report ambiguous about which build produced it — the reporter found it
// while filing a report about something else entirely.
//
// The resolution is EXECUTED here, not described. A first version of this file asserted on
// `boot.ts`'s source text, which codex correctly rejected: source text cannot distinguish
// "reads the manifest" from "reads the manifest and then returns something else". Pulling
// the logic into `readPackageVersion` made it runnable — `boot.ts` itself is a program that
// seizes stdio, so a test can never import it.
//
// The wiring is still checked textually, because that IS a text fact: the one line in
// boot.ts that decides whether any of this reaches the handshake.
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { readPackageVersion, UNKNOWN_VERSION } from "../utils/package-version.js";

const bootSrc = readFileSync(new URL("../boot.ts", import.meta.url), "utf-8");
const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf-8"),
) as { version: string };

const fakeManifest = (body: string) => (): string => body;

describe("readPackageVersion resolves the REAL version (#1447)", () => {
  it("reads this package's actual version by default", () => {
    // No injection: the default URL must land on our own manifest from wherever this
    // module ends up, which is the whole point of resolving from import.meta.url.
    expect(readPackageVersion()).toBe(manifest.version);
    expect(readPackageVersion()).not.toBe("0.1.0");
  });

  it("survives a UTF-8 BOM (codex)", () => {
    // npm writes manifests without one, but a hand-edited file on Windows can carry it,
    // and JSON.parse throws on the BOM — losing the real version to an editor's byte-order
    // mark would reintroduce exactly the ambiguity this fixes.
    const withBom = "﻿" + JSON.stringify({ version: "1.2.3" });
    expect(readPackageVersion(new URL("file:///x/package.json"), fakeManifest(withBom))).toBe(
      "1.2.3",
    );
  });

  it("an unreadable, malformed, or version-less manifest yields a NON-COLLIDING sentinel", () => {
    // Not a plausible one. The literal this replaced was "0.1.0", which read as data —
    // and plain "0.0.0" was rejected in review for the same reason: it is a legal SemVer a
    // real manifest could carry, so it could not be told apart from a genuine value.
    const boom = (): string => {
      throw new Error("ENOENT");
    };
    expect(readPackageVersion(new URL("file:///x/package.json"), boom)).toBe(UNKNOWN_VERSION);
    expect(
      readPackageVersion(new URL("file:///x/package.json"), fakeManifest("{not json")),
    ).toBe(UNKNOWN_VERSION);
    expect(
      readPackageVersion(new URL("file:///x/package.json"), fakeManifest('{"name":"x"}')),
    ).toBe(UNKNOWN_VERSION);
    expect(
      readPackageVersion(new URL("file:///x/package.json"), fakeManifest('{"version":""}')),
    ).toBe(UNKNOWN_VERSION);
    expect(UNKNOWN_VERSION).toBe("0.0.0-unknown");
    // A real manifest reading 0.0.0 must NOT be mistaken for the failure sentinel.
    expect(
      readPackageVersion(new URL("file:///x/package.json"), () => '{"version":"0.0.0"}'),
    ).toBe("0.0.0");
  });
});

describe("the MCP server is wired to it (#1447)", () => {
  it("the McpServer identity block carries no hardcoded version literal", () => {
    // WIRING, not behaviour: a correct helper nothing calls would leave the bug shipped.
    const at = bootSrc.indexOf('name: "comfyui-mcp",');
    expect(at, "the McpServer identity block moved — re-anchor this test").toBeGreaterThan(-1);
    const block = bootSrc.slice(at, at + 200);

    expect(block).toMatch(/version:\s*SERVER_VERSION/);
    expect(block).not.toMatch(/version:\s*["'`]\d+\.\d+\.\d+/);
  });

  it("SERVER_VERSION comes from the helper, once, and not from the install walk", () => {
    expect(bootSrc).toMatch(/const SERVER_VERSION: string = readPackageVersion\(\);/);
    // detectInstallMode() lstat/realpath-walks the install. It is fine after a transport is
    // up (the orchestrator and the issue reporter both use it there) and wrong HERE, on the
    // handshake path — which is the very thing #1447 is about (codex).
    expect(bootSrc).not.toMatch(/detectInstallMode/);
  });
});
