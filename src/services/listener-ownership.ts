// Who owns the healthy listener after a launch? (#776)
//
// This module exists to make one invariant UNFORGEABLE rather than merely
// documented: a definite verdict — `ours` or `not-ours` — may only be produced by
// the code that actually gathered the evidence for it. The same defect kept
// reappearing on new paths (#796): an early return naming a definite answer it had
// no basis for. A comment could not stop that; a type can.
//
// `ListenerOwnership` is a branded string. The values serialise and compare as
// ordinary `"ours"` / `"not-ours"` / `"unconfirmed"`, but the type carries a
// phantom property no literal satisfies, and the only cast that mints one lives in
// `classified()` — which is private to this file and used solely inside
// `classifyListenerOwnership`. Callers get exactly two ways to obtain a value:
// classify (and earn a verdict), or `unclassifiedOwnership()` (and admit you did
// not). Living in its own module is the point: in a 2600-line file the cast was
// reachable by any future early return, which made the guarantee "that file's
// discipline" rather than the compiler's.

import type { ChildProcess } from "node:child_process";
import { commandLineMatchesArgv, type ProcessIdentity } from "./live-interpreter.js";

declare const CLASSIFIED: unique symbol;

export type ListenerOwnership = ("ours" | "not-ours" | "unconfirmed") & {
  readonly [CLASSIFIED]: true;
};

/** Mint a verdict. PRIVATE — the whole point of the module boundary. */
function classified(
  verdict: "ours" | "not-ours" | "unconfirmed",
): ListenerOwnership {
  return verdict as ListenerOwnership;
}

/** The only verdict a caller that did NOT classify is entitled to return. */
export function unclassifiedOwnership(): ListenerOwnership {
  return "unconfirmed" as ListenerOwnership;
}

// ---------------------------------------------------------------------------
// Will a supervisor bring this process back? (#814)
// ---------------------------------------------------------------------------

declare const SUPERVISION_CLASSIFIED: unique symbol;

/**
 * Whether stopping this process is SURVIVABLE — i.e. whether something else will
 * start it again.
 *
 * The question exists because a ComfyUI **Desktop** instance is never killed and
 * relaunched by us (#400): the Electron shell owns the process, so the restart path
 * asks ComfyUI-Manager to re-exec it and relies on that shell to be there. #814 is
 * what happens when it is NOT — the reboot stopped a Desktop-spawned server whose
 * shell had already moved on, nothing brought it back, and the user was left with no
 * ComfyUI at all. The stop was dispatched on an ASSUMPTION about a supervisor nobody
 * had looked for.
 *
 * Branded for exactly the reason `ListenerOwnership` is: a definite verdict may only
 * come from the code that gathered the evidence. Here BOTH definite verdicts are
 * costly in opposite directions — `supervised` licenses a stop, `abandoned` denies a
 * user a restart that would have worked — so neither is reachable from a literal.
 */
export type SupervisorRelaunch = ("supervised" | "abandoned" | "unconfirmed") & {
  readonly [SUPERVISION_CLASSIFIED]: true;
};

function classifiedSupervision(
  verdict: "supervised" | "abandoned" | "unconfirmed",
): SupervisorRelaunch {
  return verdict as SupervisorRelaunch;
}

/** The only verdict a caller that did NOT classify is entitled to return. */
export function unclassifiedSupervision(): SupervisorRelaunch {
  return "unconfirmed" as SupervisorRelaunch;
}

/**
 * The verdict AND what stopped the walk from reaching a definite one.
 *
 * `because` exists because `unconfirmed` now REFUSES a reboot rather than allowing
 * it, and a refusal that cannot say what it failed to establish is not actionable:
 * "could not read the parent of PID 4321" tells a user (and a maintainer) something
 * a bare "unconfirmed" does not. Only populated for `unconfirmed` — the two definite
 * verdicts describe themselves.
 */
