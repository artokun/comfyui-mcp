import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { detectInstallMode } from "../services/self-update.js";
import { agentLabel, readAgentIdentity, stampAgentIdentity } from "../services/agent-identity.js";

// Issue reporting. For OUR repos (comfyui-mcp / comfyui-mcp-panel) this FILES the
// issue through the async AI-triage Worker: submit (with the reporter's versions)
// → get an instant version-ack + job_id → poll /status/<job_id> until the triage
// agent CLOSEs the job, then surface its result (a new issue, a dedup, a reopen,
// or an "already fixed — upgrade" answer with the fixing PR + version). For
// third-party repos, or when the Worker is unreachable, it falls back to a
// PREFILLED GitHub "new issue" URL the user can review and submit in one click.

const DEFAULT_REPO = "artokun/comfyui-mcp";

// Repos the intake Worker is allowed to file into (owner is fixed server-side).
const OUR_OWNER = "artokun";
const OUR_REPO_NAMES = new Set(["comfyui-mcp", "comfyui-mcp-panel"]);

// Defaults mirror the report-bug SKILL. Both are overridable via env; the client
// key is a soft anti-spam gate (not a real secret — the GitHub token is
// server-side in the Worker).
const DEFAULT_WORKER_URL = "https://comfyui-mcp-issue-worker.artokun.workers.dev";
const DEFAULT_CLIENT_KEY = "9b6f2abf09b64006dc6e033f59d2dc8112e34d8347a923c2";

/** The User-Agent every report-bug request sends (#937). Named on purpose: a
 *  default runtime signature is a WAF disposition we do not control. */
export const REPORT_UA = "comfyui-mcp-report-bug/1.0";

