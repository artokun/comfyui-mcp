import { beforeEach, describe, expect, it, vi } from "vitest";

const downloadModelMock = vi.fn();
const listLocalModelsMock = vi.fn();
/** #369 post-landing verification, controlled per test. Default: the honest
 *  "could not check" verdict, echoing the path back. */
// #1204 — the RETURN type comes from the real verdict, not from whatever this
// default happens to contain. Inferring it from the literal made the mock's
// shape narrower than `verifyLandedModel`'s, so a test overriding it with
// `verifiedAgainstRoot` (real: model-resolver.ts:1349, read at
// download-jobs.ts:623) was rejected by an annotation the test itself invented.
type LandedVerdict = Awaited<ReturnType<typeof import("../../services/model-resolver.js").verifyLandedModel>>;
const verifyLandedModelMock = vi.fn(async (targetPath: string): Promise<LandedVerdict> => ({
  verifiedPath: targetPath,
  liveVisible: "unknown",
  note: "no live server in this test",
}));
/** The models root the connected server reads NOW (stubbed; see the mock). */
const currentLiveRootMock = vi.fn(async (): Promise<string | undefined> => undefined);
vi.mock("../../services/model-resolver.js", async () => {
  const actual = await vi.importActual<typeof import("../../services/model-resolver.js")>(
    "../../services/model-resolver.js",
  );
  return {
    ...actual,
    downloadModel: (...a: unknown[]) => downloadModelMock(...a),
    listLocalModels: (...a: unknown[]) => listLocalModelsMock(...a),
    // #918: the rendering path reads the coverage-carrying entry point. Wrap the
    // existing mock so a test only has to say what the listing CONTAINS; the
    // default coverage is the verified-answered case (nothing to caveat).
    listLocalModelsWithCoverage: async (...a: unknown[]) => ({
      models: (await listLocalModelsMock(...a)) ?? [],
      coverage: { answered: ["checkpoints"], unanswered: [], usedFilesystem: false },
    }),
    // Deterministic local routing (no live server probe) so startDownloadJob keys
    // the job locally and threads dispatchToManager=false into downloadModel.
    shouldDispatchDownloadToManager: async () => false,
    // startDownloadJob resolves the destination via this before streaming; stub
    // it so the tool tests don't need a live server to compute a targetPath.
    resolveDownloadTarget: async (url: string, sub: string, filename?: string) => {
      const name = filename ?? String(url).split("/").pop() ?? "model.safetensors";
      return { targetDir: `/m/${sub}`, filename: name, targetPath: `/m/${sub}/${name}` };
    },
    verifyLandedModel: (...a: unknown[]) =>
      verifyLandedModelMock(...(a as [string, string])),
    // The root the connected server reads NOW. Stub it: the real one probes the
    // DEVELOPER's machine, and a resolvable root there would invalidate every
    // verdict these tests assert. Undefined = unknown, which never downgrades.
    currentLiveModelsRoot: async (): Promise<string | undefined> => currentLiveRootMock(),
  };
});

import { registerModelManagementTools } from "../../tools/model-management.js";
import { setProgressDir } from "../../services/download-progress.js";
import * as progressModule from "../../services/download-progress.js";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
}>;

/**
 * 0.50.0 slice 11 folded these three tools into two action-parameterized ones,
 * so the behaviour tests below reach them through the dispatcher. Everything
 * they assert — the #369 placement verdicts, the #822 ambiguous-id handling,
 * the sidecar rendering — is unchanged by the fold, which is the point of
 * routing rather than rewriting them.
 */
function makeServer() {
  const handlers = new Map<string, ToolHandler>();
  const server = {
    // The SDK's `tool()` is overloaded: the callback is the LAST argument, and an
    // optional annotations object (#1106) sits before it. Resolve by TYPE the way the
    // real SDK does, so adding annotations to a tool cannot break this fake.
    tool: (name: string, _desc: string, _schema: unknown, ...rest: unknown[]) => {
      const handler = rest.find((a) => typeof a === "function") as ToolHandler;
      handlers.set(name, handler);
    },
  };
  registerModelManagementTools(server as never);
  const download = handlers.get("download_model")!;
  const inventory = handlers.get("list_local_models")!;
  return {
    downloadModel: (args: Record<string, unknown>) => download({ ...args, action: "download" }),
    downloadStatus: (args: Record<string, unknown>) => download({ ...args, action: "status" }),
    cancelDownload: (args: Record<string, unknown>) => download({ ...args, action: "cancel" }),
    listLocalModels: (args: Record<string, unknown>) => inventory({ ...args, action: "list" }),
  };
}

