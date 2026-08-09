// #1183 — a DECLINE is not an ABSENCE.
//
// A reporter polled a live 26.5GB local download for ~30 minutes (20% → 67% →
// 79% → 85% → 89% → 95%) and then, for ONE poll, got:
//
//   No download matching id `cb43b8c206bec9b1`. It has either finished long ago
//   … or never started
//
// The file existed nowhere on disk and nothing had been cancelled. Re-issuing the
// same URL immediately re-adopted the SAME id at 97% — the job had been alive in
// process the whole time.
//
// getDownloadJob DECLINES rather than guessing when two live transfers share an
// id, and that refusal is right: picking one arbitrarily is how you report the
// wrong transfer's progress. What is wrong is rendering the refusal as an
// absence. "I will not choose between two" and "there is nothing here" are
// different facts, and only the second justifies telling someone their download
// vanished — which is what invites a redundant multi-gigabyte re-download.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let dir: string;
let mod: typeof import("../../services/download-jobs.js");
let progress: typeof import("../../services/download-progress.js");

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "cm-dl-decline-"));
  vi.resetModules();
  vi.stubEnv("COMFYUI_MCP_PROGRESS_DIR", dir);
  progress = await import("../../services/download-progress.js");
  mod = await import("../../services/download-jobs.js");
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

/** A persisted in-flight record, as a foreign session's heartbeat would write it. */
function writeLive(id: string, trayId: string, owner: string) {
  writeFileSync(
    join(dir, `${progress.CONTROL_PREFIX}job-${id}-${owner}.json`),
    JSON.stringify({
      id,
      trayId,
      owner,
      status: "downloading",
      url: `https://huggingface.co/org/repo/resolve/main/${trayId}.safetensors`,
      updated: Date.now(),
    }),
  );
}

describe("describeUnresolvedDownload (#1183)", () => {
  it("says the transfer is STILL RUNNING when two live records share an id", () => {
    // The ambiguity the lookup legitimately declines to resolve.
    writeLive("cb43b8c206bec9b1", "tray-a", "ownerA");
    writeLive("cb43b8c206bec9b1", "tray-b", "ownerB");

    const note = mod.describeUnresolvedDownload("cb43b8c206bec9b1");
    expect(note).toBeDefined();
    expect(note).toMatch(/IS still running/);
    expect(note).toMatch(/NOT the same as it being gone/);
    // …and names the way to disambiguate, rather than leaving the caller stuck.
    expect(note).toMatch(/tray_id/);
    expect(note).toContain("tray-a");
    expect(note).toContain("tray-b");
  });

  it("tells the caller NOT to re-download — the harm this prevents", () => {
    writeLive("abc", "tray-a", "ownerA");
    expect(mod.describeUnresolvedDownload("abc")).toMatch(/Do NOT re-download/);
  });

  it("says nothing when the id is genuinely absent", () => {
    // A real "not found" must keep its existing wording, or this becomes a
    // different false answer pointing the other way.
    expect(mod.describeUnresolvedDownload("no-such-id")).toBeUndefined();
  });

  it("says nothing for a SETTLED record — done is not still running", () => {
    writeFileSync(
      join(dir, `${progress.CONTROL_PREFIX}job-done1-ownerA.json`),
      JSON.stringify({ id: "done1", trayId: "t", owner: "ownerA", status: "done", updated: Date.now() }),
    );
    expect(mod.describeUnresolvedDownload("done1")).toBeUndefined();
  });

  it("says nothing for a STALE in-flight record — the writer is gone", () => {
    // Beyond the freshness window this is not evidence of a live transfer, and
    // claiming it is would be the same defect in the other direction.
    writeFileSync(
      join(dir, `${progress.CONTROL_PREFIX}job-stale1-ownerA.json`),
      JSON.stringify({
        id: "stale1",
        trayId: "t",
        owner: "ownerA",
        status: "downloading",
        updated: Date.now() - progress.PERSISTED_INFLIGHT_STALE_MS - 1000,
      }),
    );
    expect(mod.describeUnresolvedDownload("stale1")).toBeUndefined();
  });
});

// THE WIRING. The helper cannot see whether the status renderer consults it —
// the call-site blindness this repo keeps getting caught by, and the mutation
// that survived until this test existed.
describe("the status renderer consults the explainer before saying 'no download' (#1183)", () => {
  it("prefers the still-running explanation over the not-found text", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(
      new URL("../../tools/model-management.ts", import.meta.url),
      "utf-8",
    );

    // It must be CALLED…
    expect(src).toContain("describeUnresolvedDownload(args.id)");

    // …and its result must take PRECEDENCE over the "No download matching" text,
    // not merely be computed and dropped.
    const notFound = src.indexOf("`No download matching ${selector}.");
    expect(notFound, "the not-found text must still exist").toBeGreaterThan(-1);
    const before = src.slice(Math.max(0, notFound - 700), notFound);
    expect(before).toContain("unresolvedLive");
    expect(before).toMatch(/text: unresolvedLive\s*\n?\s*\? unresolvedLive/);
  });
});
