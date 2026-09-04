// Decide whether an absolute path on the ORCHESTRATOR host names a file the
// connected ComfyUI can serve over /view — and, when it can, produce the exact
// ref to hand the panel.
//
// WHY THIS EXISTS (#648). panel_show_media's absolute-path branch base64-encodes
// the whole file into the tool reply, so it must cap the payload. The cap is
// correct — a 72 MB inline payload is not something to send an agent, and
// raising it is not the fix. But on its own the cap is a DEAD END: an agent
// asked to preview an ordinary local reference video was told only that a
// ceiling exists, with nothing it could do about it, so it concluded the task
// was impossible.
//
// A file that ALREADY lives under a directory ComfyUI serves needs no inline
// payload at all. The panel is a browser tab on ComfyUI's own origin, so it
// fetches /view directly; there is no size cap on that path, and a viewRef
// video arriving at the panel gets the full sampled-frame preview and
// disclosure. So the remedy is to forward a ref instead of refusing.
//
// THREE ANSWERS, NOT TWO. The naive check ("is the path under the output dir?")
// collapses "we could not find out" into "no", which sends the caller to move a
// file that may already be in exactly the right place. This module keeps them
// apart:
//
//   servable — PROVEN inside a directory this ComfyUI serves. Emits the ref.
//   outside  — the roots WERE resolved and the file is provably in none of them.
//   unknown  — the roots could not be resolved. NOT "outside".
//   remote   — ComfyUI runs on another host, so a path on THIS machine names a
//              file that server cannot open, whatever the path says.
//
// EVIDENCE, NOT ASSUMPTION. The roots come from resolveOutputDir/resolveInputDir,
// which ask the RUNNING server for its launch argv (--output-directory /
// --base-directory) before falling back to <COMFYUI_PATH>/output. That matters:
// ComfyUI is routinely launched with its output elsewhere, and assuming
// <COMFYUI_PATH>/output would mint refs that resolve to nothing.
//
// Deliberately NOT resolveEffectiveComfyUIBase(): it returns config.comfyuiPath
// BEFORE it checks remote mode, contradicting its own docstring (#490, owned
// elsewhere — not fixed here, and not built on either). The same exposure reaches
// this module by another route, because localOutputDirFallback() also reads
// config.comfyuiPath directly, and an explicitly-set COMFYUI_PATH survives into
// remote mode. That is exactly why the remote check runs FIRST, before any root
// is resolved: otherwise a remote session with COMFYUI_PATH set would compare a
// local file against a local-looking root and call it servable, and the panel
// would resolve that ref against the REMOTE server — showing a different file,
// or nothing. Never let a coincidence of path strings stand in for evidence that
// the server can reach the file.
//
// NOT COVERED: ComfyUI's temp directory. There is no --temp-directory parser in
// this codebase, so a file under it cannot be recognised. The refusal therefore
// names the directories it actually checked rather than claiming no directory
// could serve the file.

