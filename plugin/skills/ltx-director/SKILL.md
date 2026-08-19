---
name: ltx-director
description: Drive the LTX Director (Timeline) node — its Add Image/Text/Audio buttons are DOM-only and cannot be clicked by an agent; edit the hidden timeline_data JSON widget instead. Load when a workflow contains LTXDirector / LTXDirectorGuide / PromptRelayEncodeTimeline, or when asked to add, move, retime, or remove timeline segments (image / text / audio / motion).
---

# LTX Director (Timeline)

`LTXDirector` (pack: **WhatDreamsCost-ComfyUI**, category `WhatDreamsCost`) is a
video *timeline editor* node. Its on-canvas UI has **Add Image**, **Add Text**
and **Add Audio** buttons.

## You cannot click those buttons. Don't try.

They are not node inputs. The pack builds them as raw DOM elements with JS
handlers:

```js
addTextBtn.addEventListener("click", () => this.addTextSegmentFreeSpace());
```

Panel/MCP tools drive the LiteGraph **node model** (widgets + inputs). They
cannot invoke arbitrary DOM handlers, so "click Add Text" is impossible — this
is a hard limitation, not flakiness. Say so plainly rather than retrying.

## The real control surface: `timeline_data`

Everything those buttons do is serialized into ONE string widget, `timeline_data`.
The pack's own code treats it as *"the absolute source of truth"*. Set it and the
editor renders it.

It is listed in the pack's `HIDDEN_WIDGET_NAMES`, so it does **not** appear in the
node's visible widget list — but it is an ordinary input and is settable:

```
create_workflow(action="modify", workflow=<the graph>, operations=[
  { op: "set_input", node_id: "42",
    input_name: "timeline_data", value: "<json string>" },
])
```

The value is a JSON **string**, not an object. Empty state is `"{}"`.

Sibling hidden widgets: `local_prompts`, `segment_lengths`, `guide_strength`,
`audio_data`, `use_custom_audio`, `inpaint_audio`, `use_custom_motion`,
`override_audio`.

## Schema (verified against a real production workflow)

```jsonc
{
  // TRACK GATES — a track's segments are IGNORED unless its gate is true.
  "mainTrackEnabled": true,
  "audioTrackEnabled": false,
  "motionTrackEnabled": false,

  // must mirror the node's start_frame / duration_frames widgets (see Edges)
  "normalStartFrame": 0,
  "normalDurationFrames": 4393,

  "global_prompt": "",
  "overrideAudio": false,
  "inpaint_audio": false,

  // retake mode
  "retakeMode": false, "retakeStart": 24, "retakeLength": 48,
  "retakePrompt": "", "retakeStrength": 1, "retakeVideo": null,
  "retake_global_prompt": "",

  // display-only
  "propHeight": 90, "globalPropHeight": 60, "showFilenames": true,

  "segments": [],        // main track: image AND text segments
  "motionSegments": [],
  "audioSegments": []
}
```

### Text segment (`segments`)

```json
{ "id": "seg1", "start": 0, "length": 48, "prompt": "wide shot, neon city", "type": "text" }
```

### Image segment (`segments`)

```json
{
  "id": "1784657553220x4fxu",
  "start": 0,
  "length": 241.68,
  "prompt": "",
  "type": "image",
  "imageFile": "whatdreamscost/Nintendo_ZeldaUrbosaHotspringKF_00002_.png",
  "imageB64": "/api/view?filename=Nintendo_ZeldaUrbosaHotspringKF_00002_.png&type=input&subfolder=whatdreamscost"
}
```

**`imageB64` is a misnomer — it holds a `/api/view` URL, not base64.** So an
image segment just points at a file already in ComfyUI's **input** dir. Full
agent-drivable recipe:

1. `upload_image (action:"image")` → puts the file in the input dir (note its `subfolder`/name)
2. `imageFile` = `"<subfolder>/<name>.png"`
3. `imageB64` = `"/api/view?filename=<name>.png&type=input&subfolder=<subfolder>"`

### Audio segment (`audioSegments`)

```json
{
  "id": "17846562234967gjvk", "type": "audio",
  "start": 0, "length": 4393, "trimStart": 0, "audioDurationFrames": 4393,
  "audioFile": "whatdreamscost/Intergalactic Hip Hop.mp3",
  "fileName": "Intergalactic Hip Hop.mp3",
  "waveformPeaks": [0.047, 0.274, 0.537, "…~200 floats…"]
}
```

`waveformPeaks` is the rendered waveform. It is cosmetic — omit or pass `[]` if
you're writing a segment programmatically; the audio still plays. Don't fabricate
plausible-looking peaks and imply they were measured.

## Edges (get these wrong and it silently does nothing)

1. **Track gates.** Pushing into `audioSegments` does nothing while
   `audioTrackEnabled` is `false`. Set the gate in the same edit. (The reference
   workflow ships an audio segment with the track OFF — easy to misread as broken.)
2. **Frame bookkeeping must agree.** `normalDurationFrames` ==
   `duration_frames` widget == `segment_lengths` widget (observed: all `4393`),
   and `normalStartFrame` == `start_frame`. Change the timeline length and you
   must update all of them.
3. **Frames, not seconds.** `start` / `length` are pixel-space frames and may be
   fractional (`241.68`). `duration_seconds` / `frame_rate` / `time_units` are
   display concerns.
4. **`global_prompt` exists twice** — inside `timeline_data` and as a `forceInput`
   socket on the node. In the reference workflow the socket is wired from a
   `PrimitiveStringMultiline`; prefer the wired source and keep them consistent.
5. **`guide_data` must go somewhere.** `LTXDirector.guide_data` →
   `LTXDirectorGuide`. That partner node is what injects the keyframes.
6. **Unsupported by the pack.** The widget tooltip says *"auto-managed; do not
   edit by hand"*. Well-formed blobs load fine; malformed JSON will break the
   editor. Round-trip and re-read after writing, and tell the user this is
   unofficial.

## Reference wiring (from a working LTX 2.3 Director graph)

```
Power Lora Loader (rgthree) ─ model ─┐
DualCLIPLoader ──────────── clip ────┤
VAELoaderKJ ───────────── audio_vae ─┤   LTXDirector #42
PrimitiveStringMultiline ─ global_prompt ─┘
        │ model         → LTX2_NAG
        │ positive      → ConditioningZeroOut, LTXVConditioning
        │ audio_latent  → LTXVConcatAVLatent
        │ guide_data    → LTXDirectorGuide   ← required partner
        │ frame_rate    → AudioToFrameCount, VHS_VideoCombine
        └ combined_audio→ AudioToFrameCount, PreviewAudio, …
```

## Procedure

1. Find the node: `get_workflow (action:"query")` with `types: ["LTXDirector"]`, `fields: "detail"`
   (or `panel_query_graph` on the live canvas).
2. Read the current `timeline_data`, `JSON.parse` it — **never** hand-splice the string.
3. Mutate the parsed object (append a segment, flip a track gate, retime).
4. Keep `normalStartFrame` / `normalDurationFrames` in sync with the widgets (edge 2).
5. Write it back as a string via `set_input`.
6. Re-read to confirm it round-trips, then `create_workflow (action:"validate")`.

## Related

`PromptRelayEncodeTimeline` (pack: ComfyUI-PromptRelay) carries the **same**
`timeline_data` hidden-widget pattern — this skill's approach applies there too.

More broadly: any node whose controls are DOM widgets over hidden state is
invisible to clicking and must be driven through its state widget. LTX Director
is just the clearest example.

## Sources

- **Official:** none found.
- **Empirical:** timeline_data schema and edge rules from a working LTX 2.3 Director graph.
