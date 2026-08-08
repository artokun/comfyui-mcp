# Tool-reach benchmark

100 realistic user requests against the consolidated **37-tool** surface, to answer the
question the 0.50.0 consolidation raises: *folding 154 tools into 37 makes the list
easier to hold in a context window — but can an agent still reach the RIGHT one?*

`tool-reach.jsonl` — one request per line:

```json
{"id":17,"request":"Find me a good anime LoRA","expect":"search_custom_nodes",
 "alt":["download_model"],"why":"AMBIGUOUS: model search vs node search"}
```

`expect` is the tool I judge correct. `alt` lists tools a reasonable agent could pick
instead — its presence is the interesting signal, not a scoring detail.

## Coverage (checked, not asserted)

- 100 rows; **every one of the 37 tools is exercised at least once** (no blind spots);
- every `expect` value exists in the live `TOOL_NAMES` — the corpus cannot silently rot
  against a rename, because the check fails loudly;
- 11 rows carry an `alt`; 7 are explicitly flagged AMBIGUOUS or CONTROL.

## How to run an arm

```
node benchmarks/run-arm.mjs --base http://127.0.0.1:11434/v1 --model qwen3:4b
node benchmarks/run-arm.mjs --base https://api.moonshot.ai/v1 --model kimi-k2 --key $KIMI_KEY
```

Any OpenAI-compatible `/chat/completions` endpoint. The model sees the 37 tool names and
the request — never `expect`, `alt` or `why`.

**It is not run automatically, and that is deliberate.** A hosted arm is 100 billable
calls; a local arm puts a model resident on the GPU, which on a single-GPU box competes
with ComfyUI for VRAM (the orchestrator already pauses Ollama during renders for exactly
that reason). Both are decisions for whoever owns the machine and the budget.

Scoring is three-way rather than pass/fail: `hit`, `alt` (the SURFACE is ambiguous
there, not the model — counting these as misses blames the model for the benchmark's own
design), and `miss`. An unparseable answer is counted separately from a wrong tool,
because "could not follow the format" and "picked the wrong tool" need different fixes.
Read the printed misses, not the rate.

### Method notes


Give a model ONLY the 37 tool names + descriptions and each `request`, ask which single
tool it would call first, and compare to `expect`. Treat a hit on `alt` as a partial,
not a miss — those rows are ambiguous **by construction** and are there to measure the
ambiguity, not the model.

## Why my own arm is weak evidence, and what to trust instead

I wrote both the requests and the answer key, so scoring myself measures agreement with
my own intuitions. It is not blind and should not be quoted as an accuracy number. The
corpus exists so the **Kimi and local-Ollama arms are blind** — those are the real test,
and the comparison across model sizes is the point (does a 4B model still land the right
tool with 37 choices, where it could not with 154?).

## Measured arms

### qwen3:4b (local Ollama) — 2026-08-07

| outcome | count |
|---|---|
| hit (`expect`) | **70** |
| alt (an `alt` the row lists as reasonable) | 3 |
| miss | 27 |
| **unparseable** | **0** |

Run against the 37-tool surface with `benchmarks/run-arm.mjs`, on a machine where nothing
else held the GPU.

**The headline is not 70%.** It is that a 4B model produced **zero** unparseable answers —
every response named a real tool from the list. "Could not follow the format" and "picked
the wrong tool" need different fixes, and only the second one is present here. A surface
small enough to hold is a surface a small model can at least *address*.

Read the misses, though, because two of them are about the surface rather than the model:

- **#9 "Cancel the job that's running"** → chose `comfy_cli`. Cancelling a run is a live
  queue operation; the model reached for the tool whose name sounds most like "control the
  server".
- **#10 "Clear everything pending"** → chose `clear_vram`. "Clear" is doing the work in
  that sentence, and the surface has a prominent tool that starts with it.

Both are collisions between a user's verb and a tool's name, not reasoning failures — the
kind of thing the corpus exists to surface. Neither is a consolidation regression; both
would have happened at 154 tools too, with more competitors.

### Not yet run

- **Kimi (hosted)** — blocked. Both stored credentials (`MOONSHOT_API_KEY`,
  `OPENROUTER_API_KEY`) are placeholders that return HTTP 401. Needs a real key; it is the
  arm most worth having, because it is the one that is genuinely blind to the answer key.
- **qwen3:8b / llama3.1:8b** — not run. The size ladder is the interesting comparison and
  a single 4B point does not make one.
- **`artokun/gemma4-comfyui-mcp:e4b`** — started and abandoned after ~100 minutes with no
  output while holding the GPU. Not a result, and recorded here only so nobody assumes it
  was measured.

A caution for whoever runs the rest: launching several arms at once makes them fight over
one GPU and turns a two-minute run into a timeout. Run them one at a time.

## What the ambiguity map already shows

Three gaps surfaced while building the corpus. None is a consolidation regression — each
is a request users make that the 37-tool surface has no clean home for:

1. **No error/log retrieval.** *"Show the last error from the server"* (#86), *"my image
   came out black"* (#77). An agent's best move is `get_history`, which is not what was
   asked. Everything else routes through a live panel session.
2. **"Which models is this workflow missing?"** (#92) needs a join of `get_workflow` and
   `list_local_models`, done by hand every time. It is one of the most common real
   questions and has no single tool.
3. **Capability discovery.** *"What can you do?"* (#100) has no answer in the surface —
   `list_packs` is the nearest and is about packs, not capabilities.

Separately, **live-canvas editing is deliberately absent from these 37** (#75, #76):
adding a node or setting a widget on the open canvas is a `panel_*` tool. That is by
design, but it means an agent holding only the core surface cannot edit a graph, and the
descriptions do not say so — a caller reaching for `create_workflow` to "change the seed
on my sampler" is being sent to build a new workflow instead of editing the open one.