import { constants as fsConstants } from "node:fs";
import {
  copyFile,
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { isCloudMode, isRemoteMode } from "../config.js";
import { resolveInputDir, resolveOutputDir } from "./output-dir.js";

/** The /view directories this module can establish from evidence. */
export type ViewRefKind = "output" | "input";

/** A ref in exactly the shape panel_show_media forwards and /view accepts. */
export type ComfyServableRef = {
  filename: string;
  subfolder?: string;
  type: ViewRefKind;
};

export type CheckedRoot = { kind: ViewRefKind; dir: string };

export type ViewRefResolution =
  | { status: "servable"; ref: ComfyServableRef; root: CheckedRoot }
  | { status: "outside"; checked: CheckedRoot[] }
  | { status: "remote"; reason: string }
  | { status: "unknown"; reason: string };

/**
 * Describe a caught failure, without becoming one.
 *
 * `String(err)` is itself an operation that can fail — a rejection carrying
 * `Object.create(null)` has no `toString`, and a getter on `.message` can throw.
 * Unguarded, describing the error rejected the function that was handling it, so
 * a resolver failure that should have become `unknown` reached the agent as an
 * opaque transport error with no remedy in it. A catch that can throw is not a
 * catch (codex finding).
 */
const errText = (err: unknown): string => {
  try {
    if (err instanceof Error) {
      const m = err.message;
      if (typeof m === "string" && m) return m;
    }
    const s = String(err);
    return s || "an error with no description";
  } catch {
    return "an error that could not be described";
  }
};

/** Windows compares paths case-insensitively; POSIX does not. */
const norm = (p: string): string =>
  process.platform === "win32" ? p.toLowerCase() : p;

/**
 * A path canonicalised as far as it could be, and whether that succeeded.
 *
 * `canonical` is never allowed to reject — resolving a symlink can fail on a
 * broken link, a permission wall or a dead share — but WHETHER it failed is
 * load-bearing and must not be swallowed. A lexical fallback that misses every
 * root is not evidence the file is outside them: the link it could not follow
 * may well point straight into one. Callers that find no match while `resolved`
 * is false owe the caller "unknown", not "move your file" (codex finding).
 *
 * `code` distinguishes the one failure that carries NO uncertainty: a root that
 * does not exist (ENOENT) cannot contain anything, so missing it is a real
 * "outside", not an open question.
 */
type Canonical = { path: string; resolved: boolean; code?: string; why?: string };

async function canonical(p: string): Promise<Canonical> {
  try {
    return { path: await realpath(p), resolved: true };
  } catch (err) {
    return {
      path: p,
      resolved: false,
      code: (err as NodeJS.ErrnoException)?.code,
      why: errText(err),
    };
  }
}

/**
 * STRICT containment: `child` sits somewhere beneath `root`.
 *
 * Equality is deliberately excluded — the caller has already established the
 * path is a regular file, so a path equal to the root is a contradiction, and
 * admitting it would derive an empty filename.
 *
 * The separator is required, so `/comfy/output-old/x.mp4` is not treated as
 * living under `/comfy/output`.
 */
function isStrictlyInside(child: string, root: string): boolean {
  const r = norm(root);
  const withSep = r.endsWith(sep) ? r : r + sep;
  return norm(child).startsWith(withSep);
}

/**
 * Why a derived ref is not safe to forward, or null when it is.
 *
 * Containment should already guarantee this shape, but the ref is about to be
 * handed to ComfyUI's /view, which has historically been permissive about ".."
 * and absolute values in these parameters. A derived value that fails here means
 * the derivation did something this module did not predict — so the answer is
 * "unknown", never a silently-emitted bad ref.
 */
function refShapeProblem(filename: string, subfolder: string): string | null {
  if (!filename) return "the derived filename is empty";
  if (filename.includes("\0") || subfolder.includes("\0")) {
    return "the derived ref contains a NUL byte";
  }
  if (filename.includes("/") || filename.includes("\\")) {
    return "the derived filename is not a single path segment";
  }
  if (filename === "." || filename === "..") {
    return "the derived filename is a directory entry, not a file";
  }
  if (subfolder.startsWith("/") || /^[A-Za-z]:/.test(subfolder)) {
    return "the derived subfolder is not relative to the media directory";
  }
  if (subfolder.split("/").some((s) => s === "..")) {
    return "the derived subfolder escapes the media directory";
  }
  return null;
}

/**
 * Establish whether `absPath` is servable by the connected ComfyUI over /view.
 *
 * Never throws: every step (a network probe for the launch argv, a realpath, the
 * path arithmetic) is an operation that can fail, and a guard that throws is not
 * a guard — a failure here has to come back as `unknown`, which the caller can
 * report honestly, not as an exception that reaches the agent as a transport
 * error with no remedy in it.
 */
export async function resolveServableViewRef(
  absPath: string,
): Promise<ViewRefResolution> {
  // FIRST, before any root is resolved — see the module header. A local path
  // cannot be servable by a server on another machine, and a root that merely
  // looks local is not evidence that it is.
  if (isCloudMode()) {
    return {
      status: "remote",
      reason:
        "this session targets ComfyUI Cloud, which has no access to this machine's filesystem",
    };
  }
  if (isRemoteMode()) {
    return {
      status: "remote",
      reason:
        "this session targets a REMOTE ComfyUI on a different host, which has no access to this machine's filesystem",
    };
  }

  const roots: CheckedRoot[] = [];
  const failures: string[] = [];
  // Resolved INDEPENDENTLY: one directory failing must not discard the other.
  // A file proven to be under a resolved output dir is servable whether or not
  // the input dir could be resolved.
  for (const kind of ["output", "input"] as const) {
    try {
      const dir = await (kind === "output"
        ? resolveOutputDir()
        : resolveInputDir());
      if (typeof dir === "string" && dir.length > 0) {
        roots.push({ kind, dir: resolve(dir) });
      } else {
        failures.push(`the ${kind} directory resolved to an empty value`);
      }
    } catch (err) {
      failures.push(`the ${kind} directory could not be resolved (${errText(err)})`);
    }
  }

  if (roots.length === 0) {
    return {
      status: "unknown",
      reason:
        failures.join("; ") ||
        "no ComfyUI media directory could be resolved",
    };
  }

  // Canonicalisations that FAILED, and so left a comparison inconclusive. A miss
  // against a root we could not canonicalise is not a proven miss.
  const inconclusive: string[] = [];
  try {
    const file = await canonical(resolve(absPath));
    if (!file.resolved) {
      // The caller already stat'ed this file successfully, so it exists and is
      // reachable; a realpath that still fails means a link this process cannot
      // follow, which could point into a served directory.
      inconclusive.push(
        `the file's real location could not be resolved (${file.why ?? "unknown error"})`,
      );
    }
    for (const root of roots) {
      const realRoot = await canonical(root.dir);
      // A root that does not exist cannot contain anything, so failing to
      // canonicalise it carries no uncertainty. Any OTHER failure does.
      if (!realRoot.resolved && realRoot.code !== "ENOENT") {
        inconclusive.push(
          `ComfyUI's ${root.kind} directory could not be canonicalised (${realRoot.why ?? "unknown error"})`,
        );
      }
      if (!isStrictlyInside(file.path, realRoot.path)) continue;
      // A MATCH made against a path we could not canonicalise is not a proven
      // match (independent gate P0). `inconclusive` was consulted only on the
      // matched-nothing path below, so a lexical fallback that happened to land
      // under a root returned `servable` and forwarded a /view reference nobody
      // had verified — a 404, or a different file, presented as servable.
      //
      // The doubt is tested against THIS pair rather than the whole run: a
      // failure canonicalising some OTHER root says nothing about the one that
      // matched, and refusing on it would be the same fold pointed the other way.
      // ENOENT is NOT carved out here, unlike on the non-match path below. That
      // exclusion is sound only in the negative direction: an absent directory
      // cannot contain the file, so it adds no doubt to an "outside" answer. This
      // line is reached only AFTER containment passed against the root's lexical
      // fallback, and there an ENOENT root is load-bearing — a concurrent agent
      // renaming the directory between our stat and our realpath would hand back
      // a /view ref for a root that is no longer there.
      const rootUnproven = !realRoot.resolved;
      if (!file.resolved || rootUnproven) {
        return {
          status: "unknown",
          reason:
            `it looks like it is under ComfyUI's ${root.kind} directory, but ` +
            `${
              !file.resolved
                ? `the file's real location could not be resolved (${file.why ?? "unknown error"})`
                : `that directory could not be canonicalised (${realRoot.why ?? "unknown error"})`
            } — so the match was made against an unverified path and whether ComfyUI can serve it is undetermined`,
        };
      }
      // Derived from the same pair the containment test just passed, so the
      // relative path is exactly the one ComfyUI joins onto its own configured
      // root — and both sides of that pair are now proven canonical.
      const rel = relative(realRoot.path, file.path);
      const filename = basename(rel);
      const parent = dirname(rel);
      const subfolder =
        parent === "." || parent === "" ? "" : parent.split(sep).join("/");
      const problem = refShapeProblem(filename, subfolder);
      if (problem) {
        return {
          status: "unknown",
          reason: `the file is under ComfyUI's ${root.kind} directory but ${problem}`,
        };
      }
      return {
        status: "servable",
        ref: { filename, ...(subfolder ? { subfolder } : {}), type: root.kind },
        root,
      };
    }
  } catch (err) {
    return {
      status: "unknown",
      reason: `the path could not be compared against ComfyUI's media directories (${errText(err)})`,
    };
  }

  // Matched nothing. Whether that means "outside" depends on whether every
  // comparison was actually conclusive — a directory that would not resolve, or
  // a path that would not canonicalise, leaves room for the file to be sitting
  // somewhere ComfyUI serves. Reporting "outside" then would send the caller to
  // move a file that is already in the right place.
  const doubts = [...failures, ...inconclusive];
  if (doubts.length > 0) {
    return {
      status: "unknown",
      reason:
        `it is not under ${roots.map((r) => `ComfyUI's ${r.kind} directory (${r.dir})`).join(" or ")}, ` +
        `but ${doubts.join("; ")} — so whether ComfyUI can serve it is undetermined`,
    };
  }
  return { status: "outside", checked: roots };
}