export function normalizeRepo(input: string | undefined): string {
  const repo = (input || DEFAULT_REPO)
    .trim()
    .replace(/^https?:\/\/github\.com\//i, "")
    .replace(/\.git$/i, "")
    .replace(/^\/+|\/+$/g, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) {
    throw new Error(`invalid repo "${repo}" — expected owner/name`);
  }
  return repo;
}

export function buildIssueUrl(repo: string, title: string, body: string, labels?: string[]): string {
  const params = new URLSearchParams({ title, body });
  if (labels?.length) params.set("labels", labels.join(","));
  return `https://github.com/${repo}/issues/new?${params.toString()}`;
}

export function isOurRepo(repo: string): boolean {
  const [owner, name] = repo.split("/");
  // Case-insensitive: git config / this repo use "Artokun" with a capital A,
  // which must still be recognized as ours (not misrouted as third-party).
  return owner?.toLowerCase() === OUR_OWNER && OUR_REPO_NAMES.has(name?.toLowerCase());
}

/** Reporter's installed versions, sent so the worker can version-match. */
export interface ReporterVersions {
  mcp?: string;
  panel?: string;
}

/** The instant, mechanical version-ack the worker returns on submit. */
export interface TriageAck {
  job_id?: string;
  versions?: unknown; // { mcp: {reporter,latest,up_to_date}, panel: {...} }
  up_to_date?: boolean | null;
  upgrade_hint?: string;
}

/** The triage agent's terminal result (from the CLOSED job payload). */
export interface TriageResult {
  url?: string;
  number?: number;
  deduped?: boolean;
  classification?: string;
  action_taken?: string;
  fixed_in_version?: string | null;
  fix_pr_url?: string | null;
  recommend_upgrade?: boolean;
  agent_message?: string;
  possible_duplicate?: boolean;
  /**
   * Existing issues triage judged to share a root cause with this report
   * (classification "related"). The created issue's body references them, so
   * GitHub already cross-linked the cluster; surfaced so the agent can tell
   * the user their report joined a known defect.
   */
  related_issues?: number[];
}

/**
 * Outcome of submitAndPoll:
 *  - "closed": the triage agent finished — full result (issue link or upgrade
 *    advice) + the version-ack.
 *  - "unfiled": the job reached a TERMINAL state without producing an issue
 *    (the worker's own triage AND its never-lose fallback both gave up). Nothing
 *    was filed, so the caller SHOULD prefill a URL as the last resort — there is
 *    no double-file risk.
 *  - "pending": submit succeeded (we have the ack + a job_id) but the triage was
 *    still running when the poll budget ran out. The worker WILL finish and
 *    file/dedup autonomously, so the caller must NOT also prefill (that would
 *    double-file) — it surfaces the ack + "still triaging".
 * A SUBMIT failure (worker unreachable / non-OK) throws instead, so the caller
 * falls back to a prefilled URL (there too, the worker never took the report).
 */
export type SubmitOutcome =
  | { kind: "closed"; ack: TriageAck; result: TriageResult }
  | { kind: "unfiled"; ack: TriageAck }
  // job_id is optional: an accepted (HTTP 2xx) submit whose body stalled or
  // omitted a job_id still means the worker TOOK the report — we can't poll but
  // must NOT prefill (that would double-file).
  | { kind: "pending"; ack: TriageAck; job_id?: string };

interface StatusFrame {
  state?: string; // PENDING | INVESTIGATING | CLOSED
  status?: string; // legacy: queued | done | error
  url?: string;
  number?: number;
  error?: string;
  payload?: TriageResult & { issue?: { number?: number; url?: string; state?: string } };
}

/**
 * Submit to the async AI-triage Worker and poll /status/<job_id> until the job
 * CLOSEs or the budget runs out. Injectable fetch/sleep for testing.
 * THROWS only on a submit failure (so the caller uses the prefilled fallback);
 * a still-running job at the budget returns { kind: "pending" }.
 */
export async function submitAndPoll(opts: {
  workerUrl: string;
  clientKey: string;
  repoName: string;
  title: string;
  body: string;
  labels?: string[];
  reporterVersions?: ReporterVersions;
  fetchImpl?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxPolls?: number;
  pollDelayMs?: number;
  timeoutMs?: number;
}): Promise<SubmitOutcome> {
  const doFetch = opts.fetchImpl ?? fetch;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  // Poll past the WORKER's own wall-clock budget, not just the typical triage
  // time — the worker allows itself up to 240 s (TRIAGE_WALL_CLOCK_MS) and a
  // thorough dedup (several searches + candidate reads) now uses it. A shorter
  // client budget returns "still triaging" for work that was about to finish,
  // costing the reporter the fix-version/duplicate answer. ~95 * 3 s ≈ 285 s.
  const maxPolls = opts.maxPolls ?? 95;
  const pollDelayMs = opts.pollDelayMs ?? 3000;
  const timeoutMs = opts.timeoutMs ?? 15000; // per-request cap (not the whole job)

  // Keep the abort active through BOTH the fetch AND the body parse — otherwise
  // a hung `.json()` after headers arrive would never time out.
  const withTimeout = async <T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await fn(ac.signal);
    } finally {
      clearTimeout(t);
    }
  };

  // `accepted` flips true the instant the worker returns a 2xx — from that point
  // the worker HAS the report and is filing autonomously, so a later body
  // stall/parse failure must NOT throw into a prefill (that would double-file).
  let accepted = false;
  let submit: StatusFrame & TriageAck;
  try {
    submit = await withTimeout(async (signal): Promise<StatusFrame & TriageAck> => {
      const r = await doFetch(opts.workerUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Client-Key": opts.clientKey,
          // #937 — an EXPLICIT, named signature rather than whatever the runtime
          // advertises. Cloudflare fronts this endpoint and bans some default
          // client UAs outright: a Python urllib POST gets 403 / `error code:
          // 1010` while the byte-identical request with an ordinary UA succeeds
          // seconds later. Node fetch happens to be allowed today — a WAF
          // disposition we neither control nor chose. Naming ourselves makes the
          // path deterministic instead of incidentally lucky.
          "User-Agent": REPORT_UA,
          Accept: "application/json",
          // Opt into the async AI-triage contract. Absent this header the worker
          // runs its legacy synchronous dumb-file path (old clients stay working).
          "X-Triage-Async": "1",
        },
        body: JSON.stringify({
          repo: opts.repoName,
          title: opts.title,
          body: opts.body,
          labels: opts.labels,
          reporter_versions: opts.reporterVersions ?? {},
        }),
        signal,
      });
      if (!r.ok) throw new Error(`worker submit failed: HTTP ${r.status}`);
      accepted = true; // 2xx → the worker took the report
      return (await r.json()) as StatusFrame & TriageAck;
    });
  } catch (err) {
    // A 2xx whose body stalled/was malformed: the worker still took it and is
    // filing — surface pending (no job_id, no ack) so the caller does NOT
    // prefill. A pre-2xx failure (network / non-OK) rethrows → caller prefills.
    if (accepted) return { kind: "pending", ack: {} };
    throw err;
  }

  const ack: TriageAck = {
    job_id: submit.job_id,
    versions: submit.versions,
    up_to_date: submit.up_to_date,
    upgrade_hint: submit.upgrade_hint,
  };

  // A synchronous worker (legacy / very fast) may return the result inline.
  if (isClosedFrame(submit)) {
    const inline = frameToResult(submit);
    return inline ? { kind: "closed", ack, result: inline } : { kind: "unfiled", ack };
  }

  const jobId = submit.job_id;
  // Accepted (2xx) but no job_id and no inline result → we can't poll, but the
  // worker took it and is filing. Surface pending (never prefill → no double).
  if (!jobId) return { kind: "pending", ack };

  const base = opts.workerUrl.replace(/\/+$/, "");
  for (let i = 0; i < maxPolls; i++) {
    await sleep(pollDelayMs);
    let parsed: StatusFrame;
    try {
      parsed = await withTimeout(async (signal): Promise<StatusFrame> => {
        const r = await doFetch(`${base}/status/${jobId}`, {
          signal,
          headers: { "X-Client-Key": opts.clientKey, "User-Agent": REPORT_UA, Accept: "application/json" },
        });
        if (!r.ok) throw new Error(`poll failed: HTTP ${r.status}`);
        return (await r.json()) as StatusFrame;
      });
    } catch {
      // A transient poll error does NOT mean the job failed — the worker keeps
      // running. Keep polling; only a real terminal frame or the budget ends it.
      continue;
    }
    if (isClosedFrame(parsed) || isTerminalError(parsed)) {
      const result = frameToResult(parsed);
      // Terminal WITH a usable issue/answer → closed; terminal WITHOUT one
      // (unfiled_needs_manual / hard error) → the worker gave up filing, so the
      // caller may safely prefill (nothing was written → no double-file).
      return result ? { kind: "closed", ack, result } : { kind: "unfiled", ack };
    }
    // else PENDING / INVESTIGATING → keep polling
  }
  // Still running at the budget: the worker will finish autonomously — do NOT
  // prefill (that duplicates). Surface the ack + job id.
  return { kind: "pending", ack, job_id: jobId };
}

