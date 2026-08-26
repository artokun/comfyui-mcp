import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { logger } from "../utils/logger.js";
import { writeFileDurable } from "../utils/durable-write.js";
import type { CompletionPayload } from "./run-completion-journal.js";

/** A prompt id is already bounded by the panel protocol; keep the disk key bounded too. */
const MAX_ID_LENGTH = 512;

/** A restarted orchestrator must remember a completion long enough to outlive reconnect churn. */
export const DEFAULT_COMPLETION_FENCE_TTL_MS = 6 * 60 * 60_000;

/** Bound the persisted map even if a panel manufactures many distinct prompt ids. */
export const DEFAULT_COMPLETION_FENCE_MAX_ENTRIES = 2048;

type FenceState = "seen" | "accepted" | "delivered";

export type CompletionFenceClaim = "claimed" | "duplicate" | "unavailable";

type FenceEntry = {
  state: FenceState;
  at: number;
};

type FenceFile = {
  version: 1;
  entries: Record<string, FenceEntry>;
};

export type CompletionFenceOptions = {
  path?: string;
  now?: () => number;
  ttlMs?: number;
  maxEntries?: number;
};

function usable(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_ID_LENGTH;
}

/**
 * Stable scheduling identity for a panel completion.
 *
 * The route/session is deliberately outside the panel tab id: a stale frontend
 * reconnect gets a new tab address, but it is still the same agent conversation.
 * A panel completion key is the only identity durable across orchestrator
 * restarts. Journal ticket generations are process-local, so prompt_id alone is
 * never a fence key here.
 */
export function completionFenceIdentity(
  route: string,
  payload: Pick<CompletionPayload, "prompt_id" | "completion_key">,
): string | null {
  const routeId = typeof route === "string" ? route.trim() : "";
  if (!routeId || routeId.length > MAX_ID_LENGTH) return null;
  if (usable(payload.completion_key)) {
    return JSON.stringify(["panel_run", routeId, "completion_key", payload.completion_key]);
  }
  return null;
}

function defaultFencePath(): string {
  return join(homedir(), ".comfyui-mcp", "run-completion-fence.json");
}

function validEntry(value: unknown): value is FenceEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as Partial<FenceEntry>;
  return (
    (entry.state === "seen" || entry.state === "accepted" || entry.state === "delivered") &&
    typeof entry.at === "number" &&
    Number.isFinite(entry.at) &&
    entry.at >= 0
  );
}

/**
 * Small, synchronous, atomic fence used immediately around agent scheduling.
 *
 * `seen` is written before the queue hand-off; `accepted` is written after the
 * manager accepts the event; `delivered` is written only from the journal's
 * actual turn-ack hook. `accepted` is process-local suppression only: a fresh
 * fence instance treats a persisted `accepted` or `seen` entry as reclaimable,
 * so a restart cannot lose a completion that was queued but never read.
 */
export class RunCompletionIdempotencyFence {
  private readonly filePath: string;
  private readonly now: () => number;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private entries = new Map<string, FenceEntry>();
  /** Reservations accepted by THIS orchestrator, but not yet turn-acked. */
  private readonly active = new Set<string>();

  constructor(options: CompletionFenceOptions = {}) {
    this.filePath = options.path ?? defaultFencePath();
    this.now = options.now ?? Date.now;
    this.ttlMs = Math.max(1, options.ttlMs ?? DEFAULT_COMPLETION_FENCE_TTL_MS);
    this.maxEntries = Math.max(1, Math.floor(options.maxEntries ?? DEFAULT_COMPLETION_FENCE_MAX_ENTRIES));
    this.load();
  }

  /** Claim an identity before creating a new agent turn. */
  claim(identity: string): boolean {
    return this.claimResult(identity) === "claimed";
  }

  /** Distinguish a duplicate from a failed durability write. */
  claimResult(identity: string): CompletionFenceClaim {
    if (!identity) return "unavailable";
    const now = this.now();
    const previous = new Map(this.entries);
    this.prune(now);
    const existing = this.entries.get(identity);
    if (existing?.state === "delivered" && now - existing.at < this.ttlMs) {
      return "duplicate";
    }
    if (this.active.has(identity)) return "duplicate";
    this.entries.set(identity, { state: "seen", at: now });
    this.trim();
    if (this.persist()) {
      this.active.add(identity);
      return "claimed";
    }
    this.entries = previous;
    return "unavailable";
  }