// ---- opt-in staging into a served directory (#802) --------------------------
//
// The `outside` verdict used to end in "copy the file yourself". Staging does
// that copy FOR the caller — and it is deliberately OPT-IN (panel_show_media's
// stage:true), because it is a filesystem WRITE into the user's ComfyUI output
// directory made as a side effect of a display call. The default behaviour is
// unchanged: a refusal that names the manual remedy.
//
// The staged copy lands in <output>/_panel_staged/ with a timestamped name, so
// a repeat staging never overwrites an earlier copy, and the copies PERSIST —
// no automatic cleanup, because every lifecycle this codebase has tried for
// shared temp files has raced a reader that had not finished (#1152). The
// reply discloses the write and where the copies live; deleting them is the
// user's call, not ours.

/** Subfolder of ComfyUI's output directory that staged copies are written to. */
export const STAGED_SUBFOLDER = "_panel_staged";

/** Per-file staging cap — a guardrail on disk use, not the transport limit. */
export const STAGE_MAX_FILE_BYTES = 512 * 1024 * 1024; // 512 MB

/** Total cap on the staging folder, so repeated staging cannot grow without bound. */
export const STAGE_MAX_DIR_BYTES = 2 * 1024 * 1024 * 1024; // 2 GB

export type StageIntoServedDirResult =
  | { status: "staged"; ref: ComfyServableRef; stagedPath: string }
  | { status: "failed"; reason: string };

/**
 * Copy a LOCAL file into <output>/_panel_staged/ so ComfyUI can serve it over
 * /view, and return the ref for the COPY.
 *
 * Never throws: like the resolver above, every step is an operation that can
 * fail, and a staging failure must come back as a reason the caller can report,
 * not as a transport error. Fails CLOSED on the copy itself — COPYFILE_EXCL
 * (never overwrite), and a size check after the copy with the partial file
 * removed when it does not match, so a raced or truncated copy is never
 * forwarded as if it were the file the caller asked to show.
 */
