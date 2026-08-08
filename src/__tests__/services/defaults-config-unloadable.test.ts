// #796, on a file the USER typed.
//
// A defaults config that exists and fails to load left `configValues` empty with
// only a `logger.warn` to show for it. Two harms followed, and the second is the
// one that loses work.
//
// 1. SILENTLY NOT APPLIED. The user wrote that file to change what gets
//    generated. `get_defaults action:"get"` reported the built-in and env
//    defaults as though nothing were wrong, and renders quietly used settings
//    the user had not chosen. The only signal went to a log they may have no
//    access to.
//
// 2. SILENTLY DESTROYED. `set({...}, {persist:true})` does
//    `{ ...state.configValues, ...updates }` — and after a failed load that is
//    `{ ...{}, ...updates }`. Persisting ONE new default therefore overwrote the
//    whole file with just that key.
//
// Unlike the session store (machine-written, so unparseable really is worthless),
// this file is typed by a person: "unparseable" usually means a trailing comma in
// content they care about. So a PARSE failure is preserved here too, not just an
// I/O failure.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DefaultsManager } from "../../services/defaults-manager.js";

let dir: string;
let configPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cmcp-defaults-"));
  configPath = join(dir, "config.json");
  // Empty env so nothing leaks in from the real process (COMFYUI_DEFAULT_*).
  DefaultsManager.configure({ configPath, env: {} });
});

afterEach(() => {
  DefaultsManager.reset();
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
});

describe("a config that could not be loaded says so", () => {
  it("reports the reason instead of looking like an empty config", async () => {
    writeFileSync(configPath, '{ "width": 1024, }'); // trailing comma — the usual cause
    await DefaultsManager.load();

    expect(DefaultsManager.configLoadError()).toBeTruthy();
    // …and none of its values are in effect, which is exactly why saying so matters.
    expect(DefaultsManager.getAll().width).toBeUndefined();
  });

  it("says nothing when the file loads fine", async () => {
    writeFileSync(configPath, JSON.stringify({ width: 1024 }));
    await DefaultsManager.load();

    expect(DefaultsManager.configLoadError()).toBeUndefined();
    expect(DefaultsManager.getAll().width).toEqual({ value: 1024, source: "config" });
  });

  it("says nothing when there is no file at all — absence is not a failure", async () => {
    await DefaultsManager.load();
    expect(DefaultsManager.configLoadError()).toBeUndefined();
  });

  it("flags valid JSON that is not an object", async () => {
    writeFileSync(configPath, JSON.stringify(["width", 1024]));
    await DefaultsManager.load();

    expect(DefaultsManager.configLoadError()).toMatch(/not an object/);
  });

  it("clears once the file is fixed and reloaded", async () => {
    writeFileSync(configPath, "{ broken");
    await DefaultsManager.load();
    expect(DefaultsManager.configLoadError()).toBeTruthy();

    writeFileSync(configPath, JSON.stringify({ steps: 30 }));
    await DefaultsManager.load();
    expect(DefaultsManager.configLoadError()).toBeUndefined();
  });
});

describe("persisting never destroys a config it could not read", () => {
  it("moves the unloadable file aside instead of overwriting it", async () => {
    const original = '{ "width": 1024, "steps": 30, }'; // the user's real settings
    writeFileSync(configPath, original);
    await DefaultsManager.load();

    await DefaultsManager.set({ height: 512 }, { persist: true });

    const preserved = readdirSync(dir).filter((f) => f.includes(".unreadable-"));
    expect(preserved, "the user's file must be kept, not overwritten").toHaveLength(1);
    expect(readFileSync(join(dir, preserved[0]!), "utf-8")).toBe(original);

    // …and the new config really was written in its place.
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({ height: 512 });
  });

  it("preserves only once — later writes are ordinary", async () => {
    writeFileSync(configPath, "{ broken");
    await DefaultsManager.load();

    await DefaultsManager.set({ a: 1 }, { persist: true });
    await DefaultsManager.set({ b: 2 }, { persist: true });

    expect(readdirSync(dir).filter((f) => f.includes(".unreadable-"))).toHaveLength(1);
    // The second write merged normally rather than clobbering the first.
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({ a: 1, b: 2 });
  });

  // A DIRECTORY at the config path is the other way loading fails (EISDIR), and
  // it must be preserved the same way — nothing about the guard should depend on
  // the obstacle being a file.
  it("preserves a directory at the config path too", async () => {
    mkdirSync(configPath, { recursive: true });
    writeFileSync(join(configPath, "marker.txt"), "the user's stuff");
    await DefaultsManager.load();
    expect(DefaultsManager.configLoadError()).toBeTruthy();

    await DefaultsManager.set({ height: 512 }, { persist: true });

    const preserved = readdirSync(dir).filter((f) => f.includes(".unreadable-"));
    expect(preserved).toHaveLength(1);
    expect(readFileSync(join(dir, preserved[0]!, "marker.txt"), "utf-8")).toBe("the user's stuff");
    expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({ height: 512 });
  });

  // NOT TESTED, and said out loud rather than faked: the branch where the file
  // can be neither loaded NOR moved aside, which throws rather than overwriting.
  // Forcing `rename` to fail needs a read-only parent directory (not portable —
  // it does not stop root, and Windows ACLs differ) or an injectable fs, which
  // this module does not take. An earlier draft of this file "covered" it by
  // asserting a runtime value applied after a persist:false call, which exercises
  // neither the rename nor the throw.
  it("keeps runtime values applying regardless of what the file is doing", async () => {
    writeFileSync(configPath, "{ broken");
    await DefaultsManager.load();

    await DefaultsManager.set({ height: 512 }, { persist: false });

    expect(DefaultsManager.getAll().height).toEqual({ value: 512, source: "runtime" });
    // persist:false must not touch the file at all — no preservation, no write.
    expect(readdirSync(dir).filter((f) => f.includes(".unreadable-"))).toHaveLength(0);
    expect(readFileSync(configPath, "utf-8")).toBe("{ broken");
  });
});
