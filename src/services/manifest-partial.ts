/**
 * #1699 — leftover custom_node entries apply_manifest never submitted.
 *
 * The ComfyUI-Manager queue only knows about tasks it was given. When
 * apply_manifest's time budget expires, later custom_nodes are reported
 * "pending" / "not started" and are NEVER enqueued; an accepted-but-ambiguous
 * operation can also remain unresolved. panel_node_queue_status then reports a
 * drained queue (total_count: 0, is_processing: false) which agents read as
 * "all installs finished". This module is the fast process-local record of
 * both unsubmitted and unresolved names. Panel-spawned children also publish
 * the same record through manifest-outcome-channel.ts so apply_manifest and
 * panel_node_queue_status share one source of truth across their process
 * boundary.
 */

import { randomUUID } from "node:crypto";
import {
  canonicalManifestOutcomeTarget,
  publishManifestOutcome,
} from "./manifest-outcome-channel.js";

export interface ManifestPartialInstall {
  kind: "custom_nodes_not_started";
  /** Human label for THIS apply (pack name, path, or "this inline manifest"). */
  source: string;
  /** custom_node ids that were never submitted to ComfyUI-Manager. */
  not_started: string[];
  /** custom_node ids submitted but unresolved when the budget elapsed. */
  still_installing: string[];
  /**
   * A subset of still_installing whose install promise did not settle before
   * apply_manifest returned. No Manager or local-fallback outcome is known for
   * these entries, so neither queue state nor local cloning is authorized by
   * this result.
   */
  outcome_unknown?: string[];
  /** Entries whose local direct-install fallback was selected after a timeout. */
  local_fallback?: string[];
  /** Entries whose late local direct-install fallback finished unsuccessfully. */
  local_fallback_failed?: string[];
  message: string;
}

export interface ManifestPartialOperationBinding {
  readonly operationId: string;
  readonly itemId: string;
  readonly scope: string;
  readonly target: string;
  readonly targetGeneration: number;
}

type FallbackPhase = "selected" | "applied" | "failed";

interface OperationState {
  readonly operationId: string;
  readonly source: string;
  readonly scope: string;
  readonly target: string;
  readonly targetGeneration: number;
  readonly itemBindings: Map<string, ManifestPartialOperationBinding>;
  readonly fallbackPhases: Map<string, FallbackPhase>;
  basePartial: ManifestPartialInstall | null;
  partial: ManifestPartialInstall | null;
  updated: number;
}

/** A single apply_manifest operation and its immutable target identity. */
export interface ManifestPartialOperation {
  readonly operationId: string;
  readonly scope: string;
  readonly target: string;
  readonly targetGeneration: number;
  bindItem(itemId: string): ManifestPartialOperationBinding;
  /** Record the current aggregate. Any fallback phase observed earlier is merged. */
  record(partial: ManifestPartialInstall | null): ManifestPartialInstall | null;
  /** Ignore callbacks that do not belong to this exact operation and target. */
  reconcile(binding: ManifestPartialOperationBinding, state: FallbackPhase): boolean;
  clear(): void;
}

const operations = new Map<string, OperationState>();
let legacyOperation: ManifestPartialOperation | undefined;

function clonePartial(partial: ManifestPartialInstall | null): ManifestPartialInstall | null {
  if (!partial) return null;
  return {
    ...partial,
    not_started: [...partial.not_started],
    still_installing: [...partial.still_installing],
    ...(partial.outcome_unknown ? { outcome_unknown: [...partial.outcome_unknown] } : {}),
    ...(partial.local_fallback ? { local_fallback: [...partial.local_fallback] } : {}),
    ...(partial.local_fallback_failed
      ? { local_fallback_failed: [...partial.local_fallback_failed] }
      : {}),
  };
}