export async function stageFileIntoServedDir(
  absPath: string,
  opts?: { maxFileBytes?: number; maxDirBytes?: number },
): Promise<StageIntoServedDirResult> {
  const maxFileBytes = opts?.maxFileBytes ?? STAGE_MAX_FILE_BYTES;
  const maxDirBytes = opts?.maxDirBytes ?? STAGE_MAX_DIR_BYTES;
  try {
    // Same guard as the resolver, and first for the same reason: on a remote or
    // cloud target a copy made HERE would land on a machine ComfyUI cannot see.
    if (isCloudMode()) {
      return {
        status: "failed",
        reason:
          "this session targets ComfyUI Cloud — a copy made on this machine would not be reachable by that server",
      };
    }
    if (isRemoteMode()) {
      return {
        status: "failed",
        reason:
          "this session targets a REMOTE ComfyUI on a different host — a copy made on this machine would not be reachable by that server",
      };
    }

    let outputDir: string;
    try {
      outputDir = await resolveOutputDir();
    } catch (err) {
      return {
        status: "failed",
        reason: `ComfyUI's output directory could not be resolved (${errText(err)})`,
      };
    }
    if (typeof outputDir !== "string" || outputDir.length === 0) {
      return {
        status: "failed",
        reason: "ComfyUI's output directory resolved to an empty value",
      };
    }
    const root = await canonical(resolve(outputDir));
    if (!root.resolved) {
      return {
        status: "failed",
        reason: `ComfyUI's output directory (${outputDir}) could not be canonicalised (${root.why ?? "unknown error"})`,
      };
    }

    const file = await canonical(resolve(absPath));
    if (!file.resolved) {
      return {
        status: "failed",
        reason: `the file's real location could not be resolved (${file.why ?? "unknown error"})`,
      };
    }
    if (isStrictlyInside(file.path, root.path)) {
      // The caller stages only files it believes are outside every served
      // directory; finding the file INSIDE the output root means that belief
      // is stale, and copying it under a second name would deposit a duplicate
      // the user never asked for.
      return {
        status: "failed",
        reason:
          "the file is ALREADY under ComfyUI's output directory, so it needs no staging — call panel_show_media with the same path again (it should take the by-reference route) and do NOT pass stage",
      };
    }

    const srcStat = await stat(file.path);
    if (!srcStat.isFile()) {
      return { status: "failed", reason: `not a regular file: ${absPath}` };
    }
    if (srcStat.size > maxFileBytes) {
      return {
        status: "failed",
        reason:
          `the file is ${mb(srcStat.size)}, over the ${mb(maxFileBytes)} per-file staging cap — ` +
          `staging is for ordinary oversized media, not unbounded disk use; copy it under a served directory yourself if it really must be shown`,
      };
    }

    const stagingDir = join(root.path, STAGED_SUBFOLDER);
    // Total-usage guardrail. Entries that vanish or refuse a stat between the
    // readdir and here are simply not counted — undercounting a transient is
    // fine; this cap exists to stop unbounded growth, not to audit the folder.
    let stagedBytes = 0;
    try {
      for (const entry of await readdir(stagingDir)) {
        try {
          stagedBytes += (await stat(join(stagingDir, entry))).size;
        } catch {
          // unknown-ok: an entry that disappeared mid-scan contributes nothing
          // to current usage; the guardrail tolerates the undercount.
        }
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        return {
          status: "failed",
          reason: `the staging folder (${stagingDir}) could not be read (${errText(err)})`,
        };
      }
      // ENOENT: nothing staged yet — usage is zero.
    }
    if (stagedBytes + srcStat.size > maxDirBytes) {
      return {
        status: "failed",
        reason:
          `the staging folder (${stagingDir}) already holds ${mb(stagedBytes)} and this ${mb(srcStat.size)} file would pass the ${mb(maxDirBytes)} total cap — ` +
          `ask the user to clear out old staged copies, then retry`,
      };
    }

    await mkdir(stagingDir, { recursive: true });

    // Timestamped so staging the same basename twice never collides; the retry
    // loop covers two calls landing in the same millisecond.
    const base = basename(file.path);
    let stagedPath = "";
    let stagedName = "";
    let copied = false;
    let lastErr: unknown = null;
    for (let attempt = 0; attempt < 3 && !copied; attempt++) {
      stagedName =
        attempt === 0
          ? `${Date.now()}-${base}`
          : `${Date.now()}-${attempt}-${base}`;
      stagedPath = join(stagingDir, stagedName);
      try {
        await copyFile(file.path, stagedPath, fsConstants.COPYFILE_EXCL);
        copied = true;
      } catch (err) {
        lastErr = err;
        if ((err as NodeJS.ErrnoException)?.code !== "EEXIST") break;
      }
    }
    if (!copied) {
      return {
        status: "failed",
        reason: `the copy into ${stagingDir} failed (${errText(lastErr)}) — the original file was not modified`,
      };
    }

    // The copy must BE the file: a source rewritten mid-copy, or a truncated
    // write, must not be forwarded as if it were what the caller asked to show.
    const dstStat = await stat(stagedPath);
    if (dstStat.size !== srcStat.size) {
      await rm(stagedPath, { force: true }).catch(() => {
        // unknown-ok: the partial copy is already rejected; failing to remove
        // it leaves harmless scratch, and masking the real failure (the size
        // mismatch) with a cleanup error would misreport what went wrong.
      });
      return {
        status: "failed",
        reason:
          `the staged copy came out ${mb(dstStat.size)} against a ${mb(srcStat.size)} source — the file may have changed while it was being copied; ` +
          `the partial copy was removed and nothing was forwarded`,
      };
    }

    const problem = refShapeProblem(stagedName, STAGED_SUBFOLDER);
    if (problem) {
      await rm(stagedPath, { force: true }).catch(() => {
        // unknown-ok: same as above — the ref rejection is the failure that
        // matters; leftover scratch is disclosed by the folder's existence.
      });
      return {
        status: "failed",
        reason: `the staged ref was rejected by the shape check (${problem}) — the copy was removed and nothing was forwarded`,
      };
    }

    return {
      status: "staged",
      ref: { filename: stagedName, subfolder: STAGED_SUBFOLDER, type: "output" },
      stagedPath,
    };
  } catch (err) {
    return {
      status: "failed",
      reason: `staging failed (${errText(err)}) — the original file was not modified`,
    };
  }
}

/**
 * What panel_show_media decided a file is, from its extension.
 *
 * #1572 added "audio". It is one type rather than three copies of the union so
 * that the next kind cannot be added to the gate and forgotten in a note — the
 * compiler named all four call sites when this widened, which is the only
 * reason the "displays it at full size" prose below was not left claiming a
 * `.wav` had been shown to someone.
 */
export type ShownMediaKind = "image" | "video" | "audio";

/** One item that was staged into a served directory and forwarded by reference. */
export type StagedForDisplay = {
  /** The original path the caller passed. */
  path: string;
  /** The copy the panel was pointed at. */
  stagedPath: string;
  sizeBytes: number;
  kind: ShownMediaKind;
  ref: ComfyServableRef;
};

/**
 * What the agent is told about items that took the staging route (#802).
 *
 * The disclosure is the point: staging is a real filesystem WRITE into the
 * user's ComfyUI output directory, and the copies PERSIST. The note states the
 * write, where it landed, that nothing cleans it up, and — as with every
 * reference route — that this process forwarded a reference and did not
 * observe the panel displaying anything.
 */
export function stagedForDisplayNote(
  items: StagedForDisplay[],
  capBytes: number,
): string {
  const one = items.length === 1;
  const lines = items.map((it) => {
    return `  - ${it.ref.filename} (${mb(it.sizeBytes)}, ${it.kind}) — copied from ${it.path} to ${it.stagedPath}`;
  });
  return (
    `NOTE — ${one ? "1 item was" : `${items.length} items were`} over the ${mb(capBytes)} inline cap and ${one ? "was" : "were"} STAGED, ` +
    `because stage:true was passed: the orchestrator COPIED ${one ? "the file" : "each file"} into a directory ComfyUI serves ` +
    `and sent the panel a /view reference to the copy (that route has no size limit):\n${lines.join("\n")}\n` +
    `That was a real filesystem WRITE, done only because stage:true opted in. The ${one ? "copy persists" : "copies persist"} — ` +
    `nothing cleans ${one ? "it" : "them"} up automatically; ${one ? "it lives" : "they live"} in the ${STAGED_SUBFOLDER} folder ` +
    `above and the user can delete that folder when done. Say so if you mention the file's location.\n` +
    `You were NOT sent the bytes of ${one ? "this file" : "these files"}. Whether the panel displayed ${one ? "it" : "them"} is in its reply above, not here.`
  );
}

const mb = (bytes: number): string => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/**
 * The refusal for a file too large to inline that could NOT be forwarded by
 * reference — stating the limit, why it exists, and a remedy that works from
 * where the caller actually is.
 *
 * Every branch ends in something the caller can do NEXT, from its current state.
 * A bare ceiling is not a remedy: it names a fact and leaves the caller with no
 * move, which is the whole defect this addresses.
 */
