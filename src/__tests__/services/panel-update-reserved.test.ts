// #1133 — "staged" is not "failed".
//
// ComfyUI-Manager cannot swap a directory the running server is serving, and it
// is always serving the panel. So instead of no-op'ing it RESERVES the switch:
// it appends a `#LAZY-CNR-SWITCH-SCRIPT` line naming the pack to
// `<user>/__manager/startup-scripts/install-scripts.txt`, prints "Installation
// reserved: <pack>", and returns success. Its prestartup script applies the line
// on the next boot.
//
// From the outside that is indistinguishable from the stale-3.x silent no-op:
// the queue drains and the pack has not moved. A reporter on ComfyUI Desktop hit
// it four times in a row, was told each time the update "did NOT apply", and was
// steered toward reinstall-from-source — for something a restart finishes. On
// Desktop the reinstall fallback refuses and restart_comfyui declines to act, so
// the misreport left no route at all.
//
// install-scripts.txt is the file Manager itself writes, so reading it is direct
// evidence of the staging rather than an inference from absence of movement.

import { describe, expect, it } from "vitest";
import { dirname, join } from "node:path";
import { readManagerReservation } from "../../services/panel-installer.js";

const PACK = "comfyui-agent-panel";
// Built with join(), like the code under test — a hard-coded "/" path silently
// misses on Windows, where this reporter was.
const ROOT = join("/comfy");
const NEW = join(ROOT, "user", "__manager", "startup-scripts", "install-scripts.txt");
const LEGACY = join(
  ROOT,
  "user",
  "default",
  "ComfyUI-Manager",
  "startup-scripts",
  "install-scripts.txt",
);

/** Manager writes a repr'd Python list, one per line. */
const reservedLine = (pack: string) =>
  `['${pack}', '#LAZY-CNR-SWITCH-SCRIPT', 'https://x/y.zip', '/from', '/to', False, '/cn', 'python']`;

function fsWith(files: Record<string, string | Error>) {
  const dirs = new Set(Object.keys(files).map((f) => dirname(f)));
  return {
    existsSync: (p: string) => p in files || dirs.has(p),
    readFile: (p: string) => {
      const v = files[p];
      if (v instanceof Error) throw v;
      if (v === undefined) throw new Error(`ENOENT ${p}`);
      return v;
    },
  };
}

describe("readManagerReservation", () => {
  it("reports RESERVED when Manager staged this pack (current layout)", () => {
    const deps = fsWith({ [NEW]: reservedLine(PACK) });
    expect(readManagerReservation(ROOT, PACK, deps)).toBe("reserved");
  });

  it("reads the LEGACY user/default/ComfyUI-Manager layout too", () => {
    // manager_migration.get_manager_path moved this; hosts that have not
    // migrated must not read as "nothing staged".
    const deps = fsWith({ [LEGACY]: reservedLine(PACK) });
    expect(readManagerReservation(ROOT, PACK, deps)).toBe("reserved");
  });

  it("reports ABSENT when the dir exists but nothing is staged", () => {
    // Manager creates startup-scripts/ at boot and writes the txt only when
    // something is reserved — so dir-without-file IS proof of no staging.
    const deps = {
      existsSync: (p: string) => p === join(ROOT, "user", "__manager", "startup-scripts"),
      readFile: () => {
        throw new Error("should not be read");
      },
    };
    expect(readManagerReservation(ROOT, PACK, deps)).toBe("absent");
  });

  it("reports ABSENT when another pack is staged, not ours", () => {
    const deps = fsWith({ [NEW]: reservedLine("comfyui-impact-pack") });
    expect(readManagerReservation(ROOT, PACK, deps)).toBe("absent");
  });

  it("does not match a pack whose name merely STARTS with ours", () => {
    // `comfyui-agent-panel-extras` must not be read as `comfyui-agent-panel`,
    // or an unrelated staging would suppress a real failure report.
    const deps = fsWith({ [NEW]: reservedLine("comfyui-agent-panel-extras") });
    expect(readManagerReservation(ROOT, PACK, deps)).toBe("absent");
  });

  it("ignores a line for our pack that is NOT a CNR switch", () => {
    const deps = fsWith({ [NEW]: `['${PACK}', '#LAZY-INSTALL-SCRIPT', 'python']` });
    expect(readManagerReservation(ROOT, PACK, deps)).toBe("absent");
  });

  it("reports UNKNOWN when no user directory is visible at all", () => {
    // Remote mode, a relocated user dir, a permissions failure. Saying "absent"
    // here would be the same fold this fix exists to undo, pointing the other
    // way: a failure re-labelled as a pending success.
    const deps = { existsSync: () => false, readFile: () => "" };
    expect(readManagerReservation(ROOT, PACK, deps)).toBe("unknown");
  });

  it("reports UNKNOWN when there is no ComfyUI path", () => {
    expect(readManagerReservation(undefined, PACK, fsWith({}))).toBe("unknown");
  });

  it("reports UNKNOWN when the file is present but unreadable", () => {
    const deps = fsWith({ [NEW]: new Error("EACCES") });
    expect(readManagerReservation(ROOT, PACK, deps)).toBe("unknown");
  });

  it("finds the reservation among unrelated lines", () => {
    const deps = fsWith({
      [NEW]: [
        `['other-pack', '#LAZY-INSTALL-SCRIPT', 'python']`,
        reservedLine(PACK),
        "",
      ].join("\r\n"), // Manager runs on Windows too
    });
    expect(readManagerReservation(ROOT, PACK, deps)).toBe("reserved");
  });
});