function normalizePartial(partial: ManifestPartialInstall | null): ManifestPartialInstall | null {
  const copy = clonePartial(partial);
  if (!copy) return null;
  if (
    copy.not_started.length === 0 &&
    copy.still_installing.length === 0 &&
    (copy.outcome_unknown?.length ?? 0) === 0 &&
    (copy.local_fallback?.length ?? 0) === 0 &&
    (copy.local_fallback_failed?.length ?? 0) === 0
  ) {
    return null;
  }
  if (!copy.outcome_unknown?.length) delete copy.outcome_unknown;
  if (!copy.local_fallback?.length) delete copy.local_fallback;
  if (!copy.local_fallback_failed?.length) delete copy.local_fallback_failed;
  return copy;
}

function without(items: string[] | undefined, id: string): string[] {
  return (items ?? []).filter((item) => item !== id);
}

function withItem(items: string[] | undefined, id: string): string[] {
  return items?.includes(id) ? [...items] : [...(items ?? []), id];
}

function phaseIds(state: OperationState, phase: FallbackPhase): string[] {
  return [...state.fallbackPhases.entries()]
    .filter(([, value]) => value === phase)
    .map(([id]) => id);
}

function syntheticPartial(state: OperationState): ManifestPartialInstall | null {
  const selected = phaseIds(state, "selected");
  const failed = phaseIds(state, "failed");
  if (selected.length === 0 && failed.length === 0) return null;
  return {
    kind: "custom_nodes_not_started",
    source: state.source,
    not_started: [],
    still_installing: selected,
    ...(selected.length ? { local_fallback: selected } : {}),
    ...(failed.length ? { local_fallback_failed: failed } : {}),
    message:
      `PARTIAL INSTALL of ${state.source}: a local direct-install fallback was selected ` +
      `after the Manager outcome became unresolved. Do not use Manager queue status or ` +
      `re-issue the node; wait for the fallback to settle and verify custom_nodes.`,
  };
}

function augmentedPartial(state: OperationState): ManifestPartialInstall | null {
  const base = normalizePartial(state.basePartial) ?? syntheticPartial(state);
  if (!base) return null;
  let partial = base;
  for (const [id, phase] of state.fallbackPhases) {
    if (phase === "selected") {
      partial = {
        ...partial,
        still_installing: withItem(partial.still_installing, id),
        outcome_unknown: without(partial.outcome_unknown, id),
        local_fallback: withItem(partial.local_fallback, id),
        local_fallback_failed: without(partial.local_fallback_failed, id),
        message:
          `${partial.message} Reconciliation: the earlier UNKNOWN outcome has now selected ` +
          `a local direct-install fallback for "${id}". It is in progress; do not use ` +
          `Manager queue status or re-issue the node while it runs.`,
      };
    } else if (phase === "applied") {
      partial = {
        ...partial,
        still_installing: without(partial.still_installing, id),
        outcome_unknown: without(partial.outcome_unknown, id),
        local_fallback: without(partial.local_fallback, id),
        local_fallback_failed: without(partial.local_fallback_failed, id),
        message:
          `${partial.message} Reconciliation: the local fallback for "${id}" completed; ` +
          `the entry is no longer unresolved.`,
      };
    } else {
      partial = {
        ...partial,
        still_installing: without(partial.still_installing, id),
        outcome_unknown: without(partial.outcome_unknown, id),
        local_fallback: without(partial.local_fallback, id),
        local_fallback_failed: withItem(partial.local_fallback_failed, id),
        message:
          `${partial.message} Reconciliation: the local direct-install fallback for "${id}" ` +
          `finished unsuccessfully. Inspect the filesystem/error before retrying.`,
      };
    }
  }
  return normalizePartial(partial);
}

function publishOperation(state: OperationState): void {
  publishManifestOutcome(state.partial, {
    operationId: state.operationId,
    scope: state.scope,
    target: state.target,
    targetGeneration: state.targetGeneration,
  });
}