export interface SupervisionAssessment {
  verdict: SupervisorRelaunch;
  because?: string;
  /**
   * Set ONLY when the walk stopped because the parent of this pid could not be
   * read at all — the first shape of `unconfirmed` below. Recorded as a field
   * (not just folded into `because`) so a caller can tell "the chain was
   * unreadable from the start" apart from the later, richer shapes — a parent
   * that exists but cannot be probed, an identity that cannot be read, start
   * times that cannot be compared — without parsing prose. The distinction
   * decides whether the #1647 fallback (proceed on the server's own Desktop
   * launch signatures, disclosed) may even be considered: that fallback exists
   * for the host that cannot read parentage at all, never for a chain that was
   * read and found ambiguous partway up.
   */
  parentUnreadableAt?: number;
  /**
   * Set when a parent PID was read and exists, but neither its command line nor
   * its executable could be identified. Distinct from `parentUnreadableAt` on
   * purpose: that one is "the host cannot read parentage at all" (#1647). This
   * one is "a live parent is sitting there and we cannot tell what it is"
   * (#1847). Inferring Desktop supervision from argv would be a guess about a
   * process we failed to identify; the caller may still relaunch if every
   * launch component is proven on disk.
   */
  parentIdentityUnreadableAt?: number;
}

export interface SupervisionEvidence {
  /** The process that would be stopped — the one holding ComfyUI's port. */
  pid: number;
  readParentPid: (pid: number) => number | undefined;
  readIdentity: (pid: number) => ProcessIdentity | undefined;
  /**
   * Does this pid exist? TRI-STATE, from a signal-0 probe:
   *   false     — ESRCH: nothing holds that number.
   *   true      — it exists (or exists and is not ours to signal).
   *   undefined — could not tell.
   * The DEFINITE FALSE is the load-bearing one: "the supervisor's pid is gone" is
   * the positive finding that a stop will not be undone.
   */
  processExists: (pid: number) => boolean | undefined;
  /**
   * Is this process a Desktop supervisor (the Electron shell / .app)?
   *
   * Takes the whole identity, not just the command line, so the decision can be made
   * from argv[0] — the process's OWN executable. A predicate over the raw string
   * cannot tell "this IS the Desktop shell" from "this merely mentions it", and a
   * wrapper that passes the Desktop exe as an argument re-execs nothing.
   */
  isSupervisorProcess: (identity: ProcessIdentity) => boolean;
}

/**
 * Is `parent` old enough to BE the parent of `child`?
 *
 * A parent pid alone does not identify a parent process. When a process's parent
 * exits, the number it held stays written in the child's record and becomes
 * reusable — so a LATER process can inherit it, and on Windows that later process
 * can perfectly well be another `Comfy Desktop.exe` (the user restarted the app).
 * Checking only "does that pid exist and look like a shell" then answers
 * `supervised` about a shell that has never heard of this backend, which is the very
 * lost-server this classifier exists to prevent (codex gate).
 *
 * Causality settles it: a parent cannot have started AFTER its child. Equality is
 * allowed because the stamps are coarse on some platforms (macOS `lstart` has
 * one-second resolution, and a shell spawning its backend immediately lands in the
 * same second).
 *
 * The stamps are only ever compared against another reading from the SAME platform,
 * as everywhere else in this codebase. All-digit forms (Linux clock ticks since
 * boot; a Windows FILETIME, which exceeds Number.MAX_SAFE_INTEGER and is therefore
 * compared as BigInt) compare numerically; otherwise a date parse is attempted.
 * Anything that cannot be compared is `unknown` — never quietly "fine".
 */
type StartOrder = "parent-first" | "parent-newer" | "unknown";

