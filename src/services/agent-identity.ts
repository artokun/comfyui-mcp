// Cross-process AGENT IDENTITY channel — WHICH LLM is driving the panel agent.
//
// A bug report filed from the panel is written by whichever model the user has
// selected in the provider/model chips: Claude Opus, a hosted Kimi, a local
// gemma. Report QUALITY tracks that choice, so a report that does not name the
// model cannot be judged — a thin, wrong or hallucinated issue looks exactly
// like a careful one until you know what wrote it.
//
// It CANNOT be self-reported. Asking a model which model it is returns a guess
// (they routinely name a sibling, or the model they were distilled from), and
// the agent's ENVIRONMENT block never carried the model at all — only
// `Backend:`. So the ORCHESTRATOR, which owns the chips and therefore the fact,
// publishes it, and report_issue reads it back.
//
// The transport is the one download-progress.ts already established, with the
// direction reversed: that channel is the comfyui MCP subprocess writing rows
// for the orchestrator to read; this one is the orchestrator writing a single
// small JSON for the subprocess to read. No socket, no new HTTP surface, and —
// like that channel — it no-ops entirely when the env var is unset, i.e. for
// every non-panel use of the MCP (plain stdio, CLI, tests).
//
// WHY A FILE AND NOT THE SPAWN ENV: the model is live-switchable. `setModel`
// deliberately does NOT restart the session (panel-agent.ts), so a value baked
// into the child's env at spawn goes stale the moment the user changes the chip
// — and would then stamp reports with a model that did not write them, which is
// worse than stamping nothing. The orchestrator republishes at every turn
// dispatch instead, so the file always describes the turn that is running.
//
// There is deliberately NO staleness cutoff on a read: the identity is written
// when a turn STARTS, and a turn can legitimately run for an hour before its
// agent files a report. Ageing the file out would drop exactly the long
// sessions most worth attributing.

import { mkdirSync, renameSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Env var naming the identity file for THIS agent's MCP subprocess. Absent for
 *  every non-panel spawn, which is what makes the whole channel opt-in. */
export const AGENT_IDENTITY_ENV = "COMFYUI_MCP_AGENT_IDENTITY";

/** The chips, as facts: what the orchestrator dispatched the current turn with. */
export interface AgentIdentity {
  /** Provider chip — the backend id (`claude`, `codex`, `ollama`, `kimi`, …). */
  backend: string;
  /** Model chip — the model this turn runs on. Absent when the provider exposes
   *  no model selection at all. */
  model?: string;
  /** Effort chip, for the providers that have one. */
  effort?: string;
  /** Epoch ms of the write. Diagnostic only — never used to expire a read. */
  updated?: number;
}

/** Machine-readable marker: the form an analysis pass greps for. */
const STAMP_MARKER = "<!-- reporter-agent:";

/**
 * What a marker becomes when it arrives INSIDE a caller's body — i.e. quoted
 * from some other issue, which is ordinary agent behaviour ("related to #1234,
 * whose body reads: …"). Every stamped issue in the tracker carries the marker
 * as quotable text, so a body that already contains one says nothing about who
 * is filing THIS report.
 *
 * An earlier version treated any marker as proof this body was already stamped
 * and returned it untouched — which filed the report under the QUOTED model's
 * name, in a sentence explicitly vouching that the attribution is mechanical.
 * That is the exact harm this module exists to prevent, arriving through its own
 * guard (fallback merge gate, P1).
 */
const QUOTED_MARKER = "<!-- quoted-reporter-agent:";

/**
 * Where the identity for one agent lives.
 *
 * Keyed by the BRIDGE PORT as well as the agent key for the same reason
 * SessionStore is (session-store.ts): the agent key is `orchestrator::<backend>`
 * and carries no port, so two ComfyUI instances on one machine would otherwise
 * write each other's identity — and a report would name the other instance's
 * model.
 */
export function agentIdentityPath(port: number | string, agentKey: string): string {
  const dir = join(
    process.env.COMFYUI_MCP_DATA_DIR?.trim() || join(homedir(), ".comfyui-mcp"),
    "agents",
  );
  // Agent keys contain `::` and could in principle contain anything else a
  // backend id allows; reduce to a filename-safe token rather than trusting it.
  const safe = agentKey.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80) || "agent";
  return join(dir, `identity-${port}-${safe}.json`);
}