function supersedePriorOperation(state: OperationState): void {
  for (const prior of [...operations.values()]) {
    if (
      prior === state ||
      prior.scope !== state.scope ||
      prior.target !== state.target ||
      prior.source !== state.source
    ) {
      continue;
    }
    operations.delete(prior.operationId);
    publishManifestOutcome(null, {
      operationId: prior.operationId,
      scope: prior.scope,
      target: prior.target,
      targetGeneration: prior.targetGeneration,
    });
  }
}

function operationHandle(state: OperationState): ManifestPartialOperation {
  const handle: ManifestPartialOperation = {
    operationId: state.operationId,
    scope: state.scope,
    target: state.target,
    targetGeneration: state.targetGeneration,
    bindItem(itemId: string): ManifestPartialOperationBinding {
      const normalized = itemId.trim();
      const existing = state.itemBindings.get(normalized);
      if (existing) return existing;
      const binding = Object.freeze({
        operationId: state.operationId,
        itemId: normalized,
        scope: state.scope,
        target: state.target,
        targetGeneration: state.targetGeneration,
      });
      state.itemBindings.set(normalized, binding);
      return binding;
    },
    record(partial: ManifestPartialInstall | null): ManifestPartialInstall | null {
      if (operations.get(state.operationId) !== state) return null;
      // Preserve the historical "this apply replaces the previous partial"
      // behavior, but do it by operation identity. Any callback from a prior
      // apply now fails its binding check rather than changing this aggregate.
      supersedePriorOperation(state);
      state.basePartial = normalizePartial(partial);
      state.partial = augmentedPartial(state);
      state.updated = Date.now();
      publishOperation(state);
      return clonePartial(state.partial);
    },
    reconcile(binding: ManifestPartialOperationBinding, phase: FallbackPhase): boolean {
      if (operations.get(state.operationId) !== state) return false;
      const expected = state.itemBindings.get(binding.itemId);
      if (
        binding !== expected ||
        !expected ||
        expected.operationId !== binding.operationId ||
        expected.scope !== binding.scope ||
        expected.target !== binding.target ||
        expected.targetGeneration !== binding.targetGeneration
      ) {
        return false;
      }
      state.fallbackPhases.set(binding.itemId, phase);
      state.partial = augmentedPartial(state);
      state.updated = Date.now();
      // A callback may arrive before the final aggregate is recorded. Keep the
      // phase in the operation state, but do not publish a null/empty record that
      // could clear another observation from this process.
      if (state.basePartial !== null || state.partial !== null) publishOperation(state);
      return true;
    },
    clear(): void {
      if (operations.get(state.operationId) === state) operations.delete(state.operationId);
      publishManifestOutcome(null, {
        operationId: state.operationId,
        scope: state.scope,
        target: state.target,
        targetGeneration: state.targetGeneration,
      });
    },
  };
  return handle;
}

export function createManifestPartialOperation(opts: {
  operationId?: string;
  source: string;
  scope: string;
  target: string;
  targetGeneration: number;
}): ManifestPartialOperation {
  const operationId = opts.operationId?.trim() || randomUUID();
  const target = canonicalManifestOutcomeTarget(opts.target.trim()) ?? "";
  const state: OperationState = {
    operationId,
    source: opts.source,
    scope: opts.scope.trim(),
    target,
    targetGeneration: opts.targetGeneration,
    itemBindings: new Map(),
    fallbackPhases: new Map(),
    basePartial: null,
    partial: null,
    updated: Date.now(),
  };
  operations.set(operationId, state);
  return operationHandle(state);
}

/** Read only operation records bound to this exact scope and target. */
export function readManifestPartials(
  target: string,
  scope: string,
  targetGeneration: number,
): ManifestPartialInstall[] {
  const expectedTarget = canonicalManifestOutcomeTarget(target.trim());
  const expectedScope = scope.trim();
  if (!expectedTarget || !expectedScope || !Number.isSafeInteger(targetGeneration) || targetGeneration < 0) {
    return [];
  }
  return [...operations.values()]
    .filter(
      (state) =>
        state.target === expectedTarget &&
        state.scope === expectedScope &&
        state.targetGeneration === targetGeneration &&
        state.partial !== null,
    )
    .sort((a, b) => b.updated - a.updated)
    .map((state) => clonePartial(state.partial)!)
    .filter((partial, index, all) => {
      const key = JSON.stringify(partial);
      return all.findIndex((candidate) => JSON.stringify(candidate) === key) === index;
    });
}

