// #2723 — `train_doctor action:"build_image"` could never succeed.
//
// The build is a `docker build` of a CUDA + torch + ai-toolkit image, documented
// as "one-time, several minutes". The tool awaited it. The panel's call_tool
// transport hard-times out at 300s, so the call always returned
//
//     timed out awaiting tools/call after 300s
//
// and a follow-up doctor still reported `image:false`. Reproduced twice by the
// reporter, including a retry with warm layers. Local Docker LoRA training was
// unreachable — not slow, unreachable.
//
// Awaiting a minutes-long job inside a request is the shape the rest of this
// server already refuses: `download_model` and `enqueue_workflow` return a handle
// and are polled. This is that, for the trainer image. The docker child belongs to
// the ORCHESTRATOR process, not to the request, so it keeps running after the call
// returns and a later `train_doctor action:"doctor"` reports how it went.
import { buildTrainerImage, TRAINER_IMAGE } from "./ai-toolkit.js";
import { logger } from "../utils/logger.js";

export interface TrainerImageBuild {
  id: string;
  image: string;
  started_at: number;
  finished_at?: number;
  status: "running" | "done" | "error";
  /** Set on `error` — the docker exit code or the thrown message. */
  error?: string;
  /** Last lines docker printed, so a failure says what happened. */
  tail: string[];
  ai_toolkit_ref?: string;
}

/** In-memory, like the download tray: a build does not outlive the orchestrator
 *  that owns the docker child, so persisting it would only ever describe a build
 *  nothing is still watching. */
const builds = new Map<string, TrainerImageBuild>();
let running: string | null = null;

const TAIL_LIMIT = 200;

/**
 * Start a trainer-image build, or ADOPT the one already running.
 *
 * Adoption rather than a second build, for the same reason `download_model`
 * adopts an identical in-flight transfer: two `docker build` runs against one tag
 * race for the same layer cache and the loser's tag write is the one that
 * survives. A caller who re-issues after the 300s timeout — which is exactly what
 * the reporter did — must not start a second one.
 */
export function startTrainerImageBuild(opts: {
  contextDir: string;
  aiToolkitRef?: string;
}): { build: TrainerImageBuild; adopted: boolean; refMismatch?: TrainerImageBuild } {
  if (running) {
    const existing = builds.get(running);
    if (existing && existing.status === "running") {
      // Adoption must not SUBSTITUTE. `aiToolkitRef` is caller-controlled and its
      // whole purpose is reproducibility ("pins the ai-toolkit commit/tag"), so
      // handing back a build of a different ref and reporting `adopted: true`
      // answers a question nobody asked -- and the tag that lands is not the one
      // that was pinned. The record already carries `ai_toolkit_ref`; this is
      // simply the first thing to read it.
      //
      // Refusing rather than starting a second build: the reason adoption exists
      // at all is that two `docker build` runs against one tag race for the layer
      // cache, and that is no less true when the refs differ.
      if ((existing.ai_toolkit_ref ?? undefined) !== (opts.aiToolkitRef ?? undefined)) {
        return { build: existing, adopted: false, refMismatch: existing };
      }
      return { build: existing, adopted: true };
    }
    // A stale pointer to a settled build: clear it rather than refuse forever.
    running = null;
  }

  const id = `build-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const build: TrainerImageBuild = {
    id,
    image: TRAINER_IMAGE,
    started_at: Date.now(),
    status: "running",
    tail: [],
    ...(opts.aiToolkitRef ? { ai_toolkit_ref: opts.aiToolkitRef } : {}),
  };
  builds.set(id, build);
  running = id;

  const settle = (patch: Partial<TrainerImageBuild>) => {
    Object.assign(build, patch, { finished_at: Date.now() });
    if (running === id) running = null;
  };

  // Deliberately NOT awaited — that is the whole fix. The rejection handler is
  // not optional: an unhandled one from a detached promise takes the process down
  // under Node's default policy, which would turn a failed build into a dead
  // orchestrator.
  void buildTrainerImage({
    contextDir: opts.contextDir,
    aiToolkitRef: opts.aiToolkitRef,
    onLog: (line) => {
      build.tail.push(line);
      if (build.tail.length > TAIL_LIMIT) build.tail.shift();
    },
  })
    .then((result) => {
      if (result.ok) {
        logger.info(`[trainer] image build ${id} finished: ${TRAINER_IMAGE}`);
        settle({ status: "done" });
      } else {
        const message = result.error?.message ?? "docker build failed";
        logger.warn(`[trainer] image build ${id} failed: ${message}`);
        settle({ status: "error", error: message });
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn(`[trainer] image build ${id} threw: ${message}`);
      settle({ status: "error", error: message });
    });

  return { build, adopted: false };
}

/**
 * A `docker build` documented as "one-time, several minutes" that is still going
 * after this long is not progressing — the network stalled pulling a base layer,
 * or the daemon is wedged. Generous on purpose: a cold CUDA + torch build on a
 * slow link genuinely takes a while, and crying stuck too early is worse than
 * staying quiet.
 */
const LOOKS_STALLED_AFTER_MS = 45 * 60_000;

/**
 * Has this build outrun any plausible duration?
 *
 * #2723 made the build detached, which removed the 300s request timeout that was
 * the bug. But a detached build that HANGS never settles, so `running` stays
 * pinned and every later call adopts a corpse — the same "the tool burns its own
 * ability to do the thing" shape as #2784, just quieter, because a wedged build
 * and a healthy one look identical for as long as anyone cares to poll.
 *
 * Adoption is still the right answer (two `docker build` runs against one tag
 * race for the layer cache), so this does not supersede anything. It just stops
 * the state being invisible.
 */
export function trainerImageBuildLooksStalled(
  build: TrainerImageBuild,
  now: number = Date.now(),
): boolean {
  return build.status === "running" && now - build.started_at > LOOKS_STALLED_AFTER_MS;
}

/** The build in flight right now, if any. */
export function runningTrainerImageBuild(): TrainerImageBuild | null {
  const id = running;
  if (!id) return null;
  const build = builds.get(id);
  return build && build.status === "running" ? build : null;
}

/**
 * What `doctor` should say about image builds: the one running, else the most
 * recent settled one.
 *
 * Reported through `doctor` rather than a new action on purpose — `doctor` is
 * already the surface a caller polls after `build_image`, and it is the one the
 * reporter polled. A settled build is worth reporting too: `image:false` plus a
 * finished build that ERRORED is a different situation from `image:false` with
 * nothing attempted, and the old output could not tell them apart.
 */
export function trainerImageBuildStatus(): TrainerImageBuild | null {
  const live = runningTrainerImageBuild();
  if (live) return live;
  let newest: TrainerImageBuild | null = null;
  for (const build of builds.values()) {
    // `>=`, not `>`. `started_at` is Date.now(), so two builds started in the same
    // millisecond tie -- and with a strict `>` the FIRST one inserted wins, because
    // `Map` iterates in insertion order and the later build never beats it. Doctor
    // then reports the earlier settled result and hides the newer one, which is the
    // opposite of what "newest" means. Ties resolve to the most recently INSERTED.
    if (!newest || build.started_at >= newest.started_at) newest = build;
  }
  return newest;
}

export function getTrainerImageBuild(id: string): TrainerImageBuild | undefined {
  return builds.get(id);
}

/** Test seam — the registry is module state and would otherwise leak between specs. */
export function __resetTrainerImageBuildsForTests(): void {
  builds.clear();
  running = null;
}