export function compareStartTimes(
  parent: string | undefined,
  child: string | undefined,
): StartOrder {
  if (!parent || !child) return "unknown";
  const p = parent.trim();
  const c = child.trim();
  if (/^\d+$/.test(p) && /^\d+$/.test(c)) {
    return BigInt(p) <= BigInt(c) ? "parent-first" : "parent-newer";
  }
  const pd = Date.parse(p);
  const cd = Date.parse(c);
  if (Number.isNaN(pd) || Number.isNaN(cd)) return "unknown";
  return pd <= cd ? "parent-first" : "parent-newer";
}

/**
 * Is a live Desktop supervisor still watching `pid`?
 *
 * ANCESTRY, WALKED UPWARD — which is the opposite direction from
 * `isDescendantOfChild` above, and for a different question. That one asks "is this
 * the child WE spawned?", where tracing to a long-lived ancestor proves nothing
 * because every stale sibling shares it. This one asks "is anything above this
 * process going to restart it?", and an ancestor is precisely what can: the Desktop
 * shell spawns the Python backend, so the shell IS the supervisor. Intermediate
 * wrappers (a launcher script, a shim) are walked THROUGH rather than treated as an
 * answer.
 *
 *   `supervised` — an ancestor is alive and its command line is a Desktop shell.
 *                  Positive: there is something there to re-exec the process.
 *   `abandoned`  — the chain was READ to its top and no live Desktop shell stands on
 *                  it: either the parent's number is provably vacant (the shell
 *                  exited) or the tree root was reached with every step readable and
 *                  none of them a supervisor. Positive too — this is the #814 shape,
 *                  and it is what refuses a stop.
 *   `unconfirmed`— the chain became unreadable, a pid could not be probed, or the hop
 *                  budget ran out. NOT an answer in either direction — and note that
 *                  it is the CALLER that decides what to do with it. For a reboot,
 *                  which is irreversible and has not happened yet, the caller refuses —
 *                  with one disclosed exception (#1647: the FIRST link unreadable on a
 *                  host that cannot read parentage at all, where the server's own
 *                  Desktop launch signatures say who started it): see
 *                  assessDesktopSupervision. Each such outcome carries `because`, so a
 *                  refusal can name what it failed to establish, and
 *                  `parentUnreadableAt`, so the fallback can tell the first-hop shape
 *                  from a chain that ran out of road partway up.
 *
 * The hop budget is small on purpose. A Desktop backend sits one or two levels under
 * its shell; a chain longer than that is not a layout we can reason about, and
 * "cannot tell" is the honest verdict for it.
 */