/** A frame is TERMINAL (job finished) iff CLOSED, a legacy done, or a legacy
 *  sync response that carries a url with no lifecycle field at all. */
function isClosedFrame(frame: StatusFrame): boolean {
  return (
    frame.state === "CLOSED" ||
    frame.status === "done" ||
    (frame.state == null && frame.status == null && !!frame.url)
  );
}

/** Flatten a terminal frame to a TriageResult, or null if it carries no usable
 *  issue link / answer (→ the caller treats it as "unfiled"). */
function frameToResult(frame: StatusFrame): TriageResult | null {
  const p = frame.payload;
  const issueUrl = p?.issue?.url ?? frame.url;
  const issueNumber = p?.issue?.number ?? frame.number;
  // "Usable" = there is a real issue link, OR it is the advise-upgrade answer
  // (no created issue, but real fix guidance). A terminal frame WITHOUT either —
  // e.g. unfiled_needs_manual, which still carries an agent_message — is NOT a
  // success: return null so the caller treats it as "unfiled" and prefills. (Do
  // NOT key this on agent_message; the worker sets one even on failure.)
  const usable = !!issueUrl || p?.action_taken === "advised_upgrade";
  if (!usable) return null;
  return {
    url: issueUrl,
    number: issueNumber,
    deduped: p?.deduped,
    classification: p?.classification,
    action_taken: p?.action_taken,
    fixed_in_version: p?.fixed_in_version ?? null,
    fix_pr_url: p?.fix_pr_url ?? null,
    recommend_upgrade: p?.recommend_upgrade,
    agent_message: p?.agent_message,
    possible_duplicate: p?.possible_duplicate,
    // Older workers omit this entirely — keep it absent rather than [] so the
    // surface distinguishes "no cluster" from "worker predates clustering".
    related_issues: Array.isArray(p?.related_issues) ? p.related_issues : undefined,
  };
}

