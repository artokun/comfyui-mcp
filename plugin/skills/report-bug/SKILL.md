---
name: report-bug
description: Issue reporting is disabled during limited maintenance of comfyui-mcp and the local Agent Panel. When the user hits a defect, explain that no report will be filed and continue helping with the task. Do not call report_issue to file, draft a report, collect reporting information, or submit through another tool. Triggers on "report this", "fix this bug", or errors in our software.
---

# Limited maintenance — reporting remains disabled

comfyui-mcp and the Agent Panel receive selected, verified critical fixes for the
local panel and provider choice. This is not a broad feature roadmap. Support will
be reassessed when Comfy's official local panel becomes publicly available.

`report_issue` stays registered for compatibility, but files nothing, contacts no
service, and returns no prefilled issue link. Worker environment variables do not
turn reporting on. Do not retry it or submit the report through another tool.

Continue helping with the user's task using the available tools. Explain observed
limitations and offer a verified workaround when available. Do not collect
versions or diagnostic material solely for a report that cannot be submitted.
Ordinary troubleshooting remains available. Never claim an unverified fix or change
the user's workflow without authorization.

Official Comfy Agent and MCP tooling remain alternatives. Check their current
availability before recommending them: https://docs.comfy.org/agent-tools.

## Sources

**Official:** Comfy agent tooling availability: https://docs.comfy.org/agent-tools

**Empirical:** The registered `report_issue` handler in `src/tools/report-issue.ts` returns a disabled result without outbound requests. Its handler tests cover configured worker variables and both filing inputs.
