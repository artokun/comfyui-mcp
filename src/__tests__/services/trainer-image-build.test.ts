// #2723 — `train_doctor action:"build_image"` could never succeed.
//
// It awaited a `docker build` of a CUDA + torch + ai-toolkit image, documented in
// its own description as "one-time, several minutes". The panel's call_tool
// transport hard-times out at 300s, so the call ALWAYS returned
//
//     timed out awaiting tools/call after 300s
//
// and the follow-up doctor still said `image:false`. Reproduced twice, including a
// retry with warm layers. Local Docker LoRA training was not slow, it was
// unreachable.
//
// The fix is the shape the rest of this server already uses for long work — return
// a handle, poll — so these pin the two properties that make that safe: the call
// returns before the build does, and a re-issue adopts rather than racing.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const buildTrainerImage = vi.fn();

vi.mock("../../services/ai-toolkit.js", () => ({
  TRAINER_IMAGE: "comfyui-mcp-trainer:test",
  buildTrainerImage: (...args: unknown[]) => buildTrainerImage(...args),
}));

const {
  startTrainerImageBuild,
  runningTrainerImageBuild,
  trainerImageBuildStatus,
  getTrainerImageBuild,
  __resetTrainerImageBuildsForTests,
} = await import("../../services/trainer-image-build.js");

/** A build that finishes only when the test says so — the whole point is that the
 *  caller returns first. */
function deferredBuild() {
  let settle: (v: unknown) => void = () => {};
  const promise = new Promise((resolve) => {
    settle = resolve;
  });
  buildTrainerImage.mockReturnValueOnce(promise);
  return { settle };
}

beforeEach(() => {
  __resetTrainerImageBuildsForTests();
  buildTrainerImage.mockReset();
});

afterEach(() => {
  __resetTrainerImageBuildsForTests();
});

describe("#2723 the build does not block the call that starts it", () => {
  it("returns a running handle while docker is still building", () => {
    deferredBuild();
    const { build, adopted } = startTrainerImageBuild({ contextDir: "/ctx" });
    // The reported failure is this call not returning for 300s.
    expect(build.status).toBe("running");
    expect(build.id).toMatch(/^build-/);
    expect(build.image).toBe("comfyui-mcp-trainer:test");
    expect(adopted).toBe(false);
    expect(buildTrainerImage).toHaveBeenCalledTimes(1);
  });

  it("passes the context dir and the pinned ai-toolkit ref through", () => {
    deferredBuild();
    const { build } = startTrainerImageBuild({ contextDir: "/ctx", aiToolkitRef: "abc123" });
    expect(buildTrainerImage).toHaveBeenCalledWith(
      expect.objectContaining({ contextDir: "/ctx", aiToolkitRef: "abc123" }),
    );
    expect(build.ai_toolkit_ref).toBe("abc123");
  });

  it("settles to done when the build succeeds", async () => {
    const { settle } = deferredBuild();
    const { build } = startTrainerImageBuild({ contextDir: "/ctx" });
    settle({ ok: true, data: { image: "x" } });
    await vi.waitFor(() => expect(build.status).toBe("done"));
    expect(build.finished_at).toBeGreaterThanOrEqual(build.started_at);
    expect(runningTrainerImageBuild()).toBeNull();
  });

  it("settles to error, and KEEPS the reason", async () => {
    // `image:false` with a build that errored is a different situation from
    // `image:false` with nothing attempted, and the old output could not tell
    // them apart — the reporter got the same doctor payload either way.
    const { settle } = deferredBuild();
    const { build } = startTrainerImageBuild({ contextDir: "/ctx" });
    settle({
      ok: false,
      error: { code: "build_failed", message: "docker build exited 1" },
    });
    await vi.waitFor(() => expect(build.status).toBe("error"));
    expect(build.error).toBe("docker build exited 1");
  });

  it("survives a THROWN build instead of taking the process down", async () => {
    // The detached promise has no awaiting caller, so an unhandled rejection is
    // fatal under Node's default policy — a failed build would kill the
    // orchestrator, which is worse than the bug being fixed.
    buildTrainerImage.mockRejectedValueOnce(new Error("docker vanished"));
    const { build } = startTrainerImageBuild({ contextDir: "/ctx" });
    await vi.waitFor(() => expect(build.status).toBe("error"));
    expect(build.error).toBe("docker vanished");
  });

  it("captures the docker log tail for a failure to point at", async () => {
    let onLog: ((line: string) => void) | undefined;
    buildTrainerImage.mockImplementationOnce((opts: { onLog?: (l: string) => void }) => {
      onLog = opts.onLog;
      return new Promise(() => {});
    });
    const { build } = startTrainerImageBuild({ contextDir: "/ctx" });
    onLog?.("Step 1/9 : FROM nvidia/cuda");
    onLog?.("Step 2/9 : RUN pip install torch");
    expect(build.tail).toEqual(["Step 1/9 : FROM nvidia/cuda", "Step 2/9 : RUN pip install torch"]);
  });
});

describe("#2723 a re-issue adopts the running build", () => {
  it("does not start a second docker build", () => {
    // Two `docker build` runs against one tag race for the layer cache and the
    // loser's tag write survives. The reporter re-issued after the 300s timeout,
    // which is exactly the call that must adopt.
    deferredBuild();
    const first = startTrainerImageBuild({ contextDir: "/ctx" });
    const second = startTrainerImageBuild({ contextDir: "/ctx" });
    expect(second.adopted).toBe(true);
    expect(second.build.id).toBe(first.build.id);
    expect(buildTrainerImage).toHaveBeenCalledTimes(1);
  });

  it("starts a NEW build once the previous one settled", async () => {
    const { settle } = deferredBuild();
    const first = startTrainerImageBuild({ contextDir: "/ctx" });
    settle({ ok: true, data: { image: "x" } });
    await vi.waitFor(() => expect(first.build.status).toBe("done"));

    deferredBuild();
    const second = startTrainerImageBuild({ contextDir: "/ctx" });
    expect(second.adopted).toBe(false);
    expect(second.build.id).not.toBe(first.build.id);
    expect(buildTrainerImage).toHaveBeenCalledTimes(2);
  });
});

describe("#2723 doctor can see the build", () => {
  it("reports nothing when none was ever started", () => {
    expect(trainerImageBuildStatus()).toBeNull();
  });

  it("reports the running one", () => {
    deferredBuild();
    const { build } = startTrainerImageBuild({ contextDir: "/ctx" });
    expect(trainerImageBuildStatus()?.id).toBe(build.id);
  });

  it("still reports the last SETTLED one, so a failure is not silent", async () => {
    const { settle } = deferredBuild();
    const { build } = startTrainerImageBuild({ contextDir: "/ctx" });
    settle({ ok: false, error: { code: "x", message: "boom" } });
    await vi.waitFor(() => expect(build.status).toBe("error"));
    expect(trainerImageBuildStatus()).toMatchObject({ id: build.id, status: "error", error: "boom" });
    expect(getTrainerImageBuild(build.id)?.status).toBe("error");
  });
});