function isTerminalError(frame: StatusFrame): boolean {
  return frame.status === "error" && !frame.url && !frame.payload;
}

/**
 * The RUNNING comfyui-mcp version, snapshotted once at module load.
 *
 * `detectInstallMode().currentVersion` reads the package on disk, which answers
 * a different question: what is INSTALLED. Those agree until someone updates in
 * place, and then every issue filed by the still-running old process is stamped
 * with the new version — the exact misreport #846 was opened for, reintroduced
 * through the auto-detect fallback after round 9 fixed the explicit path (codex
 * gate P1).
 *
 * Reading at load time is not a perfect proxy for "the code executing right
 * now", but it is bounded by process start, which is the property that matters:
 * it cannot drift underneath a long-lived process the way a report-time read
 * does.
 */
const RUNNING_MCP_VERSION: string | undefined = (() => {
  try {
    return detectInstallMode().currentVersion ?? undefined;
  } catch {
    return undefined;
  }
})();

/** The running comfyui-mcp version (best-effort; undefined if undetectable). */
function detectMcpVersion(): string | undefined {
  return RUNNING_MCP_VERSION;
}

/** A semver body, with the optional `v` prefix stripped by the capture group. */
const SEMVER_BODY = String.raw`v?(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)`;

/**
 * How each version is LABELLED in the ENVIRONMENT line.
 *
 * `comfyui-mcp-panel 0.11.38` is not readable as the mcp version because the label
 * has to be followed by a separator and then A VERSION, and the word `panel` sits
 * in between — the version is simply not adjacent to the mcp label. Stated plainly
 * because two stronger-looking guards were tried here and both turned out to change
 * no input at all: negative lookaheads on the label, and forbidding the hyphen as a
 * separator. Neither was falsifiable, so neither is kept as protection; the covering
 * test asserts the BEHAVIOUR (`comfyui-mcp-panel 0.11.38` yields no mcp version)
 * rather than the mechanism.
 */
export const MCP_VERSION_LABEL = String.raw`(?:comfyui-mcp|mcp)`;
/** Same, for the sidebar panel. The longer alias is listed first so it wins. */
export const PANEL_VERSION_LABEL = String.raw`(?:comfyui-mcp-panel|panel)`;

/**
 * Reduce a caller-supplied version to the VERSION IN IT, or undefined.
 *
 * These strings are copied by an agent out of a prose ENVIRONMENT line, and that
 * line grew a qualifying clause (#846: "comfyui-mcp 0.48.18 (this process is
 * RUNNING 0.48.18; 0.49.5 is now installed on disk …)"). Passed through whole, the
 * triage worker's version match sees a sentence instead of a version and cannot
 * tell the user that upgrading already fixes their bug — the single most common
 * resolution, and the outcome #846 was filed to protect.
 *
 * THE LABEL IS TRIED FIRST, and it is what makes this correct rather than merely
 * lucky (codex gate round 2). Two simpler rules were tried and both mis-read a
 * realistic input:
 *   - anchored at position 0: an agent pasting the natural segment
 *     ("comfyui-mcp 0.48.18 …") matched nothing, fell through to a fresh disk read,
 *     and reported the INSTALLED version — reintroducing #846 through its own fix;
 *   - first semver ANYWHERE: the ENVIRONMENT line names `torch 2.7.1 · python
 *     3.12.3` BEFORE `comfyui-mcp 0.48.18`, so an agent pasting the whole line —
 *     which the tool description tells it to do — reported TORCH's version as the
 *     reporter's. Wrong in a way nobody downstream could detect.
 * Reading the label is the only rule that survives the input the tool actually asks
 * for.
 */