beforeEach(() => {
  downloadModelMock.mockReset();
  listLocalModelsMock.mockReset();
  verifyLandedModelMock.mockReset();
  verifyLandedModelMock.mockImplementation(async (targetPath: string) => ({
    verifiedPath: targetPath,
    liveVisible: "unknown",
    note: "no live server in this test",
  }));
});

describe("download_model tool", () => {
  it("passes optional auth through to downloadModel", async () => {
    downloadModelMock.mockResolvedValueOnce("/comfy/models/checkpoints/x.safetensors");
    const auth = {
      type: "header",
      header_name: "X-Api-Key",
      header_value: "secret",
    };

    const { downloadModel } = makeServer();
    const res = await downloadModel({
      url: "https://example.com/x.safetensors",
      target_subfolder: "checkpoints",
      filename: "x.safetensors",
      auth,
    });

    expect(downloadModelMock).toHaveBeenCalledWith(
      "https://example.com/x.safetensors",
      "checkpoints",
      "x.safetensors",
      auth,
      false, // routing decision threaded through (local, #420 codex round 1)
      expect.any(Function), // onResume callback — reports the resume decision onto the job (#467)
      expect.any(AbortSignal), // per-download abort signal threaded from the job's controller (#515)
      expect.any(Function), // onTrayId callback — aligns the job trayId with the tray row id (#515)
      expect.any(Function), // onLanded callback — commits done synchronously at the destination rename (#515)
    );
    expect(res.isError).toBeFalsy();
  });

  // -------------------------------------------------------------------------
  // #369 — success is only ever claimed for a destination that was VERIFIED.
  // -------------------------------------------------------------------------
  it("reports the VERIFIED on-disk path when the connected ComfyUI lists the file", async () => {
    downloadModelMock.mockResolvedValueOnce("/m/checkpoints/x.safetensors");
    verifyLandedModelMock.mockResolvedValueOnce({
      // A symlinked models tree: the real location is what must be reported.
      verifiedPath: "/mnt/models/checkpoints/x.safetensors",
      liveVisible: "visible",
      // Confirmation requires the RENDERER to re-establish the verdict, so the
      // verdict's root and the reader's current root must agree (#369).
      verifiedAgainstRoot: "/live/models",
    });
    currentLiveRootMock.mockResolvedValueOnce("/live/models");

    const { downloadModel } = makeServer();
    const res = await downloadModel({
      url: "https://example.com/x.safetensors",
      target_subfolder: "checkpoints",
      filename: "x.safetensors",
    });

    const text = res.content[0].text;
    expect(text).toContain("/mnt/models/checkpoints/x.safetensors");
    expect(text).toContain("verified on disk");
    expect(text).toContain("the connected ComfyUI lists it");
  });

  it("does NOT claim success when the landed file is invisible to the connected ComfyUI", async () => {
    downloadModelMock.mockResolvedValueOnce("/stale/models/checkpoints/x.safetensors");
    verifyLandedModelMock.mockResolvedValueOnce({
      verifiedPath: "/stale/models/checkpoints/x.safetensors",
      liveVisible: "not-visible",
      note: "The file IS on disk but the connected ComfyUI does NOT list it.",
    });

    const { downloadModel } = makeServer();
    const res = await downloadModel({
      url: "https://example.com/x.safetensors",
      target_subfolder: "checkpoints",
      filename: "x.safetensors",
    });

    const text = res.content[0].text;
    expect(text).not.toContain("downloaded successfully");
    expect(text).toContain("NOT usable by the connected ComfyUI");
    expect(text).toContain("The file IS on disk but the connected ComfyUI does NOT list it.");
    expect(text).toContain("Do NOT tell the user the model is ready");
  });

  it("qualifies the result when placement could not be confirmed", async () => {
    downloadModelMock.mockResolvedValueOnce("/m/checkpoints/x.safetensors");
    const { downloadModel } = makeServer();
    const res = await downloadModel({
      url: "https://example.com/x.safetensors",
      target_subfolder: "checkpoints",
      filename: "x.safetensors",
    });

    const text = res.content[0].text;
    expect(text).not.toContain("downloaded successfully");
    expect(text).toContain("UNCONFIRMED");
  });

  it("never claims success while the visibility check is still PENDING (#369 grace-window race)", async () => {
    // The file lands (commitDone marks it `pending`) but the tool's grace window
    // expires before verification concludes. A pending verdict must read as
    // unconfirmed, never as "the connected ComfyUI lists it". A distinct filename
    // keeps this job's (deliberately unresolved) destination chain to itself.
    const prevGrace = process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS;
    process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS = "20";
    let releaseVerify: (() => void) | undefined;
    downloadModelMock.mockResolvedValueOnce("/m/checkpoints/pending.safetensors");
    verifyLandedModelMock.mockImplementationOnce(
      () =>
        new Promise((r) => {
          releaseVerify = () =>
            r({ verifiedPath: "/m/checkpoints/pending.safetensors", liveVisible: "visible" });
        }),
    );

    try {
      const { downloadModel } = makeServer();
      const res = await downloadModel({
        url: "https://example.com/pending.safetensors",
        target_subfolder: "checkpoints",
        filename: "pending.safetensors",
      });

      const text = res.content[0].text;
      expect(text).not.toContain("downloaded successfully");
      expect(text).not.toContain("lists it");
      expect(text).toContain("NOT been confirmed yet");
    } finally {
      releaseVerify?.();
      if (prevGrace === undefined) delete process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS;
      else process.env.COMFYUI_MCP_DOWNLOAD_GRACE_MS = prevGrace;
    }
  });
});