/** Compatibility seam retained for existing local callers and tests. */
export function recordManifestPartial(
  partial: ManifestPartialInstall | null,
  options: { target?: string; scope?: string; operationId?: string; targetGeneration?: number } = {},
): void {
  const target = options.target ?? process.env.COMFYUI_URL?.trim() ?? "";
  const scope = options.scope ?? process.env.COMFYUI_MCP_TAB?.trim() ?? `legacy:${process.pid}`;
  if (
    !legacyOperation ||
    legacyOperation.target !== (canonicalManifestOutcomeTarget(target) ?? "") ||
    legacyOperation.scope !== scope.trim()
  ) {
    legacyOperation = createManifestPartialOperation({
      operationId: options.operationId ?? "legacy",
      source: partial?.source ?? "this inline manifest",
      scope,
      target,
      targetGeneration: options.targetGeneration ?? 0,
    });
  }
  legacyOperation.record(partial);
}

export function getManifestPartialLeftover(): ManifestPartialInstall | null {
  return [...operations.values()]
    .sort((a, b) => b.updated - a.updated)
    .map((state) => clonePartial(state.partial))
    .find((partial): partial is ManifestPartialInstall => partial !== null) ?? null;
}

/** Test seam — remove every operation-local record, including its child files. */
export function clearManifestPartialLeftover(): void {
  for (const state of operations.values()) {
    publishManifestOutcome(null, {
      operationId: state.operationId,
      scope: state.scope,
      target: state.target,
      targetGeneration: state.targetGeneration,
    });
  }
  operations.clear();
  legacyOperation = undefined;
}

export function describeManifestSource(opts: {
  pack?: string;
  path?: string;
}): string {
  const pack = opts.pack?.trim();
  if (pack) return `pack "${pack}"`;
  const path = opts.path?.trim();
  if (path) return `path "${path}"`;
  return "this inline manifest";
}

export function formatNotStartedMessage(item: string): string {
  return (
    `PARTIAL INSTALL — "${item}" was NOT STARTED and was NEVER submitted to the ` +
    `ComfyUI-Manager queue. The apply_manifest time budget elapsed while earlier ` +
    `packs were still installing. A drained panel_node_queue_status is NOT ` +
    `completion of this entry (the queue cannot include work it was never given) ` +
    `and is NOT a reason to restart ComfyUI. Re-run apply_manifest with the same ` +
    `pack/path/manifest to submit the remaining unsubmitted custom_node entries.`
  );
}

export function formatStillInstallingMessage(
  opts: { outcomeUnknown?: boolean } = {},
): string {
  if (opts.outcomeUnknown) {
    return (
      "Install outcome is UNKNOWN because the apply_manifest time budget elapsed before " +
      "the Manager operation settled. It may still be running on the ComfyUI-Manager " +
      "queue, or it may later settle to a result that does not authorize cloning. No " +
      "local direct-install fallback is authorized from this unresolved result. This " +
      "is NOT a failure and must not be re-issued. Do not use Manager queue status alone " +
      "to decide completion; verify the custom_nodes directory after the operation " +
      "settles."
    );
  }
  return (
    "Still installing on the ComfyUI-Manager queue when the apply_manifest time " +
    "budget elapsed. This is NOT a failure — the install continues server-side. " +
    "Poll panel_node_queue_status for THIS entry only. Do not treat a drained " +
    "queue as proof that later unsubmitted entries installed, and do not re-issue " +
    "this node."
  );
}