/** Release channels that are legitimate version values without carrying a digit. */
const CHANNEL_TAGS = new Set([
  "nightly",
  "dev",
  "development",
  "edge",
  "canary",
  "beta",
  "alpha",
  "rc",
  "latest",
  "main",
  "master",
  "local",
]);

/**
 * Is this token a VERSION, as opposed to a word that merely stands where one was
 * expected? Semver wins outright; otherwise it must carry a digit (`0.49.6-dev3`,
 * `2026.08.04`) or be a recognised channel name.
 *
 * The point is what it REJECTS: `unknown`, `unspecified`, `none`, and any stray word
 * an agent might drop in ("comfyui-mcp is broken"). Those are not versions, and
 * forwarding them would hand the triage worker something unmatchable while looking
 * like a confident answer — the caller falls through to detection instead, which is
 * the right move precisely when the agent had nothing.
 */
function asVersionToken(rawToken: string): string | undefined {
  // The ENVIRONMENT line ends in a full stop, so the last component's token arrives
  // as `0.11.38.` — which passes every shape test and is then reported with the
  // trailing dot attached, defeating the exact-version match downstream. No version
  // ends in punctuation, so stripping it is unambiguous.
  const token = rawToken.replace(/[.,;:)\]}]+$/, "");
  if (token === "") return undefined;
  const semver = new RegExp(`^${SEMVER_BODY}$`, "i").exec(token);
  if (semver) return semver[1];
  if (!/^[A-Za-z0-9][A-Za-z0-9._+-]{0,31}$/.test(token)) return undefined;
  if (/\d/.test(token)) return token;
  return CHANNEL_TAGS.has(token.toLowerCase()) ? token : undefined;
}

export function normalizeReportedVersion(
  raw: string | undefined,
  label: string,
): string | undefined {
  if (typeof raw !== "string") return undefined;
  const trimmed = raw.trim();
  if (trimmed === "") return undefined;

  // 1. LABELLED — survives a whole ENVIRONMENT line, other components' versions and
  //    all. The separator covers both `comfyui-mcp 0.49.6` and `mcp=0.49.6`.
  //
  //    The value is captured as a TOKEN and validated after, not required to be
  //    semver in the pattern (codex gate round 3). Requiring semver here meant a
  //    non-semver running build — `comfyui-mcp nightly (this process is RUNNING
  //    nightly; 0.49.6 is now installed on disk …)` — matched nothing, fell through
  //    to a disk read, and reported the INSTALLED 0.49.6 as the running version.
  //    That is #846 exactly, for the one user whose version needed the most care.
  //
  //    ONE named filler word may stand between the label and the number (codex gate
  //    round 4): `MCP version: 0.48.18` puts `version` where the value goes, and
  //    taking only the adjacent token dropped a perfectly good reading straight into
  //    the disk-read fallback — #846 again.
  //
  //    It is a NAMED filler and not "scan the next few tokens" (codex gate round 6).
  //    Scanning walked straight over an indeterminate value into the NEXT
  //    component's: `comfyui-mcp unknown · panel 0.11.38.` returned the PANEL's
  //    version as the mcp one. An mcp version that cannot be determined has to stay
  //    undetermined — that is the whole rule this cluster is about — so anything that
  //    is neither the filler nor a version stops the search here.
  //
  //    The left boundary keeps `other-mcp 1.2.3` from being read as ours.
  const after = new RegExp(
    `(?<![A-Za-z0-9-])${label}[\\s:=]+(?:versions?[\\s:=]+)?([^\\s·,;)]+)`,
    "i",
  ).exec(trimmed);
  if (after) {
    const value = asVersionToken(after[1]);
    if (value) return value;
  }

  // 2. LEADING — the caller sent the version itself, possibly with the #846 drift
  //    clause after it. The clause names a NEWER installed version second, so
  //    taking the leading one keeps the RUNNING build, which is what the report is
  //    about. Nothing in the ENV line begins with a bare version, so this cannot
  //    pick up another component's.
  const leading = new RegExp(`^${SEMVER_BODY}`).exec(trimmed);
  if (leading) return leading[1];

  // 3. THE WHOLE STRING as a version token — the caller sent just `nightly`, with no
  //    label. Preserved for the same reason as above: discarding it would send the
  //    caller to a disk read, i.e. the version-swap in a different disguise.
  return asVersionToken(trimmed);
}

