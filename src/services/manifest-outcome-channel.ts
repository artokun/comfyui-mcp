/**
 * Cross-process handoff for apply_manifest's outstanding custom-node outcome.
 *
 * apply_manifest normally runs in a panel agent's stdio child while
 * panel_node_queue_status runs in the orchestrator. The old process-local
 * manifest-partial record therefore could never reach the queue-status reader.
 * This channel uses the already nonce-scoped, mode-0700 progress directory,
 * but adds a per-child HMAC so a stray file or an untrusted payload cannot turn
 * into an annotation. Writes are atomic: readers see either the previous
 * complete record or the next complete record, never a partial JSON document.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ManifestPartialInstall } from "./manifest-partial.js";

export const MANIFEST_OUTCOME_CHANNEL_VERSION = 1 as const;
export const MANIFEST_OUTCOME_TTL_MS = 6 * 60 * 60 * 1000;

const FILE_PREFIX = "cmcp-manifest-outcome-";
const MAX_RECORD_BYTES = 128 * 1024;
const MAX_SCOPE_LENGTH = 512;
const MAX_TARGET_LENGTH = 2048;
const MAX_SOURCE_LENGTH = 1024;
const MAX_MESSAGE_LENGTH = 16 * 1024;
const MAX_ITEM_LENGTH = 1024;
const MAX_ITEMS = 512;

export interface ManifestOutcomeEnvelope {
  version: typeof MANIFEST_OUTCOME_CHANNEL_VERSION;
  scope: string;
  target: string;
  updated: number;
  partial: ManifestPartialInstall | null;
  signature: string;
}

interface ReaderConfig {
  dir: string;
  secrets: () => Iterable<string>;
}

let readerConfig: ReaderConfig | undefined;
let writeSequence = 0;

/** Configure the orchestrator-side reader. The callback keeps the secret set
 * live as new agent sessions are spawned, without exposing secrets to a file. */
export function configureManifestOutcomeReader(
  dir: string,
  secrets: () => Iterable<string>,
): void {
  readerConfig = { dir: dir.trim(), secrets };
}

function configuredWriterDir(): string {
  return process.env.COMFYUI_MCP_PROGRESS_DIR?.trim() ?? "";
}

function configuredWriterSecret(): string {
  return process.env.COMFYUI_MCP_MANIFEST_OUTCOME_SECRET?.trim() ?? "";
}

function configuredWriterScope(): string {
  return process.env.COMFYUI_MCP_TAB?.trim() || `stdio:${process.pid}`;
}

/** Keep only the identity-bearing URL components. Query strings may contain
 * credentials and are not part of the ComfyUI target identity. */
export function canonicalManifestOutcomeTarget(input: string): string | null {
  if (typeof input !== "string" || input.length === 0 || input.length > MAX_TARGET_LENGTH) {
    return null;
  }
  try {
    const url = new URL(input);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.protocol}//${url.host}${path}`;
  } catch {
    return null;
  }
}

function validStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_ITEMS &&
    value.every((item) => typeof item === "string" && item.length <= MAX_ITEM_LENGTH)
  );
}

function validPartial(value: unknown): value is ManifestPartialInstall {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const partial = value as Record<string, unknown>;
  if (
    partial.kind !== "custom_nodes_not_started" ||
    typeof partial.source !== "string" ||
    partial.source.length > MAX_SOURCE_LENGTH ||
    typeof partial.message !== "string" ||
    partial.message.length > MAX_MESSAGE_LENGTH ||
    !validStringArray(partial.not_started) ||
    !validStringArray(partial.still_installing)
  ) {
    return false;
  }
  for (const key of ["outcome_unknown", "local_fallback", "local_fallback_failed"] as const) {
    if (partial[key] !== undefined && !validStringArray(partial[key])) return false;
  }
  const stillInstalling = partial.still_installing as string[];
  const outcomeUnknown = partial.outcome_unknown as string[] | undefined;
  const localFallback = partial.local_fallback as string[] | undefined;
  return (
    (outcomeUnknown ?? []).every((id) => stillInstalling.includes(id)) &&
    (localFallback ?? []).every((id) => stillInstalling.includes(id))
  );
}

function payloadFor(envelope: Omit<ManifestOutcomeEnvelope, "signature">): string {
  return JSON.stringify({
    version: envelope.version,
    scope: envelope.scope,
    target: envelope.target,
    updated: envelope.updated,
    partial: envelope.partial,
  });
}

function signatureFor(payload: string, secret: string): string {
  return createHmac("sha256", secret).update(payload).digest("hex");
}

function fileFor(dir: string, secret: string): string {
  const key = createHash("sha256").update(secret).digest("hex").slice(0, 32);
  return join(dir, `${FILE_PREFIX}${key}.json`);
}

