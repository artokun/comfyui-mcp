import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  discoverDsh,
  dshMemoryOverlays,
} from "../../orchestrator/dsh-discovery.js";
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "dsh-discovery-"));
  roots.push(root);
  return root;
}
function put(path: string, text = "") {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
}
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
describe("DSH discovery", () => {
  it("prefers an explicit JS CLI and preserves paths with spaces", () => {
    const root = fixture();
    const bin = join(root, "portable DSH", "bin.js");
    put(bin);
    expect(
      discoverDsh({
        env: { COMFYUI_MCP_DSH_BIN: bin, COMFYUI_MCP_DSH_HOME: root },
        node: "node",
        home: root,
      })?.args,
    ).toEqual([bin]);
  });
  it("does not silently fall through an invalid configured CLI", () => {
    expect(() =>
      discoverDsh({ env: { COMFYUI_MCP_DSH_BIN: join(fixture(), "missing") } }),
    ).toThrow(/Configured DSH/);
  });
  it("finds a PATH executable without installing anything", () => {
    const root = fixture();
    put(join(root, "dsh"));
    expect(
      discoverDsh({ env: { PATH: root }, home: root, platform: "linux" })
        ?.source,
    ).toBe("path");
  });
  it("resolves a Windows npm shim without invoking a shell", () => {
    const root = fixture();
    put(join(root, "dsh.cmd"));
    const script = join(root, "node_modules/@deepseek-ai/dsh/lib/bin.js");
    put(script);
    const found = discoverDsh({
      env: { PATH: root },
      home: root,
      platform: "win32",
      node: "node",
    });
    expect(found?.command).toBe("node");
    expect(found?.args).toEqual([script]);
  });
  it("discovers a portable running official CLI and its home", () => {
    const root = fixture();
    const script = join(root, "node_modules/@deepseek-ai/dsh/lib/bin.js");
    put(script);
    put(
      join(script, "../../package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh" }),
    );
    const proc = join(root, "proc");
    put(
      join(proc, "100/cmdline"),
      [process.execPath, script, "--profile", "web", ""].join("\0"),
    );
    put(
      join(proc, "100/environ"),
      `DSH_HOME=${root}\0IGNORED_PRIVATE_VALUE=fixture-secret\0`,
    );
    const found = discoverDsh({
      env: {},
      home: root,
      platform: "linux",
      procRoot: proc,
    });
    expect(found?.source).toBe("running");
    expect(found?.home).toBe(root);
    expect(JSON.stringify(found)).not.toContain("fixture-secret");
  });
  it("returns unavailable when no installation exists", () => {
    const root = fixture();
    expect(discoverDsh({ env: {}, home: root, platform: "win32" })).toBeNull();
  });
  it("reuses a selected memory bundle but not a merely cached package", () => {
    const root = fixture(),
      profile = join(root, "profiles/web"),
      bundle = join(profile, "node_modules/dsh-mnemon");
    put(
      join(profile, "package.json"),
      JSON.stringify({ dsh: { profile: { bundles: ["dsh-mnemon"] } } }),
    );
    put(
      join(bundle, "package.json"),
      JSON.stringify({
        name: "dsh-mnemon",
        dsh: { bundle: { patch: "./cordis.patch.yml" } },
      }),
    );
    put(join(bundle, "cordis.patch.yml"), "[]");
    expect(dshMemoryOverlays(root)).toEqual([join(bundle, "cordis.patch.yml")]);
    put(
      join(profile, "package.json"),
      JSON.stringify({ dsh: { profile: { bundles: [] } } }),
    );
    expect(dshMemoryOverlays(root)).toEqual([]);
  });
});