export function oversizedInlineRefusal(opts: {
  path: string;
  sizeBytes: number;
  capBytes: number;
  kind: ShownMediaKind;
  resolution: ViewRefResolution;
}): string {
  const { path, sizeBytes, capBytes, kind, resolution } = opts;

  // Three kinds, three honest answers. The old two-branch form treated "not a
  // video" as "an image", so once audio reached this gate (#1572) a `.wav`
  // would have been described as displayed "at full size" and the agent told to
  // call get_image to look at it — a claim about a file nobody can look at.
  const seeItYourself =
    kind === "video"
      ? "The panel then builds a SAMPLED contact sheet of the video for you; you are still not sent the video itself."
      : kind === "audio"
        ? "The panel then gives the USER an audio player for it. You are not sent the audio and cannot hear it — say what you generated, never what it sounds like, and ask the user if you need to know."
        : "The panel then displays it to the USER at full size. To look at it YOURSELF, call get_image (action:\"get\") with its filename/subfolder/type — that returns the image inline.";

  const head =
    `file too large to send inline (${mb(sizeBytes)} > ${mb(capBytes)} cap): ${path}\n` +
    `The cap applies to the INLINE path only: this tool base64-encodes the file into the reply, and a payload that size would swamp the context. ` +
    `There is a route with no size limit — a file that lives under a directory ComfyUI serves is displayed BY REFERENCE, because the panel is a browser tab on ComfyUI's own origin and fetches it directly.`;

  if (resolution.status === "remote") {
    return (
      `${head}\n` +
      `That route is unavailable here: ${resolution.reason}. A path on this machine names a file that server cannot open, so no reference to it would resolve.\n` +
      `What you can do:\n` +
      `  1. Put the file on the ComfyUI host — upload it into that server's input directory — then call panel_show_media with a ComfyUI reference ({ filename, type: "input" }) instead of a path.\n` +
      `  2. Ask the user to open the file themselves; it is on the machine they are at.`
    );
  }

  if (resolution.status === "unknown") {
    return (
      `${head}\n` +
      `Whether that route is available could NOT be determined: ${resolution.reason}. ` +
      `That is not the same as knowing the file is in the wrong place — it may already be under a directory ComfyUI serves.\n` +
      `What you can do:\n` +
      `  1. Make the directories resolvable and retry: check ComfyUI is running and reachable (its launch arguments are the primary source), or set COMFYUI_PATH to the ComfyUI install.\n` +
      `  2. Copy the file under ComfyUI's output directory and call panel_show_media again with the new path.\n` +
      `  3. Ask the user to open the file themselves.`
    );
  }

  if (resolution.status === "outside") {
    const list = resolution.checked
      .map((r) => `    - ${r.kind}: ${r.dir}`)
      .join("\n");
    const outputDir = resolution.checked.find((r) => r.kind === "output")?.dir;
    // Staging is named FIRST because it is the one remedy that is a single
    // retried call — but it is disclosed as the disk write it is, caps and
    // persistence included, so choosing it is an informed choice (#802).
    const staging = outputDir
      ? `  1. Retry THIS call with stage:true on the item — the orchestrator will COPY the file into ${outputDir}${outputDir.endsWith("/") || outputDir.endsWith("\\") ? "" : "/"}${STAGED_SUBFOLDER} and display the copy by reference. That is a real disk write (caps: ${mb(STAGE_MAX_FILE_BYTES)} per file, ${mb(STAGE_MAX_DIR_BYTES)} total staged) and the copy PERSISTS until someone deletes it.\n`
      : "";
    return (
      `${head}\n` +
      `This file is not under any directory this ComfyUI serves. Checked:\n${list}\n` +
      `What you can do:\n` +
      staging +
      `  ${staging ? "2" : "1"}. Copy or move it under one of the directories above (a subfolder is fine) and call panel_show_media again with the NEW path. ${seeItYourself}\n` +
      `  ${staging ? "3" : "2"}. Ask the user to move it, or to open it themselves; it is on the machine they are at.`
    );
  }

  // A servable file is not refused — reaching here means the caller ignored the
  // resolution. Say so rather than inventing a reason it could not be shown.
  return (
    `file too large to send inline (${mb(sizeBytes)} > ${mb(capBytes)} cap): ${path}\n` +
    `This file IS servable by reference and should not have been refused; this is a bug in panel_show_media, not a problem with the file.`
  );
}

/** One item that was forwarded by reference instead of inlined. */
export type ForwardedByReference = {
  path: string;
  sizeBytes: number;
  kind: ShownMediaKind;
  ref: ComfyServableRef;
};

/**
 * What the agent is told about items that took the reference route.
 *
 * States ONLY what this process did — it forwarded a reference. Whether the
 * panel actually displayed anything is in the panel's own reply, which reports
 * its paint outcomes; claiming a display here would be fabricating a result this
 * code never observed.
 */
export function forwardedByReferenceNote(
  items: ForwardedByReference[],
  capBytes: number,
): string {
  const lines = items.map((it) => {
    const where = it.ref.subfolder
      ? `type "${it.ref.type}", subfolder "${it.ref.subfolder}"`
      : `type "${it.ref.type}"`;
    return `  - ${it.ref.filename} (${mb(it.sizeBytes)}, ${it.kind}) — ${where}`;
  });
  const anyVideo = items.some((it) => it.kind === "video");
  const anyImage = items.some((it) => it.kind === "image");
  const anyAudio = items.some((it) => it.kind === "audio");
  const howToSee = [
    anyImage
      ? `To look at an IMAGE yourself, call get_image (action:"get") with the filename/type/subfolder above — it comes back inline.`
      : null,
    anyVideo
      ? `A VIDEO is never sent to you inline; the panel's reply above carries a sampled contact sheet and says what it does and does not show. get_image (action:"get") on a video saves it to disk and returns the path.`
      : null,
    // #1572 — audio has no equivalent of the contact sheet, and saying nothing
    // about it would leave the one kind an agent is most likely to narrate
    // unheard as the only kind with no caveat attached.
    anyAudio
      ? `AUDIO is never sent to you either, and there is no sampled preview of it: the user gets a player, you get this note. Do not describe how it sounds.`
      : null,
  ]
    .filter(Boolean)
    .join(" ");

  return (
    `NOTE — ${items.length === 1 ? "1 item was" : `${items.length} items were`} over the ${mb(capBytes)} inline cap, ` +
    `so ${items.length === 1 ? "it was" : "they were"} sent to the panel as ComfyUI /view reference${items.length === 1 ? "" : "s"} instead of inline data ` +
    `(that path has no size limit):\n${lines.join("\n")}\n` +
    `You were NOT sent the bytes of ${items.length === 1 ? "this file" : "these files"}. Whether the panel displayed ${items.length === 1 ? "it" : "them"} is in its reply above, not here. ` +
    howToSee
  );
}