/**
 * The intake worker truncates a submitted body at 60_000 chars (index.ts:
 * MAX_BODY_LEN) before anything is stored or filed.
 *
 * The identity stamp is the LAST thing in the body, so an oversized report — a
 * pasted log, the diff the report-bug skill asks for — would have its
 * attribution cut off server-side, silently, and precisely on the reports with
 * the most in them. Trim the caller's own text by the stamp's width instead: the
 * worker was going to cut that tail anyway, so the content lost is the same
 * either way, and the attribution survives.
 *
 * Exported for the covering test — nothing else calls it.
 */
export const WORKER_MAX_BODY_LEN = 60_000;

export function fitUnderWorkerCap(
  body: string,
  identity: Parameters<typeof stampAgentIdentity>[1],
): string {
  if (!identity || stampAgentIdentity(body, identity).length <= WORKER_MAX_BODY_LEN) return body;
  const note = "\n\n…[trimmed to keep the reporting-agent stamp]";
  // Measure the stamp against THIS identity rather than assuming a width — the
  // model name is provider-supplied and unbounded in principle.
  const stampWidth = stampAgentIdentity("", identity).length;
  const room = WORKER_MAX_BODY_LEN - stampWidth - note.length;
  return room > 0 ? body.slice(0, room) + note : note;
}