  /** Mark a successfully accepted queue hand-off, without claiming it was read. */
  markAccepted(identity: string): boolean {
    const entry = this.entries.get(identity);
    if (!entry) return false;
    const previous = entry.state;
    entry.state = "accepted";
    if (this.persist()) return true;
    // The pre-injection `seen` write is still durable. Keep the local active
    // reservation so a same-process stale frame cannot mint another turn; a
    // restart will reclaim the persisted seen entry.
    entry.state = previous;
    return false;
  }

  /** Mark a queue hand-off delivered only after the agent turn actually acks it. */
  markDelivered(identity: string): boolean {
    const entry = this.entries.get(identity);
    if (!entry) return false;
    const previous = entry.state;
    entry.state = "delivered";
    if (this.persist()) {
      this.active.delete(identity);
      return true;
    }
    // Keep the already-written accepted/seen fence if the second write fails.
    // It remains process-local suppression, while a restart can reclaim it.
    entry.state = previous;
    return false;
  }

  /** Remove a reservation when the manager refused the hand-off. */
  release(identity: string): boolean {
    if (!this.entries.has(identity)) {
      this.active.delete(identity);
      return true;
    }
    const previous = this.entries;
    this.entries = new Map(previous);
    this.entries.delete(identity);
    if (this.persist()) {
      this.active.delete(identity);
      return true;
    }
    this.entries = previous;
    // Let a later retry re-attempt the durable release/claim. Keeping the
    // in-memory reservation here would turn a persistence failure into a
    // permanent same-process refusal.
    this.active.delete(identity);
    return false;
  }

  /** Test/diagnostic seam. */
  state(identity: string): FenceState | undefined {
    return this.entries.get(identity)?.state;
  }

  private load(): void {
    if (!existsSync(this.filePath)) return;
    try {
      const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as Partial<FenceFile>;
      if (parsed.version !== 1 || !parsed.entries || typeof parsed.entries !== "object") return;
      const loaded = Object.entries(parsed.entries)
        .filter(([, value]) => validEntry(value))
        .sort(([, a], [, b]) => a.at - b.at);
      for (const [identity, entry] of loaded) this.entries.set(identity, entry);
      const before = this.entries.size;
      this.prune(this.now());
      if (this.entries.size !== before) this.persist();
    } catch (error) {
      logger.warn(`[run-completion-fence] ignoring unreadable fence ${this.filePath}: ${String(error)}`);
      this.entries.clear();
    }
  }

  private prune(now: number): void {
    for (const [identity, entry] of this.entries) {
      if (now - entry.at >= this.ttlMs || now < entry.at) {
        this.entries.delete(identity);
        this.active.delete(identity);
      }
    }
    this.trim();
  }

  private trim(): void {
    while (this.entries.size > this.maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
      this.active.delete(oldest);
    }
  }

  private persist(): boolean {
    try {
      mkdirSync(dirname(this.filePath), { recursive: true });
      const file: FenceFile = { version: 1, entries: Object.fromEntries(this.entries) };
      writeFileDurable(this.filePath, JSON.stringify(file) + "\n");
      return true;
    } catch (error) {
      logger.warn(`[run-completion-fence] could not persist ${this.filePath}: ${String(error)}`);
      return false;
    }
  }
}

export type ScheduleCompletionOptions = {
  route: string;
  payload: CompletionPayload;
  token: string;
  fence: RunCompletionIdempotencyFence;
  inject: () => boolean;
  /** Bind the fence identity to the journal token until the real turn ack. */
  onAccepted?: (identity: string) => void;
  suppress: (token: string) => void;
  log?: (message: string) => void;
};

/**
 * The one scheduling gate for recovered and live `panel_run` completions.
 * Returning true for a suppressed entry tells the journal that the queue offer
 * was handled; `suppress` removes the duplicate, so it cannot be retried into a
 * new turn on every reconnect.
 */
export function scheduleRunCompletion(options: ScheduleCompletionOptions): boolean {
  const identity = completionFenceIdentity(options.route, options.payload);
  if (!identity) {
    return options.inject();
  }
  const claim = options.fence.claimResult(identity);
  if (claim === "unavailable") return false;
  if (claim === "duplicate") {
    options.suppress(options.token);
    options.log?.(
      options.payload.possible_repeat === true
        ? `suppressed a POSSIBLE_REPEAT with a durable delivered fence for ${identity}`
        : `suppressed a replay for ${identity}`,
    );
    return true;
  }
  const handedOff = options.inject();
  if (handedOff) {
    options.fence.markAccepted(identity);
    options.onAccepted?.(identity);
  } else {
    options.fence.release(identity);
  }
  return handedOff;
}