/** A ComfyUI /view reference handed to a BROWSER panel without being verified. */
export type UnverifiedViewRef = { filename: string; subfolder?: string; type?: string };

/** What an orchestrator-side probe of /view found, when one was run. */
export type ViewRefProbe = {
  /** How many refs were probed (bounded — this is a diagnostic, not a sweep). */
  checked: number;
  /** Refs whose /view answered with something that is not media. */
  nonMedia: { filename: string; detail: string }[];
};

/** Map a /view Content-Type onto the panel painter kind, or null if not media. */
export function mediaKindFromMime(mimeType: string): "image" | "video" | "audio" | null {
  const mime = mimeType.split(";")[0]!.trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  return null;
}

/** Narrow a caller-supplied ComfyUI type to what fetchImage accepts. */
export function viewRefTypeForFetch(type: string | undefined): "output" | "input" | "temp" {
  return type === "input" || type === "temp" ? type : "output";
}

/**
 * #2861 — fail-closed copy when a REMOTE /view ref cannot be inlined.
 *
 * A browser panel probes `/view` in ITS session. That is not get_image's
 * authenticated/configured route, and forwarding the ref paints 0 cards.
 * The handler fetches through fetchImage instead. If that fetch cannot be
 * painted (transport, non-media, over the inline cap), this is the reply —
 * never a broken viewRef, and never a same-named local workspace file
 * (#877/#899).
 */
export function remoteViewRefInlineFailedNote(args: {
  filename: string;
  detail: string;
  capBytes: number;
}): string {
  const capMb = Math.round(args.capBytes / (1024 * 1024));
  return (
    `panel_show_media cannot paint "${args.filename}" as a ComfyUI /view reference ` +
    `on this REMOTE target: the panel's browser-facing /view is not the same route ` +
    `get_image uses, and forwarding the ref would return painted:0 (HTTP 404). ` +
    `${args.detail} ` +
    `I did not substitute a same-named local workspace file (that is a different machine). ` +
    `If get_image(action:"get") already saved the bytes locally and they are under the ` +
    `${capMb} MB inline cap, call panel_show_media with that absolute path.`
  );
}

/**
 * The caveat a forwarded /view reference has to carry (#941).
 *
 * `panel_show_media` hands a browser panel a reference and the panel replies
 * `painted: N, unconfirmed: 0`. That count is honest about what the PANEL did —
 * it created N cards — and silent about the thing the caller cares about: the
 * browser fetches `/view` itself, AFTER the reply, and if that fetch returns
 * HTML the card renders broken with no error anywhere in the chain. A reporter
 * saw `{"ok":true,"count":8,"painted":8,"unconfirmed":0}` over eight broken
 * images on a proxied remote ComfyUI.
 *
 * Note what this deliberately does NOT do: inline bytes from a local workspace
 * "mirror" when the target is REMOTE. Same-named files on a different machine
 * are not the same files, and painting a stale local image while reporting
 * success would replace a visibly broken card with an invisibly wrong one —
 * strictly worse (the #877/#899 hazard).
 */
export function unverifiedViewRefNote(
  refs: UnverifiedViewRef[],
  probe?: ViewRefProbe,
): string {
  if (refs.length === 0) return "";
  const one = refs.length === 1;
  const lines = refs
    .slice(0, 8)
    .map((r) => `  - ${r.filename}${r.subfolder ? ` (subfolder "${r.subfolder}")` : ""}`)
    .join("\n");
  const more = refs.length > 8 ? `\n  - …and ${refs.length - 8} more` : "";

  // A probe result is EVIDENCE, not proof: this process asks its own
  // COMFYUI_URL, while the browser asks the origin its tab is on, and those two
  // are allowed to differ (#952). Say which one was tested.
  const evidence =
    probe && probe.nonMedia.length > 0
      ? `\nChecked from HERE: ${probe.nonMedia.length} of the ${probe.checked} probed did NOT return media ` +
        `(${probe.nonMedia.map((n) => `${n.filename} → ${n.detail}`).join("; ")}). ` +
        `That is this orchestrator's ComfyUI target, not necessarily the origin the browser tab is on, ` +
        `so treat it as strong evidence rather than proof.`
      : probe && probe.checked > 0
        ? `\nChecked from HERE: all ${probe.checked} probed returned media, so the reference itself looks fine — ` +
          `which does not rule out the browser tab reaching a DIFFERENT ComfyUI than this orchestrator does.`
        : "";

  return (
    `NOTE — ${one ? "1 item was" : `${refs.length} items were`} sent to the panel as a ComfyUI /view REFERENCE, ` +
    `not as inline bytes:\n${lines}${more}\n` +
    `A "painted" count above means the panel created ${one ? "that card" : "those cards"} — NOT that the media loaded. ` +
    `The browser fetches /view itself, after that reply, and when it gets HTML instead of an image (a proxied or ` +
    `remote ComfyUI, an auth wall, an expired session) the card renders BROKEN and nothing reports an error.${evidence}\n` +
    `If the user says the image is broken, do not re-send the same reference — pass an absolute LOCAL path instead, ` +
    `which is verified and inlined as bytes.`
  );
}

