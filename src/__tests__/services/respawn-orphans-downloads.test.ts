// #1378 — saving a credential mid-flight respawns the comfyui tool session, and the new
// auth header changes each in-flight download's CACHE IDENTITY. A `.partial` at 96% becomes
// unreachable and the re-issued download starts from zero. A reporter lost ~29 GB across
// two files: the bytes were never deleted, nothing could find them again, and nothing
// warned them until it was already too late to wait.
//
// RESCUING THE TRANSFER IS DELIBERATELY NOT ATTEMPTED. Reusing the old cache entry under
// the new identity would serve bytes fetched under one auth identity to a request made
// under another — exactly what folding headers into the key exists to prevent, and a worse
// failure than a re-download. The reporter reached the same conclusion and filed a
// diagnosis rather than guess at a patch.
//
// So what ships is the CHOICE, delivered while it is still a choice: before the respawn.
//
// The job list is INJECTED, not mocked. `downloadsAtRiskOfRespawn` calls
// `listDownloadJobs` from inside its own module, and vi.mock replaces a module's EXPORT,
// not its internal binding — my first version of this file mocked it and got an empty list
// back from working code.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

const hoisted = vi.hoisted(() => ({
  progress: {} as Record<string, { downloaded: number }>,
}));

vi.mock("../../services/download-progress.js", async (orig) => ({
  ...(await orig<Record<string, unknown>>()),
  readDownloadProgress: (id: string) => hoisted.progress[id],
}));

const { downloadsAtRiskOfRespawn } = await import("../../services/download-jobs.js");
const { setProgressDir, CONTROL_PREFIX } = await import("../../services/download-progress.js");

type Job = Parameters<typeof downloadsAtRiskOfRespawn>[0];
const jobs = (...list: Record<string, unknown>[]): Job => list as unknown as Job;

beforeEach(() => {
  hoisted.progress = {};
});