function copyPartial(partial: ManifestPartialInstall | null): ManifestPartialInstall | null {
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

/** Publish from the stdio child, or from a test that supplies explicit seams. */
export function publishManifestOutcome(
  partial: ManifestPartialInstall | null,
  options: {
    dir?: string;
    secret?: string;
    scope?: string;
    target?: string;
  } = {},
): boolean {
  const dir = options.dir?.trim() ?? configuredWriterDir();
  const secret = options.secret?.trim() ?? configuredWriterSecret();
  const scope = options.scope?.trim() ?? configuredWriterScope();
  const target = canonicalManifestOutcomeTarget(
    options.target?.trim() || process.env.COMFYUI_URL?.trim() || "",
  );
  if (!dir || !secret || !scope || scope.length > MAX_SCOPE_LENGTH || !target) return false;
  if (partial !== null && !validPartial(partial)) return false;

  const envelopeWithoutSignature = {
    version: MANIFEST_OUTCOME_CHANNEL_VERSION,
    scope,
    target,
    updated: Date.now(),
    partial: copyPartial(partial),
  } satisfies Omit<ManifestOutcomeEnvelope, "signature">;
  const envelope: ManifestOutcomeEnvelope = {
    ...envelopeWithoutSignature,
    signature: signatureFor(payloadFor(envelopeWithoutSignature), secret),
  };
  const finalPath = fileFor(dir, secret);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (partial === null) {
      rmSync(finalPath, { force: true });
      return true;
    }
    const tempPath = `${finalPath}.${process.pid}-${writeSequence++}.tmp`;
    writeFileSync(tempPath, JSON.stringify(envelope));
    try {
      renameSync(tempPath, finalPath);
      return true;
    } catch {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        /* ignore a stray .tmp; readers only inspect .json */
      }
      return false;
    }
  } catch {
    return false;
  }
}

function parseEnvelope(raw: unknown, secret: string): ManifestOutcomeEnvelope | null {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
  const envelope = raw as Partial<ManifestOutcomeEnvelope>;
  if (
    envelope.version !== MANIFEST_OUTCOME_CHANNEL_VERSION ||
    typeof envelope.scope !== "string" ||
    envelope.scope.length === 0 ||
    envelope.scope.length > MAX_SCOPE_LENGTH ||
    typeof envelope.target !== "string" ||
    typeof envelope.updated !== "number" ||
    !Number.isFinite(envelope.updated) ||
    typeof envelope.signature !== "string" ||
    !/^[a-f0-9]{64}$/.test(envelope.signature) ||
    (envelope.partial !== null && !validPartial(envelope.partial))
  ) {
    return null;
  }
  const target = canonicalManifestOutcomeTarget(envelope.target);
  if (!target || target !== envelope.target) return null;
  const unsigned = {
    version: envelope.version,
    scope: envelope.scope,
    target: envelope.target,
    updated: envelope.updated,
    partial: copyPartial(envelope.partial ?? null),
  } satisfies Omit<ManifestOutcomeEnvelope, "signature">;
  const expected = Buffer.from(signatureFor(payloadFor(unsigned), secret), "hex");
  const actual = Buffer.from(envelope.signature, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  return {
    ...unsigned,
    signature: envelope.signature,
  };
}

/** Read only records authenticated by the orchestrator and bound to its
 * current target. Invalid, stale, or foreign-target records are ignored. */
export function readPublishedManifestOutcomes(target: string): ManifestPartialInstall[] {
  const cfg = readerConfig;
  const expectedTarget = canonicalManifestOutcomeTarget(target);
  if (!cfg?.dir || !expectedTarget) return [];
  let files: string[];
  try {
    files = readdirSync(cfg.dir).filter(
      (name) => name.startsWith(FILE_PREFIX) && name.endsWith(".json"),
    );
  } catch {
    return [];
  }

  const secrets = [...cfg.secrets()].filter((secret) => typeof secret === "string" && secret.length > 0);
  const out: Array<{ updated: number; partial: ManifestPartialInstall }> = [];
  for (const name of files.slice(0, 128)) {
    let text: string;
    try {
      const path = join(cfg.dir, name);
      const stat = readFileSync(path, "utf8");
      if (Buffer.byteLength(stat, "utf8") > MAX_RECORD_BYTES) continue;
      text = stat;
    } catch {
      continue;
    }
    let raw: unknown;
    try {
      raw = JSON.parse(text);
    } catch {
      continue;
    }
    for (const secret of secrets) {
      const envelope = parseEnvelope(raw, secret);
      if (!envelope || envelope.target !== expectedTarget) continue;
      if (Date.now() - envelope.updated > MANIFEST_OUTCOME_TTL_MS) {
        try {
          rmSync(join(cfg.dir, name), { force: true });
        } catch {
          /* stale cleanup is best-effort */
        }
        break;
      }
      if (envelope.partial) out.push({ updated: envelope.updated, partial: envelope.partial });
      break;
    }
  }
  out.sort((a, b) => b.updated - a.updated);
  const seen = new Set<string>();
  return out.flatMap(({ partial }) => {
    const key = JSON.stringify(partial);
    if (seen.has(key)) return [];
    seen.add(key);
    return [copyPartial(partial)!];
  });
}

/** Test seam for isolated channel tests. */
export function resetManifestOutcomeReader(): void {
  readerConfig = undefined;
}