// ---------------------------------------------------------------------------
// #2010 — what a `show_media` reply actually ESTABLISHED
// ---------------------------------------------------------------------------
//
// `panel_show_media` dispatches items to whatever client the session is bound
// to and returns that client's reply verbatim. Two clients answer it, and they
// do not answer the same question:
//
//   • the sidebar panel replies with the #710 per-item contract —
//     `{ok, count, painted, unconfirmed, unrenderable, previews, note}` — where
//     `painted` counts only what the person can SEE or HEAR and a kind it has no
//     player for is reported in `unrenderable` instead. That reply read the
//     items and says what became of each one.
//
//   • the mobile / remote pseudo-panel replies `{'shown': true}` to ANY
//     show_media, without reading the items at all
//     (comfyui-mcp-mobile `bridge_client.dart`: `replyOk(frame.rid, {'shown':
//     true})`). Its `MediaCard.build` is `if (item.isVideo) _video else _still`
//     — two branches, no audio one — so an audio item becomes an `<Image>` that
//     fails to decode. The reply says it was shown; nothing looked.
//
// Relaying the second one is this repo's own worst failure mode: a tool
// reporting an outcome it did not observe. The rule below states the narrowest
// true thing instead, and it asks NO question about the destination — no
// "is this tab headless", no extension sniffing, no client guess. It reads the
// reply that came back. A client earns the claim by accounting for the items;
// one that does not account for them establishes acceptance and nothing more.
//
// That is deliberately kind-agnostic. Audio is what surfaced it, but "the
// client did not say what it rendered" is exactly as true of an image, and a
// rule that fired only for audio would be a guess about the other kinds wearing
// a narrower coat. It also, without naming them, covers a panel older than #710
// (whose reply predates `unrenderable` and which paints audio as a broken
// `<img>` — the client in #2017) and any future client this bridge meets.

/** One item `panel_show_media` actually dispatched, as it went on the wire. */
export type DispatchedMediaItem = {
  filename: string;
  /** The `kind` field on the dispatched item — "image"/"video" for inlined
   *  bytes, "viewRef" for a ComfyUI reference. Reported as sent, never
   *  re-derived here: a guess about the media kind is the thing this module is
   *  refusing to make. */
  kind: string;
  /** True only when the outbound item carried a data URL with the source
   *  bytes. Omitted/false means the item was sent as a reference. */
  inline?: boolean;
};

/** Why a `show_media` reply did or did not establish that its items were
 *  presented. Each value changes what the caller may honestly say. */
export type ShowMediaAckReason =
  /** The #710 per-item contract, covering the batch that was actually sent. */
  | "accounted"
  /** The reply DECLARES failure (`ok:false`). Nothing needs correcting: the
   *  client is not claiming a success, it is reporting the opposite. */
  | "declared_failure"
  /** #2013 — buffered by the bridge because it could not route. No client has
   *  seen it, so no client can have presented it. */
  | "mailboxed"
  /** No per-item accounting at all — `{shown:true}`, `{ok:true}`, a string. */
  | "no_accounting"
  /** Well-formed accounting about a DIFFERENT number of items than were sent. */
  | "partial_accounting"
  /** Accounting whose own numbers do not add up — `painted + unconfirmed +
   *  unrenderable.length` exceeds the `count` it declares, or the count is not
   *  a whole non-negative number. A reply that contradicts itself establishes
   *  nothing, and it is a different thing to report than a short one. */
  | "incoherent_accounting";

export type ShowMediaAckVerdict = {
  /** True only when the reply establishes presentation for the WHOLE batch. */
  accounted: boolean;
  reason: ShowMediaAckReason;
  /** How many items the reply itself claims to be about, when it says at all;
   *  null when it does not. A COUNT, never an identity — a reply covering 1 of
   *  2 items does not say WHICH one, so nothing downstream can name it. */
  covered: number | null;
  /** #2013 — concrete tab id the mailbox named, when the recipient is knowable.
   *  `null` when the box is scope-keyed (whoever hellos next). Present only
   *  for reason `"mailboxed"`. */
  queuedFor?: string | null;
};

/**
 * What a `show_media` reply established about the items it was given.
 *
 * `accounted` is true only for the #710 contract — a numeric `count`, a numeric
 * `painted`, and an `unrenderable` array — AND only when that accounting is
 * about the batch that was actually dispatched. Every clause is load-bearing:
 *
 *  - `count`+`painted` are the arithmetic the panel documents
 *    (`painted + unconfirmed + unrenderable.length + dropped === count`);
 *  - `unrenderable` is the field a client only has once it can tell "I presented
 *    this" from "I was handed a kind I have no player for" — a panel older than
 *    #710 has the first two and not this one (#2017);
 *  - the COVERAGE check is the difference between an account and a coincidence.
 *    `{count:1, painted:1, unrenderable:[]}` is a perfectly well-formed #710
 *    reply and it establishes nothing whatever about the SECOND item of a
 *    two-item batch. Without it the extra item is lost in silence — which is
 *    the same defect this module exists to remove, one layer in (gate r1, P1).
 *
 * Note what is NOT accepted: `{shown: true}`, `{ok: true}`, `{mailboxed: true}`,
 * a bare `true`, an array, a string. None of them names an item.
 */