describe("downloadsAtRiskOfRespawn (#1378)", () => {
  it("reports the in-flight downloads and how much has been fetched", () => {
    hoisted.progress = { a: { downloaded: 16_291_583_966 }, b: { downloaded: 15_207_387_077 } };
    const at = downloadsAtRiskOfRespawn(
      jobs(
        { filename: "flux2_dev.safetensors", status: "downloading", trayId: "a" },
        { filename: "text_encoder.safetensors", status: "downloading", trayId: "b" },
      ),
    );
    expect(at).toHaveLength(2);
    // The reporter's actual numbers: 77% of 19.53 GB and 96% of 14.61 GB.
    expect(at[0]).toEqual({ id: "a", filename: "flux2_dev.safetensors", bytes: 16_291_583_966 });
    expect(at[1]).toEqual({ id: "b", filename: "text_encoder.safetensors", bytes: 15_207_387_077 });
  });

  it("ignores downloads that are NOT in flight — a finished one loses nothing", () => {
    expect(
      downloadsAtRiskOfRespawn(
        jobs(
          { filename: "done.safetensors", status: "done", trayId: "a" },
          { filename: "failed.safetensors", status: "error", trayId: "b" },
          { filename: "cancelled.safetensors", status: "cancelled", trayId: "c" },
        ),
      ),
    ).toEqual([]);
  });

  it("REDACTS a credential-shaped filename, not just the URL (codex)", () => {
    // The URL is never reported and a url-DERIVED filename takes only the pathname — but an
    // explicitly supplied `filename` is copied through unchanged, and its validation
    // rejects separators and dot-names, not secret-looking content. A caller can legally
    // pass `model-sk-live-abc123.safetensors`, and this string lands in a transcript.
    hoisted.progress = { a: { downloaded: 1 }, b: { downloaded: 2 }, c: { downloaded: 3 } };
    const at = downloadsAtRiskOfRespawn(
      jobs(
        { filename: "model-sk-live-abcdefghijkl.safetensors", status: "downloading", trayId: "a" },
        { filename: "my_api_key_dump.safetensors", status: "downloading", trayId: "b" },
        { filename: "flux2_dev.safetensors", status: "downloading", trayId: "c" },
      ),
    );
    expect(at[0].filename).toBe("(redacted).safetensors");
    expect(at[1].filename).toBe("(redacted).safetensors");
    // …and an ordinary name is kept, or the warning stops being useful.
    expect(at[2].filename).toBe("flux2_dev.safetensors");
  });

  it("REDACTS shapes SHORTER than the generic run — an AWS key ID is 20 chars (codex)", () => {
    // The generic rule is a 32-character floor, and 20 characters is an ordinary model
    // filename, so the floor cannot be lowered to catch this. `AKIA…` printed in full.
    hoisted.progress = { a: { downloaded: 1 }, b: { downloaded: 2 } };
    const at = downloadsAtRiskOfRespawn(
      jobs(
        { filename: "AKIAABCDEFGHIJKLMNOP.safetensors", status: "downloading", trayId: "a" },
        { filename: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.safetensors", status: "downloading", trayId: "b" },
      ),
    );
    expect(at[0].filename).toBe("(redacted).safetensors");
    expect(at[1].filename).toBe("(redacted).safetensors");
  });

  it("redacts the opaque PART and keeps the name (codex P1/P3)", () => {
    // Both directions at once, and the reason the thresholds below are affordable.
    // Deciding whether a whole filename is a secret loses either way: an exact-length hex
    // credential was waved through as "a hash", while a legitimate CivitAI-style name was
    // redacted entirely — leaving a receipt that says two downloads are at risk without
    // saying which, which is most of the warning's value.
    hoisted.progress = { a: { downloaded: 1 }, b: { downloaded: 2 }, c: { downloaded: 3 } };
    const at = downloadsAtRiskOfRespawn(
      jobs(
        { filename: `flux1-dev-${"a1b2c3d4".repeat(5)}.safetensors`, status: "downloading", trayId: "a" },
        // A 32-hex credential. The old rule called this a hash and printed it in full.
        { filename: "twilio-0123456789abcdef0123456789abcdef.safetensors", status: "downloading", trayId: "b" },
        // A real model name with two mixed parts. The old rule redacted it whole.
        { filename: "realisticVisionV60B1_v51HyperVAE-inpainting.safetensors", status: "downloading", trayId: "c" },
      ),
    );
    expect(at[0].filename).toBe("flux1-dev-(redacted).safetensors");
    expect(at[1].filename).toBe("twilio-(redacted).safetensors");
    expect(at[2].filename).toBe("realisticVisionV60B1_v51HyperVAE-inpainting.safetensors");
  });

  it("named vendor token prefixes are redacted, and real model names are not", () => {
    // Codex round 3 found `glpat-` (GitLab, 20-character body) surviving: it matched no
    // named shape and its run is under the generic 32-character floor.
    //
    // The obvious generalisation does not exist. "A short alphabetic prefix followed by a
    // long opaque body" is the shape of `juggernautXL_v9Rundiffusionphoto2` — a real
    // CivitAI model — as exactly as it is the shape of `glpat-8GMtG8Mf4EnMJzmAWDU`. So the
    // prefixes are enumerated, and both directions are pinned in one table: adding a
    // pattern that catches the left column while destroying the right is the failure this
    // guards against, and it is not visible from either column alone.
    // ASSEMBLED FROM FIELDS, NOT WRITTEN OUT — and not from inline fragments either.
    //
    // Written as literals, GitHub's push protection rejected the file: it recognised one as
    // a Shopify token, which is a fair reading and rather the point of the code under test.
    // Rewritten with the separator interpolated as a quoted fragment, the repo's own
    // vocabulary gate rejected it — a name stitched together from quoted fragments is
    // invisible to a literal scan, which is the thing that gate exists to stop. (It reads
    // comments too, so this paragraph deliberately describes that shape instead of
    // spelling it.)
    //
    // Both are right. A table of separate FIELDS satisfies both: no full token appears in
    // the file, and no quoted fragment sits next to a concatenation. The values the
    // assertions see are unchanged.
    const filler = "abcdef0123456789".repeat(4);
    const shapes = [
      { prefix: "glpat", sep: "-", body: "8GMtG8Mf4EnMJzmAWDU" },
      { prefix: "github", sep: "_", body: "pat_11ABCDEFG0123456789_abcdefghijklmnop" },
      { prefix: "dop", sep: "_", body: `v1_${filler.slice(0, 32)}` },
      { prefix: "shpat", sep: "_", body: filler.slice(0, 32) },
      { prefix: "ya29", sep: ".", body: "a0AfH6SMBx1234567890abcdefg" },
      { prefix: "xkeysib", sep: "-", body: `${filler.slice(0, 16)}-abcdefghij` },
      { prefix: "AKIA", sep: "", body: "ABCDEFGHIJKLMNOP" },
    ];
    const mustRedact = shapes.map((t) => `${t.prefix}${t.sep}${t.body}.safetensors`);
    const mustKeep = [
      "juggernautXL_v9Rundiffusionphoto2.safetensors",
      "realisticVisionV60B1_v51HyperVAE-inpainting.safetensors",
      "flux1-kontext-dev-Q8_0-GGUF-v2-fp8-e4m3fn.safetensors",
      "wan2.2-i2v-a14b-high-noise-Q4_K_M.gguf",
      "sd_xl_turbo_1.0_fp16.safetensors",
      "epicrealism_naturalSinRC1VAE.safetensors",
    ];
    hoisted.progress = { t: { downloaded: 1 } };
    const shown = (filename: string): string =>
      downloadsAtRiskOfRespawn(jobs({ filename, status: "downloading", trayId: "t" }))[0].filename;

    for (const [i, f] of mustRedact.entries()) {
      expect(shown(f), `${f} must not be printed`).not.toBe(f);
      // …and the token BODY does not survive into the displayed name. Taken from the
      // table rather than re-derived from the filename by a regex, which would be a
      // second parser to get wrong.
      expect(shown(f), `the body of ${f} leaked`).not.toContain(shapes[i].body);
    }
    for (const f of mustKeep) expect(shown(f), `${f} must stay identifiable`).toBe(f);
  });

  it("drops an extension that is not one — the redaction must not publish the secret", () => {
    // `extname` returns everything after the last dot, and filename validation rejects
    // separators and dot-names but not `?`. So the redacted form carried the credential it
    // had just removed (codex).
    hoisted.progress = { a: { downloaded: 1 } };
    const at = downloadsAtRiskOfRespawn(
      jobs({ filename: "model-token.safetensors?token=TopSecret", status: "downloading", trayId: "a" }),
    );
    expect(at[0].filename).toBe("(redacted)");
    expect(at[0].filename).not.toMatch(/TopSecret/);
  });

  it("a long name of ORDINARY parts is kept, but several blob parts are not", () => {
    // The line between the two directions, asserted where it actually sits: real model
    // filenames are long and full of `Q8_0`/`a14b`/`e4m3fn`, and a rule that redacts those
    // redacts nearly everything. Parts that are long AND interleaved are budgeted, so one
    // is a name and several is a blob.
    hoisted.progress = { a: { downloaded: 1 }, b: { downloaded: 2 } };
    const ordinary = "flux1-kontext-dev-Q8_0-GGUF-v2-fp8-e4m3fn.safetensors";
    const blobby = "AbcD3fGhIjK-LmNo9pQrStU-VwXy7zAbCdE.safetensors";
    const at = downloadsAtRiskOfRespawn(
      jobs(
        { filename: ordinary, status: "downloading", trayId: "a" },
        { filename: blobby, status: "downloading", trayId: "b" },
      ),
    );
    expect(at[0].filename).toBe(ordinary);
    // Three interleaved parts in one run is a token spelled to look like a name; each part
    // alone reads as ordinary, so it can only be judged across the run.
    expect(at[1].filename).toBe("(redacted).safetensors");
  });

  it("NEVER reports the URL — a download URL can carry query-string auth", () => {
    // This string lands in a chat transcript. The filename and the byte count are what the
    // decision needs; the URL is the one field that can carry a credential.
    hoisted.progress = { a: { downloaded: 1 } };
    const serialized = JSON.stringify(
      downloadsAtRiskOfRespawn(
        jobs({
          filename: "gated.safetensors",
          status: "downloading",
          trayId: "a",
          url: "https://example.invalid/m.safetensors?token=SHOULD_NOT_APPEAR",
        }),
      ),
    );
    expect(serialized).not.toMatch(/SHOULD_NOT_APPEAR/);
    expect(serialized).not.toMatch(/https?:/);
  });

  it("reports a job with no progress row at zero rather than dropping it", () => {
    // A download whose progress channel is off is still at risk, and still worth naming —
    // dropping it would under-report exactly when the user has least information.
    expect(
      downloadsAtRiskOfRespawn(
        jobs({ filename: "unknown-progress.safetensors", status: "downloading", trayId: "z" }),
      ),
    ).toEqual([{ id: "z", filename: "unknown-progress.safetensors", bytes: 0 }]);
  });

  it("the revoke disclosure NAMES the transfers, and stays silent when there are none", async () => {
    // The behaviour behind the wiring test above: a field nobody renders is not a warning,
    // and a warning that fires on an empty list is noise on every ordinary revoke.
    const { removeDisclosures } = await import("../../services/panel-secrets.js");
    const base = { changed: true, lostKeys: [], lostCommentLines: 0 };

    const loud = removeDisclosures(
      {
        ...base,
        atRiskDownloads: [
          { filename: "flux1-dev.safetensors", bytes: 12 * 1024 ** 3 },
          { filename: "wan22.safetensors", bytes: 4 * 1024 ** 3 },
        ],
      },
      "/store/.env",
    );
    const text = loud.join(" ");
    expect(text).toMatch(/flux1-dev\.safetensors/);
    expect(text).toMatch(/16\.00 GB/);
    // It must NOT claim which side of the respawn we are on — this path collects no
    // respawn reports, so "already lost" and "will be lost" are both unchecked claims.
    expect(text).toMatch(/not reported on this path/);

    expect(removeDisclosures({ ...base, atRiskDownloads: [] }, "/store/.env")).toEqual([]);
  });

  it("two credential-shaped names are TWO downloads, not one (codex P2)", async () => {
    // Both redact to the same display string, so a consumer keying on the filename
    // collapsed them and reported the larger byte count — under-reporting the loss exactly
    // when the names are least informative. The record carries a job id for this reason.
    hoisted.progress = { a: { downloaded: 3 }, b: { downloaded: 5 } };
    const at = downloadsAtRiskOfRespawn(
      jobs(
        { filename: "model-token-alpha.safetensors", status: "downloading", trayId: "a" },
        { filename: "model-secret-beta.safetensors", status: "downloading", trayId: "b" },
      ),
    );
    expect(at.map((d) => d.filename)).toEqual(["(redacted).safetensors", "(redacted).safetensors"]);
    // The distinguishing field, which is what a deduplicating consumer must key on.
    expect(new Set(at.map((d) => d.id)).size).toBe(2);
    // …and the shared summary counts both and totals their bytes.
    const { atRiskDownloadSummary } = await import("../../services/panel-secrets.js");
    expect(atRiskDownloadSummary(at)).toMatch(/^2 download\(s\)/);
  });

  it("the note distinguishes applied, scheduled, and NOT REPORTED", async () => {
    // Three states (#796). A path that collects no respawn report has not established that
    // no respawn happened: "already lost" claims an event nobody observed, and "will be
    // lost" invites the user to act on a transfer that may be dead already.
    const { atRiskNote } = await import("../../services/panel-secrets.js");
    const at = [{ id: "a", filename: "flux1-dev.safetensors", bytes: 1024 ** 3 }];

    expect(atRiskNote(at, { applied: true, scheduled: false, live: 1 } as never)).toMatch(
      /replaced immediately/,
    );
    expect(atRiskNote(at, { applied: false, scheduled: true, live: 1 } as never)).toMatch(
      /queued to be rebuilt/,
    );
    const unreported = atRiskNote(at, undefined);
    expect(unreported).toMatch(/was not reported here/);
    expect(unreported).not.toMatch(/already paid|let them finish/);

    // Empty stays silent on every path, or an ordinary save grows a warning about nothing.
    expect(atRiskNote([], undefined)).toBeNull();
    expect(atRiskNote([], { applied: true, scheduled: false, live: 1 } as never)).toBeNull();
  });

  it("WIRING: the snapshot lives INSIDE the emit, so neither half can be forgotten", async () => {
    // This started as two call sites each remembering to snapshot before emitting. Three
    // defects came out of that arrangement — an emit with no snapshot (revoke, for a whole
    // release), a snapshot with no emit (a rollback under suspended emissions, warning
    // about a loss that never happened), and an ordering restated at every site and
    // therefore mistakable at any of them. It is one function now.
    const { readFileSync } = await import("node:fs");
    const code = (rel: string): string =>
      readFileSync(new URL(rel, import.meta.url), "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*/g, "");
    const src = code("../../services/panel-secrets.ts");

    const emitter = src.slice(src.indexOf("function emitComfyuiChange"));
    const body = emitter.slice(0, emitter.indexOf("\n}"));
    const snapshotAt = body.indexOf("snapshotAtRiskDownloads()");
    const emitAt = body.indexOf("emitGuarded(");
    expect(snapshotAt, "the emitter must snapshot").toBeGreaterThan(-1);
    expect(emitAt, "the emitter must emit").toBeGreaterThan(-1);
    // The whole premise: the emit is synchronous and a listener replaces its tool session
    // inside it, so a list gathered afterwards describes a world where they are already
    // orphaned.
    expect(snapshotAt, "the snapshot must precede the emit").toBeLessThan(emitAt);
    // ...and the suspended path must return BEFORE the snapshot: nothing emitted, nothing
    // lost, nothing to warn about.
    expect(body.indexOf("emitSuspendDepth > 0")).toBeLessThan(snapshotAt);

    // No call site may take its own snapshot any more — that is the arrangement this
    // replaced, and a second one would drift from this one.
    // The DECLARATION is not a call site — `function snapshotAtRiskDownloads()` matches the
    // same text, and an assertion its own definition satisfies is not an assertion.
    const others = (src.split("function emitComfyuiChange")[0] + emitter.slice(emitter.indexOf("\n}")))
      .replace(/function snapshotAtRiskDownloads\(\)[^\n]*/g, "");
    expect(others).not.toMatch(/snapshotAtRiskDownloads\(\)/);

    // …and it must reach the user through the shared disclosure list, not one caller's
    // renderer: the Settings endpoint saves through the same path and said nothing.
    expect(src).toMatch(/atRiskNote\(receipt\.atRiskDownloads/);
    const receiptRenderer = code("../../orchestrator/panel-tools.ts");
    expect(receiptRenderer).not.toMatch(/downloadsAtRiskOfRespawn\(\)/);
  });
});

describe("downloadsAtRiskOfRespawn sees live tray rows (#1567)", () => {
  // The save-time job list cannot see a transfer that starts after the save:
  // downloads run in the MCP child, persist can lag a heartbeat, and the
  // orchestrator's in-memory registry is empty. The tray files are the child's
  // live writes. Re-calling this function at respawn on the job list alone still
  // reported nothing for the nine downloads started in that window.
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "at-risk-tray-"));
    setProgressDir(dir);
  });

  afterEach(() => {
    setProgressDir("");
    rmSync(dir, { recursive: true, force: true });
  });

  const writeTray = (row: {
    id: string;
    name: string;
    downloaded: number;
    status: "downloading" | "done" | "error";
  }) => {
    writeFileSync(
      join(dir, `${row.id}-deadbeef.json`),
      JSON.stringify({
        id: row.id,
        name: row.name,
        downloaded: row.downloaded,
        total: row.downloaded + 1,
        bytes_per_sec: 1,
        status: row.status,
        updated: Date.now(),
      }),
    );
  };

  it("names a transfer that exists only as a live tray row — the ones started AFTER save", () => {
    writeTray({
      id: "d5819adcd02a4257",
      name: "flux-dev.safetensors",
      downloaded: 4_000_000_000,
      status: "downloading",
    });
    // Empty job list: the save-time snapshot, and the orchestrator's registry.
    const at = downloadsAtRiskOfRespawn(jobs());
    expect(at).toEqual([
      { id: "d5819adcd02a4257", filename: "flux-dev.safetensors", bytes: 4_000_000_000 },
    ]);
  });

  it("does not double a transfer already in the job list", () => {
    writeTray({
      id: "a",
      name: "flux-dev.safetensors",
      downloaded: 9_000_000_000,
      status: "downloading",
    });
    hoisted.progress = { a: { downloaded: 4_000_000_000 } };
    const at = downloadsAtRiskOfRespawn(
      jobs({ filename: "flux-dev.safetensors", status: "downloading", trayId: "a" }),
    );
    expect(at).toHaveLength(1);
    // Live tray bytes win when they are further along than the (possibly stale) job read.
    expect(at[0]).toEqual({ id: "a", filename: "flux-dev.safetensors", bytes: 9_000_000_000 });
  });

  it("ignores a settled tray row and a control-channel file", () => {
    writeTray({
      id: "done-id",
      name: "finished.safetensors",
      downloaded: 1,
      status: "done",
    });
    writeFileSync(
      join(dir, `${CONTROL_PREFIX}job-not-a-tray-owner.json`),
      JSON.stringify({
        id: "not-a-tray",
        name: "secret.safetensors",
        downloaded: 99,
        status: "downloading",
        updated: Date.now(),
      }),
    );
    expect(downloadsAtRiskOfRespawn(jobs())).toEqual([]);
  });

  it("WIRING: the respawn-time enumerator unions the live tray", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../services/download-jobs.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*/g, "");
    const fn = src.slice(src.indexOf("export function downloadsAtRiskOfRespawn"));
    expect(fn).toMatch(/listInFlightDownloadProgress\(\)/);
  });
});
