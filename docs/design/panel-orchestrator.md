# Panel orchestrator — autonomous background agent for the ComfyUI panel

Status: **implemented (P0)**. The ComfyUI sidebar panel is driven by autonomous
**background agents** so the user's interactive Claude session stays free — the
way the Linear app quietly works a ticket on its own.

Transport: the **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`),
streaming-input mode, on the user's **Claude subscription** (no API key, no
binary patch). See the blog post `docs/blog/panel-agent-subscription.mdx` for the
narrative (and the two dead ends that preceded this).

---

## Why the panel "connected but didn't reply"

The old `--channels` model embedded the bridge in whatever interactive Claude
session spawned the MCP server, and relied on a `notifications/claude/channel`
push to drive it. That fails because a channel push **can't wake an idle
session** (and needs a dev-only flag absent from stable Claude Code). So the
panel showed "connected" (socket open) while nothing was *attending*:
`panel_inbox` queued messages no one polled.

## Transport: Claude Agent SDK streaming input

We need a persistent background agent with (a) a live "channel in" to push
messages over time, (b) interrupt/inject into a running turn, (c) subscription
auth with no API key, (d) no `--sdk-url` (guarded on current Claude Code) and no
binary patch. `query({ prompt: <async generator>, options })` is exactly that:

- **Channel in** — the async generator stays open; pushing a new message = the
  agent's next turn. It idles between messages and wakes on send, which is what
  the channel-notification approach could not do.
- **Interrupt/inject** — the object `query()` returns exposes `interrupt()`.
- **Subscription, no key** — with `ANTHROPIC_API_KEY` unset, the SDK reads the
  on-disk `claude.ai` OAuth login. Verified: the session reports
  `apiKeySource=none` on this machine. (For a durable token instead of the
  interactive login, `claude setup-token` → `CLAUDE_CODE_OAUTH_TOKEN`.)

Dead ends (do not revisit): `--sdk-url=127.0.0.1` is guarded ("not an approved
Anthropic endpoint") and only works if you patch the claude binary — not
shippable. `notifications/claude/channel` can't wake idle and needs an
unavailable dev flag.

## Architecture (what we built)

The Agent SDK collapses the old CCR-v2 design — no local HTTP/SSE worker
ingress, no process manager, no spawn/reap. What's left:

```
comfyui-mcp --panel-orchestrator   (standalone, long-lived background process)
  ├── UI bridge (port 9101)               # owns the bridge; sees panel messages directly
  └── tab_id → PanelAgent (Agent SDK)      # one persistent streaming session per ComfyUI tab
```

- **`src/orchestrator/index.ts`** (`runPanelOrchestrator`): unsets
  `ANTHROPIC_API_KEY` (subscription lane), starts the bridge, and **fails loudly
  if it can't bind** the bridge port (owning it is the whole job). On a panel
  `user_message` it echoes the message back to the tab and routes it to that
  tab's agent.
- **`src/orchestrator/panel-agent.ts`** (`PanelAgent` / `PanelAgentManager`):
  one streaming `query()` session per `tab_id`, spawned lazily on the tab's
  first message. Options: `model: claude-opus-4-8`, `permissionMode:
  "bypassPermissions"`, `strictMcpConfig: true`, `mcpServers: { comfyui: … }`
  (this build run as a stdio MCP in **non-channels** mode, so it generates
  against the live ComfyUI over `COMFYUI_URL` and never contends for the bridge
  port). Assistant text blocks are relayed into the panel chat as `say` frames;
  the session id is captured from the init message for resume.

### The bridge-ownership rule

The orchestrator must **own** port 9101. The interactive MCP server must
therefore **not** run with `--channels` (that would hold the port). The bridge
now exposes `whenReady()` so the orchestrator can detect a lost bind and exit
with a clear message instead of running uselessly. Override the port with
`COMFYUI_MCP_BRIDGE_PORT` (used by the headless test harness).

## Config / env

- `--panel-orchestrator` (or `COMFYUI_MCP_PANEL_ORCHESTRATOR=1`) — run the
  orchestrator instead of an MCP server.
- `COMFYUI_URL` — live ComfyUI the spawned agents generate against.
- `COMFYUI_MCP_PANEL_MODEL` — override the panel agent model (default
  `claude-opus-4-8`).
- `COMFYUI_MCP_BRIDGE_PORT` — bridge port (default 9101).

## Testing

- **Headless** (no browser): `scripts/panel-sim.mjs` connects to the bridge,
  sends `hello` + `user_message`, and asserts the agent's reply comes back as a
  `say` frame — the full loop (bridge → manager → Agent SDK session on
  subscription → reply). Run the orchestrator on a spare `COMFYUI_MCP_BRIDGE_PORT`
  and point `BRIDGE_URL` at it. Verified PASS with `apiKeySource=none`.
- **End-to-end** (claude-in-chrome): open ComfyUI with the panel, type a
  request, and assert a background `claude` process (not the interactive
  session) generates and replies in the panel.

## Next increments

1. **Panel-client mode / live-graph driving** — give the agent the `panel_*`
   graph tools backed by the orchestrator's bridge (an in-process SDK MCP
   server via `createSdkMcpServer`, tagged with the tab) so it can edit the live
   graph, not just generate + reply.
2. **Resume across restarts** — persist each tab's captured `session_id` and pass
   it as `resume` when the orchestrator restarts.
3. **Reaping** — stop a tab's agent on disconnect (needs a bridge disconnect
   hook); today agents persist and a reconnecting tab reuses its agent.
4. **Docs/terminology sweep** — reframe panel marketing from "your session talks
   back" to "background orchestrator agent drives the panel" (keep the
   `--channels` flag name for the bridge).
