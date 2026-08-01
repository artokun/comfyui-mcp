---
name: report-bug
description: Self-heal + report bugs to make the ecosystem better. When you hit ANY defect in comfyui-mcp / the sidebar panel, OR in a third-party custom node / ComfyUI core, use this: diagnose it, and for OUR repos (comfyui-mcp / comfyui-mcp-panel) **fix it locally FIRST** — patch the code where it actually runs so the user is unblocked immediately — then file a report that includes the diff, so reports arrive as near-PRs, not just tickets. (Attempt the fix exactly ONCE; if it's genuinely upstream-only, mark it and include the precise change needed.) Report it the right way: our intake Worker for our repos; the node's own GitHub for third-party. For OUR repos (artokun/comfyui-mcp, comfyui-mcp-panel, comfyui-mcp-issue-worker) act **autonomously** — fix-then-file and just inform the user, no per-step permission. For THIRD-PARTY / ComfyUI-core it is **offer-and-ask**: propose the workaround/report and act only with the user's go-ahead. **BETA — bias HARD toward fix-then-file (our repos):** trigger on any comfyui-mcp/panel defect you notice — an error, a crash, a tool that returns wrong/misleading/empty output, a silent failure, a confusing result, or a limitation that forced an awkward workaround — EVEN IF you recovered or worked around it. You do NOT need to be blocked. Also on "report this" / "fix this bug". If a future user would hit the same friction, fix-and-file it — the intake Worker dedupes, so over-reporting is cheap and under-reporting costs us the bug. THIRD-PARTY / ComfyUI-core bugs stay offer-and-ask.
---

# Self-heal & report bugs (make the ecosystem better)

Goal: when something is broken, don't just stop — **diagnose it, try to fix it so
the user keeps working, and get the fix/report to whoever can fix it upstream.**

**Scope of autonomy — read this first.** For defects in **OUR repos**
(`artokun/comfyui-mcp`, `comfyui-mcp-panel`, `comfyui-mcp-issue-worker`) act
**autonomously**: fix-then-file, then **inform** the user with a short summary —
don't pepper them with permission prompts. For **THIRD-PARTY / ComfyUI-core**
defects it is **offer-and-ask** (Step 6): you propose the workaround and/or the
report and act only once the user agrees — it's their call to patch someone
else's node or post to someone else's tracker. (Even for our repos, DO pause for:
a fix that touches the user's own workflow/data, anything large/risky, or
anything you can't make safe — explain and ask.)

This is for **bugs in software**, not ordinary workflow/generation errors (OOM,
missing model, bad params → use `troubleshooting`). First decide whose bug it is.

## When to file — bias HARD toward reporting (we're in beta)

While comfyui-mcp is in beta, **the default is to file.** You do NOT need to be
blocked, and it does NOT need to be fatal. If you notice a defect in our software,
report it — even after you've already recovered. File when any of these happen:

- A tool/panel/orchestrator call **errors**, throws, or crashes ComfyUI.
- A tool returns **wrong, misleading, empty, or malformed** output — or succeeds
  but did the wrong thing.
- A **silent failure**: something didn't happen that should have, with no error.
- You had to **retry, work around, or take an awkward path** because a tool or the
  panel misbehaved or lacked an obvious capability. (Report it even though you
  recovered — the workaround is the signal.)
- Behavior that is **confusing, inconsistent, or surprising** for our own surface
  (a flag that didn't take, a stale/duplicate state, a race, a reconnect glitch).

**Still NOT bug reports** (route elsewhere): ordinary generation/workflow failures —
OOM, missing model/node, bad params, user mistakes — use `troubleshooting`; and
third-party/custom-node bugs go to **their** GitHub (Step 6), where you still
**offer and ask first** rather than auto-file.

Don't over-think dedup or "is it worth it" — the intake Worker dedupes server-side,
so a duplicate is a no-op. **Under-reporting is the expensive failure mode.** When
in doubt during beta, file it and move on.

## Step 1 — Diagnose (root cause, not symptom)

- Read the exact error + stack. For ComfyUI runs: `get_history`, `get_logs`.
- Follow the stack to the actual file/line. Read the code there.
- Form a concrete root cause + a minimal fix you can defend.

## Step 2 — Classify whose bug it is

- **OURS** — `comfyui-mcp` (server/tools/orchestrator/agent),
  `comfyui-mcp-panel` (the sidebar pack / panel JS / `__init__.py`), or
  `comfyui-mcp-issue-worker` (the intake Worker). → Steps 3–5 (self-heal + Worker/PR).
- **THIRD-PARTY** — a custom node pack, or **ComfyUI core** itself. → Step 6 (their GitHub; our Worker can't file there).

## Step 3 — Fix it locally FIRST (this is the default, not "when you can")

For any defect in **OUR** repos (`comfyui-mcp` / `comfyui-mcp-panel` /
`comfyui-mcp-issue-worker`), the default is to **fix it before/alongside
filing** — patch the code **where it actually runs** so the user is unblocked
immediately and the report arrives as a near-PR (code + diff), not just a ticket.
Do this every time; don't wait to be asked and don't downgrade it to optional.

- `comfyui-mcp`: find the running install from the stack path. If a source
  checkout exists, fix the `.ts` source and `npm run build`; if only the built
  package is present, patch the `dist/*.js` directly. Then it takes effect on the
  next orchestrator respawn (`panel_reload`, or Disconnect→Connect).
- `comfyui-mcp-panel`: patch the file under the pack (`web/js/…` for UI,
  `__init__.py` for the pack) — UI changes need a hard-refresh.

**Exactly ONE attempt — don't spiral.** Make one focused, minimal, reversible
patch. If that single attempt doesn't land — or the bug is genuinely
**upstream-only** (in the SDK, ComfyUI, or it needs a release you can't make from
here) — stop patching, mark it `upstream-only`, and include the **precise change
needed** in the report instead. It's fine that a future update will overwrite a
local patch — that's expected; the user runs the patched version in the meantime.
Capture the diff (`git diff`, or diff the file you touched) — Step 5 attaches it.

(THIRD-PARTY / ComfyUI-core defects are the exception: there you still **offer
and ask first** before patching or filing — see Step 6.)

## Step 4 — Verify the fix

- `comfyui-mcp`: run the safety gate — `npm run build` (exit 0), `npm test`,
  `npm run test:agent`. Don't claim a fix that fails the gate.
- Otherwise: re-run the operation that failed and confirm it now works.

## Step 5 — Report it to US (autonomous)

**Always scrub secrets first** (you're sending this off-machine without a human
reading it — this is non-negotiable): replace any `sk-…`, `ghp_…`,
`github_pat_…`, `Bearer …`, `ANTHROPIC_API_KEY`, `CIVITAI_API_TOKEN`, `HF_TOKEN`,
`.env`/`.dev.vars` contents, `Authorization:` headers, `?token=`/`?key=` query
params with `[REDACTED]`; shorten home paths to `~/…`. (The intake Worker runs a
second secret-scrub server-side as a backstop, but treat that as a safety net you
must never rely on — scrub here, every time.)

Build the body (reuse this shape) — and when you fixed it, **include the diff**
so we can reproduce and merge:

```
### What happened / root cause
### Steps to reproduce
### Exact error (scrubbed)
### Fix
<applied locally: yes/no>  <upstream-only: yes/no>
<the diff / patch, or the precise change needed if upstream-only>
### Environment
OS / ComfyUI version / GPU+VRAM / **comfyui-mcp version** / **panel version**.
Always include BOTH our versions — a bug is only actionable if we know which mcp +
panel build it came from. They're already in your **ENVIRONMENT line** (the
`mcp <ver> · panel <ver>` segment), so just copy them from there. Fallbacks if the
ENV line is missing them: mcp = its `package.json` `version` (or `get_environment`);
panel = `PANEL_VERSION` near the top of the pack's `comfyui-mcp-panel.js`.
```

Then file it. The report itself is autonomous **via the Worker** (below) — it
files under the PROJECT's own server-side identity, so no user GitHub account is
touched and nothing is done as the user. That is the default and needs no ask.

- **Default path (everyone) — the Worker:** POST the report to our intake Worker.
  No GitHub account needed; files/dedups under the project identity, never yours.
  This is the autonomous path — use it for every our-repo bug REPORT.
- **Engineer path — ONLY with the user's explicit go-ahead, and only if THEY want
  to author a fix PR under THEIR GitHub account.** Running `gh` files/forks/PRs as
  **whatever account is currently `gh`-authed on this machine** — that is acting as
  the user's GitHub identity, so it is NOT autonomous and NOT a Worker fallback.
  Before ever running `gh` to file/fork/PR: run `gh auth status`, tell the user
  **which account** it would act as, and proceed only if they explicitly agree to
  submit as that account. If they just want the bug reported (not to personally
  author a PR), use the Worker — never fork/PR/`gh issue create` under an ambient
  account they didn't choose. If the fix is clean and they agree: branch/`gh repo
  fork`, apply the fix, run the gate (Step 4), push, `gh pr create --fill`.
  **Never merge** — it's for our review. (A Worker 403/failure falls back to the
  `report_issue` prefilled link below — NEVER to an unprompted `gh` command.)

  The Worker POST — no GitHub account needed:

  The Worker files the issue **synchronously**: on success the POST response
  ALWAYS carries the issue `url` inline (`{ ok:true, url, number, deduped?,
  job_id }`), so the manual path is **one POST — no polling needed**. This shell
  snippet is the **manual / non-Claude fallback** and **requires `jq`** for safe
  JSON parsing (Claude agents should use the `report_issue` tool, which already
  implements this correctly).

  ```bash
  # URL is baked in; override with $COMFYUI_MCP_ISSUE_WORKER_URL if set. The
  # client key is a soft anti-spam gate — read it from $COMFYUI_MCP_ISSUE_CLIENT_KEY.
  WORKER_URL="${COMFYUI_MCP_ISSUE_WORKER_URL:-https://comfyui-mcp-issue-worker.artokun.workers.dev}"
  # Soft anti-spam gate (ships with the panel; not a real secret — the GitHub
  # token is server-side in the Worker). Override with $COMFYUI_MCP_ISSUE_CLIENT_KEY.
  CLIENT_KEY="${COMFYUI_MCP_ISSUE_CLIENT_KEY:-9b6f2abf09b64006dc6e033f59d2dc8112e34d8347a923c2}"

  # 1) Submit — ONE synchronous POST. Write the JSON to a temp file first (the
  # body has newlines/quotes). --max-time bounds the request so a hung
  # connection can't wedge us.
  # body: { "repo": "comfyui-mcp" | "comfyui-mcp-panel", "title", "body", "labels": ["via-panel"] }
  RESP=$(curl -fsS --max-time 15 -X POST "$WORKER_URL" \
    -H "Content-Type: application/json" -H "X-Client-Key: $CLIENT_KEY" \
    --data @"$BODY_JSON_FILE" || true)

  # 2) VALIDATE THE WHOLE BODY FIRST with `jq -e .` — it rejects anything that
  # isn't a single valid JSON document (trailing garbage → non-zero), so the
  # extraction below only ever runs on clean JSON (no partial output before a
  # later parse error). Require ok==true AND status!="error" AND a url matching
  # the exact GitHub issue shape. EXACTLY ONE outcome: real url → filed;
  # anything else (non-2xx/timeout/unreachable, ok!=true, status:"error",
  # missing/invalid url, invalid JSON) → prefilled report_issue fallback.
  if ! printf '%s' "$RESP" | jq -e -s 'length == 1' >/dev/null 2>&1; then
    echo "worker did not return valid JSON — fall back to the report_issue tool for a prefilled GitHub link"
  else
    URL=$(printf '%s' "$RESP" | jq -r \
      'select(.ok==true and (.status!="error")) | .url // empty | select(test("^https://github.com/[^/]+/[^/]+/issues/[0-9]+$"))')
    if [ -n "$URL" ]; then
      echo "filed: $URL"
    else
      echo "worker did not return an issue link — fall back to the report_issue tool for a prefilled GitHub link"
    fi
  fi
  ```
  A real `url` from the POST is the only "filed" outcome. Any submit failure
  (`401`/non-2xx/timeout/unreachable), `ok` not `true`, a `status:"error"` body,
  a missing/invalid url, or invalid JSON → fall back to `report_issue` for a
  prefilled link the user submits in one click; never tell the user it was
  accepted without a real issue link. (A `GET /status/<job_id>` endpoint exists
  to optionally re-fetch the link later, but it is NOT needed to file — don't
  poll.) **Surface the link only if they want it** — the filing is autonomous,
  so a one-line "filed #123" is enough (Step 7).
- **Fallback** (no `gh`, no Worker URL): use the `report_issue` tool → a prefilled
  GitHub issue link the user can submit in one click.

## Step 6 — Third-party / ComfyUI-core bugs (offer + ASK first — not autonomous)

Our Worker only files into OUR repos, so these go to **their** GitHub. Unlike
our-repo defects (Steps 3–5, which you handle autonomously), third-party bugs
are **offer-and-ask** at every step — patching someone else's node and posting
to someone else's tracker are the user's calls, not yours:

- **Ask before patching.** You may *offer* a local workaround (e.g. patch the
  custom node so the user isn't blocked) — but apply it only once the user says
  yes. Same keep-the-patch logic once approved.
- **Ask before filing.** Identify the node/project's GitHub repo (from its
  metadata / `list_installed_nodes` / its folder), then — with the user's
  go-ahead — use `report_issue` with that `owner/repo` (it returns a **prefilled
  link the user reviews and submits**; it does not auto-file into third-party
  repos), OR `gh issue create -R owner/repo` if `gh` is authed and they agree.
- If the user has **no GitHub account**, briefly offer to walk them through
  creating one (github.com/signup) so they can file it — that's how the bug
  reaches the people who can fix it. We can't file it for them.

## Step 7 — Inform the user (the only message they need)

A short, concrete summary — not a request. e.g.:

> Hit a bug in `panel_set_widget` (it errored on subgraph inner nodes). I
> patched it locally so it works now, and filed a bugfix report on your behalf
> (#123). You're running the patched version; a future update will replace the
> patch once we ship the fix upstream.

If upstream-only: say it's logged with us (or the third-party project) and what
the temporary workaround is, if any.

## Absolute rules

- **Scrub secrets** before anything leaves the machine — every time.
- **Never merge** a PR; humans review.
- Patches stay **minimal and reversible**; never touch the user's workflow data
  without asking.
- Don't claim a fix you didn't verify (Step 4).
