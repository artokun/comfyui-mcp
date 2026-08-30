---
name: report-bug
description: Self-heal and report bugs. Use when a defect in comfyui-mcp, the sidebar panel, a third-party custom node, or ComfyUI core actually cost the user something - it blocked them, produced a wrong result they would keep, lost or corrupted work, or crashed ComfyUI. Diagnose it; for OUR repos (comfyui-mcp, comfyui-mcp-panel, comfyui-mcp-issue-worker) fix it locally FIRST so the user is unblocked, then file a report including the diff, so reports arrive as near-PRs rather than tickets. Attempt the fix exactly ONCE; if it is upstream-only, say so with the precise change needed. Route it - our intake Worker for our repos, the node's own GitHub for third-party, which is offer-and-ask rather than autonomous. Do NOT file something you recovered from cleanly, a missing capability (we are in a stabilisation freeze, so those are parked on arrival), or behaviour that was merely surprising - say those in chat instead. One report per root cause, not one per symptom. Always file on "report this" or "fix this bug".
---

# Self-heal & report bugs (make the ecosystem better)

Goal: when something is broken, do not stop there. Diagnose it, try to fix it
so the user keeps working, and get the fix or report to whoever can fix it
upstream.

**Scope of autonomy. Read this first.** For defects in OUR repos
(`artokun/comfyui-mcp`, `comfyui-mcp-panel`, `comfyui-mcp-issue-worker`) act
autonomously. Fix, then file, then inform the user with a short summary. Do not
pepper them with permission prompts. For THIRD-PARTY and ComfyUI-core defects
it is offer-and-ask (Step 6). You propose the workaround and/or the report and
act only once the user agrees, because patching someone else's node or posting
to someone else's tracker is their call. Even for our repos, pause and ask for
a fix that touches the user's own workflow or data, for anything large or
risky, and for anything you cannot make safe.

This is for bugs in software, not ordinary workflow or generation errors (OOM,
missing model, bad params: use `troubleshooting`). First decide whose bug it is.

## When to file — a real defect that cost the user something

Two questions, both must be YES:

1. **Is it ours, and does it still reproduce?** On the CURRENT version — check
   before filing, not after. A defect already fixed upstream of the user's
   install is noise.
2. **Did it cost the user something?** It blocked them, produced a wrong result
   they would have kept, lost or corrupted their work, or crashed ComfyUI.

File when both hold:

- A tool, panel, or orchestrator call crashes ComfyUI, loses work, or corrupts a
  workflow.
- A tool returns wrong or misleading output the user would act on, or succeeds
  while doing something different from what it reported.
- A silent failure: something that should have happened did not, and nothing
  said so. (Silence is the expensive kind — the user cannot see it.)
- You could not complete the task, and the reason is a defect in our software.

**Do NOT file** — say it in chat and move on:

- Anything you recovered from cleanly. A retry that worked is not a report; the
  workaround is only a signal if the user is still paying for it.
- A missing capability or a feature you wish existed. We are in a stabilisation
  freeze, so these are parked on arrival — filing one adds a ticket nobody will
  action.
- Behaviour that surprised you but was correct, or that you have not actually
  diagnosed. An unverified hunch costs a maintainer the whole investigation.
- A one-off you cannot reproduce. Note it; if it happens again, that second
  occurrence is the report.

**One report per root cause.** If several symptoms trace to one component in one
session, file ONE report covering them, not one per symptom. Three separate
reports for three faults in the same backend are three triage passes for one
fix.

Still NOT bug reports (route elsewhere): ordinary generation and workflow
failures such as OOM, a missing model or node, bad params, or user mistakes go
to `troubleshooting`. Third-party and custom-node bugs go to their GitHub
(Step 6), where you still offer and ask first rather than auto-file.

The intake Worker dedupes server-side, so you need not research duplicates — but
that is not a licence to file freely. Over-reporting is now the expensive
failure mode: every low-value report costs a maintainer a read, a triage, and a
close, and it buries the reports that matter. When genuinely in doubt, tell the
user what you saw and let them decide.

