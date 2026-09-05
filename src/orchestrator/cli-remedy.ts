import { QueueMonitor } from "../services/queue-monitor.js";
// #948 — a correct instruction delivered to the wrong place is a wrong instruction.
//
// A user saw `Not logged in, please run /login` in the PANEL CHAT and reported
// that `/login` "doesn't exist as a command". They were right: `/login` is typed
// at the `pi` CLI's own prompt. It is not a panel command, not a ComfyUI command,
// and not a shell command — and the message named none of that.
//
// In a chat box a leading `/` reads as "type this here". That is the whole defect:
// the remedy was accurate and unusable at the same time, and it points the reader
// at the one place it cannot work.
//
// It also misleads ACROSS providers. A user on the Claude or Codex chip has no
// `/login` at all (`claude setup-token`, `codex login`), so a passed-through
// string naming it is not merely unhelpful there — it is false.
//
// Two rules follow, and both are about the reader's location rather than the
// text's accuracy:
//   1. Never let a bare `/command` reach chat. Say where its prompt is.
//   2. When we wrap a provider's auth failure, name the tool, the place, and the
//      follow-up — not just the keystrokes.

/** The CLI whose prompt a backend's slash commands belong to, when it has one. */
const SLASH_CLI_BY_BACKEND: Record<string, string> = {
  pi: "pi",
  grok: "grok",
};

/**
 * Rewrite bare `/command` mentions so they cannot read as "type this here".
 *
 * Only touches a slash-command that stands as its own word — `/login`,
 * `/status` — and leaves paths (`/usr/bin/pi`), URLs and dates alone, since
 * those are not instructions and rewriting them would corrupt real values.
 *
 * The first occurrence gets the full "at <cli>'s prompt" qualification; later
 * ones in the same message get a shorter form, because repeating the whole
 * clause reads as noise and noise is what gets skimmed past.
 */
export function qualifySlashCommands(text: string, cli: string): string {
  if (!text) return text;
  let seen = 0;
  return text.replace(/(^|[\s("'`])\/([a-z][a-z0-9-]{1,24})\b(?!\/)/gi, (match, lead: string, cmd: string) => {
    // A path segment (`/foo/bar`) or a URL is not an instruction.
    seen += 1;
    const qualified =
      seen === 1
        ? `\`${cli}\`, then type \`/${cmd}\` at its prompt`
        : `\`/${cmd}\` (at the \`${cli}\` prompt)`;
    return `${lead}${qualified}`;
  });
}

/** True when a CLI's failure text is about missing/expired credentials. */
export function looksLikeAuthFailure(text: string): boolean {
  return /sign.?in|log.?in|logged.?out|auth|credential|unauthoriz|api.?key|no provider/i.test(text);
}

/**
 * OUR wrapper for a provider's not-authenticated failure.
 *
 * Names the tool, WHERE to run it, and the follow-up — a raw CLI string assumes
 * the reader is already standing in that CLI, which from a panel chat is exactly
 * the assumption that fails.
 *
 * `detail` is the CLI's own tail, kept because it often carries the real reason
 * (an expired token vs a missing file) — but passed through `qualifySlashCommands`
 * first, so the child's phrasing can never smuggle a bare `/login` into chat.
 */
export function providerAuthRemedy(backend: string, detail?: string): string {
  const cli = SLASH_CLI_BY_BACKEND[backend];
  const tail = detail?.trim()
    ? ` (${cli ? qualifySlashCommands(detail.trim(), cli) : detail.trim()})`
    : "";

  switch (backend) {
    case "pi":
      return (
        `pi has no usable provider credentials. Fix it in a TERMINAL, not here: either set a provider ` +
        `API key (OPENAI_API_KEY / CEREBRAS_API_KEY / …), or run \`pi\` once and type \`/login\` at its ` +
        `prompt — that writes ~/.pi/agent/auth.json. Then Disconnect → Connect and send your message ` +
        `again.${tail}`
      );
    case "codex":
      return (
        `Codex is not logged in. In a TERMINAL run \`codex login\` (ChatGPT sign-in) or set CODEX_API_KEY, ` +
        `then Disconnect → Connect.${tail}`
      );
    case "claude":
      return (
        `Claude has no usable credentials. In a TERMINAL run \`claude setup-token\`, ` +
        `then Disconnect → Connect. The agent authenticates from that login, not from an environment API key.${tail}`
      );
    case "gemini":
      return (
        `Gemini is not authenticated. In a TERMINAL run \`gemini\` once and complete its sign-in, or set ` +
        `GEMINI_API_KEY, then Disconnect → Connect.${tail}`
      );
    default:
      return (
        `${backend} has no usable credentials. Set the provider's API key in the API Keys card, or complete ` +
        `its CLI sign-in in a TERMINAL, then Disconnect → Connect.${tail}`
      );
  }
}


// ---------------------------------------------------------------------------
// #889 — a run-error notification must not assert who queued the run.
// ---------------------------------------------------------------------------

/**
 * The ComfyUI prompt id named in a run-error string, when there is one.
 *
 * Best-effort by design: the id travels inside prose ("Render status for prompt
 * 9d70fd9d-… could not be confirmed"), so a miss is normal and simply yields the
 * `unknown` attribution rather than a wrong one. Matches a bare uuid, which is
 * what ComfyUI mints.
 */
export function promptIdOf(text: string): string | undefined {
  const m = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i.exec(text ?? "");
  return m?.[0];
}

/**
 * The run-error notification, phrased by what we can actually establish.
 *
 * The three wordings differ in the ONE thing that was wrong before — the claim
 * about authorship — and in how hard they push. An agent told to STOP and to
 * relate a failure to its own work will relate it, so the imperative only
 * belongs on a run we can show is the agent's.
 */
export function describeRunError(
  error: string,
  attribution: "mine" | "not-mine" | "unknown",
): string {
  const details = `(panel_get_errors has the full node-level details)`;
  switch (attribution) {
    case "mine":
      return (
        `[panel event] ⚠️ The workflow run you queued ERRORED on the user's canvas: ${error}. ` +
        `STOP — do not carry on as if it succeeded. Diagnose it ${details} and fix it.`
      );
    case "not-mine":
      return (
        `[panel event] A workflow run ERRORED on the user's canvas: ${error}. ` +
        `You did NOT queue this run — this session has queued none — so do not treat it as your own ` +
        `failure and do not look for a connection to what you were doing. Tell the user briefly. ` +
        `Only investigate ${details} if they ask, or if it is obviously about a graph you just edited.`
      );
    default:
      return (
        `[panel event] ⚠️ A workflow run ERRORED on the user's canvas: ${error}. ` +
        `Whether it is one you queued could NOT be determined, so do not assume either way. ` +
        `If you were waiting on a render, treat this as it and diagnose it ${details}; if you were not, ` +
        `it is the user's own run — tell them briefly and carry on.`
      );
  }
}

/**
 * The run-error notice for a raw error string: extract the prompt id, ask the
 * QueueMonitor whose run it was, and phrase it accordingly.
 *
 * Kept as one named step so the composition is testable. Left inline in
 * PanelAgent it was reachable only through a full agent harness, and a mutation
 * that hardcoded the attribution back to "mine" — the exact #889 regression —
 * broke no test at all.
 */
export function runErrorNotice(error: string): string {
  return describeRunError(error, QueueMonitor.attributeRun(promptIdOf(error)));
}