/**
 * Publish the identity for one agent. Best-effort: a failure here must never
 * break a turn — the cost of not writing it is an unstamped report, which is
 * where we were before.
 *
 * Written tmp-then-rename so a reader in the subprocess can never observe a
 * half-written file (Node's rename replaces an existing destination on Windows
 * too, which is where this runs most).
 */
export function publishAgentIdentity(path: string, identity: AgentIdentity): boolean {
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify({ ...identity, updated: Date.now() }), "utf8");
    renameSync(tmp, path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read the published identity, or undefined when there is none to read: no env
 * var (every non-panel spawn), no file yet, unreadable, unparseable, or parsed
 * to something without a backend. Every one of those means "we do not know what
 * model this is", and an unknown must stay unstamped rather than be guessed at.
 */
export function readAgentIdentity(
  path: string | undefined = process.env[AGENT_IDENTITY_ENV],
): AgentIdentity | undefined {
  if (!path) return undefined;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!raw || typeof raw !== "object") return undefined;
    const rec = raw as Record<string, unknown>;
    const backend = typeof rec.backend === "string" ? rec.backend.trim() : "";
    if (!backend) return undefined;
    const str = (v: unknown): string | undefined => {
      const s = typeof v === "string" ? v.trim() : "";
      return s ? s.slice(0, 120) : undefined;
    };
    return {
      backend: backend.slice(0, 60),
      model: str(rec.model),
      effort: str(rec.effort),
      updated: typeof rec.updated === "number" ? rec.updated : undefined,
    };
  } catch {
    return undefined;
  }
}

/** Human form for the report line: `kimi · model kimi-k2-thinking · effort high`. */
export function formatAgentIdentity(identity: AgentIdentity): string {
  const parts = [`**${identity.backend}**`];
  // "model unknown" is stated rather than omitted: a provider that exposes no
  // model chip is a different fact from a report filed before this shipped, and
  // silently dropping the field makes those two read identically.
  parts.push(identity.model ? `model \`${identity.model}\`` : "model _unreported_");
  if (identity.effort) parts.push(`effort \`${identity.effort}\``);
  return parts.join(" · ");
}

/**
 * Append the identity block to an issue body.
 *
 * The wording says who stamped it, because the whole point is that this line is
 * NOT the model's own claim about itself — a reader comparing report quality
 * across models has to be able to trust it the way they trust the version line.
 *
 * ALWAYS appended when the identity is known. There is no "already stamped"
 * shortcut, because nothing in the body can establish that: the only marker a
 * caller's text can carry is one QUOTED from another issue, and skipping on it
 * files the report under someone else's model. The one caller passes the raw
 * argument and forwards the stamped result, so a body cannot reach here twice.
 *
 * A quoted marker is REWRITTEN as it passes through, so exactly one live marker
 * survives and it is this report's — an analysis pass counting `reporter-agent`
 * across the tracker can never read a quotation as a second reporter. The quoted
 * line stays readable; only its machine prefix changes.
 */
export function stampAgentIdentity(body: string, identity: AgentIdentity | undefined): string {
  if (!identity) return body;
  body = body.replaceAll(STAMP_MARKER, QUOTED_MARKER);
  const machine = [
    `backend=${identity.backend}`,
    identity.model ? `model=${identity.model}` : "model=unknown",
    ...(identity.effort ? [`effort=${identity.effort}`] : []),
  ].join(" ");
  return (
    `${body.replace(/\s+$/, "")}\n\n---\n` +
    `Filed from the ComfyUI panel by ${formatAgentIdentity(identity)} ` +
    `— stamped by comfyui-mcp from the panel's provider/model selection, not self-reported.\n` +
    `${STAMP_MARKER} ${machine} -->\n`
  );
}

/** The label that makes the filed issues filterable by provider on GitHub
 *  (`label:agent:ollama`). The MODEL stays in the body — one label per provider
 *  is a bounded set, one per model is not. */
export function agentLabel(identity: AgentIdentity): string {
  return `agent:${identity.backend}`;
}