## Step 1 — Diagnose (root cause, not symptom)

- Read the exact error and stack. For ComfyUI runs: `get_history(action="diagnose")`, `get_system_stats (action:"logs")`.
- Follow the stack to the actual file and line. Read the code there.
- Form a concrete root cause and a minimal fix you can defend.

## Step 2 — Classify whose bug it is

- **Ours.** `comfyui-mcp` (server/tools/orchestrator/agent),
  `comfyui-mcp-panel` (the sidebar pack / panel JS / `__init__.py`), or
  `comfyui-mcp-issue-worker` (the intake Worker). Go to Steps 3 to 5 (self-heal, then Worker or PR).
- **Third-party.** A custom node pack, or ComfyUI core itself. Go to Step 6 (their GitHub; our Worker cannot file there).

## Step 3 — Fix it locally FIRST (this is the default, not "when you can")

For any defect in OUR repos (`comfyui-mcp` / `comfyui-mcp-panel` /
`comfyui-mcp-issue-worker`), the default is to fix it before or alongside
filing. Patch the code where it actually runs so the user is unblocked at once
and the report arrives as a near-PR (code plus diff) rather than a ticket. Do
this every time; do not wait to be asked and do not downgrade it to optional.

- `comfyui-mcp`: find the running install from the stack path. If a source
  checkout exists, fix the `.ts` source and `npm run build`; if only the built
  package is present, patch the `dist/*.js` directly. The patch takes effect on
  the next respawn that reloads it. `panel_reload` covers the agent and its
  comfyui tool server, but the long-lived orchestrator process (which serves
  the `panel_*` tools) only reloads code on a full process restart. Disconnect
  followed by Connect does NOT restart it either; say so when the patch is in
  that process.
- `comfyui-mcp-panel`: patch the file under the pack (`web/js/…` for UI,
  `__init__.py` for the pack). UI changes need a hard refresh.

**Exactly ONE attempt. Do not spiral.** Make one focused, minimal, reversible
patch. If that single attempt does not land, or the bug is upstream-only (in
the SDK, in ComfyUI, or it needs a release you cannot make from here), stop
patching, mark it `upstream-only`, and include the precise change needed in the
report instead. A future update will overwrite a local patch. That is expected;
the user runs the patched version in the meantime. Capture the diff
(`git diff`, or diff the file you touched) so Step 5 can attach it.

THIRD-PARTY and ComfyUI-core defects are the exception. There you still offer
and ask first before patching or filing (Step 6).

## Step 4 — Verify the fix

- `comfyui-mcp`: run the safety gate, which is `npm run build` (exit 0),
  `npm test`, and `npm run test:agent`. Do not claim a fix that fails the gate.
- Otherwise: re-run the operation that failed and confirm it now works.

## Step 5 — Report it to US (autonomous)

**Always scrub secrets first.** You are sending this off-machine without a
human reading it, so this is non-negotiable. Replace any `sk-…`, `ghp_…`,
`github_pat_…`, `Bearer …`, `ANTHROPIC_API_KEY`, `CIVITAI_API_TOKEN`, `HF_TOKEN`,
`.env`/`.dev.vars` contents, `Authorization:` headers, and `?token=`/`?key=`
query params with `[REDACTED]`; shorten home paths to `~/…`. The intake Worker
runs a second secret-scrub server-side as a backstop, but never rely on it.
Scrub here, every time.

Build the body (reuse this shape). When you fixed it, include the diff so we
can reproduce and merge:

