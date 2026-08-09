import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { canonicalOrigin } from "../utils/origin.js";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { logger } from "../utils/logger.js";
import { SHARED_SESSION_SCOPE } from "../services/session-scope.js";
import { runningUnderTestRunner } from "../services/panel-secrets.js";

/**
 * Durable SDK session ids, so an agent's memory survives the orchestrator
 * PROCESS dying — a wedge auto-restart, a crash, an OOM — not just a soft
 * reload.
 *
 * SESSIONS ARE ORCHESTRATOR-SCOPED (#884, owner-stated invariant): one agent
 * session spans every panel, browser tab and open workflow this orchestrator
 * serves. The store is therefore keyed by the composite shared agent key
 * (`orchestrator::<backend>` — see src/services/session-scope.ts), one entry
 * per provider, and persisted in the user's config dir
 * (~/.comfyui-mcp/sessions/panel-sessions-<port>.json) — on disk, owned by the
 * orchestrator, never the browser. The panel's own localStorage copy is only a
 * last-resort hint for a wiped store. Keyed by the bridge port so two ComfyUI
 * instances on one machine never cross-resume.
 *
 * MIGRATIONS this constructor performs, once, on first load:
 *  - LOCATION: earlier builds wrote the file into the OS temp dir
 *    (world-writable on some systems, and routinely wiped). If the new file is
 *    absent and the tmpdir file exists, its `sessions` map is imported so an
 *    upgrade loses no history. The old file is left in place (an older
 *    orchestrator build may still be running against it); the OS reclaims it.
 *  - KEYING: earlier builds kept one session per (workflow tab, backend) —
 *    `wf:<path>::claude`, `tmp:<uuid>::codex`, … When the shared key for a
 *    backend has no entry yet, {@link get} adopts the MOST RECENTLY USED legacy
 *    entry for that backend as the shared conversation, so the user's newest
 *    per-workflow conversation becomes the one shared session instead of
 *    starting everyone from zero. Older legacy entries stay resumable via the
 *    panel's history picker (resume_session) and age out via GC.
 *  - The legacy `stable` index (per-workflow resume fallback for unsaved
 *    workflows, including its poison mechanism) is obsolete under a shared key
 *    that never churns — it is dropped on load, never read, never written.
 *
 * Entries carry a write timestamp and are GC'd on load (older than
 * {@link SessionStore.GC_TTL_MS}), so the file can't grow unbounded with dead
 * keys from prior runs.
 */

interface Entry {
  /** SDK session id to resume. */
  s: string;
  /** Epoch ms of the last write — for GC. */
  t: number;
  /** Optional workflow-identity binding retained from the per-workflow era.
   *  Unused for shared-scope keys (a shared session legitimately spans
   *  workflows); preserved on legacy entries so nothing is rewritten. */
  u?: string;
}

interface StoreFileV2 {
  v: 2;
  sessions: Record<string, Entry>;
}