export function readShowMediaAck(reply: unknown, dispatchedCount: number): ShowMediaAckVerdict {
  if (!reply || typeof reply !== "object" || Array.isArray(reply)) {
    return { accounted: false, reason: "no_accounting", covered: null };
  }
  const r = reply as Record<string, unknown>;
  // A reply that DECLARES failure is left alone. This exists to stop an
  // unearned claim of SUCCESS; `ok:false` is the client claiming the opposite,
  // and rewriting it as `dispatched:true` — telling the caller not to re-send —
  // would manufacture the very over-claim it is here to remove (gate r1, P1).
  if (r.ok === false) return { accounted: false, reason: "declared_failure", covered: null };
  // #2013 — buffered rather than refused. Checked BEFORE the shape test so a
  // mailbox receipt that happened to carry counts could not be read as an
  // account of a presentation no client has had the chance to make.
  if (r.mailboxed === true) {
    const queuedFor =
      typeof r.queued_for === "string" && r.queued_for.length > 0 ? r.queued_for : null;
    return { accounted: false, reason: "mailboxed", covered: null, queuedFor };
  }
  const count = r.count;
  const painted = r.painted;
  const unrenderable = r.unrenderable;
  if (typeof count !== "number" || typeof painted !== "number" || !Array.isArray(unrenderable)) {
    return { accounted: false, reason: "no_accounting", covered: null };
  }
  const unconfirmed = typeof r.unconfirmed === "number" ? r.unconfirmed : 0;
  // EVERY number here must be a whole non-negative one. Non-negative alone is
  // not enough: `{count:1, painted:0.5}` satisfies `0.5 <= 1` and would be
  // relayed as a trustworthy account of one item (gate r2, P1). A fraction of a
  // card was never painted; a reply that says so is malformed, and malformed
  // accounting is not accounting.
  const whole = (n: number): boolean => Number.isInteger(n) && n >= 0;
  const coherent =
    whole(count) &&
    whole(painted) &&
    whole(unconfirmed) &&
    // `dropped` is described in the panel's note but not carried as a field, so
    // the parts can be FEWER than the count. They can never be more.
    painted + unconfirmed + unrenderable.length <= count;
  if (!coherent) return { accounted: false, reason: "incoherent_accounting", covered: count };
  if (count !== dispatchedCount) {
    return { accounted: false, reason: "partial_accounting", covered: count };
  }
  return { accounted: true, reason: "accounted", covered: count };
}

/** Thin boolean over {@link readShowMediaAck}, for a call site that only gates. */
export function showMediaReplyAccountsForItems(reply: unknown, dispatchedCount: number): boolean {
  return readShowMediaAck(reply, dispatchedCount).accounted;
}

/**
 * The disclosure an unaccounted-for `show_media` reply has to carry.
 *
 * Written to be un-mistakable for a failure report, because it is not one: the
 * items were dispatched and the client took them. What is missing is the part
 * that would let this tool say the person perceived them — so the one thing the
 * caller must not do is narrate the audio, or the picture, as though it landed.
 *
 * Re-sending is called out explicitly as the WRONG next step. The identical
 * reply comes back the second time, and an agent that reads "unconfirmed" as
 * "failed" will loop on a delivery that already happened.
 *
 * The three unaccounted reasons are genuinely different diagnoses and are not
 * given one wording. "The client took it and said nothing" is false of a
 * mailboxed command that no client has seen (#2013), and false again of a reply
 * that accounted for a DIFFERENT number of items than were sent — there the
 * client did read items, just not all of these, and the shortfall is the thing
 * the caller has to be told about (gate r1, P1).
 */
export function unaccountedShowMediaNote(
  dispatched: readonly DispatchedMediaItem[],
  verdict: ShowMediaAckVerdict,
): string {
  if (dispatched.length === 0) return "";
  const one = dispatched.length === 1;
  const lines = dispatched
    .slice(0, 8)
    .map((d) => `  - ${d.filename} (dispatched as ${d.kind})`)
    .join("\n");
  const more = dispatched.length > 8 ? `\n  - …and ${dispatched.length - 8} more` : "";
  const animatedImages = dispatched.filter(
    (d) => d.inline === true && /\.(?:gif|apng|webp)$/i.test(d.filename),
  );
  const animationCaveat =
    animatedImages.length > 0
      ? ` Animated GIF/APNG/WebP bytes were dispatched, but this reply does not say whether ` +
        `their frames advanced beyond the first frame.`
      : "";

  let what: string;
  if (verdict.reason === "mailboxed") {
    // #2013 — `show_media` is the ONE command the bridge buffers instead of
    // refusing when it cannot route. No client has seen this at all yet, which
    // is a weaker fact than "a client took it and said nothing about it".
    // A concrete tab is a known recipient; a scope-keyed box is not — saying
    // "whichever client connects next" of a named tab would be a lie in the
    // other direction.
    if (verdict.queuedFor) {
      const short =
        verdict.queuedFor.length > 12 ? `${verdict.queuedFor.slice(0, 8)}…` : verdict.queuedFor;
      what =
        `${one ? "It was" : "They were"} QUEUED, not delivered: no client has this yet. ` +
        `It is waiting for tab ${short} to reconnect, and nothing here says that client can present it.`;
    } else {
      what =
        `${one ? "It was" : "They were"} QUEUED, not delivered: no client has this yet. It will be handed ` +
        `to whichever client connects next, and nothing here says that client can present it.`;
    }
  } else if (verdict.reason === "partial_accounting") {
    // A count is not an identity: a reply about 1 of 2 items does not say WHICH
    // one, so every item is listed and none can be marked settled.
    what =
      `The client's reply accounts for ${verdict.covered ?? "an unstated number of"} item(s), but ` +
      `${dispatched.length} were sent — so it is not an account of this batch. It does not say WHICH ` +
      `of them it was about, so none of them can be treated as settled.`;
  } else if (verdict.reason === "incoherent_accounting") {
    // Said apart from the short-count case on purpose: the numbers here are
    // about the right batch and still cannot be true, and "it covered N of M"
    // would be nonsense prose when N and M are equal.
    what =
      `The client's reply is shaped like a per-item account but its own numbers do not add up ` +
      `(\`painted\` + \`unconfirmed\` + \`unrenderable\` exceeds the \`count\` it declares, or that ` +
      `count is not a whole number). A reply that contradicts itself establishes nothing.`;
  } else {
    what =
      `The client acknowledged the command but did not report what it rendered — its reply carries no ` +
      `per-item accounting (\`count\`/\`painted\`/\`unrenderable\`), so it did not read the items. ` +
      `The mobile / remote client answers \`{"shown": true}\` to any show_media without looking at them, ` +
      `and it has no audio player at all.${animationCaveat}`;
  }

  return (
    `NOTE — this call did NOT establish that ${one ? "this item was" : "these items were"} presented ` +
    `to the user:\n${lines}${more}\n` +
    `${what}\n` +
    `So: do not tell the user what they saw or heard here, and do not describe the contents of a file ` +
    `on the basis of this reply. Ask them whether ${one ? "it" : "they"} appeared, if you need to know.\n` +
    `This is NOT a failure report and re-sending is the wrong next step — the same reply comes back. ` +
    `A sidebar panel answers with a real per-item account; this client does not.`
  );
}