```
### What happened / root cause
### Steps to reproduce
### Exact error (scrubbed)
### Fix
<applied locally: yes/no>  <upstream-only: yes/no>
<the diff / patch, or the precise change needed if upstream-only>
### Environment
OS / ComfyUI version / **ComfyUI FRONTEND version** / GPU+VRAM / **comfyui-mcp
version** / **panel version**.

The FRONTEND version is a separate package from ComfyUI itself and they move
independently — `get_system_stats (action:"health")` prints both on the ComfyUI
line. Include it for ANY panel/UI bug. It is not a formality: comfyui-mcp-panel#779
was a blank agent panel on a fresh install where ComfyUI was 0.30.0 on the broken
machine and 0.30.2 on a working one — indistinguishable, and not the cause. The
frontend was 1.50.3 vs 1.47.12, which was the whole answer, and it took an hour of
eliminating the install, two browsers, the cache and the orchestrator to get to a
number that one line of output already had.
Always include BOTH our versions — a bug is only actionable if we know which mcp +
panel build it came from. They're already in your **ENVIRONMENT line** (the
`mcp <ver> · panel <ver>` segment), so just copy them from there. Fallbacks if the
ENV line is missing them: mcp = its `package.json` `version` (or `install_comfyui (action:"environment")`);
panel = `PANEL_VERSION` near the top of the pack's `comfyui-mcp-panel.js`.
```

Then file it. The report itself is autonomous via the Worker (below). It files
under the PROJECT's own server-side identity, so no user GitHub account is
touched and nothing is done as the user. That is the default and needs no ask.

- **Default path for everyone is the Worker.** POST the report to our intake
  Worker. No GitHub account needed; it files and dedups under the project
  identity, never yours. This is the autonomous path. Use it for every our-repo
  bug REPORT.