export function classifyDesktopSupervision(
  input: SupervisionEvidence,
  maxHops = 8,
): SupervisionAssessment {
  const unconfirmed = (because: string): SupervisionAssessment => ({
    verdict: classifiedSupervision("unconfirmed"),
    because,
  });
  const definite = (v: "supervised" | "abandoned"): SupervisionAssessment => ({
    verdict: classifiedSupervision(v),
  });
  // NO SELF-SUPERVISOR SHORTCUT. An earlier revision returned `supervised` when the
  // pid handed in was ITSELF a Desktop shell, to serve the caller's fallback of
  // "ComfyUI could not be attributed to the port, so use whatever Desktop shell is
  // running". But that fallback picks a shell by scanning process NAMES — it is bound
  // to no port and to no backend, so "this pid is a Desktop shell" says nothing about
  // whether it supervises the server the reboot would stop. A second, unrelated
  // Desktop window would have licensed stopping an orphaned backend it has never
  // heard of, which is the same lost server by a new route (codex gate round 9).
  //
  // The premise, not the shortcut, was the problem: that caller now declines before
  // reaching here, so every pid this classifier sees is one resolved FROM THE PORT —
  // a backend, whose supervisor is genuinely somewhere above it.
  const self = input.readIdentity(input.pid);
  let current = input.pid;
  let currentStartedAt = self?.startedAt;
  for (let hop = 0; hop < maxHops; hop++) {
    const parent = input.readParentPid(current);
    // The chain stopped being readable. Nothing was learned in either direction.
    // WHICH pid failed is recorded: a caller that falls back to weaker evidence
    // (#1647) may do so only when the FIRST link — the port owner's own parent —
    // is the unreadable one, not when a walk that got partway up ran out of road.
    if (parent == null) {
      return {
        ...unconfirmed(`the parent process of PID ${current} could not be read`),
        parentUnreadableAt: current,
      };
    }
    // A process cannot be its own parent; that reading is damage, not a tree root.
    if (parent === current) return unconfirmed(`PID ${current} was reported as its own parent, which is not a tree this can be read from`);
    // The TOP of the tree, reached without passing a supervisor. On POSIX an
    // orphan is reparented to init (1) — that reparenting is itself the record
    // that whoever spawned it has gone.
    if (parent <= 1) return definite("abandoned");
    const alive = input.processExists(parent);
    // THE #814 SIGNAL: the parent's number is vacant, so the shell that spawned this
    // server has exited. Nothing is left to act on a reboot request.
    if (alive === false) return definite("abandoned");
    // Exists, but we could not establish that — do not spend it either way.
    if (alive !== true) return unconfirmed(`it could not be established whether PID ${parent} (the parent of PID ${current}) is still running`);
    const identity = input.readIdentity(parent);
    // Something holds that number and we cannot see WHAT it is. A pid can be
    // RECYCLED, so "a process exists there" is not evidence a supervisor does.
    //
    // "What it is" now has two possible sources, and either will do: the command
    // line, or the OS's own record of the binary. Gating on the command line alone
    // was a leftover from when it was the only one — a process whose command line is
    // unreadable but whose EXECUTABLE the OS names would stop the walk here, and the
    // authenticated evidence that exists precisely to settle this question would
    // never be consulted (codex gate round 4).
    if (!identity || (!identity.commandLine && !identity.executablePath)) {
      return {
        ...unconfirmed(
          `PID ${parent} (the parent of PID ${current}) exists but what it is running could not be read`,
        ),
        parentIdentityUnreadableAt: current,
      };
    }
    // IS THIS REALLY THE PARENT, or just whoever holds that number now? A pid
    // recorded in a child's record outlives the process that earned it, and the
    // replacement can look exactly like a supervisor.
    const order = compareStartTimes(identity.startedAt, currentStartedAt);
    // The process at that number started AFTER its supposed child, so the real
    // parent has exited — which is what made the number reusable. That is positive
    // evidence the supervisor is gone.
    if (order === "parent-newer") return definite("abandoned");
    // No usable stamps on one side or the other: the link is unverified, so nothing
    // built on it may be claimed.
    if (order === "unknown") {
      return unconfirmed(
        `PID ${parent} could not be confirmed as the parent of PID ${current} — the process ` +
          `start times needed to rule out a reused PID could not be compared`,
      );
    }
    if (input.isSupervisorProcess(identity)) return definite("supervised");
    current = parent;
    currentStartedAt = identity.startedAt;
  }
  // Ran out of hops: did not finish looking.
  return unconfirmed(
    `no Desktop supervisor was found within ${maxHops} levels above PID ${input.pid}, and the ` +
      `walk ran out before reaching the top of the process tree`,
  );
}

// ---------------------------------------------------------------------------
// Path tokens
// ---------------------------------------------------------------------------

/**
 * A token's path dialect, decided from ROOTING rather than from the presence of a
 * separator character.
 *
 * Backslash is a legal filename character on POSIX, so "contains a backslash"
 * cannot mean "Windows": under that rule `/srv/Comfy\A` and `/srv/comfy\a` — two
 * different installs — normalised identically and case-folded into a false MATCH,
 * which is the direction that licenses stopping somebody else's process.
 *
 *   "win-rooted"  — a drive (`C:\`, `C:/`) or UNC (`\\host\share`) root. Windows
 *                   for certain: separators are interchangeable, case is not
 *                   significant.
 *   "win-relative"— backslashes and NO forward slash, e.g. `ComfyUI\main.py`. This
 *                   is how a Windows-launched ComfyUI reports `sys.argv[0]`, but it
 *                   is also a legal POSIX filename, so separators are normalised
 *                   and case is NOT folded on this evidence alone.
 *   "drive-relative" — `C:ComfyUI\main.py`, which resolves against that drive's
 *                   own working directory. Two processes can resolve the same text
 *                   to DIFFERENT installs, so it is not comparable at all.
 *   "posix"       — everything else. Case-sensitive, backslashes literal.
 */
