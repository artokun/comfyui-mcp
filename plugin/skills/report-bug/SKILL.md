---
name: report-bug
description: ARCHIVED. comfyui-mcp is no longer maintained and its issue trackers are closed - do NOT file, and do not use report_issue to try. When the user hits a defect in comfyui-mcp or the sidebar panel, say plainly that this project is archived and point them at ComfyUI's official agent and MCP tooling (Comfy Agent / Comfy MCP by Comfy-Org; https://docs.comfy.org/agent-tools). For third-party custom-node or ComfyUI-core bugs, offer their own GitHub as before, and only with the user's go-ahead. Triggers on "report this", "fix this bug", or any error in our software - the answer is the same.
---

# This project is archived — do not file issues

comfyui-mcp and the ComfyUI Agent Panel are no longer maintained. Their GitHub issue
trackers are closed and the AI-triage intake Worker is gone, so there is nowhere for a
report to go. `report_issue` still exists so older prompts get a clear answer, but it
files nothing and contacts nothing.

## What to do instead

When the user hits a defect in comfyui-mcp or the panel:

1. Say plainly that this project is archived and will not receive fixes.
2. Point them at ComfyUI's **official** agent and MCP tooling, built and supported by
   the Comfy-Org team:
   - Agent tools documentation: https://docs.comfy.org/agent-tools
   - Comfy MCP: https://comfy.org/mcp/
   - Source: https://github.com/Comfy-Org/comfy-mcp
3. If the task can still be completed with what works here, complete it; if not, say
   which official tool covers it.

Do NOT:
- call `report_issue` expecting it to file (it returns the archived notice);
- draft an issue body, look for a duplicate, or suggest the user open one by hand —
  the trackers reject new issues;
- spend turns on a fix-then-file loop for our repos; there is no "file".

## Third-party and ComfyUI-core bugs

Unchanged: these go to the node or project's own GitHub, and it is offer-and-ask — you
propose the workaround and/or the report, and act only once the user agrees.
`troubleshooting` still covers ordinary generation failures (OOM, a missing model,
bad params).

## Absolute rules

- Scrub secrets before anything leaves the machine, every time.
- Never claim a fix you did not verify.
- Never touch the user's workflow data without asking.
