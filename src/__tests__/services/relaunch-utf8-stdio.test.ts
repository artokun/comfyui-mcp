// #2693 — a portable Windows relaunch died on an emoji.
//
//     UnicodeEncodeError: 'cp949' codec can't encode character '\U0001f389'
//
// rgthree-comfy printed its startup banner and ComfyUI exited during custom-node
// startup. The user's own console launch of the same command works, which is the
// tell that this is ours: #1259 points the relaunched child's stdout at a LOG
// FILE so a failed launch can say what it printed, and Python not writing to a
// terminal encodes to the locale codepage instead. On a Korean Windows install
// that is cp949, and a party popper is not encodable in cp949.
//
// We chose the destination, so the encoding on it is ours to choose. These pin
// that choice, and — just as important — pin that it is not imposed on a user who
// made their own.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { withUtf8StdioEnv } from "../../services/launcher-env.js";

const WIN = { platform: "win32" as NodeJS.Platform, baseEnv: {} as NodeJS.ProcessEnv };

describe("#2693 a relaunch whose stdout is a file gets UTF-8", () => {
  it("adds both variables when the launch has neither", () => {
    const out = withUtf8StdioEnv({ PATH: "/x" }, WIN);
    expect(out).toMatchObject({ PATH: "/x", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
  });

  it("adds them to an INHERITED environment too", () => {
    // `env: undefined` means the child inherits, so the values already in force
    // are what it would have got — that is the case the reporter hit, since the
    // plain-install path passes no env at all.
    const out = withUtf8StdioEnv(undefined, {
      platform: "win32",
      baseEnv: { PATH: "/inherited" },
    });
    expect(out).toMatchObject({ PATH: "/inherited", PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
  });

  it("NEVER overrides an explicit PYTHONIOENCODING", () => {
    // Someone who set it means it. Overriding a user's encoding choice to fix an
    // encoding bug is just a different encoding bug.
    const out = withUtf8StdioEnv({ PYTHONIOENCODING: "cp932" }, WIN);
    expect(out?.PYTHONIOENCODING).toBe("cp932");
    expect(out?.PYTHONUTF8).toBe("1"); // the other one is still missing, so it is added
  });

  it("NEVER overrides an explicit PYTHONUTF8=0", () => {
    // The deliberate opt-OUT. "0" is a real value, so the emptiness test must not
    // treat it as unset.
    const out = withUtf8StdioEnv({ PYTHONUTF8: "0", PYTHONIOENCODING: "cp949" }, WIN);
    expect(out).toEqual({ PYTHONUTF8: "0", PYTHONIOENCODING: "cp949" });
  });

  it("treats an EMPTY value as unset", () => {
    const out = withUtf8StdioEnv({ PYTHONUTF8: "", PYTHONIOENCODING: "   " }, WIN);
    expect(out).toMatchObject({ PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" });
  });

  it("returns the input UNCHANGED when both are already set", () => {
    // Identity, not a copy: a launch that was already fine must keep its exact
    // previous behaviour, including inheriting rather than being handed a copy.
    const env = { PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" };
    expect(withUtf8StdioEnv(env, WIN)).toBe(env);
  });

  it("does nothing off Windows, and preserves `inherit`", () => {
    // Scope is deliberate: a POSIX box under LANG=C has the same shape, but
    // nothing has reported one and widening a fix past its evidence is how it
    // acquires a second bug.
    expect(withUtf8StdioEnv(undefined, { platform: "linux", baseEnv: {} })).toBeUndefined();
    const env = { PATH: "/x" };
    expect(withUtf8StdioEnv(env, { platform: "darwin", baseEnv: {} })).toBe(env);
  });

  // The helper is correct in isolation on every platform; it only CHANGES the
  // spawn on Windows, so the behavioural coverage above runs for real on one CI
  // leg out of three. This pins the wiring on all of them — a helper nothing
  // calls would leave every test above green.
  it("is applied at the relaunch spawn, on the env the plan resolved", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../services/process-control.ts", import.meta.url)),
      "utf-8",
    );
    expect(src).toContain("env: withUtf8StdioEnv(envPlan.env),");
    // …and it decorates the spawn that captures stdio to a file, which is what
    // makes the encoding ours to choose in the first place.
    const spawnAt = src.indexOf('stdio: launchLog ? ["ignore", launchLog.fd, launchLog.fd] : "ignore",');
    expect(spawnAt).toBeGreaterThan(-1);
    expect(src.indexOf("env: withUtf8StdioEnv(envPlan.env),", spawnAt)).toBeGreaterThan(spawnAt);
  });
});
