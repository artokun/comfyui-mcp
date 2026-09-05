// #1131 — "not listed" has TWO causes, and they take OPPOSITE remedies.
//
// A user downloaded a LoRA into the connected ComfyUI's exact models root. The
// placement check asked the server's loader option list immediately, the list had
// not been re-read yet, and the tool reported NOT VISIBLE — then told them to
// "move the file into the running server's models tree", naming a directory the
// file was already in. Their own words: the written path and the server models
// path were identical.
//
// That is a remedy that cannot be followed — the same family as #1043's fence
// advice, where the verdict was defensible and the instruction was not.
//
// ComfyUI caches loader options and invalidates them on the directory's mtime, so
// a check this soon after a write routinely races it. Inside the root ⇒ stale
// listing, refresh. Outside ⇒ genuinely misplaced, move.

import { describe, expect, it } from "vitest";
import {
  isUnderRoot,
  notVisibleVerdict,
  staleListingRefreshRemedy,
} from "../../services/model-resolver.js";

const BASE = {
  wanted: "example.safetensors",
  category: "loras",
  baseUrl: "http://127.0.0.1:8188",
  // Pin the unknown-bundle branch so a live panel on this machine cannot
  // rewrite the refresh sentence (#2876).
  panelBundle: {},
};

describe("a file inside the server's own models root is not called misplaced", () => {
  // The reporter's exact shape: one path, spelled two ways.
  const reported = notVisibleVerdict({
    ...BASE,
    verifiedPath: "C:\\ComfyUI\\models\\loras\\example.safetensors",
    liveModelsDir: "C:/ComfyUI/models",
    // #369 (0.52.1) — the provenance is now REQUIRED for this branch, and this is
    // #1131's actual setup: the reporter wrote into the connected ComfyUI's own
    // models root, i.e. one the running server named. Containment against a root
    // nobody vouched for gets the third verdict instead (below).
    liveModelsDirNamedByServer: true,
  });

  it("never prints the impossible instruction", () => {
    expect(reported.note).not.toMatch(/Move the file into the running server's models tree/);
    expect(reported.note).not.toMatch(/point COMFYUI_PATH/);
  });

  it("says the placement is right, and says so explicitly", () => {
    expect(reported.note).toMatch(/it is in the right place/);
    expect(reported.note).toMatch(/Do NOT move the file/);
  });

  it("names the actual cause and a remedy that can be followed", () => {
    expect(reported.note).toMatch(/cached loader options/);
    expect(reported.note).not.toMatch(/install_comfyui \(action:"refresh_nodes"\)/);
    expect(reported.note).toMatch(/hard-refresh the ComfyUI browser tab \(Ctrl\+Shift\+R\)/);
  });

  it("still reports not-visible — the verdict did not weaken", () => {
    // #369 exists because an unobserved placement must not render as confirmed.
    // A kinder explanation is not evidence that the server can read the file.
    expect(reported.liveVisible).toBe("not-visible");
  });
});

describe("a file outside that root keeps the move remedy", () => {
  const misplaced = notVisibleVerdict({
    ...BASE,
    verifiedPath: "/home/u/Downloads/example.safetensors",
    liveModelsDir: "/opt/ComfyUI/models",
  });

  it("still tells the user to move it, and where", () => {
    expect(misplaced.note).toMatch(/Move the file into the running server's models tree/);
    expect(misplaced.note).toMatch(/\/opt\/ComfyUI\/models/);
  });

  it("does not tell them a refresh will fix it", () => {
    // The dangerous inversion: a genuinely misplaced file that the user refreshes
    // forever instead of moving.
    expect(misplaced.note).not.toMatch(/Do NOT move the file/);
  });

  it("keeps the move remedy when the live root is unknown", () => {
    const unknownRoot = notVisibleVerdict({
      ...BASE,
      verifiedPath: "/home/u/Downloads/example.safetensors",
      liveModelsDir: undefined,
    });
    // Cannot prove it is in the right place ⇒ must not claim it is.
    expect(unknownRoot.note).toMatch(/Move the file/);
    expect(unknownRoot.note).not.toMatch(/models directory that server reads/);
  });
});

describe("a file inside via a junction keeps the refresh remedy (#369/#870)", () => {
  // StabilityMatrix: the write path is inside the live root, but the REALPATH
  // escapes it through the junction. The membership answer (knownInsideLiveRoots)
  // — not the path comparison — decides which remedy is followable.
  const junctioned = notVisibleVerdict({
    ...BASE,
    verifiedPath: "E:/StabilityMatrix/models/VAE/example.safetensors",
    liveModelsDir: "C:/ComfyUI/models",
    knownInsideLiveRoots: true,
  });

  it("does not prescribe moving a file the server already reads", () => {
    expect(junctioned.note).toMatch(/Do NOT move the file/);
    expect(junctioned.note).not.toMatch(/Move the file into the running server's models tree/);
  });

  it("still reports not-visible — the verdict did not weaken", () => {
    expect(junctioned.liveVisible).toBe("not-visible");
  });
});

// ---------------------------------------------------------------------------
// #369, the 0.52.1 recurrence — CONTAINMENT IN A ROOT WE PICKED IS NOT READERSHIP.
//
// macOS, two installs under ~/ComfyUI-Installs, the live one a Comfy Desktop
// server reached through --extra-model-paths-config. Four downloads landed in the
// install-local models/ tree while the connected server's /models/<category>
// answered EMPTY; the tool told the user the directory was one the connected
// server reads and not to move the file. ~25 GB.
//
// The containment test ran against whatever resolveModelsDir() returned — which
// includes a `configured-base`/`observed-root` value the server never named. That
// is the very root the download resolved to, so the landed file is inside it BY
// CONSTRUCTION: the comparison answers "inside" for a correct destination and for
// a stale second install alike (taxonomy #1 — two states, one answer, no way to
// say unknown).
// ---------------------------------------------------------------------------
describe("a root the server never NAMED cannot vouch for the placement (#369)", () => {
  const unvouched = notVisibleVerdict({
    ...BASE,
    verifiedPath: "/Users/u/ComfyUI-Installs/ComfyUI/ComfyUI/models/loras/example.safetensors",
    liveModelsDir: "/Users/u/ComfyUI-Installs/ComfyUI/ComfyUI/models",
    // Omitted provenance = unknown provenance. Local config / an inference.
  });

  it("never claims the connected ComfyUI reads that directory", () => {
    expect(unvouched.note).not.toMatch(/INSIDE the models directory the connected ComfyUI reads/);
    expect(unvouched.note).not.toMatch(/it is in the right place/);
    expect(unvouched.note).toMatch(/UNCONFIRMED/);
  });

  it("does not hand out either remedy as if it were established", () => {
    // Not the #1131 harm (an unfollowable move instruction)…
    expect(unvouched.note).not.toMatch(/Move the file into the running server's models tree/);
    // …and not the #369 harm (a reassurance that the bytes are placed).
    expect(unvouched.note).not.toMatch(/Do NOT move the file/);
  });

  it("states BOTH candidate causes and the check that separates them", () => {
    expect(unvouched.note).toMatch(/STALE LISTING/);
    expect(unvouched.note).toMatch(/DIFFERENT INSTALL/);
    expect(unvouched.note).not.toMatch(/install_comfyui \(action:"refresh_nodes"\)/);
    expect(unvouched.note).toMatch(/list_paths/);
  });

  it("still reports not-visible — the verdict did not weaken", () => {
    expect(unvouched.liveVisible).toBe("not-visible");
  });

  it("takes the CONFIDENT branch for the same paths once the server named the root", () => {
    // Same two paths, one fact different. If this and the case above ever produce
    // the same note, the provenance stopped being read.
    const vouched = notVisibleVerdict({
      ...BASE,
      verifiedPath: "/Users/u/ComfyUI-Installs/ComfyUI/ComfyUI/models/loras/example.safetensors",
      liveModelsDir: "/Users/u/ComfyUI-Installs/ComfyUI/ComfyUI/models",
      liveModelsDirNamedByServer: true,
    });
    expect(vouched.note).toMatch(/it is in the right place/);
    expect(vouched.note).not.toBe(unvouched.note);
  });

  it("keeps the junction/extra-root vouching, which carries its own narrowing", () => {
    // knownInsideLiveRoots comes from isUnderLiveModelRoots, which already refuses
    // to answer for a root the server did not name — so it stays sufficient, and a
    // #870 junction must not regress into the unverified branch.
    const junctioned = notVisibleVerdict({
      ...BASE,
      verifiedPath: "E:/StabilityMatrix/models/VAE/example.safetensors",
      liveModelsDir: "C:/ComfyUI/models",
      knownInsideLiveRoots: true,
    });
    expect(junctioned.note).toMatch(/Do NOT move the file/);
    expect(junctioned.note).not.toMatch(/UNCONFIRMED/);
  });

  it("does not present an unvouched root as what the server reads in the MOVE branch", () => {
    const outside = notVisibleVerdict({
      ...BASE,
      verifiedPath: "/home/u/Downloads/example.safetensors",
      liveModelsDir: "/opt/guessed/models",
    });
    expect(outside.note).not.toMatch(/models directory that server reads/);
    // …but it still names the root, because that is where the bytes are.
    expect(outside.note).toMatch(/\/opt\/guessed\/models/);
  });
});

describe("stale-listing refresh names a tool the live bundle can run (#2876)", () => {
  const FAKE_INSTALL_ACTION = 'install_comfyui (action:"refresh_nodes")';
  const BASE_VERDICT = {
    ...BASE,
    verifiedPath: "C:\\ComfyUI\\models\\loras\\example.safetensors",
    liveModelsDir: "C:/ComfyUI/models",
    liveModelsDirNamedByServer: true,
  };

  it("never advertises install_comfyui action:\"refresh_nodes\" — that action is not declared", () => {
    expect(staleListingRefreshRemedy({})).not.toContain(FAKE_INSTALL_ACTION);
    expect(staleListingRefreshRemedy({ liveVersion: "0.15.174", installedVersion: "0.15.174" })).not.toContain(
      FAKE_INSTALL_ACTION,
    );
    expect(staleListingRefreshRemedy({ liveVersion: "0.15.173", installedVersion: "0.15.174" })).not.toContain(
      FAKE_INSTALL_ACTION,
    );
    expect(notVisibleVerdict({ ...BASE_VERDICT, panelBundle: {} }).note).not.toContain(FAKE_INSTALL_ACTION);
  });

  it("names panel_refresh_nodes when the live tab can execute it", () => {
    const note = staleListingRefreshRemedy({
      liveVersion: "0.15.174",
      installedVersion: "0.15.174",
    });
    expect(note).toMatch(/call panel_refresh_nodes/);
    expect(note).not.toMatch(/Hard-refresh the ComfyUI browser tab first/);
    const wired = notVisibleVerdict({
      ...BASE_VERDICT,
      panelBundle: { liveVersion: "0.15.174", installedVersion: "0.15.174" },
    });
    expect(wired.note).toMatch(/call panel_refresh_nodes/);
    expect(wired.note).not.toContain(FAKE_INSTALL_ACTION);
  });

  it("the reporter's stale tab is told to hard-refresh first, not to call panel_refresh_nodes now", () => {
    // tab 0.15.173, installed 0.15.174 — panel_refresh_nodes was blocked on the live bundle.
    const note = staleListingRefreshRemedy({
      liveVersion: "0.15.173",
      installedVersion: "0.15.174",
    });
    expect(note).toMatch(/Hard-refresh the ComfyUI browser tab first \(Ctrl\+Shift\+R\)/);
    expect(note).toMatch(/0\.15\.173/);
    expect(note).toMatch(/0\.15\.174/);
    const firstCall = note.search(/call panel_refresh_nodes/);
    const hardRefresh = note.search(/Hard-refresh the ComfyUI browser tab first/);
    expect(hardRefresh).toBeGreaterThanOrEqual(0);
    expect(firstCall).toBeGreaterThan(hardRefresh);
    const wired = notVisibleVerdict({
      ...BASE_VERDICT,
      panelBundle: { liveVersion: "0.15.173", installedVersion: "0.15.174" },
    });
    expect(wired.note).toMatch(/Hard-refresh the ComfyUI browser tab first \(Ctrl\+Shift\+R\)/);
    expect(wired.note).not.toContain(FAKE_INSTALL_ACTION);
  });

  it("does not name panel_refresh_nodes when the live bundle is unknown or too old", () => {
    expect(staleListingRefreshRemedy({})).not.toMatch(/call panel_refresh_nodes/);
    expect(staleListingRefreshRemedy({ liveVersion: "0.11.20", installedVersion: "0.11.20" })).not.toMatch(
      /call panel_refresh_nodes/,
    );
    expect(staleListingRefreshRemedy({})).toMatch(/hard-refresh the ComfyUI browser tab \(Ctrl\+Shift\+R\)/);
  });
});

describe("isUnderRoot", () => {
  // The platform is a PARAMETER, not read from the host, so the Windows case is
  // genuinely exercised on ubuntu CI rather than quietly passing there for the
  // wrong reason — a local green run is single-platform evidence only.
  it("treats mixed separators and case as the same directory on Windows", () => {
    expect(
      isUnderRoot("C:\\ComfyUI\\models\\loras\\example.safetensors", "c:/comfyui/models", "win32"),
    ).toBe(true);
  });

  it("does NOT fold case on POSIX, where Models and models differ", () => {
    expect(isUnderRoot("/comfy/Models/loras/x.safetensors", "/comfy/models", "linux")).toBe(false);
  });

  it("does not treat a SIBLING directory as inside", () => {
    // …/models2 must never count as inside …/models, or a genuinely misplaced
    // file gets the "just refresh" advice and is never found.
    expect(isUnderRoot("/comfy/models2/loras/x.safetensors", "/comfy/models", "linux")).toBe(false);
  });

  it("counts the root itself as inside", () => {
    expect(isUnderRoot("/comfy/models", "/comfy/models", "linux")).toBe(true);
  });

  it("ignores a trailing separator on the root", () => {
    expect(isUnderRoot("/comfy/models/loras/x.safetensors", "/comfy/models/", "linux")).toBe(true);
  });

  it("keeps a genuinely outside path outside", () => {
    expect(isUnderRoot("/somewhere/else/x.safetensors", "/comfy/models", "linux")).toBe(false);
  });
});