export function formatLocalFallbackMessage(): string {
  return (
    "A local direct-install fallback is still in progress in this MCP process when the " +
    "apply_manifest time budget elapsed. This is NOT queued server-side work and is NOT " +
    "on the ComfyUI-Manager queue. Do not use Manager queue status to track this local " +
    "work or re-issue this node while the fallback is running; verify the custom_nodes " +
    "directory after it finishes."
  );
}

export function buildManifestPartial(opts: {
  source: string;
  notStarted: string[];
  stillInstalling: string[];
  outcomeUnknown?: string[];
}): ManifestPartialInstall | null {
  const outcomeUnknown = (opts.outcomeUnknown ?? []).filter((id) =>
    opts.stillInstalling.includes(id),
  );
  if (opts.notStarted.length === 0 && opts.stillInstalling.length === 0) return null;
  const names = opts.notStarted.join(", ");
  const still = opts.stillInstalling.length
    ? outcomeUnknown.length
      ? ` Still unresolved: ${opts.stillInstalling.join(", ")}. For ${outcomeUnknown.join(", ")}, ` +
        `the install outcome is UNKNOWN and no local direct-install fallback is ` +
        `authorized from this result; do not use queue status alone to decide completion.`
      : ` Still installing (ON the queue, pollable): ${opts.stillInstalling.join(", ")}.`
    : "";
  const n = opts.notStarted.length;
  const unsubmitted =
    n > 0
      ? `${n} custom_node ${n === 1 ? "entry was" : "entries were"} NEVER submitted to ` +
        `ComfyUI-Manager (${names}). panel_node_queue_status going idle does NOT ` +
        `mean they installed — they are not on that queue. Do not restart ComfyUI ` +
        `yet. Re-run apply_manifest with the same pack/path/manifest to submit the ` +
        `remaining entries.`
      : `No custom_node entries were left unsubmitted, but the submitted entries ` +
        `below remain unresolved; panel_node_queue_status going idle does NOT prove ` +
        `this apply_manifest completed.`;
  return {
    kind: "custom_nodes_not_started",
    source: opts.source,
    not_started: [...opts.notStarted],
    still_installing: [...opts.stillInstalling],
    ...(outcomeUnknown.length ? { outcome_unknown: [...outcomeUnknown] } : {}),
    message:
      `PARTIAL INSTALL of ${opts.source}: ${unsubmitted}` +
      still,
  };
}

export function formatQueueStatusPartialNote(partial: ManifestPartialInstall): string {
  const unsubmitted = partial.not_started.length
    ? `apply_manifest of ${partial.source} never submitted: ${partial.not_started.join(", ")}. ` +
      `Those entries are NOT on the ComfyUI-Manager queue, so this status cannot ` +
      `account for them. Re-run apply_manifest to submit the remaining custom_nodes.`
    : "No entries were left unsubmitted, but submitted entries remain unresolved.";
  const unresolved = partial.still_installing.length
    ? ` Unresolved submitted entries: ${partial.still_installing.join(", ")}.` +
      (partial.outcome_unknown?.length
        ? ` For ${partial.outcome_unknown.join(", ")}, the install outcome is UNKNOWN; ` +
          `no local direct-install fallback is authorized and queue idle is not proof ` +
          `of completion. Verify the custom_nodes directory before reissuing.`
        : " Do not treat queue idle as proof that this apply_manifest completed.")
      : "";
  const local = partial.local_fallback?.length
    ? ` Local direct-install fallback is in progress for ${partial.local_fallback.join(", ")}. ` +
      `This work is NOT on the Manager queue; wait for it to settle and do not re-issue it.`
    : "";
  const failed = partial.local_fallback_failed?.length
    ? ` Local direct-install fallback failed for ${partial.local_fallback_failed.join(", ")}. ` +
      `Queue status cannot determine that result; inspect the install error before retrying.`
    : "";
  return `WARNING — PARTIAL INSTALL, QUEUE DRAIN IS NOT COMPLETION. ${unsubmitted}${unresolved}${local}${failed}`;
}