- **Engineer path, ONLY with the user's explicit go-ahead, and only if THEY
  want to author a fix PR under THEIR GitHub account.** Running `gh` files,
  forks, and PRs as whatever account is currently `gh`-authed on this machine.
  That is acting as the user's GitHub identity, so it is NOT autonomous and NOT
  a Worker fallback. Before ever running `gh` to file, fork, or PR: run
  `gh auth status`, tell the user which account it would act as, and proceed
  only if they explicitly agree to submit as that account. If they only want
  the bug reported (not to personally author a PR), use the Worker. Never fork,
  PR, or `gh issue create` under an ambient account they did not choose. If the
  fix is clean and they agree: branch or `gh repo fork`, apply the fix, run the
  gate (Step 4), push, `gh pr create --fill`. **Never merge**; it is for our
  review. A Worker 403 or failure falls back to the `report_issue` prefilled
  link below, NEVER to an unprompted `gh` command.

  The Worker POST needs no GitHub account.

  The Worker files the issue synchronously. On success the POST response ALWAYS
  carries the issue `url` inline (`{ ok:true, url, number, deduped?, job_id }`),
  so the manual path is one POST with no polling. This shell snippet is the
  manual, non-Claude fallback and requires `jq` for safe JSON parsing. Claude
  agents should use the `report_issue` tool, which already implements this
  correctly.

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
  # The User-Agent is EXPLICIT and load-bearing (#937). Cloudflare bans some
  # default client signatures outright — a Python `urllib.request` POST to this
  # endpoint returns 403 with `error code: 1010` (the browser-signature ban),
  # while the byte-identical request with any ordinary UA succeeds seconds later.
  # Sending a named UA keeps every client path on a known-good signature instead
  # of whatever its stdlib happens to advertise.
  RESP=$(curl -fsS --max-time 15 -X POST "$WORKER_URL" \
    -H "Content-Type: application/json" -H "X-Client-Key: $CLIENT_KEY" \
    -H "User-Agent: comfyui-mcp-report-bug/1.0" -H "Accept: application/json" \
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
  **On Windows, use this instead. It needs no `jq` and no Python** (#937). The
  `jq` requirement above is what pushed Windows agents onto Python's
  `urllib.request` in the first place, and that client's default User-Agent is
  exactly the signature Cloudflare rejects. PowerShell parses JSON natively, so
  this path has neither problem:

  ```powershell
  $WorkerUrl = if ($env:COMFYUI_MCP_ISSUE_WORKER_URL) { $env:COMFYUI_MCP_ISSUE_WORKER_URL }
               else { "https://comfyui-mcp-issue-worker.artokun.workers.dev" }
  $ClientKey = if ($env:COMFYUI_MCP_ISSUE_CLIENT_KEY) { $env:COMFYUI_MCP_ISSUE_CLIENT_KEY }
               else { "9b6f2abf09b64006dc6e033f59d2dc8112e34d8347a923c2" }

  # Invoke-RestMethod parses the JSON body itself and THROWS on a non-2xx, so
  # both failure shapes land in the same catch — no partial-output window.
  try {
    $resp = Invoke-RestMethod -Method Post -Uri $WorkerUrl -TimeoutSec 15 `
      -ContentType "application/json" `
      -Headers @{ "X-Client-Key" = $ClientKey; "User-Agent" = "comfyui-mcp-report-bug/1.0"; "Accept" = "application/json" } `
      -InFile $BodyJsonFile
  } catch { $resp = $null }

  # Same single "filed" condition as the bash path: ok==true, status not "error",
  # and a url matching the exact GitHub issue shape. Anything else falls back.
  if ($resp -and $resp.ok -eq $true -and $resp.status -ne "error" -and
      $resp.url -match '^https://github\.com/[^/]+/[^/]+/issues/\d+$') {
    "filed: $($resp.url)"
  } else {
    "worker did not return an issue link — fall back to the report_issue tool for a prefilled GitHub link"
  }
  ```

  A real `url` from the POST is the only "filed" outcome. Any submit failure
  (`401`, non-2xx, timeout, unreachable), `ok` not `true`, a `status:"error"`
  body, a missing or invalid url, or invalid JSON means fall back to
  `report_issue` for a prefilled link the user submits in one click. Never tell
  the user it was accepted without a real issue link. A `GET /status/<job_id>`
  endpoint exists to re-fetch the link later, but it is NOT needed to file, so
  do not poll. Show the link only if they want it. The filing is autonomous,
  so a one-line "filed #123" is enough (Step 7).
- **Fallback** (no `gh`, no Worker URL): use the `report_issue` tool for a
  prefilled GitHub issue link the user can submit in one click.

## Step 6 — Third-party / ComfyUI-core bugs (offer + ASK first — not autonomous)

Our Worker only files into OUR repos, so these go to their GitHub. Unlike
our-repo defects (Steps 3 to 5, which you handle autonomously), third-party
bugs are offer-and-ask at every step. Patching someone else's node and posting
to someone else's tracker are the user's calls, not yours.

- **Ask before patching.** You may offer a local workaround (for example, patch
  the custom node so the user is not blocked), but apply it only once the user
  says yes. Same keep-the-patch logic once approved.
- **Ask before filing.** Identify the node or project's GitHub repo (from its
  metadata, `install_custom_node` (`action: "list"`), or its folder). Then, with
  the user's go-ahead, use `report_issue` with that `owner/repo` (it returns a
  prefilled link the user reviews and submits; it does not auto-file into
  third-party repos), OR `gh issue create -R owner/repo` if `gh` is authed and
  they agree.
- If the user has no GitHub account, offer to walk them through creating one
  (github.com/signup) so they can file it. That is how the bug reaches the
  people who can fix it. We cannot file it for them.

## Step 7 — Inform the user (the only message they need)

A short, concrete summary, not a request. For example:

> Hit a bug in `panel_set_widget` (it errored on subgraph inner nodes). I
> patched it locally so it works now, and filed a bugfix report on your behalf
> (#123). You're running the patched version; a future update will replace the
> patch once we ship the fix upstream.

If upstream-only, say it is logged with us (or the third-party project) and
what the temporary workaround is, if any.

## Absolute rules

- Scrub secrets before anything leaves the machine, every time.
- Never merge a PR; humans review.
- Patches stay minimal and reversible; never touch the user's workflow data
  without asking.
- Do not claim a fix you did not verify (Step 4).
- Do not file to be thorough. A report is a claim on a maintainer's
  attention; if you cannot say what it cost the user, it is not one.

## Sources

- **Official:** comfyui-mcp intake Worker and this skill (this repo).
- **Empirical:** none. Product reporting policy, not reverse-engineered from a vendor graph.