type Dialect = "win-rooted" | "win-relative" | "drive-relative" | "posix";

function dialectOf(token: string): Dialect {
  if (/^[a-zA-Z]:[\\/]/.test(token) || /^\\\\/.test(token)) return "win-rooted";
  if (/^[a-zA-Z]:[^\\/]/.test(token)) return "drive-relative";
  if (token.includes("\\") && !token.includes("/")) return "win-relative";
  return "posix";
}

interface PathToken {
  text: string;
  /** Case may be folded when comparing against another token. */
  foldable: boolean;
  /** The text cannot be resolved to a location at all (drive-relative). */
  unresolvable: boolean;
}

function prepareToken(raw: string): PathToken {
  const trimmed = raw.trim().replace(/^["']+|["']+$/g, "");
  const dialect = dialectOf(trimmed);
  if (dialect === "drive-relative") {
    return { text: trimmed, foldable: false, unresolvable: true };
  }
  // Separators are only interchangeable in a Windows dialect. On POSIX a backslash
  // is part of the name and must stay.
  const windows = dialect === "win-rooted" || dialect === "win-relative";
  let t = windows ? trimmed.replace(/\\/g, "/") : trimmed;
  // Extended-length and UNC prefixes denote the same locations as their plain
  // spellings.
  t = t.replace(/^\/\/\?\/unc\//i, "//").replace(/^\/\/\?\//, "");
  if (t.includes("/")) {
    const drive = /^([a-zA-Z]:)(?=\/)/.exec(t)?.[1] ?? "";
    const rooted = t.startsWith("/") || drive !== "";
    const body = t.slice(drive.length);
    const out: string[] = [];
    for (const seg of body.split("/")) {
      if (seg === "" || seg === ".") continue;
      if (seg === "..") {
        if (out.length > 0 && out[out.length - 1] !== "..") out.pop();
        // At a ROOT, `..` has nowhere to go — the OS clamps it, so we must too,
        // or `/../ComfyUI` and `/ComfyUI` (the same directory) read as different.
        else if (!rooted) out.push("..");
        continue;
      }
      out.push(seg);
    }
    t = `${drive}${rooted ? "/" : ""}${out.join("/")}`;
  }
  return { text: t, foldable: dialect === "win-rooted", unresolvable: false };
}

/**
 * Do two argv tokens denote the same thing?
 *
 * Case is folded ONLY when a side is rooted in a Windows path (that filesystem is
 * case-insensitive); everywhere else the comparison is exact, because a spurious
 * equality here can promote a listener to `ours`. Paths compare SEGMENT-ALIGNED —
 * one may be a suffix of the other — since we launch the script by absolute path
 * while the server reports the relative one it was handed.
 */
function tokensAgree(a: PathToken, b: PathToken): boolean {
  if (a.unresolvable || b.unresolvable) return false;
  const fold = a.foldable || b.foldable;
  const x = fold ? a.text.toLowerCase() : a.text;
  const y = fold ? b.text.toLowerCase() : b.text;
  if (x === y) return true;
  const pathish = (s: string): boolean => /\//.test(s) || /^[a-zA-Z]:/.test(s);
  if (!pathish(x) || !pathish(y)) return false;
  return x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

// ---------------------------------------------------------------------------
// Liveness and lineage
// ---------------------------------------------------------------------------

/**
 * Is the process we spawned still alive? Tri-state, because only a DEFINITE answer
 * may change a verdict.
 *
 *   false     — an exit was recorded, or a signal-0 probe says ESRCH: it is gone.
 *   undefined — no pid to probe, or EPERM (something holds that number but it is
 *               not ours to signal). "Cannot tell", never "alive" and never "dead".
 *   true      — the pid exists and is signalable. Necessary, NOT sufficient: a
 *               recycled number passes too, which is why lineage is also required.
 */
export function launchedChildStillRunning(
  child: ChildProcess,
  kill: (pid: number, signal: 0) => void = (pid, signal) => {
    process.kill(pid, signal);
  },
): boolean | undefined {
  const pid = child.pid;
  if (pid == null) return undefined;
  // Loose null check: a not-yet-exited child reports `null`, and an absent
  // property must read the same way rather than as "already exited".
  if (child.exitCode != null || child.signalCode != null) return false;
  try {
    kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "ESRCH" ? false : undefined;
  }
}

/**
 * Is `pid` THIS CALL'S CHILD, or a descendant of it?
 *
 * Traced to `childPid`, deliberately NOT to the orchestrator. Ancestry under the
 * long-lived MCP process proves almost nothing: a stale ComfyUI from an EARLIER
 * request is also descended from it, has identical argv, and may still hold the
 * port — so tracing to the orchestrator would report that sibling as `ours` and
 * announce a restart that never happened, while the child we just spawned may have
 * died on a bind failure. Only lineage through this launch's own child answers the
 * question actually being asked.
 *
 * `undefined` the moment the chain becomes unreadable, and on budget exhaustion:
 * running out of hops is "did not finish looking", not a negative answer.
 */
export function isDescendantOfChild(
  pid: number,
  childPid: number,
  readParentPid: (pid: number) => number | undefined,
  maxHops = 8,
): boolean | undefined {
  let current = pid;
  for (let hop = 0; hop < maxHops; hop++) {
    if (current === childPid) return true;
    const parent = readParentPid(current);
    if (parent == null) return undefined;
    // Reached the top of the tree without passing through our child.
    if (parent === current || parent <= 1) return false;
    current = parent;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// The classifier
// ---------------------------------------------------------------------------

export interface OwnershipEvidence {
  isDesktopApp: boolean;
  /** The child's `exit` event has already been delivered. */
  childExited: boolean;
  /** The child's `error` event has been delivered — the spawn FAILED. */
  spawnFailed: boolean;
  child: ChildProcess;
  /** The exact (interpreter + args) we launched. */
  launchArgv?: string[];
  /** The pid holding the port after readiness, or null when unmappable. */
  portOwnerPid: number | null;
  /** `sys.argv` as reported by whatever server is now answering. */
  servingArgv?: string[];
  readParentPid: (pid: number) => number | undefined;
  readIdentity: (pid: number) => ProcessIdentity | undefined;
  childIsAlive?: boolean | undefined;
}

export function classifyListenerOwnership(
  input: OwnershipEvidence,
): ListenerOwnership {
  /**
   * Does the server that is answering run what we launched?
   *
   * ASYMMETRIC by design. A MISMATCH is proof of the negative — nobody else's
   * command line is ours. A match is only CORROBORATION: another supervisor can
   * start the very same command, win the bind race, and answer identically, so it
   * may never promote anything to `ours`. And `unknown` is neither: it is the
   * absence of a comparison, and must not be spent as either.
   */
  const byArgv = (): "match" | "differ" | "unknown" => {
    if (!input.servingArgv?.length || !input.launchArgv?.length) return "unknown";
    // The interpreter is dropped from our side: the server reports `sys.argv`,
    // which never contains it. Order is preserved on both sides (a relaunch passes
    // the same arguments in the same order), so compare positionally, and require
    // the same COUNT so a foreign subset cannot pass as a match.
    const ours = input.launchArgv.slice(1).map(prepareToken).filter((t) => t.text);
    const serving = input.servingArgv.map(prepareToken).filter((t) => t.text);
    if (ours.length === 0 || serving.length === 0) return "unknown";
    // A drive-relative token resolves against a per-drive working directory we do
    // not know, so identical text can denote different installs. Not comparable.
    if (ours.some((t) => t.unresolvable) || serving.some((t) => t.unresolvable)) {
      return "unknown";
    }
    const same =
      ours.length === serving.length &&
      ours.every((token, i) => tokensAgree(token, serving[i]));
    return same ? "match" : "differ";
  };

  // A LAUNCH THAT NEVER HAPPENED is decisive on every path, Desktop included, so
  // these come first and no later shortcut can soften them. The spawn error is
  // latched independently of the readiness race, and Node leaves `pid` undefined
  // only when the spawn did not happen — the same fact by two routes.
  if (input.spawnFailed) return classified("not-ours");
  if (input.child.pid == null) return classified("not-ours");
  // A Desktop launch is undecidable BY DESIGN once it HAS started: we spawn the
  // Electron shell (or macOS `open`, which exits immediately by design) and its
  // child binds the port. Sits after the never-launched checks, before
  // `childExited`, because for Desktop a launcher exiting is normal.
  if (input.isDesktopApp) return classified("unconfirmed");

  const alive = input.childIsAlive;
  // OUR DIRECT CHILD IS GONE — by its `exit` event or by a signal-0 probe. Usually
  // that means the listener is somebody else's, but it is ALSO the shape of a
  // wrapper that launched ComfyUI as a grandchild and exited, after which the
  // grandchild is reparented and lineage cannot place it. So only a real, comparable
  // MISMATCH is decisive here; a match and an unreadable comparison alike degrade,
  // rather than telling that user their own server is not theirs.
  if (input.childExited || alive === false) {
    return byArgv() === "differ"
      ? classified("not-ours")
      : classified("unconfirmed");
  }

  const ourPid = input.child.pid;
  if (input.portOwnerPid == null) {
    // NO LISTENER WAS IDENTIFIED. `not-ours` is a positive finding about an
    // identified process, so it cannot be reached from here — there is nothing to
    // have found.
    return classified("unconfirmed");
  }
  if (input.portOwnerPid !== ourPid) {
    // A different pid holds the port. That is usually somebody else's server, but
    // it is also the shape of an indirect launch (wrapper, double fork,
    // trampoline) where the listener is our GRANDchild — so trace lineage through
    // THIS launch's child before concluding.
    const descendant = isDescendantOfChild(
      input.portOwnerPid,
      ourPid,
      input.readParentPid,
    );
    // Lineage does not outrank direct contrary evidence: a wrapper of ours can
    // bring up a DIFFERENT or stale ComfyUI, which would be in our tree while
    // plainly not being what we launched.
    if (descendant === true) {
      return byArgv() === "differ" ? classified("not-ours") : classified("ours");
    }
    if (descendant === false) return classified("not-ours");
    return byArgv() === "differ"
      ? classified("not-ours")
      : classified("unconfirmed");
  }
  // The pid MATCHES — but it could be a recycled number we cannot signal.
  if (alive !== true) return classified("unconfirmed");

  // LINEAGE is the discriminator that does not depend on WHEN we looked: we
  // spawned this child, so the process on the port must still be it. A recycled
  // number has a different parent. Not knowing is never promoted to `ours`.
  const parent = input.readParentPid(ourPid);
  if (parent == null) return classified("unconfirmed");
  if (parent !== process.pid) return classified("not-ours");

  // Belt and braces: the OS's view of the command line, and the server's own
  // account of itself, must both agree. Each is a decisive negative only.
  const identity = input.readIdentity(ourPid);
  if (
    identity?.commandLine &&
    input.launchArgv &&
    !commandLineMatchesArgv(identity.commandLine, input.launchArgv)
  ) {
    return classified("not-ours");
  }
  if (byArgv() === "differ") return classified("not-ours");
  return classified("ours");
}