export function registerReportIssueTools(server: McpServer): void {
  server.tool(
    "report_issue",
    "File or triage a GitHub issue for a bug/problem you hit (ComfyUI, a workflow, a model, custom nodes, or comfyui-mcp/its panel). For OUR repos (artokun/comfyui-mcp, artokun/comfyui-mcp-panel) it sends the report to the AI triage worker, which searches existing OPEN and CLOSED issues, version-matches, and either files a new issue, adds context to an existing one, or — if the problem was already FIXED in a newer version than the user runs — answers with the fixing PR + fixed-in version and a recommendation to upgrade (no new issue). It returns that triage result plus an instant check of whether the user is on the latest versions. TIMING: this call BLOCKS while the triage runs — typically a few minutes — and that wait is normal, not a hang. It always returns eventually (every request is time-capped and the poll budget is bounded); on a failing network the caps make that wait longer, but never indefinite. Do not abort a slow call just to retry it: once the worker has accepted the report it keeps triaging on its own — filing, deduping into an existing issue, advising an upgrade, or (rarely) reporting that it could not file — so a blind retry can double-file. If triage outlasts the polling budget the call still returns, with pending:true (and a job_id when the worker gave one — an accepted submit whose acknowledgement was unreadable returns pending without it). If the worker is unreachable it falls back to a prefilled GitHub 'new issue' URL. For third-party repos it returns a prefilled URL to SHARE (it does not auto-file). ALWAYS pass mcp_version and panel_version from the known environment (the env line in your context, e.g. 'mcp=… panel=…') so the worker can tell the user if simply upgrading fixes it — the single most common resolution. Surface the worker's agent_message / upgrade advice to the user.",
    {
      title: z.string().min(1).describe("Short, specific issue title."),
      body: z
        .string()
        .min(1)
        .describe(
          "Issue body: what happened, steps to reproduce, the exact error text, and environment (GPU/VRAM, ComfyUI version, ComfyUI FRONTEND version, OS) if known. The FRONTEND version is a SEPARATE package from ComfyUI and they move independently — get_system_stats (action:\"health\") prints both, and for any panel/UI bug it is often the deciding variable. Scrub secrets first.",
        ),
      repo: z
        .string()
        .optional()
        .describe("owner/repo (default 'artokun/comfyui-mcp'; use 'artokun/comfyui-mcp-panel' for the sidebar panel)."),
      labels: z.array(z.string()).optional().describe("Optional GitHub label names to prefill."),
      mcp_version: z
        .string()
        .optional()
        .describe("The running comfyui-mcp version (from the env line in your context). Auto-detected if omitted."),
      panel_version: z
        .string()
        .optional()
        .describe("The running comfyui-mcp-panel (sidebar) version, from the env line in your context, if known."),
      no_file: z
        .boolean()
        .optional()
        .describe("Force the prefilled-URL path even for our repos (skip the Worker). Rarely needed."),
    },
    async (args) => {
      try {
        const repo = normalizeRepo(args.repo);
        const ours = isOurRepo(repo);
        // WHICH LLM WROTE THIS REPORT. Published by the orchestrator from the
        // panel's provider/model chips (services/agent-identity.ts) and read
        // here, in the subprocess the reporting agent's tools run in — NOT asked
        // of the model, which cannot reliably name itself and was never told its
        // own model in the first place (the ENVIRONMENT block carries only
        // `Backend:`). Report quality varies enormously across the providers the
        // panel can drive, and until this line existed there was no way to tell a
        // thin report from a local 4B model apart from a thin report from a
        // frontier one.
        //
        // OUR repos only: someone else's tracker is not the place for our
        // provider telemetry, and a prefilled `agent:*` label would be a label
        // their repo has never heard of. Absent identity (every non-panel spawn:
        // plain stdio, CLI, tests) changes nothing — body and labels pass
        // through as before.
        const identity = ours ? readAgentIdentity() : undefined;
        const body = stampAgentIdentity(fitUnderWorkerCap(args.body, identity), identity);
        const labels = identity
          ? Array.from(new Set([...(args.labels ?? []), agentLabel(identity)]))
          : args.labels;
        const prefilledUrl = buildIssueUrl(repo, args.title, body, labels);

        // Third-party (or explicitly disabled): prefilled link only, as before.
        if (!ours || args.no_file) {
          return jsonResult({
            url: prefilledUrl,
            repo,
            filed: false,
            note: "Prefilled issue link (not auto-filed). Share it with the user to review and submit.",
          });
        }

        const workerUrl = process.env.COMFYUI_MCP_ISSUE_WORKER_URL || DEFAULT_WORKER_URL;
        const clientKey = process.env.COMFYUI_MCP_ISSUE_CLIENT_KEY || DEFAULT_CLIENT_KEY;
        const timeoutEnv = Number(process.env.COMFYUI_MCP_ISSUE_TIMEOUT_MS);
        const timeoutMs = Number.isFinite(timeoutEnv) && timeoutEnv > 0 ? timeoutEnv : undefined;
        const maxPollsEnv = Math.floor(Number(process.env.COMFYUI_MCP_ISSUE_MAX_POLLS));
        // Clamp to a sane ceiling so a mis-set env can't poll for hours.
        const maxPolls = Number.isFinite(maxPollsEnv) && maxPollsEnv > 0 ? Math.min(maxPollsEnv, 200) : undefined;
        const pollMsEnv = Number(process.env.COMFYUI_MCP_ISSUE_POLL_MS);
        const pollDelayMs =
          Number.isFinite(pollMsEnv) && pollMsEnv >= 0 ? Math.min(pollMsEnv, 60000) : undefined;
        const repoName = repo.split("/")[1];

        const reporterVersions: ReporterVersions = {
          mcp:
            normalizeReportedVersion(args.mcp_version, MCP_VERSION_LABEL) ??
            detectMcpVersion(),
          panel:
            normalizeReportedVersion(args.panel_version, PANEL_VERSION_LABEL) ??
            process.env.COMFYUI_MCP_PANEL_VERSION ??
            undefined,
        };

        try {
          const outcome = await submitAndPoll({
            workerUrl,
            clientKey,
            repoName,
            title: args.title,
            body,
            labels,
            reporterVersions,
            timeoutMs,
            maxPolls,
            pollDelayMs,
          });

          if (outcome.kind === "closed") {
            const r = outcome.result;
            return jsonResult({
              // "filed" means a real issue was created/updated. advised_upgrade
              // files nothing; and a closed result always has a url here (a
              // no-url terminal is routed to "unfiled" above).
              filed: !!r.url && r.action_taken !== "advised_upgrade",
              repo,
              url: r.url,
              number: r.number,
              classification: r.classification,
              action_taken: r.action_taken,
              deduped: r.deduped,
              fixed_in_version: r.fixed_in_version,
              fix_pr_url: r.fix_pr_url,
              recommend_upgrade: r.recommend_upgrade,
              possible_duplicate: r.possible_duplicate,
              // Present (non-empty) when triage judged this a NEW symptom of an
              // already-known defect; the issues are cross-linked on GitHub.
              related_issues: r.related_issues?.length ? r.related_issues : undefined,
              versions: outcome.ack.versions,
              up_to_date: outcome.ack.up_to_date,
              upgrade_hint: outcome.ack.upgrade_hint,
              // The one line to relay to the user.
              agent_message: r.agent_message,
              note: "Triaged by the AI issue worker. Relay agent_message (and the upgrade advice) to the user.",
            });
          }

          // Terminal without an issue: the worker's triage AND its own fallback
          // both gave up — nothing was filed, so a prefilled URL is the safe
          // last resort (no double-file risk).
          if (outcome.kind === "unfiled") {
            return jsonResult({
              url: prefilledUrl,
              repo,
              filed: false,
              versions: outcome.ack.versions,
              up_to_date: outcome.ack.up_to_date,
              upgrade_hint: outcome.ack.upgrade_hint,
              note: "The triage worker could not file this report. Fallback: prefilled issue link for the user to submit in one click.",
            });
          }

          // Still triaging at the budget: the worker WILL finish + file/dedup on
          // its own. Do NOT prefill (would double-file). Surface the version-ack.
          return jsonResult({
            filed: false,
            pending: true,
            repo,
            job_id: outcome.job_id,
            versions: outcome.ack.versions,
            up_to_date: outcome.ack.up_to_date,
            upgrade_hint: outcome.ack.upgrade_hint,
            agent_message: outcome.ack.upgrade_hint,
            note: "The AI triage is still running; the worker will file or dedup this report autonomously. If the user is behind on versions (see upgrade_hint), suggest upgrading first — that often resolves it.",
          });
        } catch (workerErr) {
          // SUBMIT failed (worker unreachable / non-OK) → the worker never took
          // the report, so a prefilled URL is safe (no double-file risk).
          return jsonResult({
            url: prefilledUrl,
            repo,
            filed: false,
            note: `Could not reach the AI triage worker (${workerErr instanceof Error ? workerErr.message : String(workerErr)}). Fallback: prefilled issue link for the user to submit in one click.`,
          });
        }
      } catch (err) {
        return {
          content: [
            { type: "text" as const, text: `Error building issue link: ${err instanceof Error ? err.message : String(err)}` },
          ],
          isError: true,
        };
      }
    },
  );
}

function jsonResult(obj: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(obj, null, 2) }],
  };
}