describe('download_model action:"status"', () => {
  it("surfaces a landed-but-invisible download as a WARNING, not a bare 'landed at' (#369)", async () => {
    downloadModelMock.mockResolvedValueOnce("/stale/models/checkpoints/x.safetensors");
    verifyLandedModelMock.mockResolvedValueOnce({
      verifiedPath: "/stale/models/checkpoints/x.safetensors",
      liveVisible: "not-visible",
      note: "the running server reads /live/ComfyUI/models instead",
    });

    const { downloadModel, downloadStatus } = makeServer();
    await downloadModel({
      url: "https://example.com/x.safetensors",
      target_subfolder: "checkpoints",
      filename: "x.safetensors",
    });

    const res = await downloadStatus({});
    const text = res.content[0].text;
    // "landed at" is reserved for a CONFIRMED placement — an unusable file must not
    // borrow the settled-sounding phrase. (The listing also renders other tests'
    // jobs, so this is asserted against THIS job's line.)
    expect(text).not.toMatch(/landed at[^\n]*\/stale\//);
    expect(text).toContain("written to (verified on disk): /stale/models/checkpoints/x.safetensors");
    expect(text).toContain("WARNING: NOT VISIBLE to the connected ComfyUI");
    expect(text).toContain("the running server reads /live/ComfyUI/models instead");
  });

  it("keeps a heartbeat-stale persisted transfer visible without prompting a concurrent reissue (#761)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "model-management-status-"));
    setProgressDir(dir);
    try {
      const id = "status-stale-job";
      await writeFile(
        join(dir, `control-job-${id}-other-session.json`),
        JSON.stringify({
          id,
          trayId: "status-stale-tray",
          progressId: "status-stale-progress",
          url: "https://example.com/large.safetensors",
          target_subfolder: "checkpoints",
          status: "downloading",
          started_at: Date.now() - 10 * 60 * 1000,
          owner: "other-session",
          updated: Date.now() - 5 * 60 * 1000,
        }),
      );

      const { downloadStatus } = makeServer();
      const res = await downloadStatus({});
      const text = res.content[0].text;
      expect(text).toContain(id);
      expect(text).toContain("heartbeat stale for");
      expect(text).toContain('Do NOT re-issue download_model action:"download" while this warning remains');
      // #858: the note now names the recovery path — a cancel that closes the
      // record once the writer is PROVEN gone, and refuses while it cannot be.
      expect(text).toContain('action:"cancel"');
      expect(text).toContain("PROVEN gone");
      expect(text).toContain("refuses while that cannot be proven");
      expect(text).toContain("Do not report this download as failed or missing.");
    } finally {
      setProgressDir("");
      await rm(dir, { recursive: true, force: true });
    }
  });
  // ── #822: a printed handle must identify exactly one row ──────────────────
  describe("#822 the id is not unique — the rendered handle must still select", () => {
    /** Two persisted in-flight records with the SAME id (one destination) and
     *  DIFFERENT source URLs: the exact listing #822 reported. */
    async function seedCollidingRows(dir: string, id: string): Promise<void> {
      const common = {
        id,
        target_subfolder: "text_encoders",
        status: "downloading",
        started_at: Date.now() - 60_000,
        updated: Date.now(),
      };
      await writeFile(
        join(dir, `control-job-${id}-session-live.json`),
        JSON.stringify({
          ...common,
          trayId: "livetray00000001",
          progressId: "live-prog",
          url: "https://huggingface.co/Comfy-Org/Krea-2/resolve/main/text_encoders/q.safetensors",
          owner: "session-live",
        }),
      );
      await writeFile(
        join(dir, `control-job-${id}-session-orphan.json`),
        JSON.stringify({
          ...common,
          trayId: "orphantray000001",
          progressId: "orphan-prog",
          url: "https://huggingface.co/Aitrepreneur/FLX/resolve/main/q.safetensors",
          owner: "session-orphan",
          started_at: Date.now() - 884_000,
        }),
      );
    }

    it("renders the tray id on every row, so the printed handle names ONE download", async () => {
      const dir = await mkdtemp(join(tmpdir(), "model-management-822-"));
      setProgressDir(dir);
      try {
        await seedCollidingRows(dir, "a0b477082f35745c");
        const { downloadStatus } = makeServer();
        const text = (await downloadStatus({})).content[0].text;

        // Both rows appear (the status action promises EVERY tracked download)…
        expect(text).toContain("livetray00000001");
        expect(text).toContain("orphantray000001");
        // …each carrying its tray id alongside the shared id, so the two lines are
        // programmatically distinguishable rather than identical-looking.
        expect(text).toContain("`a0b477082f35745c` (tray `livetray00000001`)");
        expect(text).toContain("`a0b477082f35745c` (tray `orphantray000001`)");
      } finally {
        setProgressDir("");
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("SHOUTS when a listing contains two rows under one id — two writers, one file", async () => {
      const dir = await mkdtemp(join(tmpdir(), "model-management-822-"));
      setProgressDir(dir);
      try {
        await seedCollidingRows(dir, "a0b477082f35745c");
        const { downloadStatus } = makeServer();
        const text = (await downloadStatus({})).content[0].text;

        expect(text).toMatch(/name MORE THAN ONE download/);
        expect(text).toContain("AMBIGUOUS id");
        // The remedy is stated in terms the caller can act on right now.
        expect(text).toMatch(/Use the `tray_id`/);
        expect(text).toMatch(/Pass that same tray_id to `action:"cancel"` to stop THIS one/);
      } finally {
        setProgressDir("");
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("status(id) on an ambiguous id names the candidates — it does NOT report 'no download'", async () => {
      const dir = await mkdtemp(join(tmpdir(), "model-management-822-"));
      setProgressDir(dir);
      try {
        await seedCollidingRows(dir, "a0b477082f35745c");
        const { downloadStatus } = makeServer();
        const text = (await downloadStatus({ id: "a0b477082f35745c" })).content[0].text;

        // The regression this guards: the id resolved to nothing (ambiguous), and
        // saying "no download matching" would turn "could not determine WHICH" into
        // a definite — and false — "it never started".
        expect(text).not.toMatch(/No download matching/);
        expect(text).toMatch(/matches 2 DIFFERENT downloads/);
        expect(text).toContain("livetray00000001");
        expect(text).toContain("orphantray000001");
        // Both source URLs are shown, which is what lets a caller tell them apart.
        expect(text).toContain("Krea-2");
        expect(text).toContain("Aitrepreneur");
        expect(text).toMatch(/Re-run download_model `action:"status"` with `tray_id`/);
      } finally {
        setProgressDir("");
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("status(id, tray_id) selects exactly one of the colliding rows", async () => {
      const dir = await mkdtemp(join(tmpdir(), "model-management-822-"));
      setProgressDir(dir);
      try {
        await seedCollidingRows(dir, "a0b477082f35745c");
        const { downloadStatus } = makeServer();
        const text = (
          await downloadStatus({ id: "a0b477082f35745c", tray_id: "orphantray000001" })
        ).content[0].text;

        expect(text).toContain("orphantray000001");
        expect(text).toContain("Aitrepreneur");
        // The OTHER row is not reported — the selector actually selected.
        expect(text).not.toContain("livetray00000001");
        expect(text).not.toContain("Krea-2");
      } finally {
        setProgressDir("");
        await rm(dir, { recursive: true, force: true });
      }
    });
  });

  // ── #858: a stale download whose writer is PROVEN gone can be cancelled ──────
  describe("#858 stale-download recovery", () => {
    /** A pid that is guaranteed dead: a child that already exited. */
    function deadPid(): number {
      // spawnSync returns after the child has fully exited.
      const res = spawnSync(process.execPath, ["-e", ""]);
      return res.pid;
    }

    async function seedStaleRecord(
      dir: string,
      id: string,
      extra: Record<string, unknown> = {},
    ): Promise<void> {
      await writeFile(
        join(dir, `control-job-${id}-dead-session.json`),
        JSON.stringify({
          id,
          trayId: "staletray8580000",
          progressId: "stale-prog-858",
          url: "https://example.com/large.safetensors",
          target_subfolder: "checkpoints",
          status: "downloading",
          started_at: Date.now() - 10 * 60 * 1000,
          owner: "dead-session",
          updated: Date.now() - 5 * 60 * 1000, // heartbeat long stale
          ...extra,
        }),
      );
    }

    it("cancel CLOSES a stale record whose writer process is proven gone — and status then reports the administrative cancel honestly", async () => {
      const dir = await mkdtemp(join(tmpdir(), "model-management-858-"));
      setProgressDir(dir);
      try {
        const id = "stale-dead-job-858";
        await seedStaleRecord(dir, id, { pid: deadPid() });

        const { cancelDownload, downloadStatus } = makeServer();
        const res = await cancelDownload({ id, tray_id: "staletray8580000" });
        const text = res.content[0].text;
        expect(text).toContain("confirmed GONE");
        expect(text).toContain("closed as **cancelled**");
        // The remedy is actionable from here: re-issue.
        expect(text).toContain('re-issue the same download_model `action:"download"` request');
        // And it must NOT claim a live transfer was aborted.
        expect(text).not.toMatch(/being aborted/);

        // The record now reads as an administrative cancel — not "the partial was
        // left on disk", which nobody verified.
        const status = (await downloadStatus({ id })).content[0].text;
        expect(status).toContain("cancelled");
        expect(status).toContain("confirmed GONE");
        expect(status).not.toContain("the partial was left on disk");
      } finally {
        setProgressDir("");
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("cancel REFUSES a stale record whose writer process is still alive", async () => {
      const dir = await mkdtemp(join(tmpdir(), "model-management-858-"));
      setProgressDir(dir);
      try {
        const id = "stale-live-job-858";
        // A live pid (this very process) under a FOREIGN owner nonce stands in for
        // another live session: stale heartbeat, but the process provably exists.
        await seedStaleRecord(dir, id, { pid: process.pid });

        const { cancelDownload } = makeServer();
        const text = (await cancelDownload({ id, tray_id: "staletray8580000" })).content[0].text;
        expect(text).toContain("STILL RUNNING");
        expect(text).toContain("refused");
        expect(text).toContain("panel download tray");
        // Nothing was closed: the record still reads downloading.
        expect(text).toContain("status: downloading");
      } finally {
        setProgressDir("");
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("cancel REFUSES a stale record with no writer identity — unprovable is not dead", async () => {
      const dir = await mkdtemp(join(tmpdir(), "model-management-858-"));
      setProgressDir(dir);
      try {
        const id = "stale-unknown-job-858";
        await seedStaleRecord(dir, id); // no pid — a pre-#858 record

        const { cancelDownload } = makeServer();
        const text = (await cancelDownload({ id, tray_id: "staletray8580000" })).content[0].text;
        expect(text).toContain("cannot be proven");
        expect(text).toContain("panel download tray");
      } finally {
        setProgressDir("");
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("cancel on a foreign SETTLED record reports the settled state instead of 'cannot be aborted'", async () => {
      const dir = await mkdtemp(join(tmpdir(), "model-management-858-"));
      setProgressDir(dir);
      try {
        const id = "foreign-done-job-858";
        await writeFile(
          join(dir, `control-job-${id}-other-session.json`),
          JSON.stringify({
            id,
            trayId: "donetray85800000",
            progressId: "done-prog-858",
            url: "https://example.com/large.safetensors",
            target_subfolder: "checkpoints",
            status: "done",
            path: "/m/checkpoints/large.safetensors",
            started_at: Date.now() - 10 * 60 * 1000,
            finished_at: Date.now() - 9 * 60 * 1000,
            owner: "other-session",
            updated: Date.now() - 9 * 60 * 1000,
          }),
        );

        const { cancelDownload } = makeServer();
        const text = (await cancelDownload({ id })).content[0].text;
        expect(text).toContain("already **done** — nothing to cancel");
        expect(text).not.toContain("can't be aborted");
      } finally {
        setProgressDir("");
        await rm(dir, { recursive: true, force: true });
      }
    });

    it("cancel DISCLOSES when the dead session's record file could not be deleted", async () => {
      const dir = await mkdtemp(join(tmpdir(), "model-management-858-"));
      setProgressDir(dir);
      const removeSpy = vi
        .spyOn(progressModule, "removePersistedDownloadJobFor")
        .mockReturnValue(false);
      try {
        const id = "stale-undeletable-858";
        await seedStaleRecord(dir, id, { pid: deadPid() });

        const { cancelDownload } = makeServer();
        const text = (await cancelDownload({ id, tray_id: "staletray8580000" })).content[0].text;
        // The reclaim happened (the terminal record is durable)…
        expect(text).toContain("closed as **cancelled**");
        // …but the leftover is disclosed, not hidden behind a clean-close claim.
        expect(text).toContain("could not be deleted");
        expect(text).toContain("no longer blocks cancelling or re-issuing");
      } finally {
        removeSpy.mockRestore();
        setProgressDir("");
        await rm(dir, { recursive: true, force: true });
      }
    });
  });
});

describe("list_local_models rendering", () => {
  it("renders sidecar hints: trigger words + base, and the civitai provenance line", async () => {
    listLocalModelsMock.mockResolvedValueOnce([
      {
        name: "detail.safetensors",
        path: "loras/detail.safetensors",
        size: 0,
        modified: "",
        type: "loras",
        triggerWords: ["more detail", "hdr"],
        baseModel: "SDXL 1.0",
        civitaiUrl: "https://civitai.com/models/162967?modelVersionId=183635",
      },
      {
        name: "plain.safetensors",
        path: "loras/plain.safetensors",
        size: 0,
        modified: "",
        type: "loras",
      },
    ]);

    const { listLocalModels } = makeServer();
    const res = await listLocalModels({ model_type: "loras" });
    const text = res.content[0].text;

    expect(res.isError).toBeFalsy();
    expect(text).toContain("## loras (2)");
    expect(text).toContain("- detail.safetensors");
    expect(text).toContain("    trigger words: more detail, hdr  ·  base: SDXL 1.0");
    expect(text).toContain(
      "    civitai: https://civitai.com/models/162967?modelVersionId=183635",
    );
    // The un-enriched entry stays a bare name — no stray metadata lines.
    expect(text).toContain("- plain.safetensors");
    expect(text).not.toContain("plain.safetensors (");
  });
});