const WORKFLOW_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The validated + canonicalized (origin, uuid) identity a panel hello/command
 *  claims, or undefined when either half is missing/untrusted. The origin MUST
 *  be the caller's SERVER-OBSERVED (unspoofable) handshake origin — never the
 *  client-supplied hello.comfyui_url. Still used for the per-command workflow
 *  STAMP (routing job: a command dispatched for workflow A must not mutate
 *  workflow B after a switch) — deliberately NOT for session identity, which is
 *  orchestrator-scoped (#884). */
export function workflowIdentityParts(opts: {
  workflowUuid?: string | undefined;
  origin?: string | undefined;
}): { origin: string; uuid: string } | undefined {
  const raw = typeof opts.workflowUuid === "string" ? opts.workflowUuid.trim() : "";
  const uuid = WORKFLOW_UUID_RE.test(raw) ? raw.toLowerCase() : "";
  if (!uuid) return undefined;
  // #1255 — `localhost` and `127.0.0.1` are the same machine, and this gate did
  // not know it: a fence bound under one spelling could never validate against
  // the other. Permanent (nothing re-binds the stored origin), refresh-proof (a
  // reload re-sends the same Origin header), no relay involved, and invisible to
  // sibling reads that never consult origin-bound identity.
  //
  // Reuses `canonicalOrigin` rather than comparing the pair, so `::1` and the
  // next spelling nobody has thought of are covered by the same definition
  // #1246 already established for target drift. Falls back to the previous
  // normalisation when the input will not parse: an origin we cannot read must
  // keep failing closed, which is the case this gate exists for.
  const raw0 = typeof opts.origin === "string" ? opts.origin.trim() : "";
  const origin =
    canonicalOrigin(raw0) ?? raw0.replace(/\/+$/, "").toLowerCase();
  if (!origin) return undefined;
  return { origin, uuid };
}

/** Legacy-adoption screen: tab-id halves that must never seed the shared
 *  conversation (test/spike keys from prior runs). */
const LEGACY_ADOPT_EXCLUDE = /^(e2e-|spike-)/;

export class SessionStore {
  /** Entries untouched for longer than this are pruned on load. Resumes are
   *  same-day / few-days in practice; three weeks is a generous ceiling that
   *  still bounds growth. */
  static readonly GC_TTL_MS = 21 * 24 * 60 * 60 * 1000;

  private readonly path: string;
  /** The pre-#884 tmpdir location — read once for the location migration. */
  private readonly legacyPath: string;
  private sessions: Record<string, Entry>;
  /** #884 P1 (codex confirming gate 2) — TRUE when the in-memory state is known
   *  NOT to be on disk, i.e. a write failed and was reported. Every path that
   *  would otherwise take an in-memory shortcut and answer `true` consults this
   *  first, so a durability claim always describes the DISK, never just RAM. */
  private undurable = false;
  /** Set when the on-disk store EXISTED but could not be READ (an I/O error, not
   *  a parse error). Its contents are unknown and presumed good, so flush() must
   *  move it aside before overwriting — see read() and flush(). Cleared once it
   *  has been preserved. */
  private loadUnreadable: string | undefined;
  /** #884 P1 (confirming gate 3) — the (size, mtime) of the store file as last
   *  READ or WRITTEN by this instance. `undurable === false` alone proved only
   *  that the LAST write succeeded, not that the file is still there: deleted
   *  or replaced externally, a later in-memory shortcut still answered "durable"
   *  while a restart would lose the session. The shortcut now re-stats the file
   *  and compares against this fingerprint — a cheap, honest "the state I put
   *  on disk is observably still in place" check (a same-size, same-mtime
   *  external replacement is not detectable without a full read and is accepted
   *  as the documented limit of the claim). Undefined = nothing verifiable on
   *  disk; the shortcut then re-writes instead of asserting. */
  private diskFingerprint: { size: number; mtimeMs: number } | undefined;

  constructor(port: number, opts: { dir?: string } = {}) {
    // #866 — guard at the WRITE, not per-test: this store lives in the user's
    // real ~/.comfyui-mcp, so a test that forgets to pass { dir } must refuse
    // loudly instead of silently polluting (and then reading back) real state.
    // Detection keys off the runner's own globals; when uncertain, the write is
    // allowed — a real user must never be refused their own store.
    if (!opts.dir && runningUnderTestRunner()) {
      throw new Error(
        "Refusing to open the real ~/.comfyui-mcp/sessions store from a test run: " +
          "pass { dir: <temp dir> } to SessionStore (see #866 — guard at the write, not per-test).",
      );
    }
    const dir = opts.dir ?? join(homedir(), ".comfyui-mcp", "sessions");
    this.path = join(dir, `panel-sessions-${port}.json`);
    this.legacyPath = join(tmpdir(), `comfyui-mcp-panel-sessions-${port}.json`);
    try {
      mkdirSync(dir, { recursive: true });
    } catch (err) {
      logger.warn(`[session-store] could not create ${dir}: ${String(err)}`);
    }
    const loaded = this.read();
    this.sessions = loaded.sessions;
    // If load had to SANITIZE (migrate the legacy format/location, GC an expired
    // entry, clamp a corrupt future timestamp), persist the cleaned version NOW —
    // otherwise a clamped-in-memory-only value survives on disk and is re-clamped
    // on every load, immortal.
    if (loaded.dirty) this.flush();
  }

  private now(): number {
    return Date.now();
  }

  /** Parse one store file's bytes into a sessions map, dropping malformed and
   *  expired rows. Handles the v2 shape and the ancient flat v1 map. */
  private parse(text: string): { sessions: Record<string, Entry>; dirty: boolean } {
    const empty = { sessions: {}, dirty: false };
    const parsed: unknown = JSON.parse(text);
    if (!parsed || typeof parsed !== "object") return empty;
    const obj = parsed as Record<string, unknown>;
    const cutoff = this.now() - SessionStore.GC_TTL_MS;
    let dirty = false;
    const coerce = (raw: unknown): Record<string, Entry> => {
      const out: Record<string, Entry> = {};
      if (raw === undefined) return out;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
        dirty = true;
        return out;
      }
      const nowMs = this.now();
      for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
        if (!v || typeof v !== "object") {
          dirty = true;
          continue;
        }
        const e = v as { s?: unknown; t?: unknown; u?: unknown };
        if (typeof e.s !== "string") {
          dirty = true;
          continue;
        }
        // Sanitize the timestamp: non-finite → epoch 0 (pruned as too old);
        // a finite FUTURE value is clamped to now so the TTL applies to it.
        const rawT = typeof e.t === "number" && Number.isFinite(e.t) ? e.t : 0;
        let t = rawT;
        if (t > nowMs) t = nowMs;
        if (t !== rawT) dirty = true;
        if (t < cutoff) {
          dirty = true;
          continue;
        }
        const entry: Entry = { s: e.s, t };
        if (typeof e.u === "string") entry.u = e.u;
        out[k] = entry;
      }
      return out;
    };
    if (obj.v === 2) {
      const sessions = coerce(obj.sessions);
      // A pre-#884 v2 file also carried a `stable` index — obsolete under the
      // shared key (see the class docstring). Dropping it must be persisted.
      if (obj.stable !== undefined) dirty = true;
      return { sessions, dirty };
    }
    // ANCIENT flat format (Record<string,string>) — migrate. Stamp `now` so the
    // migration itself never trips GC.
    const sessions: Record<string, Entry> = {};
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === "string") sessions[k] = { s: v, t: this.now() };
    }
    return { sessions, dirty: true };
  }

  private read(): { sessions: Record<string, Entry>; dirty: boolean } {
    // RECOVERY ORDER. A leftover `.tmp` is always the NEWEST state when it
    // parses: a successful flush renames it away, so its presence means the
    // last rename failed or crashed mid-flush — prefer it over the main file
    // and re-persist (dirty). The legacy tmpdir file is consulted ONLY when
    // the new-location file does not EXIST (the one-shot location migration).
    // An existing-but-corrupt home file with no usable `.tmp` starts EMPTY,
    // never falls back to the stale pre-migration store — that would silently
    // resurrect sessions the user has since replaced or cleared (a wrong
    // resume; codex round 1, P1). Missing ≠ corrupt.
    const tmpPath = `${this.path}.tmp`;
    try {
      if (existsSync(tmpPath)) {
        const recovered = this.parse(readFileSync(tmpPath, "utf8"));
        logger.warn(
          `[session-store] recovered the newest state from ${tmpPath} (a previous persist did not complete)`,
        );
        return { sessions: recovered.sessions, dirty: true }; // re-persist properly
      }
    } catch {
      // tmp unreadable/corrupt (a crash mid-tmp-write) — fall through to main.
    }
    if (existsSync(this.path)) {
      // COULD NOT READ IT and IT IS CORRUPT are different states (#796), and this
      // catch used to serve both. The difference decides whether the file on disk
      // is worthless or precious:
      //
      //   parse threw     → the bytes really are unusable; starting empty loses
      //                     nothing that was recoverable.
      //   readFileSync threw → EACCES / EBUSY / EMFILE. The sessions are INTACT
      //                     and readable later; we simply could not open the file
      //                     this instant (antivirus, a backup process, another
      //                     orchestrator mid-write — all routine on Windows).
      //
      // Starting empty on the second one is silent data loss, because flush()
      // renames over this.path unconditionally: the first new session — or even a
      // touch() — replaces an intact store with a one-entry one, and every prior
      // resume id is gone. This file already argues "failing to persist is
      // strictly better than destroying what's there"; that reasoning simply never
      // covered a failed LOAD.
      let text: string | undefined;
      try {
        text = readFileSync(this.path, "utf8");
      } catch (err) {
        // Do NOT let the next flush() overwrite a file we never managed to read.
        this.loadUnreadable = String(err);
        logger.warn(
          `[session-store] ${this.path} could NOT be READ (it is not known to be corrupt) — ` +
            `starting empty for now, and the next persist will move it aside rather than ` +
            `overwrite it, so nothing in it is lost: ${String(err)}`,
        );
        return { sessions: {}, dirty: false };
      }
      try {
        const parsed = this.parse(text);
        // The in-memory state now equals this on-disk file — fingerprint it so
        // a later durability shortcut can verify the file is still in place.
        this.captureDiskFingerprint();
        return parsed;
      } catch (err) {
        logger.warn(
          `[session-store] ${this.path} is unreadable/corrupt — starting empty (NOT falling back to the pre-migration tmpdir store): ${String(err)}`,
        );
        return { sessions: {}, dirty: false };
      }
    }
    try {
      if (existsSync(this.legacyPath)) {
        const migrated = this.parse(readFileSync(this.legacyPath, "utf8"));
        if (Object.keys(migrated.sessions).length) {
          logger.info(
            `[session-store] migrated ${Object.keys(migrated.sessions).length} session(s) from ${this.legacyPath} to ${this.path}`,
          );
        }
        return { sessions: migrated.sessions, dirty: true }; // persist at the new location
      }
    } catch {
      // Legacy unreadable/corrupt — start empty; resume falls back to fresh.
    }
    return { sessions: {}, dirty: false };
  }

  /** Persist the store. Atomic (temp + rename); returns whether the state is
   *  durably on disk. On ANY failure the previous on-disk store is left
   *  INTACT — there is deliberately NO truncate-in-place fallback (codex
   *  confirming-gate P0: a truncated write surviving a crash reads as corrupt
   *  next boot, and corrupt refuses legacy recovery, so every resume id would
   *  be lost; failing to persist is strictly better than destroying what's
   *  there). When the temp write itself succeeded, the newest state survives
   *  in `.tmp` and read() recovers it on the next load. */
  private flush(): boolean {
    const payload = JSON.stringify({ v: 2, sessions: this.sessions } satisfies StoreFileV2);
    const tmp = `${this.path}.tmp`;
    // The store we are about to replace was never read (an I/O failure at load,
    // not a parse failure), so its contents are unknown and presumed GOOD. Move it
    // aside before the rename below destroys it. If it cannot even be moved,
    // REFUSE to persist — the same ruling this method already makes for a failed
    // write: failing to persist is strictly better than destroying what's there.
    if (this.loadUnreadable !== undefined) {
      const aside = `${this.path}.unreadable-${this.now()}`;
      try {
        if (existsSync(this.path)) {
          renameSync(this.path, aside);
          logger.warn(
            `[session-store] preserved the unreadable store as ${aside} before writing a fresh one ` +
              `(it could not be read at startup: ${this.loadUnreadable}). If sessions went missing, ` +
              `that file holds them.`,
          );
        }
        this.loadUnreadable = undefined; // preserved (or already gone) — safe from here
      } catch (err) {
        this.undurable = true;
        logger.warn(
          `[session-store] REFUSING to persist: ${this.path} could not be read at startup and cannot ` +
            `be moved aside either, so overwriting it would destroy sessions that are probably intact ` +
            `(${String(err)}). State is kept in memory for this run.`,
        );
        return false;
      }
    }
    try {
      writeFileSync(tmp, payload);
      renameSync(tmp, this.path);
      this.undurable = false;
      this.captureDiskFingerprint();
      return true;
    } catch (err) {
      this.undurable = true;
      this.diskFingerprint = undefined; // nothing of ours verifiably on disk
      const tmpHoldsState = ((): boolean => {
        try {
          return existsSync(tmp) && readFileSync(tmp, "utf8") === payload;
        } catch {
          return false;
        }
      })();
      logger.warn(
        `[session-store] persist FAILED — the previous on-disk store was left intact; the latest state ${
          tmpHoldsState ? `survives in ${tmp} and will be recovered on the next load` : "was NOT captured on disk"
        }: ${String(err)}`,
      );
      return false;
    }
  }

  /** Touch an entry's timestamp on a resume hit so an actively-used session
   *  never ages out. Debounced (1h) so the per-spawn read doesn't churn disk. */
  private touch(key: string): void {
    const e = this.sessions[key];
    if (!e) return;
    const now = this.now();
    if (now - e.t < 60 * 60 * 1000) return;
    e.t = now;
    this.flush();
  }

  /**
   * KEYING migration (#884): the shared key for a backend has no entry yet, but
   * per-workflow entries from the pre-#884 era may. Adopt the most recently
   * used one for this backend as the shared conversation, persisting it under
   * the shared key, so upgrading users keep their newest conversation's memory.
   *
   * Adoption CONSUMES every legacy entry for the backend (they are deleted).
   * This is what makes it one-shot: after a deliberate New chat clears the
   * shared key, a later get() finds no legacy entry to re-adopt — otherwise the
   * cleared conversation would silently resurrect. The archived conversations
   * themselves are untouched (the panel's history picker resumes them by
   * explicit session id via resume_session, never through these keys).
   */
  private adoptLegacyForSharedKey(sharedKey: string): Entry | undefined {
    const sep = sharedKey.indexOf("::");
    if (sep < 0) return undefined;
    const backend = sharedKey.slice(sep + 2);
    if (!backend) return undefined;
    const suffix = `::${backend}`;
    let bestKey: string | undefined;
    let best: Entry | undefined;
    const legacyKeys: string[] = [];
    for (const [k, e] of Object.entries(this.sessions)) {
      if (!k.endsWith(suffix)) continue;
      const tabHalf = k.slice(0, k.length - suffix.length);
      if (tabHalf === SHARED_SESSION_SCOPE || tabHalf.includes("::")) continue;
      if (LEGACY_ADOPT_EXCLUDE.test(tabHalf)) continue;
      legacyKeys.push(k);
      if (!best || e.t > best.t) {
        best = e;
        bestKey = k;
      }
    }
    if (!best || !bestKey) return undefined;
    const adopted: Entry = { s: best.s, t: this.now() };
    for (const k of legacyKeys) delete this.sessions[k]; // consumed — see docstring
    this.sessions[sharedKey] = adopted;
    const persisted = this.flush();
    logger.info(
      `[session-store] adopted legacy per-workflow session ${bestKey.slice(0, 24)}… as the shared ${backend} conversation (${legacyKeys.length} legacy ${backend} entr${legacyKeys.length === 1 ? "y" : "ies"} consumed, #884)${
        persisted ? "" : " — WARNING: the adoption could NOT be persisted and will re-run from disk on the next boot"
      }`,
    );
    return adopted;
  }

  /** The persisted session id to resume for a key, if any. For a shared-scope
   *  key with no entry, falls back to adopting the newest legacy per-workflow
   *  entry for that backend (see the class docstring). */
  get(key: string): string | undefined {
    let e: Entry | undefined = this.sessions[key];
    if (!e && key.startsWith(`${SHARED_SESSION_SCOPE}::`)) {
      e = this.adoptLegacyForSharedKey(key);
    }
    if (!e) return undefined;
    this.touch(key);
    return e.s;
  }

  /** The workflow-identity binding a legacy entry carries, if any. Retained for
   *  the manager's rebind plumbing; shared-scope entries never carry one. */
  identityOf(key: string): string | undefined {
    return this.sessions[key]?.u;
  }

  /** Record (and persist) a key's current session id. `identityUuid` is the
   *  legacy per-workflow binding — accepted for API compatibility, unused for
   *  shared-scope keys. No-op if both the id and binding are unchanged.
   *  Returns whether the state is DURABLY persisted (a swallowed write failure
   *  here is the false-success class — codex confirming-gate P1). */
  set(key: string, sessionId: string, identityUuid?: string): boolean {
    const u = typeof identityUuid === "string" && identityUuid ? identityUuid : undefined;
    const existing = this.sessions[key];
    if (existing?.s === sessionId && existing.u === u) {
      // Same id — refresh the timestamp so an active session never GCs out, but
      // skip the disk write when the timestamp is already recent. NOT a blanket
      // `true`: if an earlier write failed, this state has never reached disk,
      // and the shortcut would report a durability we never achieved (codex
      // confirming-gate 2, P1). Retry the write instead and answer honestly.
      if (this.now() - existing.t < 60 * 60 * 1000) return this.settled();
    }
    const entry: Entry = { s: sessionId, t: this.now() };
    if (u) entry.u = u;
    this.sessions[key] = entry;
    return this.flush();
  }

  /** Forget a key's session — called on a deliberate NEW chat, so the disk
   *  fallback never resurrects a conversation the user reset. Returns whether
   *  the clear is DURABLE: false means the in-memory entry is gone (this
   *  process starts fresh) but the on-disk copy could not be updated, so an
   *  orchestrator restart could resume the cleared conversation — callers must
   *  disclose that instead of reporting a clean New chat (codex
   *  confirming-gate P1). */
  clear(key: string): boolean {
    // Absent in memory does NOT mean absent on disk. After a failed clear the
    // entry is already gone from memory, so a naive `true` here let the SECOND
    // New chat report a clean durable clear while the stale on-disk entry sat
    // there waiting to resurrect the conversation on the next restart (codex
    // confirming-gate 2, P1). Retry the write and report what actually happened.
    if (!(key in this.sessions)) return this.settled();
    delete this.sessions[key];
    return this.flush();
  }

  /** Record the store file's current (size, mtime) after a successful read or
   *  write, for the drift check in {@link settled}. A failed stat clears the
   *  fingerprint: what cannot be fingerprinted cannot later be verified, so the
   *  shortcut re-writes instead of asserting. */
  private captureDiskFingerprint(): void {
    try {
      const st = statSync(this.path);
      this.diskFingerprint = { size: st.size, mtimeMs: st.mtimeMs };
    } catch {
      this.diskFingerprint = undefined;
    }
  }

  /** Durability of the CURRENT in-memory state when a caller took an in-memory
   *  shortcut (nothing to change). `true` is claimed only on EVIDENCE: no prior
   *  write failure AND the store file is observably still the one this instance
   *  last read/wrote (same size+mtime — confirming gate 3, P1: after external
   *  deletion/replacement the old shortcut kept answering "durable" while a
   *  restart would lose the session). Anything less re-runs the write, which
   *  both repairs the store the moment the filesystem recovers and keeps the
   *  answer honest while it hasn't. */
  private settled(): boolean {
    if (this.undurable) return this.flush();
    if (this.diskFingerprint) {
      try {
        const st = statSync(this.path);
        if (st.size === this.diskFingerprint.size && st.mtimeMs === this.diskFingerprint.mtimeMs) {
          return true;
        }
      } catch {
        // missing/unreadable — fall through to the repair write
      }
    }
    return this.flush();
  }
}
