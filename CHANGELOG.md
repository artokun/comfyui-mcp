# Changelog

All notable changes to this project are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and the format follows
[Keep a Changelog](https://keepachangelog.com/).

## 0.51.35

### Fixed

- **`panel_set_workflow_target({mode:"current"})` rebinds an unsaved tmp: tab after a multi-workflow reconnect (#1650).**
  An unsaved canvas never has path/filename. After a reconnect the top-level
  `active` record often omitted `key`/`routing_key` as well — the panel had not
  yet established a reply identity — while the unique flagged-active list row
  still published `tmp:<uuid>`. Corroboration treated that as "no comparable
  identity field" and refused to adopt the live fence, so the documented
  recovery left the next graph call fenced to the previous workflow.

  `mode:"current"` now treats a `tmp:` handle on either side as the comparable
  identity for that unique unsaved active tab, and adopts the uuid the panel
  did publish. A saved path on either side, or two disagreeing uuids, still
  fail closed. Filename-only records stay uncorroborated: that name collides
  across tabs.

- **An orchestrator that never finishes starting no longer lingers silently (#1524).**
  A respawned instance was found alive for hours holding no listening ports at all,
  while an older one still owned them. Nothing was wrong from the sidebar's point of
  view, and nothing reported a problem -- the process simply sat there, burning a slot
  and making "which one is the orchestrator?" ambiguous for anything that looks by
  process name.

  Failing to claim the port was already handled: that path retries, tries to take the
  port over, and exits with a clear message. A process holding NO port never got that
  far, so there was nothing to catch it. There is now a deadline covering startup
  itself: if the bridge port has not been claimed within the window, the process says
  why and exits instead of staying. It names the process holding the port when it can
  identify one -- which is also when "your other copy is on an older version" becomes
  worth saying -- and says plainly that the stall is earlier than the port when nothing
  is holding it.

  Tunable with `COMFYUI_MCP_STARTUP_DEADLINE_MS` for a genuinely slow machine, and a
  value outside a sane range falls back to the default rather than being taken
  literally: a number large enough to overflow, or smaller than a millisecond, would
  otherwise be rounded into an immediate exit -- the guard causing the very outage it
  exists to prevent.

  Deliberately scoped: this catches a startup that hangs waiting on something. It
  cannot catch one wedged in a tight loop with the event loop blocked, and the code
  says so rather than implying otherwise.

- **A misleading warning when the panel port is already taken (#1524).** It claimed the
  session would keep working with only `panel_*` unavailable. No such mode exists -- the
  process does not continue without that port -- and the sentence sent this session's
  own debugging down a false path within minutes. It now reports what was actually
  observed and leaves the outcome to the code that decides it.

## 0.51.34

### Fixed

- **`list_tools` search finds the tool you named, and stops returning half the catalog (#1525).**
  Searching `"download model"` returned only `runpod` -- while the unfiltered catalog
  plainly contains `download_model`. The filter was matching the phrase literally, and
  tool names are identifiers: `download_model` is spelled with an underscore, so the
  phrase never occurred in it, whereas another tool's prose happens to say "download
  model" as ordinary English. The one tool you obviously wanted was the one excluded,
  and the only result was the coincidence.

  Underscores and hyphens are now folded on both sides, so you can type a tool's name
  the way you say it, and the words are matched individually rather than as a fixed
  phrase. Dots and slashes are deliberately left alone, so a literal query like `v1.2`
  still means what it says.

  Matching every word across names, descriptions and parameter docs turned out to be
  barely a filter on its own -- `"install node"` matched 19 of 37 tools, since those are
  ordinary words in a dozen descriptions. So a tool whose NAME matches now wins outright:
  `"download model"` gives you `download_model`, `"install node"` gives you
  `install_custom_node`. When no name matches -- `"checkpoint"`, `"free vram"` -- the
  search still looks through descriptions and parameters, which is the case that made
  searching them worthwhile.

  When results were chosen by name, the reply says so and tells you how many other tools
  also matched, so a short list is never mistaken for the whole answer.

## 0.51.33

### Fixed

- **An install ComfyUI-Manager accepted but never queued no longer looks like it worked (#1129).**
  On legacy ComfyUI-Manager 3.x, `panel_install_node` could report an install as queued
  while the Manager silently dropped it -- the queue then sat idle having seen no task
  at all, and nothing appeared under `custom_nodes`. The panel's "queued" is an
  acknowledgement, not a receipt, and it was being passed on as though it were one.

  The reply now carries what a follow-up read actually found. It is careful about how
  much that proves: the same counters are cleared by a queue reset, which other
  operations here can issue, so an install that really did run can look identical. So it
  says what was observed, says plainly that this settles nothing on its own, and asks for
  the one check that does -- `panel_list_nodes`. It does not guess at the cause, and it
  does not report a failure it cannot demonstrate; a wrong "this definitely failed" would
  cost a needless reinstall, which is the same harm as the false success in the other
  direction.

  A related fix from 0.50.40 handled the case where the Manager REFUSES the install
  outright (it falls back to a direct clone). This is the opposite shape -- accepted, then
  dropped -- which that path could never catch, because nothing was refused.

  The follow-up read is also pinned to the exact panel the install went to, so a browser
  tab that reconnects or is replaced mid-install can never have its empty queue reported
  as evidence about someone else's install.

## 0.51.32

### Fixed

- **`apply_manifest` explains a PEP 668 refusal instead of walking into it (#1508).**
  Installing a manifest's Python packages against a uv-managed interpreter (Stability
  Matrix, and distro Pythons on Linux) is refused by design: the environment declares
  itself externally managed. The manifest run simply failed with that raw error and no
  way forward. Three different paths reached it -- with uv absent, with uv present and
  refusing, and through the older non-venv fallback, where uv's unrelated "no virtual
  environment" complaint sat on top of the real reason and sent readers off to fix the
  wrong thing.

  All three now say the same actionable thing: the interpreter is externally managed,
  that is a deliberate guard rather than a broken install, and here is what actually
  works. Notably it says what does NOT work -- routing through uv is refused by uv too,
  which was worth measuring rather than assuming, because recommending it would have
  cost the reader the time to find that out. It also names the check worth doing first:
  if ComfyUI already runs from a virtual environment, the interpreter in the message is
  the wrong one, and the fix is to point `COMFYUI_PYTHON` at the venv.

  It does not force the install. pip offers an override for exactly this, and passing it
  on a uv-managed interpreter writes into an environment uv may later reset -- turning a
  clear failure now into a broken ComfyUI later. That stays a deliberate decision rather
  than one inherited from a manifest, and the message says so.

### Security

- **A manifest entry's credentials no longer reach messages, results or logs (#1508).**
  A pip entry or model URL may legitimately carry credentials (`https://user:token@...`).
  Several failure paths echoed the entry back verbatim -- into the error message, into
  the per-item report, and into the log line naming the package -- and a failed
  subprocess additionally embeds the whole command line, so the spec travelled inside
  ordinary install errors too. URL credentials are now masked at the single point every
  manifest item passes through, which covers the Python-package, model and custom-node
  paths together. Entries stay identifiable: only the user/password portion is masked,
  so the host and path still read normally, and the underlying diagnosis is unchanged.

## 0.51.31

### Fixed

- **A trailing space in `COMFYUI_PATH` no longer breaks every install-root check silently (#1512).**
  On Windows the usual launcher line -- `set COMFYUI_PATH=C:\...\ComfyUI && comfyui-mcp connect ...`
  -- captures the space BEFORE the `&&`, because that is how `cmd.exe` assigns. The
  orchestrator then consumed the value exactly as given, so nothing matched and the
  connected ComfyUI was reported as undeterminable. The failure surfaced about forty
  minutes later, at the first write, with a message that echoed the path back but never
  pointed at the space. It cost a 12.3 GB download, stranded at 11.35 GB and finished by
  hand. The panel pack had always stripped this; the orchestrator had not.

  The value is normalized now -- surrounding whitespace, and a matched pair of surrounding
  quotes, which is the other thing that survives a paste. This is a REPAIR, not a cleanup:
  a value that already names a real directory is never touched, because a trailing space
  is a legal filename character (on POSIX, and in fact on Windows too), and redirecting
  someone away from a folder that works would be worse than the bug. Only a value that
  names nothing is repaired.

  It also says so at startup, naming both forms and the launcher line that produced them,
  instead of leaving a malformed value to surface as a mystery much later. A launcher that
  bakes in a bad value will hand the same one to everything else it starts.

  Applied at every reader, not just the obvious one: the same value feeds workflow-library
  lookups, the environment handed to spawned agents, and the check that decides whether a
  ComfyUI root was named explicitly or inferred. Fixing only the first would have left the
  rest wrong -- and would have made that last one worse, by comparing a normalized value
  against a raw one.

## 0.51.30

### Fixed

- **A panel command that WAS applied stops being reported as a failed mutation (#1468).**
  `panel_civitai_search` timed out at 10 s while the search demonstrably ran (`renderRev`
  advanced, the grid reported `loading:true`), and `panel_exit_subgraph` timed out at 15 s
  while the very next `panel_graph_outline` showed the view already back at `root`. Both
  handed back a failure for work that had happened.

  The reported cause -- that these wait on a slow frontend or external request -- turned out
  not to be true on the affected build, and the earlier diagnosis in that issue has been
  corrected. `driveSearch` does not await the CivitAI fetch: it dispatches and returns
  `{dispatched:true, renderRev}` immediately, which shipped in panel 0.11.0 while the report
  came from 0.11.44. `graph_exit_subgraph`'s own navigation receipt budgets about a second
  and returns early on success. Neither was waiting on anything.

  What was left was a bound tighter than this codebase's own default failing on a busy but
  alive tab. `civitai_search` now waits as long as every other panel command instead of half
  as long. And because an exit's effect is something the panel can simply be ASKED about,
  an unanswered exit now takes one scope read and reports what it found: at the root graph
  is decisive and says so; still inside a subgraph is NOT decisive -- an exit pops to the
  immediate parent, so that reading cannot separate "never landed" from "landed, from a
  nested subgraph" -- and it says which question is open rather than guessing. A read that
  cannot answer claims nothing in either direction.

  The confirmation reports where the canvas IS, not that this command is what put it there,
  and it is pinned to the tab the navigation was dispatched to, so a session that silently
  rebinds to another tab can never have that tab's canvas read as this navigation landing.
  Whether the tab answered at all is now taken from the bridge's own reply-timeout marker
  rather than inferred from message wording, so a panel error that merely reads like a
  timeout can never be promoted to a success.

## 0.51.29

### Fixed

- **A rebind refusal after a reconnect now runs the check it tells you to run (#1473).**
  Right after a ComfyUI restart, `panel_set_workflow_target({mode:"current"})` reported that
  the graph binding was NOT restored -- and the very next `panel_graph_outline` succeeded
  with the expected graph. The session was never wedged; it was told it was, and then sent
  to find out for itself.

  That refusal already explained the situation correctly: the panel had flagged its active
  workflow UNCONFIRMED, so nothing could be adopted, and the identity it reported already
  matched the fence this session held. It ended by prescribing a cheap graph read to settle
  which of the two remaining cases this was. It now RUNS that read and reports what it
  found: a read that passes is reported as evidence of a reconciliation race, and a read
  the fence rejects confirms the wedge instead of leaving it ambiguous.

  The result is still reported as a failure, deliberately: the rebind genuinely did not
  happen, and softening the diagnosis must not soften the result. What changed is that the
  answer arrives WITH the refusal instead of one call later.

  The message says only what the read established -- that this fence did not reject THAT
  command a moment ago -- and not that graph tools work in general. Mutations are governed
  by a separate write-fence capability, so a tab that serves reads while refusing every edit
  is told so rather than waved through, and a read that fails for any reason OTHER than a
  fence refusal (a timeout, a backgrounded tab) settles nothing and claims nothing.

## 0.51.28

### Fixed

- **Installing a custom node from a Git URL with `version:"nightly"` no longer fails and
  deletes the clone (#1470).** The repository cloned successfully, then the checkout died
  with `fatal: '--detach' cannot be used with '-b/-B/--orphan'` and the clone was discarded
  as a husk -- so a perfectly good install left nothing behind.

  "nightly" is overloaded in this tool's own surface, which is what made it awkward to fix.
  For a Manager install it names the git-HEAD channel -- one of our own paths mints it,
  rewriting an absent or "latest" version because ComfyUI-Manager rejects a registry
  "latest" for a repository-style entry. For a from-source git install, `version` is
  documented as a git ref. Someone typing it may mean either.

  So the meaning is resolved by ASKING the repository rather than guessing: tags are
  fetched, the ref is looked up, and only if the repository genuinely has no such ref -- and
  the ref came from `version` rather than an explicit `ref:` -- is the checkout skipped and
  the clone left at the default HEAD, which is what the channel reading asks for. The reply
  says that happened.

  Everything else is unchanged: a repository that DOES have a `nightly` branch gets it, an
  explicit `ref:"nightly"` still fails loudly when it is absent, and any other missing ref
  still fails rather than quietly installing something else. Asking for `v1.2.3` and
  silently receiving HEAD would be a worse bug than the one being fixed.

## 0.51.27

### Fixed

- **A workflow-instance mismatch right after loading a workflow now names the load as its
  cause (#1478).** `panel_load_workflow` returned `loaded:true` and the very next graph
  call was refused with *"workflow instance mismatch … the active workflow last moved …
  and NO PANEL COMMAND CLAIMED IT"*. A panel command had caused it one call earlier, so
  that sentence sent the reader looking for a tab switch that never happened -- twice,
  deterministically, in the reporting session.

  The load now says so itself: an API-format load can re-mint the canvas workflow
  instance, and if the next graph command is refused this is why, with the one call that
  clears it (`panel_set_workflow_target({mode:"current"})`). If nothing is refused, nothing
  needs doing.

  Deliberately a CONDITIONAL rather than a claim that the fence is stale, because the
  reply cannot tell: a UI-format load into an active workflow preserves the instance on
  purpose, and a second API load into the same active workflow reuses it as well. Nothing
  in the reply separates "re-minted" from "reused", so stating it as fact would be a guess
  wearing the clothes of a measurement.

  It also does NOT repair the fence automatically. The obvious repair adopts whatever
  workflow is active at that moment, which has no tie to the load -- a user switching
  canvases in that window would silently re-point the session and the next edit would land
  on the wrong graph. Reporting the cause accurately is worth more than a repair that can
  aim at the wrong workflow.

## 0.51.26

### Fixed

- **Cancelling a large batch no longer floods every later turn with a growing block of
  errors (#1489).** Stopping a 27-scene run left ComfyUI with no history for the prompts it
  cleared while pending, so each one came back after reconnect as an urgent error -- and the
  block GREW every turn, carrying prompts 1..N, then 1..N+1, dragging the user's original
  message along with it. It reproduced roughly 25 messages dozens of times and consumed a
  large share of the context window on noise.

  The report describes this as missing deduplication, and it is not: every notice names a
  different prompt, so all of them are distinct and nothing would dedupe. The cause is that
  each error INTERRUPTED the live turn and re-queued it, and after the first error the
  interrupted turn is itself an error turn -- so error N re-queued errors 1 through N-1 and
  the next turn carried all of them.

  A burst now collapses into one turn instead of nesting. An error arriving while an error
  turn is already waiting joins it; one arriving while an error turn is being handled waits
  its turn instead of interrupting the handling. A single error arriving during ordinary
  work still stops that work, which was the intended behaviour all along.

  Every cancelled prompt is still reported exactly once -- collapsing the noise must not
  swallow a real failure -- and notices from DIFFERENT workflow tabs are never merged, so
  each keeps the origin that pins "diagnose and fix it" to the graph that actually failed.

  Not fixed here, and still open on the issue: those prompts should not be reported as
  errors at all, since the cancellation was requested. That half lives in the panel.

## 0.51.25

### Fixed

- **A very large render can be inspected again -- `get_image` no longer inlines an
  unbounded image (#1495).** An 8504x17008 output encoded to about 267 MB and exceeded the
  caller's 64 MB message limit, so a render that had saved perfectly could not be looked at
  at all; the reporter added a low-resolution preview branch to their own workflow to
  inspect their own output. The only check before inlining was a media-type test that sent
  video and audio to disk -- there was no size budget of any kind.

  The saved file is untouched. Only what goes back over the wire is capped, and when it is,
  the reply says so: the preview reports the true original dimensions and states plainly
  that fine detail, small text and pixel-level artefacts must not be judged from it. A
  silently downscaled image would be a worse failure than the original bug, because an
  agent reads detail off it and answers confidently.

  The budget is on the ENCODED size and the scale is MEASURED rather than predicted --
  base64 inflates by a third and PNG size swings by an order of magnitude with content, so
  a pixel cap alone still overshoots on exactly the images that matter. Decoding is bounded
  by a MEMORY budget computed from the file's own depth and channel count, not by a pixel
  count: a pixel limit is the wrong unit for protecting memory, which is how a 16-bit image
  can pass a generous-looking ceiling and still need over a gigabyte to open.

  Everything else about the preview is disclosed too: whether the source format could have
  held animation (in which case you are seeing one frame), and whether colour depth or
  colour space changed. A preview that cannot be built at all never destroys the fetch --
  the reply keeps the saved path and says why, and says honestly when the save ALSO failed
  and the image is not available locally either.

  `max_preview_bytes` and `max_preview_dimension` let a caller tighten both bounds.

## 0.51.24

### Fixed

- **The MCP server now reports the version it actually is (#1447).** `serverInfo.version` was
  the hardcoded literal `0.1.0` -- a version this package has never shipped. That string is what
  an MCP client displays and what a bug report quotes, so every report was ambiguous about which
  build produced it, including the reports we ask people to send us. It is now read from the
  package's own manifest, once, at startup.

  Deliberately kept CHEAP: resolving it through the install-mode detector would have put a
  symlink-resolving directory walk in front of the MCP handshake, which is self-defeating in a
  fix filed under "startup exceeds the client's timeout". It is one small read of our own
  manifest, resolved relative to the module so it can never pick up a parent directory's
  package.json, and a UTF-8 byte-order mark no longer downgrades a working install to the
  fallback.

  If that read ever fails the version reads `0.0.0-unknown` -- a sentinel no release can carry,
  rather than a plausible-looking number that would recreate the same ambiguity.

  This is the second defect in #1447 and does not close it: the report's headline -- a cold `npx`
  install exceeding the client's startup budget -- is a distribution problem measured on the
  issue, where the tempting one-flag fix was tried and rejected because it produces an install
  that cannot start.

## 0.51.23

### Fixed

- **`check_runtime` no longer calls a paid third-party service node "local -- no paid credits"
  (#1483).** A workflow containing `NanoBananaPro_fal` -- a node whose whole job is to bill a
  fal.ai endpoint -- was reported as `runtime:"local"`, `usesApiNodes:false`, with the guidance
  "every node runs on the user's own GPU, no paid credits". Being INSTALLED is what made it
  confidently wrong: the node is in `/object_info`, so it was never "unknown", and
  known-and-unmarked resolved to local.

  Measured against a real 4304-node `/object_info` rather than assumed: not one of the 3464
  custom-node-registered classes carries ComfyUI's `api_node` marker -- all 220 marked nodes are
  core. So the partner marker can never fire for a third-party pack, and this was a category-wide
  hole that fal.ai happened to expose.

  Two signals now catch it, because neither covers the case alone: an enumerated registry of packs
  known to bill a remote service (matched on the pack's module path AND its category, so cloning it
  into a differently-named folder does not slip past), and any node declaring a service credential
  input -- the general catch for packs nobody has enumerated. A pack's own local helpers stay free:
  `FAL/Utils` resizes an image before upload and spends nothing.

  The tempting one-line fix -- flag anything taking an `api_key` -- was rejected because it misses
  the reported node: that pack reads its key from the environment, so its nodes expose only
  `prompt`/`aspect_ratio`/`seed`. Equally rejected: treating every custom node as unclassifiable,
  which would flag 3464 of 4304 classes and make the warning meaningless.

  These stay OUT of the Comfy partner-node list, which feeds tools that hand out schemas assuming
  Comfy's own auth model -- a fal.ai node is paid, but it is not a partner node. They ride a
  separate `externalApiNodes` field that counts the same way for the verdict, and the guidance now
  names WHO bills (e.g. fal.ai, on the user's own account with them, not Comfy api credits) so a
  reader who checks their Comfy balance and finds it untouched does not conclude the warning was
  wrong.

## 0.51.22

### Fixed

- **A remote ComfyUI that a restart stops and nothing brings back is now reported, not described
  as restarting (#742).** `panel_restart_comfyui` against a REMOTE-classified target returned
  "it is restarting out-of-band -- check in a few seconds" whether the server was mid-restart or
  dead for good: the recovery probe is loopback-only, so on that path nothing was ever watched and
  the two outcomes were indistinguishable.

  The reporter's Pinokio install was addressed by its LAN IP -- which classifies as remote even
  though it is the same machine -- stopped, and never relaunched, because Pinokio's launcher only
  re-launches on the Manager's dependency-install signal. They learned the server was gone from
  every later panel call failing with a generic "still reconnecting".

  The address this session already uses for every other call is now watched after a remote
  dispatch, and what it may conclude is one-directional by design: it can report a failure to come
  back, and can never manufacture readiness. `ready` and `confirmed_cycle` stay false on every
  branch here exactly as before -- a healthy answer proves the address responds, not that this
  instance cycled.

  The report is deliberately narrow about what it knows. It states that the address went down and
  had not come back within the window, says outright that this does not prove the server is gone
  (a remote host can boot slower than the budget), names the other explanation, and names the one
  check that separates them. It also requires the LAST observation to still be unreachable rather
  than trusting a flag that latches on a single missed connection, so a brief refusal from a
  tunnel or NAT can no longer be reported as a dead install.

  Nothing about what gets refused changed, so a working supervised-remote restart is untouched.

## 0.51.21

### Fixed

- **A wrong-canvas refusal on a NEVER-SAVED workflow is no longer a dead end (#1480).** The
  `root-workflow-uuid-mismatch` guard tells the caller to re-open the tab with
  `panel_open_workflow(<path>)`. A tab that has never been saved has no path -- the workflow list
  reports `path: null, filename: null` for it, because ComfyUI reuses the "Unsaved Workflow" title
  across unsaved tabs -- so the reporter passed the tab's TITLE, got "no workflow matching", and
  found every other documented exit closed too: reload refuses while unsaved, save refuses under
  this same guard. The agent could read the user's canvas and change nothing, and handed the
  problem back with "please press Ctrl+S yourself".

  The exit existed the whole time and nothing named it. Each tab's per-instance ROUTING KEY is a
  valid selector -- for an unsaved tab it is the only one it has -- and the workflow list already
  publishes it on every record.

  So this refusal now does what the two refusals beside it already do: one read-only workflow-list
  read, exempt from the fence it is reporting on, establishes the single fact that decides which
  remedy is followable, and the message names THAT one -- the routing key for an unsaved tab, the
  real path for a saved one, and neither when the read did not land. It also warns off the two
  exits that refuse from this state.

  Nothing is auto-applied and the guard is not weakened: a canvas that really does belong to
  another workflow still refuses, and the saved-tab advice is unchanged. Reads get the diagnosis
  too, because a refused `panel_graph_outline` was half of the reported dead end. Verified on a
  live rig, not only in tests: with the fix the named remedy re-opens the unsaved tab, restores its
  identity tag, and the previously-refused read and widget edit both succeed.

## 0.51.20

### Fixed

- **`download_model action:"status"` no longer reports a dead download as "still streaming" (#1479).**
  Three transfers died with their owning process, and status rendered them as *downloading --
  still streaming* with "the transfer may still be running ... Do not report this download as failed
  or missing" -- while `action:"cancel"` on the same ids, in the same process, answered "that session
  is confirmed GONE".

  The evidence was already there: `writerProcessGone()` probes the owner pid, but it was only reached
  from the cancel path, and the status render branched on heartbeat AGE alone. Status now consults
  the same probe, and both the status line and the note change together.

  A merely-stale record keeps the cautious wording -- a missed heartbeat still does not prove the
  transfer stopped (#761) -- and the pid verdict is carried as "proven gone" or absent, never as a
  tri-state, so "cannot tell" can never render as death. The verdict is scoped to what was measured:
  no process with that pid exists ON THIS MACHINE. A writer on another host or container looks the
  same from here, and `cancel` shares that blind spot, so the message says so rather than promising
  a safe recovery it cannot guarantee.

## 0.51.19

### Fixed

- **A download can no longer land in a ComfyUI the connected server does not read (#1371).** A
  model was written into a DIFFERENT local installation than the one serving the session: connected
  to ComfyUI on `:8190`, the download streamed into a tree belonging to another install, resolved
  from a stale `COMFYUI_PATH`, while visibility was checked against the connected server.

  The existing divergence guard shipped in v0.49.4 and the reporter was on 0.50.107, so it was
  present and did not fire: it proves divergence from CONTENT -- files on disk the running server
  does not list -- and a sparse or empty destination category proves nothing.

  The destination is now checked against the roots the live server actually reads, including any
  registered through `extra_model_paths.yaml`, with junctions and symlinks resolved and the check
  scoped to the destination's category. It refuses only on a demonstrated mismatch, never on an
  unverifiable one -- an unknown answer proceeds exactly as before, because treating "the server
  did not vouch for it" as "the server cannot read it" is what produced false refusals every
  previous time that inference was tightened.

## 0.51.18

### Fixed

- **A model download can no longer exhaust the system drive (#1477).** `download_model` stages
  the whole file in the content-addressed cache before it lands, and that cache path came only
  from `homedir()` -- on Windows essentially always the system drive, while models are almost
  always on a big secondary volume. The reporter's ComfyUI lives on `F:` with 1 TB free; `C:`
  had 0.7 GB free of 232 GB, and a 32.29 GB download grew a `.partial` to 22.62 GB heading for
  zero. Taking a Windows system drive to zero risks the page file and general OS stability, so
  the failure did not stay confined to the download that caused it.

  `Content-Length` is already known before the first byte is written, and there was no
  free-space check anywhere in the codebase. There is now: the download is REFUSED up front,
  naming the space needed, the space available, the destination's free space when it is a
  different volume, and `COMFYUI_DOWNLOAD_CACHE_DIR` as the lever. The reserve scales as
  min(1 GiB, 5% of the volume) so a small or removable cache volume stays usable. Every check
  fails soft: an unknown size or an unreadable volume proceeds exactly as before, because an
  unmeasurable volume must not become an unusable one.

  Not addressed here, and deliberately: relocating the cache to the destination volume, the
  cached copies retained after a model lands, and the ~10x progress under-report -- all three
  are recorded on the issue.

## 0.51.17

### Fixed

- **The stable_audio_3 template could not produce audio at all, and its defaults rendered
  silence (#1458).** `SaveAudioMP3` was emitted without the required `quality` input, so every
  generation for this family failed validation before execution with
  `Required input is missing (quality)`. Separately, the shipped `lcm` + cfg 7 pairing renders
  DIGITAL SILENCE at mean -91 dB while ComfyUI reports success -- a correctly-sized,
  correctly-durated file of nothing, with nothing in the logs to grep for. The default sampler
  is now `dpmpp_2m`; passing `sampler_name` explicitly is unaffected. The reporter measured six
  combinations to isolate it.
- **A ComfyUI-Manager failure now shows the Manager's own error body (#1397).** An opaque
  exception for a deno-compatible pack reported a bare status and discarded everything the
  Manager said about why. The body is now carried into the message, bounded, with credential
  shapes redacted first -- git-remote userinfo, bearer/token headers, `Authorization: Basic`,
  and cookie/session pairs.
- **`list_local_models` `remove` says WHY it searched fewer roots than `list_paths` shows
  (#1474).** The two tools disagreed with nothing to reconcile them. The resolver behind
  deletion enumerates only roots provable from the running server's launch arguments, which is
  deliberate and unchanged; the refusal now states that, and that "not found" here does NOT
  mean "not on disk".
- **`list_templates` says it reflects what the server REGISTERS, not what is on disk (#1454).**
  Installed `example_workflows` were omitted from a list that looked complete.
- **The npx update note names the restart that actually applies it (#1471).** "restart to pick
  it up" sent users to the panel's `/restart`, which does not restart the long-lived
  orchestrator process -- the one that keeps the build it launched with. The note now names the
  levers that do NOT work, says an unchanged version cannot distinguish a missed restart from a
  deliberate pin from a cached copy, and no longer claims `npm cache clean` clears npx's
  execution cache.

## 0.50.114

### Fixed

- **A failed local download now says what made ComfyUI-Manager necessary (#1374).** A LOCAL
  Windows-portable install could not download anything: every attempt died on "ComfyUI-
  Manager's queue API is not reachable", for a capability that needs no Manager at all. The
  reporter downloaded ~45 GB with `curl` instead.

  That error is raised in generic Manager code which cannot know it is serving a download,
  so it named the thing that BROKE and not the decision that made Manager necessary — this
  MCP could not resolve where the connected server keeps its models. Only the second has a
  remedy you can apply, and nothing distinguished it from "your ComfyUI is remote, this is
  normal".

  The failure now explains the route, per case, with the `argv[0]` and `cwd` that identify
  which one you hit. It is appended ONLY when the Manager API call itself failed — a bad
  source URL or an auth refusal keeps its own error untouched.

  **The routing is deliberately unchanged.** The reporter's decision could not be
  reproduced here: a live ComfyUI on this machine reports a relative `main.py` and no `cwd`
  — the shape that looked like the culprit — and still resolves, because the process-table
  probe anchors it. Guessing at which of six conditions fires for them, and "fixing" that,
  is how a routing change breaks installs that work today. What ships is the answer being
  visible in the next report.

## 0.50.113

### Fixed

- **A frontend-only node no longer makes a workflow's runtime "unknown" (#1372).**
  `list_packs(action:"check_runtime")` counted `MarkdownNote` as an unclassifiable node and
  refused to say the workflow was free, stopping the paid-API safety flow to ask a question
  that already had an answer.

  `MarkdownNote`, `Note`, `Reroute` and `PrimitiveNode` are LiteGraph-native: the frontend
  registers them, `/object_info` never lists them, and they are stripped before a prompt is
  queued. A node that does not execute cannot be a paid partner node, so it earns none of
  the doubt the "unknown" verdict exists to express. They are also removed from the
  classifiable denominator — one API node beside three Notes used to read as "mixed".

  The caution itself is unchanged: a genuinely unrecognised node still collapses the
  verdict, and a node the server DOES register under one of those names is classified
  normally rather than skipped — a safety check that a name collision can bypass would be
  worse than the false "unknown" it replaced.

  The type list is imported from the workflow converter, which has always known which types
  never reach the backend. The two disagreeing was the bug.

  Not covered: third-party virtual nodes (KJNodes `GetNode`/`SetNode`, rgthree's
  canvas-only nodes) still report "unknown". They have the same property but a hardcoded
  list of third-party names goes stale silently — tracked in #1400.

## 0.50.112

### Fixed

- **A remote panel can convert its own live canvas (#1359).** `panel_strip_workflow` read the
  graph from the connected panel but fetched node definitions over `COMFYUI_URL` — the same
  machine locally, two different ones whenever the panel is remote. A canvas on a proxy URL
  could not be stripped at all: the definitions request went to `127.0.0.1:8188`.

  The live canvas now takes its definitions from the ComfyUI the PANEL is connected to,
  which the panel has been able to serve since 0.13.0. In a tunnel or loopback-only
  topology the browser is the only thing that can reach that server, so this is not a
  workaround for the remote case — it is the correct source for every case.

  There is deliberately **no fallback** to `COMFYUI_URL`. Both hosts can answer, and when
  they disagree a fallback returns a workflow converted against the wrong server's schema —
  wrong widget order, wrong input names — with no error at all. That is worse than the
  connection failure this issue was filed about, which at least announced itself. A panel
  that cannot serve definitions, an empty map, an error body, and a map that describes some
  other install are each refused with the reason.

  Requires panel 0.13.0+; an older panel is refused by the version gate with the version it
  needs, rather than an "unknown command" error that reads like a broken ComfyUI.

## 0.50.111

### Fixed

- **`download_model` no longer promises a resumable partial it never looked for (#1370).**
  Cancelling a download reported "the partial was left on disk and can be resumed by
  re-issuing" purely from the job's status — nothing stat'd the file. A reporter paused a
  33 GB download because of that sentence, found no partial anywhere, and restarted from
  zero.

  Both cancelled branches now report what is actually staged: the partial's SIZE when there
  is one, so "resumable" is something you can weigh against restarting, or its absence, so
  you learn it before re-spending the bandwidth rather than after. A cancel that leaves
  nothing is not an error; telling you it left something is.

  The lookup derives the staged path from the same function the writer uses, so the two
  cannot drift. Getting there took two corrections — the file is keyed by the download's
  CACHE identity rather than its destination filename, and it is HIDDEN (a leading dot) —
  and each wrong version would have reported "no partial found" to someone holding tens of
  gigabytes of resumable bytes.

## 0.50.110

### Fixed

- **A progress line is no longer handed to you as a failure reason (#417).** When a
  comfy-cli download died, its stderr often held only progress, so the error you were shown
  was comfy-cli's own `Start downloading URL: … into …` — a sentence that reads like a
  diagnosis and names no cause. Output that carries no failure information now says exactly
  that, and names what to check; the raw output is still kept. A real error is passed
  through unchanged.

  The progress patterns match the emitter that actually exists: comfy-cli's own downloader
  is `rich.progress` (which writes nothing to a pipe), so the bars that reach us come from
  `huggingface_hub` with a `desc` prefix. The diagnosis is also scoped to downloads — a
  failing `comfy node install` was being handed disk-space and gated-Hugging-Face advice
  about a transfer it never performed.

- **A reconnect no longer wedges every mutating `panel_*` call (#1331).** After a workflow
  switch, a save/rename, or an id-scheme change the tab gets a new id, and the trusted
  workflow stamp was deleted and only restored if that same hello resolved an identity. A
  reconnect hello that lands before the canvas identity is readable carries none, so the
  stamp was gone for the rest of the session and every mutation was refused with "this
  workflow has no trusted identity" while reads kept working.

  The stamp now moves with the rest of the routing state. It cannot widen authorization —
  the panel authorizes only when the stamp equals the live workflow uuid — while an absent
  stamp was unrecoverable. This restores `carryWorkflowCommandStamp`, which #436 added for
  exactly this and the #884 refactor dropped.

### Added

- **`panel_remove_widget` removes ONE dynamic widget row (#938)** — rgthree Power Lora
  Loader `lora_N`, Impact/Inspire list rows. Their add/remove affordance is a canvas-drawn
  button an agent cannot click, so those rows were previously un-removable from an agent
  session. Requires panel 0.13.7.

  The rows are deliberately NOT renumbered (`lora_N` is a monotonic id, not a position), and
  removal is refused with the specific reason for a backend-declared input, a
  frontend-generated control widget, a linked widget, or a subgraph container. Node
  definitions that cannot be READ are reported as unknown rather than treated as "declares
  nothing".

## 0.50.109

### Added

- **Operator-level restriction of the tool surface (#873).** For a hosted deployment — a
  shared Open WebUI, a team frontend — where the operator is not the person prompting,
  three environment variables now withhold tools from the model entirely:
  `COMFYUI_MCP_TOOL_PRESET` (`safe` | `readonly`), `COMFYUI_MCP_TOOL_DENY`, and
  `COMFYUI_MCP_TOOL_ALLOW`. A withheld tool is never registered, so it is absent from
  `tools/list`, absent from `call_tool`, and the model never learns it exists.

  Measured on a built server: 40 tools unrestricted, 16 under `safe`, 10 under `readonly`.
  Under `readonly`, `call_tool {"name": "restart_comfyui"}` answers `Unknown tool` —
  absent from dispatch, not merely hidden from the listing, which was the reporter's
  specific concern about compact mode.

  A misconfiguration **refuses to start** rather than starting unrestricted: an unknown
  preset, or a variable set but empty (an unexpanded `${VAR}` in a compose file), aborts
  with the reason on every transport — stdio, `--http`, and `--panel-orchestrator`.
  Coming up with a full surface while the operator believes it is restricted is worse than
  having no filter.

  This is a boundary against the model and the people prompting it — not against whoever
  sets the environment, and not a substitute for keeping an untrusted party off the
  ComfyUI host. `docs/configuration.mdx` says so.

### Fixed

- `list_packs` is withheld by both presets. Its `action:"install_deps"` installs custom
  node packs through ComfyUI-Manager — downloading and RUNNING third-party code on the
  host — behind a name that reads like inspection. Same for `apps` (`action:"import"`
  installs from the public registry), `get_defaults` (writes config), `list_local_models`
  (`action:"remove"` deletes a model file) and `queue` (destroys work).
- `search_custom_nodes` is NOT withheld. It only searches; the installing tool is
  `install_custom_node`, which is withheld.

## 0.50.66

### Fixed

- The restart-confirmation timeout no longer points you at a server it never checked. When
  `panel_restart_comfyui`'s confirmation card times out it suggests the headless
  `restart_comfyui` as a fallback — but that targets `COMFYUI_URL`, which is not
  necessarily the ComfyUI the panel is running inside. It now says which server it would
  restart, and refuses to recommend it outright when it can prove that is a different one.
  A confirmed origin mismatch (a tab fronting a second local ComfyUI) reaches that strong
  warning instead of being lost inside a proof that only answers "is it the same"; an
  origin that merely cannot be proven stays a mild, target-naming note. The warning also
  now names the worse outcome — restarting a live wrong target can succeed and take down a
  ComfyUI you did not mean to touch, not merely find nothing there (#1233, panel#851)

## Unreleased

### MCP

#### Fixed
- a queued tool-session respawn sees the downloads started after the save, instead of killing them with no warning (#1567)
- it waits on those transfers' live byte counts rather than treating every one as already stalled (#1567)

## [0.52.28] - 2026-08-20

### MCP

#### Fixed
- panel_update_node reports the Manager update-git error, not a stale generation traceback (#1879)
- panel_free_vram no longer reports VRAM freed when a device stays pinned (#1878)


## [0.52.27] - 2026-08-20

### MCP

#### Fixed
- panel_run takes the node id its own tools printed (#1874)
- a stale tab advertisement stops being reported as a restored graph binding (#1868)
- panel_get_errors waits as long as the panel is allowed to take (#1867)


## [0.52.26] - 2026-08-20

### MCP

#### Fixed
- a Blind conversation no longer receives run-completion pixels through the synthesised (watchdog) door — the strip now applies wherever a completion enters, and video refs are named rather than attached as `image/png` (#1863)
- `panel_add_node`'s automatic refresh no longer reports a reply TIMEOUT as a failed refresh: a refresh that outruns its ack keeps running, so the reply now says the schema may already be current and to retry, instead of telling the caller a retry will refuse again (#1864)
- `panel_load_workflow` loads a saved workflow after a confirmed restart instead of failing with ECONNREFUSED (#1850)

## [0.52.25] - 2026-08-20

### MCP

#### Fixed
- launch-server tests collect on a Windows checkout (#1860)


## [0.52.24] - 2026-08-20

### MCP

#### Fixed
- check_runtime knows PoYo's pack is a paid service, not a local node (#1858)
- a dropped panel completion still arrives with the history output filenames (#1856)


## [0.52.23] - 2026-08-19

### MCP

#### Fixed
- panel_open_workflow succeeds after placeholder definition rehydration (#1849)


## [0.52.22] - 2026-08-19

### MCP

#### Changed
- bump the npm-minor-patch group across 1 directory with 10 updates (#1837)
- from bug report to published release, autonomously (#1831)


## [0.52.21] - 2026-08-19

### MCP

#### Fixed
- a departed Blind tab stops blinding the whole conversation, and the strip says it happened (#1842)
- a dev-symlink panel below the floor reports behind:true (#1840)

#### Changed
- bump the actions-all group with 6 updates (#1836)
- bump typescript from 5.9.3 to 7.0.2 (#1838)


## [0.52.20] - 2026-08-19

### MCP

#### Changed
- watch dependencies for advisories, weekly and grouped (#1833)


## [0.52.19] - 2026-08-19

### MCP

#### Fixed
- Panel auto-sync reclaims a provably-abandoned operation lock instead of failing for days; panel_add_node names version skew (pack update + hard tab refresh) when an allowlisted frontend-only type is refused as a missing backend node (#1828)

### MCP

#### Fixed
- auto-sync reclaims abandoned panel locks; frontend-only add-node errors name version skew (#1830)


## [0.52.18] - 2026-08-19

### MCP

#### Added
- panel_unexpose_subgraph_input/output — remove a subgraph boundary slot by name (#1812)

## [0.52.17] - 2026-08-19

### MCP

#### Fixed
- call_tool runs when the payload is under parameters instead of args (#1825)


## [0.52.16] - 2026-08-19

### MCP

#### Added
- check_runtime consults the panel-proven frontend virtual registry (#1817)

#### Fixed
- panel_restart_comfyui refuses an unidentifiable local instance before asking, leaving the tab connected (#1822)
- a stale graph fence no longer blocks Manager search/install/reboot or mode:current recovery (#1821)
- empty registry zip installs fail instead of reporting success (#1820)


## [0.52.15] - 2026-08-19

### MCP

#### Added
- Qwen Code CLI as an Agent Panel backend over ACP (#1813)
- panel_configure_app_mode — set App Mode inputs, outputs, and default mode (#1809)
- panel_show_media stage:true stages oversized outside files into a served dir (#1810)

#### Fixed
- matchTitle on Fast Groups no longer pretends the toggle list rebuilt (#1814)


## [0.52.14] - 2026-08-19

### Added

- **`minimax-h3-video` plugin skill (#1167).** Local MiniMax H3 (Hailuo) T2V/I2V/R2V
  in ComfyUI — Comfy-Org INT8 pack, turbo LoRAs, 15 s stereo clips — with a
  `#1155` `## Sources` block that **links** MiniMax's official prompting guides
  rather than copying them (Community License includes Documentation). Distinguishes
  the free local-weights nodes from the paid Hailuo API nodes. Enhancement — do not
  merge until another agent reviews.

### Fixed

- **`panel_set_property(matchTitle)` on Fast Groups Bypasser/Muter no longer claims a live toggle-list rebuild (#1808).**
  The write stores the property and the `from`/`to` reply is truthful, but rgthree
  does not implement `onPropertyChanged` — `refreshWidgets()` runs on its own
  service tick and leftover-row removal skips every other `Enable` row. A first
  set can leave a partial list or `widgets:{}` (unbuilt, not "no matches").
  The tool now says so, appends that note on Fast Groups filter writes, and the
  rgthree skill / authoring prompt tell the agent to re-read and set again
  instead of delete+re-add.

- **MiniMax H3 skill load path (#1167 / #1801).** `plugin/skills/minimax-h3-video/SKILL.md`
  no longer tells the agent to `panel_load_workflow` / `run_template` a Template
  Library basename. Core `video_minimax_h3_*` graphs open from the frontend
  Template Library, or from Comfy-Org/workflow_templates via `save_workflow` then
  `panel_load_workflow path:`. `run_template` is named only as "won't work until
  a pack exists."

### MCP

#### Added
- MiniMax H3 local-video skill citing official prompting guides (#1801)
- canonical flows at MCP initialize (call order, async handles, pre-flight, trust) (#1805)

#### Fixed
- plugin .mcp.json launches via a warm-path wrapper instead of bare npx (#1807)
- one-arg panelLauncherPaths keeps windowsStartup under the passed home (#1806)


## [0.52.13] - 2026-08-19

### MCP

#### Fixed
- five ways the launcher fallback could strand or double-serve a user (#1800)

## [0.52.11] - 2026-08-19

### MCP

#### Added
- split ComfyUI code and data roots via `COMFYUI_CODE_PATH` so pip/venv/core git can target the checkout while pack reads/writes stay on the live `--base-directory` / `COMFYUI_PATH` data root (#1765, thanks @woodenriver05; rebase of #1766)

### MCP

#### Added
- support split ComfyUI code roots

#### Fixed
- route pack writes to the live data/base root after #1770


## [0.52.10] - 2026-08-19

### MCP

#### Fixed
- list_templates honors COMFYUI_MCP_HTTP_TIMEOUT_S instead of aborting at 8s (#1795)
- environment no longer reports packages missing off the Homebrew base python (#1794)
- refuse Anima regional prompt writes the custom textarea overwrites (#1793)
- a PINNED extra-paths target says so when the running server reads a different config (#1792)
- the orchestrator's own /history observation keeps the completion promise panel_run makes — and the rider stops over-promising (#1791)


## [0.52.9] - 2026-08-19

### MCP

#### Fixed
- a live graph read with a missing instance stamp now runs (#1787)

#### Changed
- the 0.52.7 changelog names #1784, which shipped in the tag (#1785)


## [0.52.7] - 2026-08-19

### MCP

#### Added
- skills cite official vs empirical prompting guidance (#1776)

#### Fixed
- panel_save_workflow corroborates a fence refusal so a save-only retry self-heals (#1782)
- the widened fence arm must not adopt refusals that merely quote it (#1784)


## [0.52.6] - 2026-08-19

### MCP

#### Fixed
- a workflow edit can no longer land silently on the canvas you switched away from: a stamp CARRIED onto a freshly minted tab id is no longer accepted as that tab's advertised identity, so panel_save_workflow and the other active-canvas commands refuse before the socket write and name the documented rebind, instead of passing a gate that compared the carried value against itself (#1775)
- a pi turn whose session the CLI no longer has drops the dead session id and retries once as a fresh session, instead of failing every turn until you type /new (#1774)
- three packs whose workflows asked for models their manifests never downloaded now install clean — z-image-xy-plot ships the Q8_0 GGUF its loader actually loads, leaked personal LoRAs are replaced with declared bring-your-own placeholders, and packs:check-models runs as a CI gate instead of never running at all (#1771)
- adding Lora Loader (LoraManager) from autocomplete names the STRING-socket LoRA Text Loader instead of stalling five seconds and refusing a healthy pack on ComfyUI 1.49+ (#1762)
- the local-llms docs flag the default :e4b fine-tune as text-only, so nobody picks it expecting the panel to see its own generated images (#1777)

#### Added
- consult the maintained arena baseline table — model, params, quant, VRAM and score, grouped by 8 GB fit — from the docs without running the benchmark yourself (#1773)

#### Changed
- the same vision caveat is mirrored into all ten translated local-llms pages, so a non-English reader is warned too (#1779)


## [0.52.5] - 2026-08-19

### MCP

#### Added
- add Atlas Cloud agent provider (#1726)
- stamp WHICH LLM filed a panel bug report, mechanically (#1753)

#### Fixed
- opening a save-as copy rebinds dest identity so save and the promoted prompt stick (#1764)
- set_workflow_target no longer reports a successful reconnect check when the next graph call has no tab (#1763)
- node_pack authors into the runtime's --base-directory, not the code install root (#1770)
- a self-nested panel_call_tool unwraps once or names the correct shape (#1769)
- name a partial install when custom_nodes were never submitted (#1755)
- restart_comfyui relaunches the Stability Matrix package venv, not Assets CPython (#1761)
- a download-complete event now means the dest file exists (#1760)
- report a non-ASCII CIVITAI_API_TOKEN as a credential fault, not a network outage (#1759)
- panel_remove_mcp + panel_reload drops the removed server (#1758)
- panel_set_widget summarizes long previous/new echo strings (#1756)
- drop vrgamedevgirl from z-image-turbo-controlnet to skip llama-cpp-python source builds (#1754)


## [0.52.4] - 2026-08-19

### MCP

#### Fixed
- a fence this call REPAIRED is not a fence that was already fine — and the verdict rides in a field (#1740)
- unwind call_tool when get_system_stats times out mid-decode (#1751)
- recover panel_restart_comfyui when the crash takes the bridge offline (#1752)
- recover the turn pin before mode:current claims bound (#1750)
- do not report a post-crash 502 as a base-URL misconfiguration (#1749)
- the progress counter runs at Node's default buffer depth again (#1746)
- graph_* fail fast while a prompt runs; do not clear the fence on an identity-only open (#1745)
- set a listed promoted subgraph widget (#1743)
- degrade panel_search_nodes when Manager cache mappings return HTTP 500 (#1742)
- treat tmp: key/routing_key as fence corroboration identity (#1741)
- the download progress counter observes bytes instead of pacing them (#1738)
- a configured COMFYUI_RESTART_COMMAND restarts the externally-managed instance the launch path can't prove (#1737)
- a fenced graph READ is diagnosed, and a missing stamp is not a wrong one (#1736)
- a download goes to the extra model root the SERVER named, not an unvouched install (#1734)
- containment in a root WE picked is not readership — an unvouched destination is UNCONFIRMED, not "in the right place" (#1735)
- a too-old note with a current disk pack prescribes restart + hard-refresh, not a no-op sync (#1729)
- panel_show_media's mid-command drop now settles with a re-issue, not an unverifiable check (#1728)

#### Changed
- lead with the demo, as a poster that links to the video (#1744)


## [0.52.3] - 2026-08-19

### MCP

#### Fixed
- a workflow-instance mismatch is diagnosed read-only, so a refused edit can no longer re-aim the fence onto the live canvas the caller did not name (#1646)
- free_vram on a frozen tab is settled against the ComfyUI server itself instead of left outcome-unknown (#1249)
- a Manager reboot whose loopback witness saw the down-up cycle reports the restart confirmed, not unconfirmed (#1642)
- bootstrap finds git in the Git for Windows install roots when the orchestrator's PATH predates the install, and says a full restart is required when git is truly absent (#1640)
- node_pack scaffold/publish adopt the live workspace install_comfyui already detected instead of refusing that no local install is configured (#1653)
- apply_manifest stops refusing junctioned model folders, so a StabilityMatrix install resolves every model category (#870)
- a re-spelled ComfyUI target keeps its self-queue ledger, so a post-reconnect scoped preview is not refused as a duplicate (#1615)


## [0.52.2] - 2026-08-18

### MCP

#### Fixed
- a new session resumes the downloads its predecessor's death orphaned (#1567)
- upload tools return the subfolder-qualified reference a loader can use (#946)
- stop shipping a preset library nothing reads (#1597)
- search_custom_nodes tries the comfyui-prefixed registry id, so repo-name queries like WanVideoWrapper no longer false-empty (#773)
- automatic previews stop at a per-conversation budget instead of compounding a Codex rollout without bound (#1516)
- a fence the settling read proved live is reported BOUND, not unrestored (#980)
- a download destination is judged by the one observation that produced it (#1371)


## [0.52.1] - 2026-08-17

### MCP

#### Added
- Grok 4.6 is now in the Agent Panel catalog (#1494)

#### Fixed
- re-delivered multi-workflow events inherit the established origin instead of wedging scope routing (#1685)
- a timed-out clone's lingering git tree is killed so cleanup can remove the husk, and an existing husk is refused rather than reported installed (#1684)
- a mid-session MCP drop is met with one bounded reconnect, reported either way (#1681)
- a post-switch panel_* command whose stamp no longer names the routed tab's canvas is refused before dispatch (#1682)
- restart relaunches the interpreter the healthy server was observed running under (#1680)
- a landed file the core listing contractually omits is unconfirmed, never "not-visible" (#1679)
- an unreadable parent PID degrades to a disclosed Desktop restart (#1677)
- training runs no longer trip the hard stall floor while the server stays alive (#1676)
- download_model action:"cancel" no longer asserts a live heartbeat it never probed (#1675)
- resolve list_paths through the live root the OS can see (#1629)
- Blind gates the Claude backend's native Read/WebFetch with a PreToolUse deny hook (#1643)


## [0.52.0] - 2026-08-17

### MCP

#### Added
- panel MCP autostart — an explicit per-user launcher starts MCP when the panel opens, loopback-only and bearer-authenticated, with live provider discovery (#1590)
- exact per-action tool allowlist — COMFYUI_MCP_TOOL_ACTION_ALLOW names the tool:action pairs an operator permits, no wildcards (#1452)

#### Fixed
- get_defaults names the live-preview id the frontend actually reads (#1638)
- download_civitai sends the per-request auth override instead of dropping it (#1635)
- a pack's install manifest is readable via list_packs action:"read_manifest" (#1649)
- panel_search_nodes documents its own limit bound (#1287)


## [0.51.57] - 2026-08-16

### MCP

#### Fixed
- a node read by id returns its full widget value, not a survey clip (#1634)
- cancel_queued reports the removal it observed, not the one it requested (#1632)
- a repo filed under a Comfy Registry id is refused, not swapped for another author's (#1624)
- a run acknowledged after its reply timeout is not an unknown outcome (#1175)
- a skill description with a colon in it ships with NO description at all (#1620)
- a tree the server demonstrably reads is not refused over one stray file (#1147)
- a session that came up without an MCP server says so (#1524)
- a queued credential respawn waits for in-flight transfers instead of killing them (#1567)
- a post-open exempt read that got no answer is REPORTED (#1560)
- refuse the ambiguous from-source install instead of picking a repo (#1616)
- a refused offer is not a verdict anyone was told (#1327)
- a git-URL install stops asking a Manager channel nobody chose (#1539)
- the Manager verdict never asserts more than it observed (#1374)
- a drained ComfyUI-Manager queue is not evidence the file landed (#1374)

#### Changed
- rgthree skill — the toggles agents keep getting wrong (#1551)


## [0.51.56] - 2026-08-15

### MCP

#### Fixed
- the restart refusal stops sending you at a server it knows is the wrong one (#1593)
- pack VRAM tiers say what their own manifest fetches (#1585)

## [0.51.55] - 2026-08-15

### MCP

#### Fixed
- let the SERVER answer whether a model is installed (#1587)
- panel_strip_workflow hands back a graph a script can parse (#1589)

## [0.51.54] - 2026-08-15

### MCP

#### Fixed
- a stale panel MCP session is a session problem, not a bad request (#1524)
- the loopback MCP reports the port it BOUND, not the one it was asked for

## [0.51.53] - 2026-08-15

### MCP

#### Fixed
- bound the images a run completion attaches to an agent turn (#1516)
- account for the unnamed outputs the counts already include
- the drain CORRECTS the claim, rather than only enforcing the number
- the preview budget is per TURN — a per-event cap was not a cap

## [0.51.52] - 2026-08-14

### MCP

#### Fixed
- adopt the instance the load proved, instead of warning about it (#1478)
- claim — an API load proves a new instance and leaves the fence stale

## [0.51.51] - 2026-08-14

### MCP

#### Fixed
- the refusal says UNKNOWN where it cannot know reads still work
- prefer the EXACT (id, target) record over a targetless one
- a write refusal stops promising that graph reads still work
- scope identity by (id, target), and stop contradicting the caveat
- DISCLOSE the disagreement — suppressing it was worse, and inert besides
- never announce a completion this orchestrator's own status tool contradicts


## [0.51.50] - 2026-08-14

### MCP

#### Fixed
- let the loader fail first, then append the remedy
- refuse a stale path with the remedy — never substitute the manifest
- resolve a pack manifest by NAME, and recognise a path that expired

#### Changed
- click the logo to go home, not to GitHub (#1581)
- play the panel demo on the landing page instead of a placeholder (#1580)
- Korean pilot — five entry pages, and the hreflang gate (#1577)


## [0.51.49] - 2026-08-14

### MCP

#### Fixed
- a tab leaves the watch when its restart RESOLVES, not only when dropped
- a watch can no longer outlive the save that created it
- only an ARMED credential respawn may speak, and only once
- take the at-risk snapshot when the respawn FIRES, not when it is queued

#### Changed
- fix what the docs claim, before translating them into eleven languages (#1558)


## [0.51.48] - 2026-08-14

### MCP

#### Fixed
- bind the own-property test at load, not through the prototype
- require an OWN property at every hop of the refusal claim
- retry a PRE-EXECUTOR refusal, keyed on the field the panel publishes
- wait out a reconnect refusal instead of handing it back


## [0.51.47] - 2026-08-14

### MCP

#### Fixed
- a panel too old to help is also too old to say so (#1572)


## [0.51.46] - 2026-08-14

### MCP

#### Fixed
- settle whether an unlisted git repo can install at all (#1566)


## [0.51.45] - 2026-08-14

### MCP

#### Fixed
- a Get/Set bus node is not an unknown runtime (#1564)


## [0.51.44] - 2026-08-14

### MCP

#### Fixed
- an INFERRED models root must still be corroborated before a download lands there (#1562)


## [0.51.43] - 2026-08-14

### MCP

#### Fixed
- a relative interpreter path no longer sends a LOCAL download to Manager (#1555)


## [0.51.42] - 2026-08-14

### MCP

#### Fixed
- let the spawned child make the #952 drift comparison (#1553)


## [0.51.29] - 2026-08-13

### MCP

#### Fixed
- take the graph read this refusal prescribes, and report what it found (#1515)


## [0.51.28] - 2026-08-13

### MCP

#### Fixed
- resolve "nightly" by asking the repository, not by guessing (#1513)


## [0.51.27] - 2026-08-13

### MCP

#### Fixed
- name the load as the cause of a workflow-instance mismatch (#1510)


## [0.51.26] - 2026-08-13

### MCP

#### Fixed
- coalesce a burst of run_errors instead of nesting them (#1507)


## [0.51.25] - 2026-08-12

### MCP

#### Fixed
- bound the inline image so a huge render stays inspectable (#1505)


## [0.51.24] - 2026-08-12

### MCP

#### Fixed
- advertise the real version instead of a hardcoded 0.1.0 (#1503)


## [0.51.23] - 2026-08-12

### MCP

#### Fixed
- a paid third-party service node is not "local, no paid credits" (#1501)


## [0.51.22] - 2026-08-12

### MCP

#### Fixed
- report a remote ComfyUI that a restart stopped and nothing brought back (#1497)
- stop telling users to turn on a setting that does not exist (#1498)


## [0.51.21] - 2026-08-12

### MCP

#### Fixed
- the mismatch guard names a selector an unsaved tab actually has (#1492)


## [0.51.20] - 2026-08-12

### MCP

#### Fixed
- status must not call a PROVEN-dead download 'still streaming' (#1490)


## [0.51.19] - 2026-08-12

### MCP

#### Added
- ship the twelve locale catalogs the runtime has been waiting for (#1486)

#### Fixed
- refuse a download whose destination the server PROVABLY does not read (#1487)


## [0.51.18] - 2026-08-12

### MCP

#### Fixed
- refuse a download that would exhaust the cache volume (#1482)


## [0.51.17] - 2026-08-12

### MCP

#### Fixed
- name the restart that actually applies an npx update (#1475)
- show the Manager's own error body, bounded, instead of a bare status line (#1465)
- say that list_templates reflects what the server REGISTERS, not what is on disk (#1469)
- stable_audio_3 emits SaveAudioMP3 without required quality, and defaults to a silent sampler pair (#1466)
- say WHY remove searched fewer roots than list_paths shows (#1476)


## [0.51.16] - 2026-08-12

### MCP

#### Fixed
- an unresolved pack must not read as 'does not exist' on a possibly-stale catalogue (#1463)


## [0.51.15] - 2026-08-12

### MCP

#### Fixed
- workflow navigation has a reader too — name it (#1459)


## [0.51.14] - 2026-08-12

### MCP

#### Fixed
- tell a dropped graph write to verify with a graph READ, not the render queue (#1457)


## [0.51.13] - 2026-08-12

### MCP

#### Fixed
- compare the panel's tool vocabulary at the handshake, not at call time (#1455)


## [0.51.12] - 2026-08-11

### MCP

#### Fixed
- say how long the workflow switch has been holding (#1450)


## [0.51.11] - 2026-08-11

### MCP

#### Fixed
- a relay fence stops assuming the panel is served from COMFYUI_URL (#1446)


## [0.51.10] - 2026-08-11

### MCP

#### Fixed
- a retarget round-trip says nothing, instead of saying A changed to A (#1444)


## [0.51.9] - 2026-08-11

### MCP

#### Fixed
- an empty download listing stops reading as 'nothing is running' (#1441)


## [0.51.8] - 2026-08-11

### MCP

#### Fixed
- a panel message that arrives before boot finishes is no longer dropped (#1439)


## [0.51.7] - 2026-08-11

### MCP

#### Fixed
- a preserved fence that still matches is not 'graph tools will keep failing' (#1437)


## [0.51.6] - 2026-08-11

### MCP

#### Fixed
- the injected steering tells a code-mode agent where its panel tools actually are (#1435)


## [0.51.5] - 2026-08-11

### MCP

#### Fixed
- colon-qualified node ids stop being uneditable (and stop resolving to the wrong node) (#1433)


## [0.51.4] - 2026-08-11

### MCP

#### Fixed
- a retarget that lands mid-turn tells the agent its tools were stale (#1430)


## [0.51.3] - 2026-08-11

### MCP

#### Fixed
- reserve time to actually SAVE a recovered token (#1426)
- a human fetching a credential is not a stalled operation (#1424)


## [0.51.2] - 2026-08-11

### MCP

#### Fixed
- ui-bridge.test.ts flakes in isolation, not just under load (#1419)


## [0.51.1] - 2026-08-11

### MCP

#### Fixed
- name the Desktop launch arguments that did not take effect (#1414)
- the smoke mock implements what it advertises (#1412)


## [0.50.115] - 2026-08-11

### MCP

#### Fixed
- warn before a credential save orphans in-flight downloads (#1406)
- the smoke mock advertises a panel version, and a ratchet keeps it current (#1410)
- a completed job no longer matches its own re-entry guard (#1407)
- verify a .json attachment by parsing it, not by its content-type (#1405)
- prove the configured base before writing a model into it (#1403)


## [0.50.114] - 2026-08-11

### MCP

#### Fixed
- a local download should not need ComfyUI-Manager (#1393)


## [0.50.113] - 2026-08-11

### MCP

#### Fixed
- a frontend-only node is not an unknown runtime (#1396)


## [0.50.112] - 2026-08-11

### MCP

#### Fixed
- the live canvas gets its node definitions from its own ComfyUI (#1390)


## [0.50.111] - 2026-08-11

### MCP

#### Fixed
- stat the partial instead of asserting it (#1392)


## [0.50.110] - 2026-08-11

### MCP

#### Added
- panel_remove_widget — remove one dynamic widget row (#1387)

#### Fixed
- the workflow stamp survives a tab-id migration (#1389)
- a progress line is not a failure reason (#1386)


## [0.50.109] - 2026-08-11

### MCP

#### Added
- restrict the tool surface — deny/allow lists and presets (#1383)
- krea2-identity-edit — local outfit swap, on demand (#1376)


## [0.50.108] - 2026-08-10

### MCP

#### Added
- send operational status to the agent, not to the user (#1375)


## [0.50.107] - 2026-08-10

### MCP

#### Fixed
- gate the instance-witness channel too, not just the process probe (#1367)


## [0.50.106] - 2026-08-10

### MCP

#### Fixed
- say what a timed-out secret card actually means (#1364)


## [0.50.105] - 2026-08-10

### MCP

#### Fixed
- say WHICH host the node definitions came from when a remote strip fails (#1362)


## [0.50.104] - 2026-08-10

### MCP

#### Fixed
- stop telling a code-mode agent its panel tools are absent (#1360)


## [0.50.103] - 2026-08-10

### MCP

#### Fixed
- accept a Desktop bundle whose binary is branded differently (#1358)


## [0.50.102] - 2026-08-10

### MCP

#### Fixed
- clear the fence on the verdict that PROVED identity (#1355)


## [0.50.101] - 2026-08-10

### MCP

#### Fixed
- refresh the node schema and retry the add, once (#1354)
- consume a control_after_generate slot only when it holds a control mode (#1350)


## [0.50.100] - 2026-08-10

### MCP

#### Fixed
- stop reporting a lost transport as "the user cancelled" (#1348)


## [0.50.99] - 2026-08-10

### MCP

#### Fixed
- name the remedy that restores a trusted identity, not the one that cannot (#1346)


## [0.50.98] - 2026-08-10

### MCP

#### Fixed
- corroborate a fence mismatch before failing 14 calls closed (#1344)


## [0.50.97] - 2026-08-10

### MCP

#### Fixed
- a re-delivered completion must not disown a run we queued (#1342)


## [0.50.96] - 2026-08-10

### MCP

#### Fixed
- refuse an arbitrary-URL download once, before three requests fail (#1338)


## [0.50.95] - 2026-08-10

### MCP

#### Fixed
- ui-bridge.test.ts is load-sensitive — find the real rejection, don't loosen the assertion (#1336)
- the prescribed recovery from a lost tab binding is a dead end (#1322)


## [0.50.94] - 2026-08-10

### MCP

#### Fixed
- tell the user the install is damaged, instead of printing a resolver path (#1333)

#### Changed
- delete a header claim about a caller that does not exist (#1324)


## [0.50.93] - 2026-08-10

### MCP

#### Fixed
- anchor a relative launch script on Windows, where /proc has no equivalent (#1315)


## [0.50.92] - 2026-08-10

### MCP

#### Fixed
- stop prescribing a rebind that needs the tab we just said is missing (#1317)


## [0.50.91] - 2026-08-10

### MCP

#### Changed
- prove the live-process stub is in force, instead of assuming it (#1314)


## [0.50.90] - 2026-08-09

### MCP

#### Fixed
- resolve the panel base through the OS-observed process on Desktop (#1193)


## [0.50.89] - 2026-08-09

### MCP

#### Fixed
- this repo's own release subject is a release subject (#1310)


## [0.50.88] - 2026-08-09

### MCP

#### Fixed
- say it once — the interactive remedy repeated its own lead (#1307)
- give an interactive card a disconnect remedy that applies to it (#1305)


## [0.50.87] - 2026-08-09

### MCP

#### Fixed
- a proven-irrelevant stale copy no longer vetoes the download (#1298)
- say why a CivitAI download failed, instead of a bare status (#1303)

#### Changed
- 0.50.86 (#1304)
- 0.50.85 (#1302)


## [0.50.86] - 2026-08-09

> Covers changes since 0.50.85.

### MCP

#### Fixed

- **A failed model download now says WHY (#1300).** `download_model` reported
  `Download failed: 404 ` and nothing else, so a missing CivitAI token and a genuinely
  wrong URL were the same sentence — one reporter needed four attempts to download a
  single file. The server's own explanation is now carried back (bounded and scrubbed),
  and for CivitAI the message names the actual cause: no token configured, a token that
  is invalid or unentitled, or a metadata-query URL that needs the `?fileId=` form.

## [0.50.85] - 2026-08-09

### MCP

#### Fixed
- stop reporting a forgotten run as one you never queued (#1301)

#### Changed
- 0.50.84 (#1297)


## [0.50.84] - 2026-08-09

### MCP

#### Fixed
- absorb the post-restart reconciliation window in mode:"current" (#1292) (#1295)


## [0.50.83] - 2026-08-09

### MCP

#### Fixed
- say 'could not determine' instead of asserting the tab did not reconnect (panel#654) (#1289)

#### Changed
- fail when a test reaches the live-process probe unstubbed (#1291)
- 0.50.82 (#1288)


## [0.50.82] - 2026-08-09

### MCP

#### Fixed
- a tab id is a bridge ROUTE, not a workflow path (#1287)


## [0.50.81] - 2026-08-09

### MCP

#### Fixed
- an explicit workflow pin must clear an AMBIGUOUS turn pin (panel#888) (#1279)

#### Changed
- 0.50.80 (#1283)


## [0.50.80] - 2026-08-09

### MCP

#### Changed
- 'unreachable' is a specific claim, not a synonym for 'it failed' (#1281)
- 0.50.79 (#1280)


## [0.50.79] - 2026-08-09

### MCP

#### Fixed
- persist job records without a panel, so a restart can be survived (#1278)
- do not adopt an in-flight record whose writer is PROVEN gone (#1275)

#### Changed
- 0.50.78 — an open that lands on another workflow stops reporting success (panel#887) (#1276)


## [0.50.78] - 2026-08-09

### MCP

#### Fixed
- tell the caller when the post-open read contradicts the open (panel#887) (#1272)

#### Changed
- 0.50.77 (#1273)


## [0.50.77] - 2026-08-09

### MCP

#### Changed
- a failure message must not name a cause nobody observed (#1271)
- 0.50.76 (#1270)


## [0.50.76] - 2026-08-09

### MCP

#### Changed
- 'no saved sessions' must not also mean 'could not read them' (#1269)
- 0.50.75 (#1268)


## [0.50.75] - 2026-08-09

### MCP

#### Fixed
- download-manager-routing depends on state a neighbour primes (#1266)
- the identity refusal must describe the check it actually ran (#1255)

#### Changed
- a probe that FAILED must not answer 'no' (#1267)
- 0.50.74 (#1265)


## [0.50.74] - 2026-08-09

### MCP

#### Fixed
- a relaunch that exits 1 must say what the child printed (#1262)

#### Changed
- 0.50.73 (#1260)


## [0.50.73] - 2026-08-09

### MCP

#### Fixed
- 'latest' is not a git ref — do not check it out (#1258)

#### Changed
- 0.50.72 (#1256)


## [0.50.72] - 2026-08-09

### MCP

#### Fixed
- investigate #1077 Finding 2 — permanent refusal without a relay backend (#1252)

#### Changed
- reset the panel-base cache in the five files that never did (#1253)
- 0.50.71 (#1251)


## [0.50.71] - 2026-08-09

### MCP

#### Fixed
- the timeout must not offer a cause it already ruled out (#1247)
- get_history shows output VALUES, not just their keys (#1229)

#### Changed
- stop panelRecoveryContext wording depending on which test ran first (#1250)
- 0.50.70 (#1249)
- 0.50.69 (#1248)


## [0.50.70] - 2026-08-09

_No user-facing changes._


## [0.50.69] - 2026-08-09

### MCP

#### Fixed
- 127.0.0.1 and localhost are the same host, not a target drift (#1246)

#### Changed
- 0.50.68 (#1245)


## [0.50.68] - 2026-08-09

### MCP

#### Fixed
- the stale-heartbeat note must not tell a Manager dispatch to re-issue (#1242)

#### Changed
- 0.50.67 (#1241)


## [0.50.67] - 2026-08-09

### MCP

#### Fixed
- a relay session can adopt a workflow fence — it knows its own origin (#1240)


## [0.50.66] - 2026-08-09

### MCP

#### Fixed
- a CONFIRMED origin mismatch must not be lost inside the proof (#1235)

#### Changed
- delete civitai-lookup.ts, which nothing has ever imported (#1236)
- 0.50.65 (#1232)


## [0.50.65] - 2026-08-09

### MCP

#### Fixed
- enforce panel_graph_outline's max_chars when the live panel ignores it (#1228)
- make an unreachable host say unreachable, not 'nothing found' (#1136)

#### Changed
- 0.50.63 (#1227)


## [0.50.64] - 2026-08-09

_No user-facing changes._


## [0.50.63] - 2026-08-09

### MCP

#### Fixed
- stop redacting file paths and module names, and filter the log BEFORE scrubbing (#1225)

#### Changed
- 0.50.62 (#1224)


## [0.50.62] - 2026-08-09

### MCP

#### Fixed
- a 0-node outline right after a restore is not an observation (#1221)


## [0.50.61] - 2026-08-09

### MCP

#### Fixed
- de-flake two timing-dependent tests (#1216)


## [0.50.60] - 2026-08-09

_No user-facing changes._


## [0.50.59] - 2026-08-09

### MCP

#### Fixed
- status must not report a LIVE download as missing (#1213)
- type three test-only violations so `src/__tests__` can rejoin typechecking (#1204)


## [0.50.58] - 2026-08-09

### MCP

#### Fixed
- scrub /internal/logs before it reaches a tool result (#1209)


## [0.50.57] - 2026-08-09

### MCP

#### Fixed
- download status must not promise survival across an orchestrator restart (#1194)


## [0.50.56] - 2026-08-09

### MCP

#### Fixed
- redact the response body in the enqueue error builders (#1202)


## [0.50.55] - 2026-08-09

### MCP

#### Fixed
- a live ComfyUI-Manager download must not be reported INTERRUPTED (#1200)


## [0.50.54] - 2026-08-09

### MCP

#### Fixed
- a rebind that fails on an OLD panel says so, and names the version (#1199)


## [0.50.53] - 2026-08-09

### MCP

#### Fixed
- a 404 category is an ANSWER, not an unreadable one (#1196)


## [0.50.52] - 2026-08-09

### MCP

#### Fixed
- report the destination ComfyUI-Manager actually chose (#1190)


## [0.50.51] - 2026-08-09

### MCP

#### Fixed
- make the endpoint-specific !res.ok branches reachable (#1187)


## [0.50.50] - 2026-08-09

### MCP

#### Fixed
- a BACKGROUNDED phone is not a departed phone (#1185)


## [0.50.49] - 2026-08-09

### MCP

#### Fixed
- stop the client library's error path eating non-JSON responses (#1178)


## [0.50.48] - 2026-08-09

### MCP

#### Fixed
- the refusal names the origin the connected panel is actually on (#1181)


## [0.50.47] - 2026-08-08

### MCP

#### Fixed
- a non-JSON /prompt reply states the delivery doubt instead of a parser message (#1179)
- hold a turn's temp images past the turn, so a deferred read still finds them (#1177)


## [0.50.46] - 2026-08-08

### MCP

#### Fixed
- getHistory names the endpoint instead of leaking a parser message (#1172)


## [0.50.45] - 2026-08-08

### MCP

#### Fixed
- an interrupted download leaves a findable record instead of vanishing (#1170)


## [0.50.44] - 2026-08-08

### MCP

#### Fixed
- an EMPTY live listing is not evidence of a different install (#1168)
- a bare JSON parse error names the tool, the likely cause, and the delivery doubt (#1166)
- accept the video containers this codebase already recognizes (#1165)


## [0.50.43] - 2026-08-08

### MCP

#### Fixed
- stop reporting a live download as FAILED, and stop claiming bytes moved for a 404 (#1163)
- Save-As and new-workflow trust their OWN reply's proven uuid (#1161)
- recent_errors:0 returns none, and says the log was not checked (#1162)
- reopening a tab's OWN tmp: routing_key refreshes the fence (#1157)


## [0.50.42] - 2026-08-08

### MCP

#### Fixed
- a filtered empty listing says where else to look (#1158)
- name the tool that CAN install an unregistered pack (#1156)
- reject unrecognized argument keys instead of silently dropping them (#1153)
- stop abandoning a WRITE sooner than a read (#1154)


## [0.50.41] - 2026-08-08

### MCP

#### Added
- attach UI workflow metadata to API-enqueued prompts (#1124)


## [0.50.40] - 2026-08-08

### MCP

#### Fixed
- a REFUSED Manager enqueue falls through to the direct git clone (#1143)


## [0.50.39] - 2026-08-08

### MCP

#### Fixed
- a RESERVED Manager update is staged, not failed (#1141)


## [0.50.38] - 2026-08-08

### MCP

#### Fixed
- the GitHub Release body is THIS version's changelog, not every PR since forever (#1138)
- stop telling users to move a model into the folder it is already in (#1137)


## [0.50.37] - 2026-08-08

### RunPod image

#### Fixed
- a hash that could not be COMPUTED is not a hash that DIFFERED (#1123)

### MCP

#### Added
- report the ComfyUI FRONTEND version — the field #779 turned on (#1126)

#### Fixed
- REFUSE an auth-gated Manager dispatch instead of writing a corrupt model (#473) (#1134)
- finish the #796 review — baseline reaches zero, and a comment could switch the gate off (#1125)

#### Changed
- ask for the ComfyUI FRONTEND version, and say why (#1127)


## [0.50.36] - 2026-08-08

### MCP

#### Fixed
- a Manager listing is PLACEMENT, never validity — my 0.50.29 regression (#473) (#1120)

#### Changed
- the shipped build's data-loss guards must actually guard (#1119)
- pin the env var our errors tell people to set (#1118)
- the tunnel-deferral comment named a function that does not exist (#1117)


## [0.50.35] - 2026-08-08

### MCP

#### Fixed
- defer the update-restart while a phone is connected over a tunnel (#875) (#1115)


## [0.50.34] - 2026-08-08

### MCP

#### Added
- gate the "could not determine" → "determined not" collapse (#1110)

#### Fixed
- persist the phone pair token so a restart stops killing the link (#875) (#1113)


## [0.50.33] - 2026-08-08

### MCP

#### Added
- declare destructive/openWorld hints on the money-spending tools (#1108)

#### Fixed
- a fence the panel repaired mid-call is no longer reported as failure (#1043) (#1111)


## [0.50.32] - 2026-08-08

### MCP

#### Fixed
- an AMBIGUOUS turn is not a dead tab, and not a missing Origin (#1077) (#1107)
- refuse API/prompt format instead of crashing or lying (#1103)

#### Changed
- pin that every pack ships a UI workflow, not API/prompt (#1105)


## [0.50.31] - 2026-08-07

### MCP

#### Fixed
- a 403 already says WHY — stop dropping it (#1099)


## [0.50.30] - 2026-08-07

### MCP

#### Fixed
- a REMOTE no-reboot-endpoint failure now names what will work (#425) (#1100)
- name the tunnelled-remote case in the panel-restart refusal (#1098)


## [0.50.29] - 2026-08-07

### MCP

#### Fixed
- ask the server whether a Manager dispatch landed (#1086) (#1096)

#### Changed
- tell callers to add sequentially, and why (#1095)


## [0.50.28] - 2026-08-07

### MCP

#### Fixed
- an unreadable overrides file is preserved, not erased (#796) (#1093)


## [0.50.27] - 2026-08-07

### MCP

#### Fixed
- never overwrite a ~/.claude.json we could not read (#796) (#1091)
- a Manager dispatch must not promise where the file lands (#1090)


## [0.50.26] - 2026-08-07

### MCP

#### Fixed
- a config that could not be loaded is neither empty nor disposable (#796) (#1087)


## [0.50.25] - 2026-08-07

### MCP

#### Fixed
- a refused adoption now says WHICH gate refused it (#1077) (#1084)
- an unreadable settings answer is not an empty one (#796) (#1082)
- say that `name` is dropped when the slot is reused (#1081)

#### Changed
- record the first measured arm, and what is still unmeasured (#1083)


## [0.50.24] - 2026-08-07

### MCP

#### Fixed
- a store that could not be READ is never overwritten (#796) (#1079)
- a log that could not be read is not a clean restart (#796) (#1078)


## [0.50.23] - 2026-08-07

### MCP

#### Fixed
- the fence repair was gated behind the one call the wedge blocks (#1075)


## [0.50.22] - 2026-08-07

### MCP

#### Fixed
- the advertise retry loop could not retry (#1073)
- getSystemStats must be able to fail, and fetchImage must be able to time out (#1072)
- give the cloud client the timeout ceiling and delivery doubt its twin already had (#1069)
- a transport failure on a POST no longer implies the POST never arrived (#1068)
- a reply-timeout on a mutating command no longer reads as "nothing happened" (#1067)
- two release gates anchored to a frozen retirement baseline instead of the live surface (#1066)

#### Changed
- verify the published PANEL surface builds too (#1065)
- verify the published surface REGISTERS, not just that it boots (#1064)
- the startup probe budget is 60, not 20 — and gate the drift (#1063)
- COMFYUI_MCP_NO_AUTOSPAWN does not exist — name the control that does (#1062)


## [0.50.21] - 2026-08-07

### MCP

#### Fixed
- the generate_* family reports rejected output branches too (#1060)

#### Changed
- a remedy never names an action the tool does not have (#1059)


## [0.50.20] - 2026-08-07

### MCP

#### Fixed
- settle before re-issuing a scoped run that lost the stamp race (#1057)


## [0.50.19] - 2026-08-07

### MCP

#### Fixed
- make the character budget reachable (#1055)


## [0.50.18] - 2026-08-07

### MCP

#### Fixed
- I/O dirs follow the CONNECTED ComfyUI, not a second install (#1053)

#### Changed
- pin that nested "<node>.<combo>.<leaf>" override keys work (#1051)


## [0.50.17] - 2026-08-07

### MCP

#### Fixed
- a save's tmp:→wf: rename is one origin, not a mixed batch (#1047)


## [0.50.16] - 2026-08-07

### MCP

#### Fixed
- a Save-As re-anchors the session fence too (#1046)


## [0.50.15] - 2026-08-07

### MCP

#### Fixed
- a queued prompt can still have had output branches rejected (#1042)


## [0.50.14] - 2026-08-07

### MCP

#### Fixed
- settle the linked-nested placeholder ambiguity by counting the row (#1040)


## [0.50.13] - 2026-08-07

### MCP

#### Fixed
- bound the four process probes that can wedge startup (#1038)


## [0.50.12] - 2026-08-07

### MCP

#### Fixed
- talk to the SAME ComfyUI as every other tool (#1035)


## [0.50.11] - 2026-08-07

### MCP

#### Added
- tool-reach corpus for the consolidated 37-tool surface (#1003)

#### Fixed
- a ComfyUI call with no budget of its own had no time limit (#1033)


## [0.50.10] - 2026-08-07

### MCP

#### Fixed
- close the swap window — and fix the reproduction that hid it (#1031)


## [0.50.9] - 2026-08-07

### MCP

#### Fixed
- retry a mid-workflow-switch refusal instead of surfacing it (#1029)
- bound the skill-generator's network calls (#1028)


## [0.50.8] - 2026-08-07

### MCP

#### Fixed
- a new canvas gets a new fence (#1024)
- accept the node ids we print, and say which canvas args were ignored (#1023)
- accept the todo status spellings agents actually produce (#1022)


## [0.50.7] - 2026-08-07

### MCP

#### Fixed
- say at pair time whether the phone URL survives a restart (#1020)
- name the panel's ComfyUI origin instead of asking the reader to check (#1019)
- describe an unparsable category body from what was observed (#1017)
- an ambiguous routing pin is not a reconnecting panel (#1016)
- an explicit retry is not a blind re-issue (#1014)


## [0.50.6] - 2026-08-07

### MCP

#### Fixed
- ask PowerShell for UTF-8 before reading a process command line (#1012)
- the ACTION-level admission refusal owes the same explanation the name-level one got (#1008)
- scan untracked files too, and say what was skipped (#1009)
- dedupe the changelog against what it already says (#1007)


## [0.50.5] - 2026-08-07

### MCP

#### Fixed
- a render completion is a STEP when a plan is still running (#1002)
- name our own User-Agent, and stop pushing Windows onto Python (#1000)
- the Manager route is a routing fallback, not a remote server (#999)
- say WHY the caller is holding a tool that does not exist (#998)

#### Changed
- reach the injection call sites three fixes could not (#1004)


## [0.50.4] - 2026-08-07

### MCP

#### Added
- summary_only, so the report costs a report (panel#690(5)) (#992)
- expose the filter/limit the panel now honours (panel#690(5)) (#990)

#### Fixed
- list what the server REGISTERS, not 15 hardcoded folder names (#995)
- a batch queues N runs, so ticket N runs (#994)
- extend the unapplied-filter guard past `creator` (#993)
- a run-error notice must not assert who queued the run (#991)
- a remedy has to work from where the user is reading it (#989)
- a slice that matches no output node explains why (panel#690(4)) (#986)


## [0.50.3] - 2026-08-07

### MCP

#### Fixed
- a path in `filename` is a subfolder request, not a broken upload (#985)
- two different tabs must not render identically (#984)
- a painted card is not a loaded image (#982)
- an untrusted hello must not ERASE the tab's command stamp (#976)

#### Changed
- stop betting on 25ms to decide when the abort lands (#981)


## [0.50.2] - 2026-08-07

### MCP

#### Fixed
- a remote listing is incomplete BY CONSTRUCTION — say so, on every result (#975)
- don't lead with an update when the disk version was never read (#974)
- a `git pull` that exits 0 is not proof the checkout moved (#972)
- a minted prompt_id is a receipt, not a flag (#971)
- a run is owned by the conversation that queued it, not by the tab id (#969)
- stop letting "fetch failed" stand in for a diagnosis (#968)
- stop reporting an unread model list as an empty install (#967)
- map live-canvas widgets by NAME, and disclose when we can't (#966)
- publish the admission surface, and stop conflating "excluded" with "unknown" (#965)
- detect panel/server vocabulary skew at the handshake, not at call time (#964)


## [0.50.1] - 2026-08-06

Ten fixes on top of the 0.50.0 consolidation, and most of them are one defect class:
a tool reporting something it had not actually established.

A restart fenced the endpoint rather than the instance, so a same-URL reaffirmation
bumped a generation without moving anything. A backend stall reached the agent as a
USER rejection. `panel_run` could stack a duplicate after a reconnect, because the
self-queue ledger is prompt-id based and in-memory — so the agent's OWN earlier render
read as unattributed; the fence now demands PROVEN self-attribution and refuses with the
override named rather than silently duplicating. A "panel install did NOT land" warning
fired against a tree the retarget had already corrected. And `self_update` on Windows
could never succeed at all: the running orchestrator holds its own sharp DLL open, the
in-place npm replace failed EBUSY, and the error was swallowed.

Also here: the test suite could rewrite the developer's real `~/.comfyui-mcp` state. That
had been fixed four separate times per-test and kept coming back, so the whole run is now
redirected before workers fork. And the vocabulary gate was counting mentions by raw
substring while every other check is token-bounded — where a live name contains a dead one
(`self_update_action` vs `self_update`) it overcounted and silently denied valid exemptions.

### MCP

#### Fixed
- a failed clone must not leave something ComfyUI will try to load (#917)
- redirect every persistent store for the whole run (#930)
- say where the listing came from, instead of making callers guess (#915)
- count mentions the way the gate detects them; stop welding doc lines together (#951)

#### Changed
- warn that Manager's "Nightly" is not nightly, and is routinely older than Latest (#931)
- self_update on Windows: EBUSY on own sharp dll, npm error swallowed; updater failure + cancelled restart disconnects bridge (#924)
- VRAM handoff during renders skips the llama.cpp backend (#927)
- panel run/sync truthfulness: duplicate run after reconnect + false 'panel install did NOT land' warning (#926)
- turn lifecycle: Claude backend stall still reported as user rejection + turn registry does not survive reconnect (#923)
- restart fences the endpoint, not the instance + cannot identify local process without start times (#925)


## [0.50.0] - 2026-08-06

The tool surface consolidates. Roughly 143 individually-registered tools fold into
an action-parameterized core (37 tools), cutting what a client sees on `tools/list`
by well over half — and with the surface small enough to carry, the default flips
back to FULL, so `--compact` becomes the opt-in rather than the way most clients
have to run.

Every folded name is redirected rather than removed: calling a retired name reports
what it became and which action replaces it, instead of failing as an unknown tool.
That is enforced mechanically — every name that has ever existed and no longer does
must be declared dead — so a tool cannot quietly vanish and leave rot behind.

The per-slice entries are under **Changed** below.

### MCP

#### Added
- flip the default to full; --compact becomes the opt-in (#942)
- arena records VRAM/quant/version axes and flags suspect scenarios
- audio attachments on the agent turn, and per-model tool mode

#### Fixed
- sessions are orchestrator-scoped — one agent across all tabs and workflows (#884) (#897)
- report a retired tool name as retired, not as unpermitted (#911)
- main is red — a retired name came back in generate_image (#936)
- gate round 3 — a stale-but-alive sibling also suppresses the tray-row clear (#858)
- gate round 2 — disclose when the dead record file can't be deleted (#858)
- stop refusing correct destinations — diffusers contract-empty listing (#844) + in-tree junction escapes (#870)
- codex gate r2 — positive identification for 'incapable', integer-safe seed bounds
- gate round 1 — don't claim the tray row was removed; count both live row ids (#858)
- codex gate r1 — refuse unsafe declared ranges, honest capability claims, sharper tests
- cancel a stale download once its writer is proven gone + deterministic interference test (#858, #869)
- seed draws honor declared max, explicit seeds survive, auto-select skips non-txt2img checkpoints
- teach the dead-name gate the difference between a dead TOOL and a live ACTION (#905)
- never write our database inside someone else's git tree (#891)
- serve the retirement ledger on direct tools/call, not only through the facade (#895)
- the first independent gate on the #842 branch (#880)
- rename before you inspect — a path read is not an ownership proof
- once a lock can be taken away, every path must prove it owns it
- explicit reclaim for a proven-abandoned op lock, durable marker/pin writes, honest panel_reload scope (#760, #798, #765)
- mixed-version best-of ranges are not one known version
- suspect analysis pools only one comfyui-mcp version
- the suspect signal counts distinct models, not leaderboard entries
- legacy okTools are not selection evidence in the suspect analysis
- a pending triage may have no job_id — say so (codex gate r2)
- a live model switch must not be silently ignored on the OpenAI dialect
- bracket EVERY entry, and stop the guard claiming more than it observed (codex gate r1)
- a snapshot of the queue is not an exclusion — bracket the merge (codex gate)
- a live switch rewrites the prompt; the audio table covers real containers
- codex gate r2 — a malformed historical counter is not 'missing'
- codex gate r1 — name partial vs incoherent truthfully; drop the false ~5-minute ceiling
- git-verify a provably-idle incoherent Manager queue; report_issue sets blocking-wait expectation
- five findings from the seventh gate pass
- audio survives re-delivery, and the delivery proof is per TURN
- acceptance proof is per media KIND, and the refusal's remedy is honest
- the attachment-acceptance proof must not survive a model switch
- honest delivery boundaries, and drop the ACP path we cannot exercise
- five more findings from the second gate pass
- the auto-install gate must name the tree it installs into; sweep "could not determine" folds (#820, #796)
- five findings from the adversarial gate

#### Changed
- 0.50.0 slice 13: consolidate install/environment and stats/diagnostics (10 to 2) (#909)
- 0.50.0 slice 16: consolidate execution, generation and observability (18→3) (#907)
- 0.50.0 slice 15: consolidate images and assets (12 to 2) (#903)
- 0.50.0 slice 12: consolidate custom nodes and node authoring (20 to 3) (#904)
- 0.50.0 slice 14: consolidate workflow authoring and library (20→4) (#906)
- 0.50.0 slice 11: consolidate models (14→2) (#901)
- a late probe must not overwrite a newer cache entry (#879)
- 0.50.0 slice 10: consolidate training (18→3) (#898)
- 0.50.0 slice 9: consolidate knowledge (9→1) (#896)
- list_output_images returns [] on a local install whose path comes from the saved workspace (#877) (#883)
- 0.50.0 slice 7: consolidate process control, API nodes and defaults (10→3) (#894)
- 0.50.0 slice 8: consolidate runpod (11→2) (#893)
- remote ComfyUI and secrets: HTML where JSON was promised, and a secret that reports success without reaching the child (#837)
- path + environment probing: 'could not determine' is not 'determined it is not' (#835)
- follow-up to #839: fix the three gate findings that merged unaddressed (#882)
- install_panel git fallback: four claims the concurrency bracket could not establish (follow-up to #840) (#878)
- node search + install: registry packs that exist on disk read as absent, results that cannot be installed as returned (#834)
- graph binding after reconnect/retarget: a documented recovery that could not recover (#803, #770, #772) (#833)
- restart + session reporting: stale launch arguments, a premature failure verdict, and a stale version line (#850)
- the 20 MB refusal is a dead end for local video (orchestrator half of #648) (#854)


## [0.49.8] - 2026-08-05

### MCP

#### Added
- add --help, deriving every default from the parser rather than restating it (#864)

#### Fixed
- **a zero-byte pending-ops marker wedged `update_all` permanently (#847).** The wedge was
  self-perpetuating: `recordPanelPendingOp` threw on any unreadable prior marker, and
  `JSON.parse("")` throws — so a zero-byte `~/.comfyui-mcp/panel-pending-ops.json` made it
  throw forever. It runs BEFORE the ComfyUI-Manager handoff by design, so `update_all` could
  never start again, and the write that would have replaced the bad file was gated behind the
  same check the bad file failed. Deleting the file by hand was the only escape.

  An empty file and an undecodable one now answer different questions: overwriting an empty
  one loses nothing (so it is superseded), while content we cannot decode may describe a real
  queued operation (so it is still refused). Both refusals name the file path, and the two
  warnings differ in what they tell you to do. Both writers are now atomic (temp + fsync +
  rename), so a crash can no longer leave a zero-byte file at all, and superseding a
  pre-existing one carries an indeterminate record forward — the block lifts, the warning
  does not.

  Also fixed on the way: the test suite was writing live pending-op markers into the real
  `~/.comfyui-mcp`, where the orchestrator reads them and warns on every pin write about
  operations that never happened. Third such leak found (after the real `.env` and the real
  OAuth mirror); a runtime guard covering all of them is tracked in #866.
- readOAuthStatus threaded home to one of its two halves (#863)

#### Changed
- .env.example advertised the wrong default, and the README shipped a section twice (#861)
- tell absent from blocked from undiscoverable — and stop our own messages asserting causes they did not observe (#841)
- truncated results fit the budget they report, and a library listing that looks in the folders (#807, #810) (#838)


## [0.49.7] - 2026-08-05

### MCP

#### Fixed
- attribute a changelog entry to the PR, not the first issue it cites (#856)
- the changelog generator silently dropped the entries that mattered most (#855)

#### Changed
- **panel version floor: blocked mutations with no self-service path, and "up-to-date"
  that means "meets the minimum" (#832).** A read was being blocked by a WRITE gate: the
  workflow fence asked "can this reach the wrong workflow's content?" and answered it with
  a set that exists to answer "is this safe to re-dispatch after a reconnect?". Eight graph
  commands that are genuine reads were refused as canvas mutations on older panels. There
  is now a single effect ledger with enforcement a rename cannot step over. Separately,
  a non-parseable advertised version (`nightly`, which is what ComfyUI-Manager reports for
  a git-installed pack) was rendered as an observed version and an age verdict; it is now
  screened by parseability and shown verbatim as evidence. Closes #819, #812, #806, #778;
  #823 remains partly open.
- give the suite a real timeout — the "rotating cast of flaky files" was runner starvation (#852) (#853)


## [0.49.6] - 2026-08-04

### MCP

#### Fixed
- **`download_model`: large-file timeouts, no resume, wrong base on Windows portable,
  and non-unique job ids (#831).** Large HuggingFace downloads timed out at 600s with no
  way to resume; a resume could silently discard a 96%-complete partial; a remote CivitAI
  auth/error page could be saved as if it were a model; and `download_status` lost
  in-flight ids. Destroying a staged file now requires re-proving, immediately before each
  syscall, that it is still the file the caller checked — so a second download of the same
  model can no longer delete the first one's resumable bytes or its validator. An
  unreadable staged file is reported as unknown rather than folded into "absent", which
  previously let a fresh response truncate an existing partial.
  Fixes #343, #401, #467, #470, #473, #529, #547, #761, #813, #817, #822.
- test reliability: a fixture bound a guessed random port and hung ~1 in 8 when that port
  was already held; it now binds `listen(0)` and reads the assigned port back, and a bind
  failure reports as a setup failure instead of a timeout in the behaviour under test (#843, #821)
- preserve AUTOGROW dotted workflow inputs (#763)
- truncated results name their own remedy — and one that works from where the caller is (#818)
- never stop a ComfyUI that cannot be proven relaunchable, and attribute a listener without lsof (#814) (#830)


## [0.49.5] - 2026-08-04

### MCP

#### Fixed
- `panel_ask`: a validated answer is now durable and is never delivered across a tab or conversation boundary (#486) (#811)
- `restart_comfyui`: preserve the launcher environment, and never report ownership or a restart that was not observed (#776) (#785)
- `install_panel`: the panel swap is crash-safe by ordering, and the status report no longer claims what it never observed (#771) (#793)
- `strip_workflow` / `panel_flatten_workflow`: preserve dynamic widget values and virtual-node links, and disclose anything dropped (#361) (#805)
- panel agent: rebind the agent tab across id migration and keep the release fallback starvation-free (#568) (#802)

## [0.49.4] - 2026-08-03

### MCP

#### Fixed
- poll past the worker's wall clock + surface root-cause clusters (#799)
- make the completion event durable across automatic goal continuation (#468) (#786)
- resolve panel_load_workflow relative paths against the live user directory (#202) (#787)
- resolve the destination from the live server and verify it on disk (#369) (#794)
- stop root icon requests becoming logged 404s (#783)
- distinguish watchdog stalls from user cancellations (#782)
- make stale panel-lock recovery fail closed (#779)
- list reachable local extra paths without argv main.py (#781)
- retain stale persisted downloads (#761) (#780)
- gate the hello retarget on the server-observed origin — never trust the spoofable claim (codex gate)
- hello veto protects only a healthy target — a ComfyUI restart can no longer pin stale remote state
- do not capability-mark the no-trusted-identity refusal (codex gate)
- type the capability refusal; full tab id + hard-refresh recovery


## [0.49.3] - 2026-08-03

### MCP

#### Fixed
- panel_ask and other blocking card tools no longer die at 60s on ollama-family backends — the internal panel MCP client now uses a 315s timeout, above the longest card budget (#325) (#754)
- list_assets reconciles from ComfyUI history, so panel-dispatched renders and earlier sessions surface — every registered record requires affirmative success evidence (on both the watched and reconcile paths), a non-empty filename, a real output, and a truthfully-sourced completion time (#751) (#753)
- the too-old panel verdict now quotes both detected panel and MCP versions (#422) (#755)


## [0.49.2] - 2026-08-02

### MCP

#### Fixed
- restart safety: a refuse-safe preflight now runs BEFORE any stop in the panel restart flow — an instance with no provable relaunch (Pinokio-style installs) is refused, never stopped; the preflight validates the immutable tab-fronted instance under a generation-stable target (a monotonic target generation detects mid-flight config/tab changes, including A→B→A retargets) (#742)
- restart reporting: the decline path no longer asserts "not restarted" blind — a bounded full-window probe distinguishes a restarting server from a genuinely lost one, and causation claims ("a restart initiated earlier…") require a session-held, bound-confirmed, recent dispatch token with an identity-checked lifecycle (#742)
- turn reliability: the stall watchdog reports exactly one failure per turn (either event order), holds the turn gate until the genuine turn end, and dead-letters straggler emissions from abandoned turns via backend-minted turn markers on every backend (#728)
- Claude backend: blocking SDK informational messages (hook blocks) surface exactly one error instead of a silent "successful" empty turn; result classification is per-turn (submission-stamped traces, real success/error_* vocabulary); traceless, gap-crossing, or late results fail closed as unverifiable instead of fabricating success (#740)
- `panel_add_node` documents the frontend-only virtual types (Note/MarkdownNote/Reroute/PrimitiveNode) as the supported way to annotate a workflow (#741)
- bump sharp to >=0.35.0 (GHSA-f88m-g3jw-g9cj)

### Docs
- docs proxy worker 301s bare doc paths onto /docs/* (fixes broken internal links on the live site)
- internal links converted to relative paths for the subpath deployment
- /packs/* links repointed to their GitHub tree paths


## [0.49.1] - 2026-08-02

### MCP

#### Added
- epoch-first session_epoch frame on every hello (#694) (#713)
- explicit retry identity (retry_of) for outcome-unknown mutations (#694) (#704)
- add atomic node editor

#### Fixed
- un-mangle the double-encoded ⚠️ in the panel sync say texts
- carry the trusted workflow stamp across proven tab-id migrations
- update/reinstall require post-op presence proof (no queue-drain trust)
- codex gate — spawn cwd must be an existing DIRECTORY, not merely exist
- restart_comfyui spawns with an explicit absolute cwd (no more main.py ENOENT)
- codex-gate r9 — malformed pending_count is unproven; dialect probe targets the op's own base
- codex-gate r8 — strict required fields in the proven signature; at-tip result honesty
- codex-gate r7 — pin the merged rev end-to-end; strict empty-queue signature
- codex-gate r6 — refuse pulls that would silently overwrite ignored files
- codex-gate r5 — dialect gate via proven-legacy probe, honest result message
- 'at upstream tip' requires HEAD === @{upstream} proof
- the fallback's pre-pull revision gate — never mutate on an unprovable no-op
- an unreadable post-pull HEAD revision fails closed — never 'at tip'
- prove the panel dir IS the worktree root before any fallback mutation
- gate the #724 git fallback on a clean worktree and one bound directory
- git pull --ff-only fallback when legacy Manager 3.x no-ops a panel update (#724)
- refresh workflow stamp after open (#716)
- require at-write workflow fencing (#718)
- reconcile download tray after restart
- structure Model Explorer 404s (#363)
- report stale graph capability after restart
- sync handshake capability floor (#712)
- preserve unrelated work on panel pin (#715)
- pin write cancels pending update_all / snapshot restore (#689) (#702)
- sync panel skew when desktop tab connects (#710)
- preserve flatten load failures (#707)
- use saved workspace for panel management (#705)
- preserve legacy color compatibility
- keep edit schemas Codex-compatible
- align legacy color validation
- validate edits and preserve legacy commands
- preserve line breaks in generated tool descriptions (review nit)
- measure non-string widget values by their real serialization (review nit)
- route describe facade through call_tool (#693)
- unclassified versions are never vouched in SFW search (#664 gate)


## [0.49.0] - 2026-08-02

### Highlights for 0.49.0

**Tool-surface consolidation begins (BREAKING for removed names).** 0.49.0 starts folding families of single-purpose tools into action-parameterized ones: the five node-bisect tools → `node_bisect` (#644), node snapshots 3→1, batch 4→1, apps 5→1 (#658), and the eight `comfy_cli_*` tools → `comfy_cli` (#684) — **162 tools total, down from 182**. Every removed name is in the `DEAD_NAMES` ledger and calling it returns a specific retired-name error quoting the replacement (#679), never a bare "unknown tool". A CI vocabulary gate fails the build on any live reference to a retired name.

**Compact tool surface by default (BREAKING).** New installs now default to the compact 3-meta-tool facade (`list_tools` / `call_tool` / `describe_tool`) — no more ~70k-token tool dumps into context (#667). Restore the full surface with `--full` or `COMFYUI_MCP_TOOL_MODE=full`; explicit choices propagate correctly to orchestrator children and the Ollama path (#682).

**Interpreter ground truth, end to end.** `get_environment` no longer guesses which Python ComfyUI runs: it resolves the interpreter from observed process identity (PID + creation time for what we launched; command-line correlation against the server's own argv otherwise) and reports `unknown` instead of a confidently wrong answer — the false "Triton: not installed" that made an agent strip working acceleration is dead (#401/#650). Package installs and `update_comfyui` now target that same observed interpreter and **refuse** when it can't be verified, instead of landing in a sibling env the server can't import from (#651/#668).

**Manager dialect cache that heals.** The ComfyUI-Manager 3.x/v4 dialect cache invalidates on restart-at-same-URL and on dialect-mismatch, retries pin to the original target (a mid-flight retarget can't redirect a queued op), and `update_all` goes through the same detection instead of a hardcoded legacy route (#646/#670, #656/#680). Remaining legacy-route bypasses are tracked in #681.

**Node-pack auto-sync skill.** On orchestrator update the agent can now bring the panel pack in sync through the verified install path — with the pin contract: explicit pins are never auto-updated over, pinned-and-behind shows a visible drift warning in every state, and unpin/reset is one tool call away (#657). update_all / snapshot-restore / workflow-deps can no longer side-step the pin guard either.

**Media saves that prove their bytes.** `get_image` saves valid MP4s (and other video/audio) to disk instead of rejecting them (#663) — with a full junk-body gate: declared type, magic-byte structure, format family, and filename extension must all agree, or the save refuses rather than write a corrupt asset.

**Truthful bridge and downloads.** Bridge command retries after a timeout reuse the original rid and the panel dedupes by rid + payload fingerprint, so a retried mutation can't double-apply (#517/#683). Downloads resolve their destination from live config and join category entries correctly (#636). `install_panel` verifies the pack actually moved on disk and fails closed on shadow copies (#639/#641/#647).

**Also:** MiniMax provider, `model_metadata_read` local fallback when the optional Model Explorer node is absent (#363), honest version-skew errors for untabled panel commands (#619), docker-compose example + stdio deployment docs (#660), `@comfyorg/sdk` added for upcoming Comfy API v2 work (#672), and the test suite runs green on machines with ripgrep installed (#655).

### MCP

#### Added
- pinned drift warning in every state, incl. remote/dev-install
- agent-driven panel node-pack sync on orchestrator update
- add pi.dev as a first-class agent backend (#491)
- add MiniMax as a first-class API-key provider (#355)
- 0.49.0 guardrails (Phases 0-1) rebased onto 0.48.32 main

#### Fixed
- drift warning in blocked states; honest install reporting; scan-reliable manifest verify
- refuse unbound panel mutations
- an unreliable panel scan blocks the deps install too
- carry scanReliable in PanelStatus; an unreliable scan blocks sync
- keep pending and manifest panel checks honest
- report generic bulk updates as unverified
- fail closed on stale locks and pending operations
- close two more pin-bypass doors + make the lock actually safe
- close the generic-node-tool pin bypass + a real cross-process lock
- close codex round 3 — honest pin-state reporting, blocked on an incomplete shadow scan
- close codex round 2 — pin writes take the op lock, no inert-pin claim, strict semver
- close 4 codex findings — array-settings fail-open, op race, tri-state stillBehind
- scope OAuth readiness to capable providers
- respect OAuth capability and stored template ownership
- fall through unusable stored API keys
- fall through empty Vertex key to ADC
- mirror exact Vertex provider precedence
- mirror current scoped credential precedence
- scope readiness to selected provider
- a `null` auth.json breaks pi's auth layer outright (codex round 13)
- OAuth expiry is ms with a 5-min window; keyless Vertex records (codex round 12)
- drop two over-strict schema checks (codex round 11)
- bedrock provider id + cost tiers + present-null (codex round 10)
- finish the schema transcription (cost/thinkingLevelMap/modelOverrides) — codex round 9
- transcribe pi's models.json schema instead of approximating it (codex round 8)
- relative config dir, stored-cloudflare companion, typed schema fields (codex round 7)
- companion-config + schema precision (codex round 6)
- match pi's resolver exactly — stored-owns-provider, escapes, agent dir (codex round 5)
- close remaining false-green readiness paths (codex round 4)
- readiness precision — match pi's real credential validation (#491)
- provider-auth codex round 3 (P0a-resume + P1a two-sided)
- provider-auth codex round 2 (P0a/P1a/P1b/P1c)
- address codex review (stdout/close, ANSI, .cmd, false-auth, model)
- require exact resolved path for open recovery
- require resolved workflow identity for open recovery
- require open receipt for timeout recovery
- reuse the original rid on mutation retry + surface late completions (#517) (#683)
- route remaining callers through detected dialect (#681)
- probe the ComfyUI venv interpreter, never fabricate "not installed" (#401) (#650)
- route update_all tool through detectManagerApi (#656) (#680)
- honor the saved default workspace when COMFYUI_PATH is unset (#648) (#652)
- retired-name error from the DEAD_NAMES ledger on call_tool (#659) (#679)
- target the live ComfyUI interpreter (#668)
- pin dialect retries to original target (#670)
- disambiguate panel_graph_outline vs visualize_workflow vs panel_query_graph (#557) (#654)
- route legacy ComfyUI-Manager self-update off the 405 path (#424) (#649)
- #641 shadow detection — content-first + fail-closed hardening
- verify the panel actually changed + detect shadow copies (#639, #641)
- remove NUL-byte percent sentinel + normalize CRLF→LF (file integrity)
- identity-guard the durable resume + include render-held in the owned-set (#570)
- clear the superseded destination's render-held queue on a tab-id collision (#570 P0)
- derive stable-key ownership from the full retained-session SET, not the current-backend mapping (#570 P0)
- gate stable-key hello.resume by concurrent-tab ownership (#570 P0)
- reset the superseded destination for ANY state (incl. dormant session) on a tab-id collision (#570 P0)
- collision handling resets the SUPERSEDED destination (not the source) + clears its bridge buffers (#570 P0)
- retire the source agent on a tab-id migration collision — no cross-tab leak (#570 P0)
- rebind ALL backends on a proven tab-id migration, not just the current one (#570 P0)
- carry the proven source identity across a tab-id migration so the rebound agent survives (#570 P0)
- fence workflow mutators by RESOLVED TARGET, not raw path presence (#570 P0)
- make workflow_uuid bridge-owned (non-overridable) at dispatch (#570 P0c)
- close the empty-path bypass in the active-workflow mutation gate + document scope (#570 P0c)
- require a trusted uuid stamp (not just the enforcement flag) to dispatch an active-workflow mutation (#570 P0c)
- retire (not reset) the prior provider on a hello-driven backend switch too (#570 P0)
- retire (not reset) the prior provider on an explicit backend switch (#570 P0)
- per-backend identity teardown so a cold-start provider switch can't erase a same-workflow session (#570 P0)
- extend the fail-closed gate to active-workflow mutators (workflow_close/save/…) (#570 P0c)
- detach migrated mirror on unproven switch + fail closed for non-enforcing panels (#570 P0a/P0c)
- stamp each command with its origin workflow uuid so the panel fences a post-switch apply (#570 P0)
- detach mirror viewers on an unproven same-socket workflow switch (#570 P0)
- cancel the OLD id's bridge queues on an unproven same-socket switch (#570 P0)
- reject in-flight bridge commands for a replaced tab (#570 P0)
- complete per-tab bridge reset — also cancel awaitingReconnect (#570 P0a)
- invert the identity boundary — unconditional, complete teardown when unproven (#570 P0)
- drop buffered deliveries before replay on an unproven identity transition (#570 P0)
- fail closed at the identity boundary — reset unless POSITIVELY proven (#570 P0)
- re-key held render queues for ALL providers on a proven migration (#570)
- count failed-start held mail as per-tab state at the identity boundary (#570 P0)
- tear down ALL per-tab state on an unproven identity transition (#570 P0a/P0b)
- bind the exact session to the FULL identity (origin+uuid), not just uuid (#570 P0)
- trust an exact session only when PROVEN to own the identity (incl. identity-less) (#570 P0)
- fail closed on pre-upgrade exact records with no identity binding (#570 P0)
- in-place replace resets the LIVE agent, not just disk state (#570 P0)
- bind the exact session to a durable identity uuid; clear on in-place replace (#570 P0)
- reject an unowned hello.resume — bind resume to trusted identity (#570 P0)
- cancel render-queued work across ALL providers on a workflow switch (#570 P0a)
- fence the old bridge route on an unproven same-socket switch (#570 P0a)
- disclose (don't silently drop) render-queued messages on a workflow switch (#570 P0a)
- fail closed on same-socket re-hello without proven identity + no post-retire leak (#570 P0a)
- don't rebind one workflow's agent onto another on a same-socket switch (#570 P0a)
- key unsaved-workflow resume on the panel's durable per-instance uuid (#570)
- resolve destination from the LIVE server's models dir + allow symlinks into registered model roots (#346, #633)


## [0.48.32] - 2026-08-01

### MCP

#### Added
- add panel_set_property MCP tool (#488) (#634)

#### Fixed
- resume — X-Linked-Etag false-changed across hops deleted valid partial (#467) (#637)
- bound the restart-confirmation card wait (panel #404) (#635)
- never file/PR under an ambient gh account unprompted — Worker is the autonomous default (project identity); gh path requires account-awareness + explicit consent (#632)


## [0.48.31] - 2026-08-01

### MCP

#### Added
- panel_civitai_results returns inline sample images so the agent can SEE them (#623) (#628)

#### Fixed
- resolve local workspace via shared fallback when COMFYUI_PATH unset (#506) (#629)
- drop superseded-attempt terminal events (panel#489) (#627)


## [0.48.30] - 2026-08-01

### Fixed
- **`panel_refresh_nodes` (and any newer bridge command) against an older panel now returns an actionable "update your panel to ≥X.Y.Z" error instead of the opaque `Unknown command "refresh_nodes"` (#619).** The #608 refresh executor shipped in panel 0.11.28; on a 0.11.20 panel the command was unrecognized, but because `refresh_nodes` wasn't in the min-version table it fell back to the 0.11.4 baseline — which a 0.11.20 panel exceeds — so the false-negative guard mistook it for "new enough" and leaked the raw dispatch error. `refresh_nodes` is now tabled at its true minimum (0.11.28), which both quotes the correct remedy version (naming the connected panel version) AND lets the proactive #392 gate reject the first call before dispatch. Class-wide: the "new enough" guard now trusts ONLY authoritative, command-specific minimums, so any UNTABLED command's `Unknown command` reply maps to an actionable "update the panel pack" message rather than a bare passthrough.

### MCP

#### Fixed
- route set_todo/open_civitai to desktop canvas when session bound to a headless client (#624) (#625)
- document panel_open_workflow stale-tab signal (#442 defect 2) (#618)


## [0.48.29] - 2026-08-01

### MCP

#### Fixed
- layer the compact facade onto full mode so a stable call_tool survives panel reconnect (#616) (#620)
- keep queryApiGraph token-bound so one blob can't starve the node you asked for (#609) (#617)
- actionable no-panel guidance after a reconnect drop (panel #436, #442) (#615)
- survive idle-user timeout on the adult-consent card (panel#390) (#610)

## [0.48.28] - 2026-08-01

### Fixed
- **`panel_reload` no longer crashes with `Cannot read properties of undefined (reading 'conns')` whenever a tab is connected (panel #478).** A regression from the 0.48.25 tab-binding work (#400/#402/#474): `panel_reload`'s multi-tab guard called `ctx.bridge.isHeadless` as an unbound reference, so `this.conns` threw and killed every reload with a live tab. Now called through the bridge receiver via a `typeof`-guarded helper (an identical second site in `panel_set_workflow_target`'s rebind path fixed too).
- **`panel_set_widget` no longer false-times-out when a fresh `/object_info` takes >6s on a large install (#599).** The refresh-awaiting commands (set_widget / add_node) now get a bounded 30s ack budget instead of the bridge's 6s default, so a slow-but-valid frontend re-register isn't reported as a dead-tab timeout (a genuinely dead tab still fails).

### Added
- **`panel_refresh_nodes` — force a frontend node-def re-register so a just-staged input is immediately usable (#608).** `stage_output_as_input` registered the file server-side but the loader combos were built at page-load, so `LoadImage` couldn't see it (the Krea2→LTX/WAN chaining flow dead-ended); the new tool (which `stage_output_as_input` now points at) forces the refresh.

### Internal
- De-flaked the `ui-bridge #486` late-ask_user test (an ECONNREFUSED bind/connect race in the shared test harness — it await's `bridge.whenReady()` now), which had intermittently failed CI merges and a release publish.

## [0.48.27] - 2026-08-01

### Fixed
- **`panel_update_node` stops surfacing a raw HTTP 405 against a `/v2`-served legacy Manager (panel #464).** A single-pack update POSTed to the unified `/v2/manager/queue/task`, which a bundled-3.x-under-`/v2` build leaves unregistered (405 from the frontend catchall); it now negotiates a 405 → the `/v2/manager/queue/batch` envelope and pins the corrected dialect only after the batch enqueue succeeds (so a proxy/WAF 405 on a genuine v4 host can't poison the cache). v4 unaffected.
- **`panel_query_graph`/`graph_query` isn't falsely gated "too old" once the connection has already served it (panel #422).** The #392 proactive version-gate rejected the command on a re-hello advertising an undercutting version; a `provenSupportedCmds` set (recorded on success, inherited across reconnect + a same-socket `tmp:→wf:` migration, cleared on a genuine `Unknown command`) now vetoes the gate.
- **A mutating `panel_*` edit refused before dispatch now names the rebind recovery instead of a bare error (panel #442, defect 4).** A pre-dispatch routing refusal is tagged with the typed `dispatched:false` flag, so the tool layer states nothing was applied — without retrying (no double-apply) — and points at `panel_set_workflow_target({mode:"current"})`; a post-dispatch executor error quoting the same phrase is never mis-classified.

## [0.48.26] - 2026-08-01

### Fixed
- **`panel_strip_workflow` live-capture fallback fires against a version-skewed panel, and `panel_list_workflows` paths load (panel #413, #414).** The #384 `graph_get_state` fallback was skipped because the bridge rewrites `unknown command` → `too old for "graph_serialize"`; it's now detected structurally via a typed `panelCmdUnsupported` tag (which also covers the new #392 proactive version-gate). And a `panel_list_workflows` key already prefixed `workflows/` was double-prefixed → 404; it now strips one leading prefix, with path-traversal / drive-letter / symlink-escape hardening.
- **Codex (and other non-Claude backends) get the live `panel_*` graph tools again (panel #291).** ComfyUI's ~250 tools saturated Codex's tool budget and it silently dropped the `panel_*` tools; the non-Claude HTTP lane now spawns the comfyui MCP in **compact** mode (freeing budget), so `panel_*` are advertised and callable. Claude is unaffected; `COMFYUI_MCP_TOOL_MODE=full` opts out (comfyui tools then become `call_tool`-gated for those backends).

## [0.48.25] - 2026-08-01

### Added
- **`panel_resize_node` sets a node's width/height on the live canvas (#530)** — so an unreadable Note/MarkdownNote can be resized (prefers `setSize()` so min-clamping nodes reflow, undo-enveloped). Also documents driving the LTXDirector timeline via `set_widget` (#314).

### Fixed
- **Remote CivitAI/Manager downloads warn when the URL is authentication-gated, and the auth-gate probe never leaks a credential (#473).** A model install dispatched to a remote ComfyUI-Manager (which fetches the URL server-side, unauthenticated) can land a login/HTML page as a `.safetensors`; the tool now runs a non-blocking credential-flip probe and surfaces a loud warning when the URL is provably auth-gated. The probe is credential-safe: HF/CivitAI tokens are gated on the **parsed hostname** (never a substring, so `evil.example?ref=huggingface.co` gets nothing) on both the remote-probe and local streaming paths, and all auth headers are stripped on the first cross-origin redirect hop. *(Hardened across a 3-round independent adversarial review that caught and closed three distinct credential-leak vectors.)*
- **Panel tab binding recovers after a restart/reload (#400, #402, #474).** `panel_restart_comfyui` awaits the tab reconnect before returning (`ready` now means graph-tools-ready, not a tabless window); open/save await a stable binding pre-send and refuse rather than fire into a dead binding; the session reconnects on every soft-reload path (no more connected-chip/dead-bridge wedge).
- **Nested-subgraph run + safe bypass (#411, #409).** `panel_run` can target an output node inside a nested subgraph (outermost-first `partial_execution_targets` path), and `panel_set_node_mode` refuses an unsafe positional bypass of a multi-input subgraph unless `force:true`.

## [0.48.24] - 2026-08-01

### MCP

#### Fixed
- **Proactively gate a panel bridge command when the panel's advertised version proves it too old (panel #392).** `panel_query_graph`/`graph_query` (etc.) are refused before dispatch with an honest, correctly-versioned message instead of being exposed and then failing at runtime — gated only on explicitly-listed commands and only when the connected panel actually advertised a too-old version (an omitted-version reconnect never blocks an upgraded panel).
- **Context-meter denominator tracks the current model's window (#543)** — switching to a smaller-context model no longer leaves the denominator pinned to a stale larger window.
- **`panel_run`'s queue-backlog warning no longer false-positives on self-queued jobs (#559)** — deliberately batching your own renders no longer warns about (and recommends destructively clearing) a backlog it created; the warning + destructive `clear_pending` recommendation are suppressed for your own in-flight batch.
- **`panel_screenshot` annotates DOM-overlay nodes (#567)** — a MarkdownNote that renders empty on the LiteGraph canvas is now named in a result note (the faithful DOM composite is a separate panel-side change).


## [0.48.23] - 2026-08-01

### MCP

#### Fixed
- **Session survives a tab-id migration and an interrupt storm (#568), and an unsaved workflow keeps its conversation across an orchestrator restart (#570).** `PanelAgent.tabId` is now updated on migration (no more `panel_*` → "no connected tab"), the interrupt-release fallback is coalesced/armed-before-await so a hammered "send now" can't wedge the agent, and session resume gains a stable `origin+title+backend` index (collision-poisoned) so a reloaded `tmp:<uuid>` tab rebinds its session.
- **A pinned workflow target actually binds reads + edits, and fails at pin time if unbindable (#556, #571).** `panel_set_workflow_target(mode:"pinned")` no longer accepts a background pin it can't honor and then silently routes graph calls to the active canvas — it validates active-ness up front (tri-state) and fails loudly when a target can't be bound.
- **Authoritative ComfyUI-Manager v3/v4 detection + GET/POST method negotiation + a v3→v4 recovery path (#551, #553, #555).** A 405 is no longer misread as "legacy v3" (it means wrong method/route for this version); `queue/start` negotiates POST→GET for GET-only v3 builds; arbitrary-URL installs blocked on v3 now surface a precise migration recovery.
- **`panel_restart_comfyui` relaunches with an absolute launch command/path (#535)** — a relative `COMFYUI_PATH`/command captured from the live process cwd, so a reachable install is no longer refused after the working directory changes.
- **`panel_graph_outline` version-gate false-negative fixed + description disambiguated (#352, #557).** A new-enough panel is no longer told it's "too old" (the gate is now per-command with the correct minimum, and no longer poisons the unsupported-command cache); the tool description no longer collides with `visualize_workflow` / `panel_query_graph`.
- **`download_model` completion now emits an agent_event (#547), and `get_history` carries the media type with `get_image` returning a well-formed error (#554).**
- **`panel_save_workflow` description states Save-As COPY semantics and drops "rename" (#579)** — reporting the outcome (`saved_as`/`copied_from`/`original_on_disk`/`first_save`) rather than a bare `{saved:true}`.

#### Changed
- Dropped the bundled Civitai MCP from the default agent config (native CivitAI tools cover it) (#539); `model_metadata_fetch_civitai` degrades gracefully when its optional dependency is absent (#541); corrected the flux-txt2img skill's Flux 2 Klein CLIPLoader (#545); fixed skill doc references and added SCAIL-2 character-replacement guidance (#552, #546).


## [0.48.22] - 2026-07-31

### MCP

#### Added
- per-download cancellation + reconnect-adoptable download_status (#515, #529) (#577)
- disk fallback for panel version when hello omits it (#575)
- async AI-triage client — versions, upgrade advice, no double-file (#544)

#### Fixed
- honest bounded restart-confirm + correct ready-banner model (#360, #376) (#576)
- tolerant default reply timeout for read ops (panel #357) (#574)
- certify reboot readiness via a concurrent, post-write-gated boot-endpoint observer (#509) (#536)
- strip [object Object] user-turn artifact + consume panel status base_path (#534, #296) (#573)
- graph-capture fallback + correct dynamic-widget/Get-Set link mapping (#384, #361) (#522)
- proactively gate a bridge command once proven unsupported (#236) (#564)
- allow panel_set_widget to clear a widget to "" (#347) (#561)
- list_local_models omits .gguf models via REST path (#526) (#549)
- stale-bug cluster — secret-notice correlation, stall false-positive, load_workflow custom user-dir (#550)
- TTL-bounded cache so out-of-band ComfyUI restart/install self-heals (#528) (#542)
- report actual backend in ENVIRONMENT (#358); accurate list_workflow_templates description (#359) (#533)
- ACE Step 1.5 fields (#501); lock native VAE/UNET loaders (#482); bundled-pack runtime (#464) (#519)
- never silently substitute comboOpts[0] for a user-staged value + refresh stale loader dropdowns (#504, #499) (#517)
- fail-fast when no interactive surface (#300); don't drop a late-but-valid answer (#486); saner set_todo deadline (#322) (#525)
- live-first download target + poll Manager queue instead of 300s false timeout (#490, #463, #489) (#524)


## [0.48.21] - 2026-07-30

### Fixed
- **SEVERE: `download_model` no longer saves an auth/error response body as a model file and reports success (#473).** A remote CivitAI (or any) download that returned an HTML login/auth page or a JSON error — often with a 200 status — was streamed verbatim into a `.safetensors`/`.ckpt`/model file and reported as a successful download, leaving a corrupt file in the models dir. Every finalize path (HTTP stream, cache-hit, coalesced, cloud, direct-fallback) now runs an authoritative content-type/magic-byte gate BEFORE materializing: HTML/JSON payloads are rejected with an actionable error (Content-Type authority for model destinations + body-magic that handles leading whitespace/control bytes), the cloud/direct path fails **closed** when the payload can't be sniffed, and a poisoned cache entry/partial can't be served on reuse (persisted Content-Type + rejected-marker + body re-sniff). Verified to NOT reject legitimate downloads (real safetensors/GGUF/pickle/ONNX/raw-bin stay binary; sidecar-less cached models still served). (#511)
- **`panel_run` derives its verdict from ComfyUI's reply instead of a bare `queued` flag (#213, #194, #331, #248).** A rejected prompt (top-level error, or non-empty `node_errors`, even alongside a stale `queued:true`) is now surfaced as a FAILURE rather than a false `queued:true`; a root SaveImage run-to-node is accepted (not mis-rejected as a subgraph node); the "you'll be notified" note is only appended on a genuine queue (not when no tab is connected); and a thrown `app.queuePrompt` preserves its error detail. (#521)
- **`get_workflow` returns the workflow JSON even when there are conversion warnings (#494); `get_image` is binary-safe (#483); `enqueue_workflow` surfaces ComfyUI's 400 validation details (#485).** (#520)

## [0.48.20] - 2026-07-30

### Fixed
- **`comfy_cli_*` tools resolve the workspace/venv CLI and fall back to the connected server (#506, #403, #360, #487).** Custom-node source tools now resolve the CLI from the saved default workspace when `COMFYUI_PATH` is unset (#506, #403); `comfy_cli_models` falls back to the connected server's API when the CLI is present-but-unsupported (not only absent — #487); and `comfy_cli_jobs` wait accepts the documented singular `promptId` (#360). (#510)
- **Graph tools resolve a single authoritative workflow-tab target + rebind after reconnect (#478, #481, #459).** Pinned/active/nested-exec graph calls now resolve to the SAME correct tab (canonical `workflow_path` injection, fail-closed, strict rebind) instead of reading/editing a different workflow, and the session rebinds (with node-info cache invalidation) after a reboot/reload. (#512)
- **Manager client detects and routes to ComfyUI-Manager 3.x-legacy vs v4/Desktop dialects (#423, #424, #425, #371).** Reboot now probes v2-POST → legacy-GET → legacy-POST with an SPA-catchall guard (a `200 text/html` from an unknown GET is no longer mistaken for a fired reboot); `panel_restart_comfyui` falls back to the headless managed restart for a LOCAL server with no working reboot endpoint (never for remote, never during a render); and legacy Manager self-update falls back to `git pull`. (#513)

## [0.48.19] - 2026-07-30

### Fixed
- **`validate_workflow` no longer contradicts itself or hides authoritative combo errors (#342, #505).** The renderer partitioned issues on `!i.kind`, which stripped the authoritative validator errors (`missing_node_type`, `missing_model`, `value_not_in_list` — all carry a `kind`) from the Errors section, so the tool printed "No issues found — ready to execute" while the header still counted them. Now only graph-health findings are tagged `health:true` and the render partitions on `!i.health`, so combo/model errors stay surfaced and the "ready to execute" verdict is derived from the actual validity — the header and body can never disagree. (#507)

## [0.48.18] - 2026-07-30

### Fixed
- **`panel_open_workflow` no longer false-fails a switch that actually succeeded (#215, #319, #496).** When the target tab is backgrounded/frozen or the workflow is already open, it may not ACK `workflow_open` within the window even though the switch genuinely happened. On an ack-timeout the tool now polls the authoritative active-workflow signal (a fresh `workflow_list` round-trip, bounded ~6s) and returns success (with a recovered note) if the target became active; a genuinely-failed open (e.g. no matching workflow) is an acked error, not a timeout, so it still fails clearly. Mirrors the #497 restart-readiness pattern. (#502)

## [0.48.17] - 2026-07-30

### Fixed
- **`download_model` resume no longer silently discards a near-complete `.partial`, and HF Xet/CAS downloads resume safely (#467, #470).** When the Xet/CAS CDN omits `ETag`/`Last-Modified`, no resume validator was ever written, so a restart silently truncated and re-downloaded a multi-GB partial with no signal. Resume is now surfaced honestly via `download_status` (four outcomes: `declined:no-validator` / `declined:full-response` / `declined:etag-changed` / `declined:unverifiable`), and HF Xet partials resume by capturing the content-addressed `X-Linked-Etag` off the resolve 302 and preserving `Range`/`If-Range` across the cross-origin redirect (dropping `Authorization`). The #343 append invariant is hardened throughout: append happens only on a validated 206 with an exact, end-reaching `Content-Range`; a cross-origin 206 additionally requires a matching content-addressed validator; completion fails **closed** (rejects any size ≠ the authoritative total, derives a 206's total from `Content-Range` and a fresh 200's from `max(Content-Length, X-Linked-Size)`, and refuses an unsolicited 206 on a fresh request); materialize + direct-fallback build into a random `O_EXCL` temp and rename atomically (never writing through a destination hardlink into a cache inode); and the cache identity folds in per-request auth and the effective cloud principal so bytes are never served across an auth boundary. (#469)

## [0.48.16] - 2026-07-30

### Fixed
- **`panel_restart_comfyui` no longer reports a false timeout/failure after a reboot that actually succeeded (#493, #222, #263, #266, #306, #307).** The panel path sends `comfy_reboot` over the UI bridge; because the Manager reboot handler returns the moment it accepts the request, ComfyUI (and the tab it serves) drops before it can ack — and the bridge surfaced that expected drop as a mutating-command `OUTCOME UNKNOWN` failure, which the tool returned verbatim. It now classifies the `comfy_reboot` result (confirmed / expected-drop / refusal): on confirmed-or-drop it resets caches and polls readiness (`nodes_queue_status`, auto-healing onto the reconnected tab) up to a generous wall-clock budget, returning success with recovery timing; a genuine refusal is still returned verbatim, and a server that never comes back within the budget still reports a clear failure. The headless `restart_comfyui` path (#400/#476) is untouched. (#497)

## [0.48.15] - 2026-07-30

### Fixed
- **`restart_comfyui` relaunches a Desktop-managed ComfyUI via the Manager reboot endpoint instead of killing the Electron shell (#400).** A local Comfy **Desktop** instance was treated like a self-spawned one — killed and re-spawned via `Comfy Desktop.exe`, which never reliably brought the `:8188` Python backend back (`stopped:true, started:false`). `restartComfyUI` now branches on `isDesktopApp` before any kill: a Desktop-managed instance routes through `POST /v2/manager/reboot` and is never killed; if the reboot can't be fired (403/no endpoint) it refuses and leaves the server running. Self-spawned Python installs keep the kill+relaunch path. (#477)
- **`restart_comfyui` uses live-first script resolution instead of refusing on a stale relative `COMFYUI_PATH` (#476, #426).** After `download_model` wrote successfully into the canonical absolute live install, restart could resolve the server script as a stale relative path (`ComfyUI/main.py`) and refuse — inconsistent with the path download just used. A new `resolveScriptAnchor` resolves live-first (`liveRootFromArgv` → saved-default workspace → configured path, first absolute wins) before anchoring a relative launcher script; the refuse-safe behavior is preserved for a genuinely unresolvable/missing install, and the #400 Desktop branch is untouched. (#479)

## [0.48.14] - 2026-07-30

### Fixed
- **`missing_node_types` is recomputed after a custom-node install (#444).** The orchestrator memoizes `/object_info`; `validate_workflow`/`diagnose_run` derive the top-level `missing_node_types` from that snapshot. The cache was invalidated on reboot (the #235/#247/#352/#364 cluster) but not on a node install, so a just-installed type stayed listed as missing until a later reboot. A single `withObjectInfoInvalidation()` choke point now wraps `install`/`update`/`reinstall`/`fix` custom-node ops and resets the object-info cache on success (covering cm-cli, Manager HTTP, and git-clone fallback paths). (#471)
- **`panel_run` tolerates a mid-command panel reconnect instead of hard-failing (#450).** The UI-bridge socket `close` handler rejected every in-flight command with a generic `panel tab disconnected mid-command` — a false failure for an already-queued `graph_run`, and one that invited a blind retry / double render. It now classifies the disconnect: idempotent reads are parked with a bounded, deadline-clamped grace and re-dispatched only if the tab re-hellos (transient reconnect resumes cleanly); every mutating command rejects with an actionable `OUTCOME UNKNOWN` message and is never auto-retried (at-most-once). (#472)

## [0.48.13] - 2026-07-30

### MCP

#### Fixed
- Gemini backend readiness recognizes API-key auth (GEMINI_API_KEY/GOOGLE_API_KEY, or ~/.gemini/settings.json security.auth.selectedType=gemini-api-key), not just OAuth — so an API-key-authed Gemini no longer shows as "Not signed in" (#456)
- comfy_cli_models list actions (list-folders/list-folder/search/show) fall back to the connected local server's /models when comfy-cli is absent (mirrors #354), with faithful comfy-cli semantics — type-alias→folder mapping, exact-match show, list-folder limit; mutations still require comfy-cli; pinned workspace / cloud never substituted (#460)


## [0.48.12] - 2026-07-30

### MCP

#### Fixed
- comfy_cli_models download uses a 120s IDLE/liveness timeout (progress resets the clock) instead of a fixed 60s wall-clock, so a long-but-live download isn't killed while a truly stalled one still times out (as a distinct idle_timeout error) (#417)
- convertUiToApi keeps a declared asset value (unet/ckpt/vae/lora/model_path) and warns instead of silently swapping it for the first installed model when it's not present on the server — so e.g. Krea 2's krea2_turbo_fp8 no longer becomes flux-2-klein-9b; plain enum combos still fall back (#407)
- download resume hardened (#343 edges): ETag/If-Range-gated resume, strict full Content-Range validation, failure-atomic sidecar handling, plus S3/Azure Content-Length truncation checks and 0-byte cache-hit recovery (#343)
- built-in ace_step_15 audio template updated to the current comfy_extras nodes_ace schema (unet_name, full TextEncodeAceStepAudio required inputs, SaveAudioMP3 quality) (#448)
- restart_comfyui/port detection: detect ComfyUI liveness via the reachable server (answered /system_stats) and parse netstat locale-independently, instead of falsely reporting "no process on port" (#449)


## [0.48.11] - 2026-07-30

### MCP

#### Fixed
- the codex run-finished callback serializes a structured final-commit payload to readable text instead of `[object Object]`, and no longer overwrites the already-streamed reply when the final commit is empty/malformed (falls back to the streamed text) (#421 #422) (#443)
- Krea 2 packs no longer declare ComfyUI-Manager as a custom-node dependency, so apply_manifest stops cloning a duplicate ComfyUI-Manager on Desktop installs where it's already present (#441) (#445)


## [0.48.10] - 2026-07-30

### MCP

#### Fixed
- download resume survives an orchestrator/panel reconnect: a nominally-local session that loses its resolvable ComfyUI base after reconnect now routes the download through the still-connected ComfyUI-Manager instead of failing with "COMFYUI_PATH is not configured"; the in-flight job registry is dual-keyed (route-independent request key + destination) so a Manager<->local route flip can't spawn a duplicate same-file writer (#420) (#440)
- train_caption_dataset fails fast on a persistent Claude auth failure (not-logged-in / invalid key / expired token) with an actionable message, instead of looping every image re-hitting the same error; transient per-file errors still continue (#438) (#439)


## [0.48.9] - 2026-07-30

### MCP

#### Fixed
- get_environment probes the ComfyUI venv/embedded python (resolved live-first from the running server's argv → COMFYUI_PATH → saved default workspace) instead of a bare PATH python, fixing false capability reports like "Triton: not installed"; remote/unreachable/ambiguous cases report an honest untrusted result rather than a confident wrong one (#401) (#433)


## [0.48.8] - 2026-07-30

### MCP

#### Fixed
- download_model follows the HF Xet CAS redirect and surfaces the real network cause (DNS/proxy/TLS/HF_ENDPOINT) instead of a generic "fetch failed" (#411) (#427)
- civitai search surfaces distinct upstream/auth(token-aware 401)/403/429/5xx/timeout/non-JSON failures instead of a misleading empty or generic error (WS-6) (#428)
- crash detector no longer false-positives on a swallowed "Exception ignored in: __del__" finalizer traceback (#341) (#429)
- get_job_status reports a present-but-empty ShowText/PreviewAny output instead of dropping it (#373) (#430)
- model_metadata_read gives an actionable message when the optional model-explorer node is absent, instead of leaking a raw 404 (#363) (#431)
- get_node_info honors the live /object_info registration key when backfilling, so a registered node (e.g. DetectorForNSFW) resolves (#404) (#432)
- get_template_schema routes through the connected client's base URL + auth and resolves template ids consistently with list_workflow_templates (proxy/auth-safe) (#391) (#434)
- get_image returns a structured not-found for non-image /view payloads (type=input refs) instead of a corrupt inline image / JSON parse error (#385) (#435)


## [0.48.7] - 2026-07-29

### MCP

#### Added
- report_issue: fix-then-file default plus an async Worker submit/poll client — filing returns a pollable job_id that resolves to the GitHub issue link, and the report-bug skill attempts a local fix before filing (#410)

#### Fixed
- download_model and verify_custom_node adopt the saved default workspace (or the Manager route) when COMFYUI_PATH is unset, instead of hard-failing or misclassifying a local instance as remote (#415 #416 #386 #409) (#418)
- route custom-node ops by Manager generation with a live /object_info fallback; comfy_cli_search_nodes falls back to the live server when comfy-cli is absent; apply_manifest adopts a saved default workspace, falls back to `python -m pip` for non-venv interpreters, and hands slow downloads to the background job registry (WS-4) (#354 #362 #377 #390 #408 #412)
- chat serializes structured error/user payloads as readable text instead of `[object Object]` (WS-9) (#405)
- invalidate stale objectInfo caches and node snapshots after a restart+edit so tools see the live graph (WS-3) (#402)
- normalize preferred_models before the set_config change-guard to stop a heartbeat config-repush loop; civitai search now ensures the endpoint is reachable (#398)
- reject truncated and 0-byte model downloads instead of leaving a corrupt file on disk (#343 #396)

## [0.48.6] - 2026-07-29

### MCP

#### Fixed
- change-guard set_config to stop a heartbeat feedback loop (#393)
- surface filter/upstream failures instead of empty results (WS-6) (#381)
- resolve live ComfyUI base dir for relaunch/model-dirs/extra-paths (WS-2) (#383)
- auto-heal orphaned workflow-tab binding to prevent cross-tab writes (WS-1) (#382)
- graceful message for graph_* commands unknown to old panels (WS-0) (#380)


## [0.48.5] - 2026-07-28

### MCP

#### Added
- bias hard toward via-panel bug reports during beta (#339)


## [0.48.4] - 2026-07-28

### MCP

#### Fixed
- resolve Windows argv paths host-agnostically (#330)
- anchor a relative main.py argv[0] to the ComfyUI root (#330)
- rebind panel session tabId on explicit signal — self-heal after reconnect/reload/workflow-switch (#322, #331, #332)
- relaunch ComfyUI via resolved Python, not sys.argv[0] script (#330)
- stop truncating the model list at 150 (#326)


## [0.48.3] - 2026-07-28

### MCP

#### Fixed
- reject path-traversal filenames in image/media upload (#329)
- default all bundled-workflow seeds to randomize (#325)


## [0.48.2] - 2026-07-27

### MCP

#### Fixed
- default the z.ai GLM provider to glm-5.2 (#323)


## [0.48.1] - 2026-07-26

### MCP

#### Fixed
- remove wait_for_job — copy-paste holdover from the official Comfy MCP/CLI (#320)


## [0.48.0] - 2026-07-24

### MCP

#### Changed
- **The panel agent now defaults to Claude Opus 5.** `COMFYUI_MCP_PANEL_MODEL`
  still pinned `claude-opus-4-8`, so new panel sessions started on the previous
  Opus unless you overrode it. Set `COMFYUI_MCP_PANEL_MODEL` to pin a different
  model. No panel-side change was required: the model picker is populated from
  `query.supportedModels()` rather than a hardcoded catalog, its fallback row
  uses the `opus` family alias, the advertised Claude effort scale already
  covers Opus 5's full `low|medium|high|xhigh|max` ladder, and the context
  window is read from the SDK rather than assumed.

#### Fixed
- **Double-encoded em dash in published metadata.** The em dash in
  `package.json`'s `description` and in `docs/docs.json` had been decoded as
  CP1252 and re-encoded as UTF-8, leaving a literal `â€"`. The description ships
  to npm and is scraped by third-party directories, so the artifact propagated
  to every downstream listing.

## [0.47.0] - 2026-07-23

### MCP

#### Added
- **Cloudflare Access service tokens on every ComfyUI endpoint.** A ComfyUI
  fronted by Cloudflare Access served a sign-in page to the CLI instead of the
  API, which broke connect/advertise and the queue watcher (the
  `--insecure-bridge` workaround existed only to dodge this). Set
  `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` and the headers are attached
  to every request. (#289)
- **RunPod pod-side dead-man switch.** Pods created via `runpod_pod_create` now
  carry a watchdog (`deadman_server.py` heartbeat + `deadman_watch.sh` self-stop
  loop): while comfyui-mcp is minding the pod it heartbeats each poll, and if the
  controller disappears the pod stops itself rather than billing forever. Adds
  structural GraphQL validation. Closes the last deferred findings from #269. (#301)
- **Training data is now readable by app clients.** `train_list_datasets`,
  dataset detail, effective job-config, and `train_file` readers over the
  whitelisted channel, plus `list_output_images` gaining a `format: 'json'`
  mode — the backend half of "see my labeled datasets / job settings / run it
  again", unblocking the mobile Training tab. (#302, #306)

#### Fixed
- **Downloads no longer pin the turn, and a download that ran is never disclaimed.**
  `download_model` and `download_civitai_model` awaited the entire transfer, so a
  multi-GB checkpoint left the turn pending for minutes — and cancelling to break
  the apparent hang made the agent report a download as not-done while the file
  was still streaming to disk. Both tools now return a handle after a grace window
  (small files still return a path inline), with a new `download_status` tool.
  Reported by seanmcmagic. (#290)
- **Interrupted and retrying Codex turns are recoverable.** Bounds the three
  unbounded waits that let a live-but-silent Codex app-server hang a turn forever;
  emits one controlled interrupted result, detaches the stale client, and lets
  PanelAgent resume on a fresh app-server. Honors `ErrorNotification.willRetry`.
  Thanks to @JusticeWay for the diagnosis. (#294)
- **A zombie browser tab can no longer drag the orchestrator to a dead ComfyUI.**
  A stale tab pointed at a dead instance kept re-helloing and retargeting the
  orchestrator to the corpse, silently degrading every target-probing tool.
  Unreachable hello retargets are now ignored. (#303)
- **`train_doctor` no longer flaps red on a cold Docker.** The parallel GPU
  docker-run and image-inspect raced on a cold Docker Desktop and intermittently
  reported the trainer image absent when it was present; the probes are serialized
  and the image check retries once. (#304)
- **`train_start` rejects doomed parameter values.** The Custom preset is
  free-form, so `steps=10^9` / `rank=100000` used to pass the schema and start an
  OOM-bound billed run. Bounded: `steps<=100000`, `lr<=1`, `rank<=1024`,
  resolution 64..4096. (#300)
- **IP-Adapter generation works again.** The `ip_adapter` template omitted
  `weight_type`, which current `ComfyUI_IPAdapter_plus` requires, so every
  `generate_with_ip_adapter` failed validation. Now always sent (default
  `standard`). Reported on 0.46.0. (#305)

#### Internal
- CI pins GitHub Actions to commit SHAs. (#295)


## [0.46.0] - 2026-07-22

### MCP

#### Added
- **`apps_*` tools — run a micro-app from a canvas-less client.** Sibling to the
  panel Apps work: thin proxies over the panel pack's
  `/comfyui_mcp_panel/apps/*` routes, so the panel remains the single storage and
  run implementation for both desktop and mobile. `apps_list` / `apps_get` read the
  registered micro-apps (manifest with appMode inputs/outputs, deps, hideWorkflow);
  `apps_run` patches `<nodeId>.<widget>` values into the app's prompt snapshot and
  queues it, returning a `prompt_id`; `apps_run_status` polls status and outputs;
  `apps_import` fetches a bundle from the public registry and installs it. (#285)
- **Grok 4.5** in the Agent Panel model catalog. (#283)
- **`restart_comfyui` now works against a remote or tunnelled ComfyUI.** It used to
  hard-throw in remote mode (`--comfyui-url`), so an agent pointed at a tunnelled
  ComfyUI Desktop could not restart it — even though Desktop self-supervises and a
  ComfyUI-Manager HTTP reboot brings it straight back. Remote mode now fires a
  Manager reboot (`POST /v2/manager/reboot`, falling back to `GET /manager/reboot`)
  and polls for readiness instead of refusing. (#296)

#### Fixed
- **RunPod retarget, connection and idle-stop correctness.** Switching the ComfyUI
  target now performs the full fan-out on *every* path — queue-monitor restart,
  agent MCP-env respawn, capability probe, host-indicator frame — after syncing the
  closed-over URL so the hello, tool and watcher origins cannot drift apart. Adds
  `connect: true` semantics, a LAN fallback, and download-aware idle so a pod is not
  auto-stopped while a model download is still streaming. Closes the remaining
  cluster from #269. (#286)


## [0.45.0] - 2026-07-22

### MCP

#### Added
- **Train a LoRA on a rented GPU (RunPod P4).** The CLI LoRA trainer now has a
  dockerless native driver + an SSH transport that bootstraps ai-toolkit on a
  RunPod pod (clone@pin → venv → torch cu128 → requirements), rsyncs the dataset
  up, streams training progress back, and stops/prunes via ssh — so `train_*`
  runs on a pod GPU with the same job-registry plumbing as local/GPU-Docker
  training. Companion to the P1 local trainer. (#263)
- **Dockerless local training** — `train_start` now falls back to the native
  trainer when Docker/the image is missing, gated on a complete bootstrap, with
  full lifecycle parity (config-scoped cancel + dead-owner recovery). (#275)
- **`resolve_missing_models`** — one call finds every model a workflow needs but
  the server doesn't have, and proposes VRAM-aware download candidates. Detection
  is mapping-free (a model-looking value absent from its own ComfyUI combo is
  missing), so it covers checkpoints, LoRAs, VAEs, ControlNets, UNets, CLIP and
  custom-pack types alike; candidates carry size, source, precision/quant and a
  fits/too-big verdict against real `/system_stats` VRAM. (#267)
- **Provider model discoverability** — the api-key credential card now says which
  model a provider is actually on (env override if set, else the pinned default)
  and names the env var to change it, generated from the registry so it can't
  drift. Answers "why am I not on the model I set?" for GLM/Kimi/Moonshot. (#264)

#### Fixed
- Antigravity (agy) backend hardening — no secrets at rest, ownership-aware config
  lifecycle, turn-settlement guarantees, `--effort` support; idle-interrupt
  poisoning, 32K argv preflight, console backend list; verified live against agy
  1.1.5 with catalog-aware model guard. (#262, #271)
- prefer `HF_TOKEN` over `HUGGINGFACE_TOKEN` for the Hugging Face token
- close deferred RunPod/training/review findings (#268, #269, #273, #274, #276, #277)

### RunPod image

#### Fixed
- close a live secret-leak + billing bug path on RunPod pod control (#270)

### MCP

#### Added
- lean toward the docked CivitAI browser over text-only answers (#284)
- panel_* tools to drive the CivitAI browser + training wizard (#281)

#### Fixed
- close deferred RunPod/training/codex review findings (#268/#269/#273/#274/#276/#277) (#278)
- #271 hardening — no secrets at rest, ownership-aware config lifecycle, turn-settlement guarantees, --effort (#271)
- review fixes — idle-interrupt poisoning, 32K argv preflight, console backend list (#262)
- verified live against agy 1.1.5 — real MCP path + catalog-aware model guard (#262)
- prefer HF_TOKEN over HUGGINGFACE_TOKEN for the HF token


## [0.44.0] - 2026-07-21

### RunPod image

#### Added
- broaden default GPU fallback list (A6000, RTX PRO 4500 Blackwell)
- one-tap deploy (runpod_pod_create) + honest local⇄pod host switch
- allow RUNPOD_API_KEY as a comfyui tool secret (panel-savable)
- add RunPod to the panel API-Keys card (RUNPOD_API_KEY slot)
- live status broadcast + idle auto-stop (gpu-cli-style control-panel backbone)
- RunPod connector — manage a live pod by ID (status/start/stop/troubleshoot/connect) + referral deploy link

#### Fixed
- target port 3000 (RunPod ComfyUI convention), not 8188
- idle auto-stop only applies to a pod we're rendering on
- createPod falls back COMMUNITY→SECURE across GPU types

### MCP

#### Added
- Antigravity CLI (agy) backend for Google subscription users (#262)
- **`ltx-director` skill** — the LTX Director (Timeline) node's *Add Image /
  Text / Audio* buttons are DOM-only and cannot be clicked by an agent, which
  read as "the agent can't control this node". They only serialize into one
  hidden `timeline_data` widget, which IS settable — so the node was always
  drivable and only the knowledge was missing. Documents the verified schema
  (track gates that silently ignore segments when off; `imageB64` actually
  holding an `/api/view` URL, making image segments reachable via
  `upload_image`; fractional pixel-space frames; the `guide_data` →
  `LTXDirectorGuide` edge). Same pattern covers `PromptRelayEncodeTimeline`. (#265)

#### Fixed
- a Stop pressed during turn startup was silently dropped (#266)
- foreign-run attribution + sub-tick run completions in the queue_status broadcast (#261)
- start-failure follow-ups — rebind-safe settle, held mail, real spinner clear (#260)
- a per-tab start failure can never self-exit the orchestrator (#253)
- steer failure-diagnosis to diagnose_run over get_history (#246)

#### Changed
- make ~/.comfyui-mcp/.env the single canonical store for token secrets
- provider registry for simple OpenAI api-key backends (#234)


## [0.43.1] - 2026-07-20

### MCP

#### Fixed
- **Text-preview node results are no longer invisible to the agent.** Nodes like
  *Preview as Text* / `PreviewAny` / `ShowText` write no file — they publish into
  the node's `ui` dict, which ComfyUI stores under `outputs[nodeId].text`. We only
  ever harvested `images` / `videos` from history, so caption, prompt-builder and
  other LLM-text workflows completed with **nothing for the agent to read**: it
  would say it was going to report the text back, then have nothing to report.
  History analysis now also extracts text, and it surfaces as `text_outputs` on
  both `get_job_status` and the job-watcher completion record (omitted entirely
  for image-only runs). Tolerates the shapes seen in the wild — `{text:[…]}`,
  `{text:"…"}`, and packs that use `string` — and the parser is pinned by a
  regression test using a payload captured verbatim from a live ComfyUI run.
  (reported by seanmcmagic, #247)


## [0.43.0] - 2026-07-20

### MCP

#### Added
- **CLI LoRA trainer (P1) — character LoRAs on FLUX.1-dev, driven by the agent.**
  Seven `train_*` tools (`train_list_flows`, `train_prepare_dataset`,
  `train_start`, `train_status`, `train_cancel`, `train_build_image`,
  `train_doctor`) wrap ostris **ai-toolkit**'s `run.py` inside a headless
  GPU Docker image, so training is an agent-orchestrated flow rather than a
  hardcoded UI. Includes an ai-toolkit config generator, a job registry with
  cross-process persistence + recovery (a cancel from another process is never
  clobbered by finalize), live step/loss/sample progress parsing, and an output
  handoff that drops the finished `.safetensors` into `models/loras/` and
  upserts it into the LoRA catalog. Ships the `train-character-lora` skill.
  `train_list_flows` / `train_status` are mobile-whitelisted (read-only).
  End-to-end proven on a 4090 (200-step character LoRA, validated in a live Flux
  workflow); the ai-toolkit ref is pinned to the commit that run was validated
  against. (#237)

## [0.42.0] - 2026-07-20

### MCP

#### Fixed
- the panel's **Blind** toggle now mechanically gates EVERY image-returning
  tool (get_image, view_image, convert previews, …): blind tabs spawn their
  comfyui tool server with COMFYUI_MCP_BLIND=1 and a single registration-
  boundary wrapper replaces image blocks with an honest "withheld" note — on
  both the full MCP surface and the compact call_tool router; toggling Blind
  live respawns the tab's tool server at idle (panel issue #90)
- **Gemini model catalog was dead on arrival** — both catalog entries
  (`gemini-2.5-pro`, the default, and `gemini-2.5-flash`) now return 404 *"no
  longer available to new users"* from Google, so every new Gemini user hit a
  failing turn on the very first prompt. The catalog now leads with Google's
  floating aliases (`gemini-pro-latest`, `gemini-flash-latest`) so it stops
  rotting, plus the pinned models they currently resolve to (`gemini-3.1-pro-preview`,
  `gemini-3.5-flash`). Default is now `gemini-pro-latest`. Verified live against
  the Gemini API on 2026-07-20.
- **Gemini backend auth** — on an ACP `auth_required`, the backend now selects the
  API-key auth method (`USE_GEMINI`) when `GEMINI_API_KEY` is set, instead of
  blindly retrying `authMethods[0]` (the Google/Code-Assist OAuth method). Google
  retired the free "Sign in with Google" login for individuals on 2026-06-18, which
  turned that blind retry into an infinite auth loop and took the whole backend
  down. API keys still work; set a restricted Gemini API key (Google AI Studio) in
  `~/.comfyui-mcp/.env`. Failure messages now point at the key path rather than a
  dead sign-in flow.

### MCP

#### Added
- diagnose_run — canvas-less 'why did my render fail?' (mobile parity with panel_view_errored_nodes) (#243)

#### Fixed
- API-key auth over stale OAuth + refresh the dead model catalog (#242)
- Blind mechanically gates every image-returning tool (fixes comfyui-mcp-panel#90) (#245)


## [0.41.0] - 2026-07-20

### MCP

#### Changed
- **GPT-5.6 family (Sol / Terra / Luna) with the extended effort scale
  (`max`, `ultra`)** — the bundled Codex SDK is now 0.145.0-alpha.24 (the
  stable 0.144.6 crashes renewing a Codex-Desktop 0.145 models cache; the
  alpha is the field-verified pairing — #241), and pre-5.6 models are
  DEPRECATED: the picker hides them whenever the account has the 5.6 family
  (accounts without 5.6 keep their catalog). ChatGPT-direct default is now
  `gpt-5.6-luna` (successor to the retired `gpt-5.4-mini`); Claude-max→xhigh
  effort downmapping removed (`max` is native now)

### MCP

#### Added
- GPT-5.6 family (Sol/Terra/Luna) + max/ultra efforts; deprecate pre-5.6 models (fixes #241) (#244)


## [0.40.0] - 2026-07-19

### MCP

#### Removed
- `panel_view_errored_nodes` — merged into `panel_get_errors` rather than
  shipping two overlapping error tools. Requires panel ≥ 0.9.6 (the panel
  executor moves with it); a 0.39.0 server paired with a newer panel would
  otherwise call a command that no longer exists.

#### Changed
- `panel_get_errors` is now the single error surface and returns every errored
  node JOINED TO ITS CAUSE — `nodes[]` with the node's detail summary,
  `red_outline`, and `reasons[]` (`missing_model` with file/folder/download URL,
  `missing_media`, `validation`, `execution` with `exception_type`) — plus
  graph-level `missing_models`, `missing_media`, `missing_node_types` /
  `missing_node_count`. The raw `node_errors` map and `last_execution_error`
  are still returned unchanged for existing consumers.
- This closes a real gap behind "red node, no error message": missing
  model/media assets paint nodes red AS SOON AS THE WORKFLOW LOADS, but the raw
  validation map only populates on a queue attempt — so the old tool answered
  "no errors recorded since the last execution start" while the user was
  looking at red nodes (reproduced live, then fixed). Likewise a node that
  throws AT RUNTIME is never painted red, so it can only be found here
  (`red_outline: false`).
- docs: the panel's Read-tools table now lists `panel_view_selected` and
  `panel_view_nodes_in_viewport`, and describes the merged `panel_get_errors`.

### MCP

#### Changed
- merge panel_view_errored_nodes into panel_get_errors (#240)


## [0.39.0] - 2026-07-19

### MCP

#### Added
- expose view_selected / viewport / errored-node tools (#238)


## [0.38.1] - 2026-07-18

### MCP

#### Fixed
- custom-node/model operations no longer 405 against pip ComfyUI-Manager
  running in legacy-UI mode (`--enable-manager-legacy-ui` — hardcoded by e.g.
  yanwk/comfyui-boot images): that mode swaps in Manager's bundled 3.x server
  under the /v2 prefix, which has no `queue/task` route — comfyui-mcp now
  detects the mode (`/v2/manager/is_legacy_manager_ui`) and speaks its
  `queue/batch` dialect; Manager detection also validates the probe payload so
  an SPA 200 can't masquerade as a Manager API (#235)

### MCP

#### Fixed
- speak pip Manager's legacy-UI dialect — queue/batch, not queue/task (fixes #235) (#236)


## [0.38.0] - 2026-07-17

### MCP

#### Added
- add Moonshot (Kimi K3) as a first-class provider (#233)


## [0.37.0] - 2026-07-16

### MCP

#### Added
- **`list_local_models` CivitAI provenance line** — entries whose
  `<file>.civitai.json` sidecar (written by `download_civitai_model`) carries
  ids now render a `civitai: <page URL>` line (the sidecar's `sourceUrl`, or
  reconstructed from `modelId`/`versionId` for older sidecars). The URL
  carries the modelId + INSTALLED modelVersionId, so agents and clients (the
  mobile LoRA hub) can link back to the source and check CivitAI for newer
  versions. Purely additive; no whitelist change — `list_local_models` is
  already mobile-callable.
- **live `queue_status` bridge frame** — the orchestrator now broadcasts
  ComfyUI's live render/queue state (running, queue depth, current node,
  sampler progress, prompt_id) to every connected tab, riding the existing
  QueueMonitor watchdog so browser-queued jobs are covered too. Change-only
  and capped at 1 frame/sec: an idle rig broadcasts nothing. Each tab is also
  seeded with the current state on `hello`, so a client connecting mid-render
  sees the running job immediately. Powers the mobile app's live queue monitor
- **`cancel_job` on the mobile call_tool whitelist** — one-tap cancel of the
  running render from the phone's queue monitor. Narrowly scoped: the client
  passes the `prompt_id` it observed, cancel_job only interrupts a still-matching
  running job, and pending jobs are never touched

#### Fixed
- **QueueMonitor stayed disconnected after a ComfyUI retarget** — the watchdog
  WS never reconnected once the orchestrator retargeted ComfyUI (e.g. the
  `127.0.0.1`→`localhost` swap on a local panel `hello`), because `start()`
  early-returned on the stale URL after the retarget's `stop()`. That left
  `queue_status` permanently `connected:false` (so the mobile queue bar never
  appeared) and silently disabled the local-Ollama VRAM pause. `start()` now
  reconnects on a URL change or after `stop()`, and the WS handlers are guarded
  against a superseded socket so the retarget's async close can't null the new
  connection. Latent since the watchdog landed (2026-06-27); surfaced by the
  `queue_status` broadcast above

#### Docs
- mobile app (beta) page — Android (Firebase App Distribution) + iOS
  (TestFlight) beta-tester links, pairing walkthrough, wired into the docs nav

### MCP

#### Added
- live queue_status broadcast + mobile one-tap render cancel (#229)
- surface CivitAI provenance (page URL w/ model+version ids) in list_local_models (#231)

#### Fixed
- reconnect watchdog WS after ComfyUI retarget (#232)


## [0.36.0] - 2026-07-15

### MCP

#### Added
- **cid-correlated `set_options` acks** — clients may stamp `set_options`
  with an opaque `cid`; the options ack echoes it verbatim plus
  `requested_model`, making model-switch acks exactly attributable (acks are
  not FIFO — each handler is an independent async task). Failure now also
  sends an `ok:false` ack for cid-stamped requests. Fully backward
  compatible: cid-less requests get the byte-identical legacy ack. Note:
  `cid`, not `rid` — the bridge consumes any frame carrying `rid` as a
  canvas-command reply. The models frame's `current` now reports the per-tab
  model override instead of the backend default (#228)


## [0.35.0] - 2026-07-15

### MCP

#### Added
- **search_civitai_creators** — CivitAI creator discovery: with no query it
  returns the site's creator leaderboard (rank, score, downloads, likes;
  boards: `overall`, `overall_90`, `overall_nsfw`, `new_creators`), with a
  query it searches usernames via the public `/api/v1/creators`. Each hit
  feeds `search_civitai_models {creator}` directly, so "show me top creators
  → their models → download" works end-to-end (Discord mobile-beta request)
- **search_civitai_models `creator` filter** — list one creator's models by
  exact username, with or without a keyword (the keyword is applied
  client-side because CivitAI returns an empty page when `query` and
  `username` are combined). Both CivitAI search tools are now whitelisted on
  the mobile `call_tool` channel (read-only)
- **panel_flatten_workflow** — one-call, formatting-preserving flatten of the
  live canvas: Get/Set buses, Reroutes, and cg-use-everywhere broadcasts
  resolve to direct real links and the virtual nodes are deleted, while kept
  nodes never move (groups/positions/colors/titles survive exactly; one undo
  restores). UE broadcasts materialize from the pack's own computed
  `extra.ue_links`; real executable nodes (rgthree Context, Seed Everywhere)
  are kept

### MCP

#### Added
- mobile workflows-over-tunnel fix + desktop-tab mirror (remote control) (#227)
- creator search — search_civitai_creators + search_civitai_models creator filter (#226)
- panel_open_civitai tool — agent opens the CivitAI browser pre-seeded (#225)
- panel_flatten_workflow — in-place UE + Get/Set flatten that preserves the author's layout (#224)


## [0.34.0] - 2026-07-14

### MCP

#### Fixed
- a user interrupt (panel Stop or a pending-tray **Send now**) no longer paints
  the "⚠️ That turn failed (error_during_execution)" banner — the Claude SDK
  reports an interrupted turn with an error-subtype result, which the
  never-end-in-silence guard mistook for a real failure; genuine failed turns
  still surface (#221)
- UI→API conversion no longer scrambles widget values on nodes with a custom
  serialized-widget layout (`properties.has_serialized_properties` — LTXDirector,
  LTXSequencer, PromptRelay): authoritative named values in `node.properties`
  now win over the shifted positional mapping (#222)

#### Added
- **orchestrator self-updater + self-restarter** (default ON) — the panel
  orchestrator re-checks npm hourly, updates the installed package
  (global/local via npm; npx respawns pinned to the new version), and restarts
  itself once every agent is idle with nothing queued, held, or rendering —
  the panel announces the restart, sessions resume from the durable store, and
  the panel reconnects on its own. Dev installs (npm link / checkout) are
  never modified on disk; instead the orchestrator restarts itself when a
  rebuilt `dist` lands, so `npm run build` is all a developer needs (no more
  days-old processes serving a fresh checkout). MCP stdio mode never
  self-restarts (the MCP client owns that process). Opt out with
  `COMFYUI_MCP_AUTO_UPDATE_DISABLE=1` (or keep checks but never restart with
  `COMFYUI_MCP_AUTORESTART=0`); tune the period with
  `COMFYUI_MCP_UPDATE_CHECK_MS`
- panel_strip_workflow / panel_slice_workflow read the LIVE CANVAS when called
  with no source (new panel graph_serialize command) — no more save-to-disk
  round trip; strip's description now states its API-format output cannot be
  loaded back onto the canvas
- chatgpt backend delivers attached images via Responses-API `input_image`
  data URLs, with the same one-shot strip-and-retry + honest 📎 note on
  rejection as the Ollama family (#218)

### MCP

#### Added
- self-updater + self-restarter — a running orchestrator never goes stale (#223)
- strip/slice read the live canvas by default — no save-to-disk round trip

#### Fixed
- the Discord invite link was expired — use the permanent one (#220)


## [0.33.0] - 2026-07-14

### MCP

#### Added
- **stable phone-pairing token** — set `COMFYUI_MCP_PAIR_TOKEN` to pin the mobile
  bridge's pairing token so a paired phone reconnects across orchestrator restarts
  instead of dying on a per-session token. When set, the LAN pairing listener also
  auto-starts at boot and prints the ready-to-paste `ws://<lan-ip>:<port>/?token=…`
  URL; leaving it unset keeps the previous on-demand, per-session behavior (and its
  default "nothing exposed until you ask" posture) unchanged (#219)


## [0.32.0] - 2026-07-14

### MCP

#### Added
- inline image delivery for every Ollama-family backend (ollama / OpenRouter /
  LM Studio / llama.cpp / custom / GLM / Kimi / Copilot) — vision is per-MODEL,
  always attempted (native `images` base64 or OpenAI `image_url` parts), with a
  graceful one-shot strip-and-retry + honest 📎 note when the endpoint rejects
  image input; live-verified against local ComfyUI and a cloudflared tunnel
- boot diagnostic logging which keyed providers have a key and its source
  (env / store / none — never values)

#### Fixed
- the gemma4 fine-tune tags' baked `temperature 0` caused greedy repetition
  loops — the backend now sends the Gemma-recommended sampling (temp 1.0 /
  top_k 64 / top_p 0.95) for the fine-tune tags; `COMFYUI_MCP_OLLAMA_TEMPERATURE`
  / `TOP_K` / `TOP_P` override wholesale
- render-completed events no longer tell a text-only model the image is
  "attached below" (confabulation guard)

#### Changed
- `~/.comfyui-mcp/.env` is the only dotenv location (dev override; a legacy
  package-root `.env` is auto-migrated once, then ignored) — panel users manage
  keys via the API Keys card, MCP-only setups via the client config env block
- docker build context whitelisted to exactly what the Dockerfile COPYs (#217)

## [0.31.1] - 2026-07-14

### MCP

#### Fixed
- codex-review hardening of the tab-id migration (#212 follow-up) (#213)
- current DeepSeek in curated picks; sort + widen the overflow list
- live account-aware model catalog + clamp; error turns are never silent
- tab-id migration self-heal — #211 hardened (chains, safe rebind, resume survival) (#212)

#### Docs
- connection guide for the five new providers (Grok / Kimi / GLM /
  ChatGPT-direct-OAuth / Copilot) — sign-in paths, picker roster, honest
  degraded-ack behavior (#214)

#### Changed
- `npx github:artokun/comfyui-mcp` now works as a nightly channel (prepare script)


## [0.31.0] - 2026-07-12

### MCP

#### Added
- clear/revoke path for credential slots — POST {slot, clear:true} (#203)
- forward tool_call as an 'action' frame for mobile tool visibility
- A2UI chat cards — panel_ui_render/panel_ui_update with server-side spec wall — ported from MichaelDanCurtis fork (#194)
- per-workflow agent sessions + prompt registry — ported from MichaelDanCurtis fork (#199)
- OAuth engine + Grok/Kimi/GLM/ChatGPT/Copilot provider backends — ported from MichaelDanCurtis fork (#201)
- upload_media bridge frame — stage phone media as ComfyUI input
- loopback MCP console + credential slots — ported from MichaelDanCurtis fork (#197)
- ltx23-distill-3stage — 3-stage LTX 2.3 distill I2V/T2V pack — from jcd315 fork (#195)
- native search_civitai_models — kill the bundled MCP, own the loop (#198)
- chat-history bridge frames (list_history / load_history)
- integrate official comfy-cli JSON tools
- download metadata sidecars + agent-visible trigger words
- call_tool — direct, whitelisted tool channel for the mobile app

#### Fixed
- a throwing backend constructor can never kill the process (#209)
- pick the real LAN IP, not a VPN/virtual adapter
- forward onToolCall to spawned agents (action lines were dropped)
- move MCP console to bridge+3 — bridge+2 is the phone-pairing listener's port
- thread injectable home through readOAuthStatus — CLI-auth detection leaked the real homedir into readiness tests
- loud not-a-model warning on download (Workflows-zip trap) (#206)
- report existing CLI logins in oauth_status — no more double sign-in prompt
- signpost graph editing to the panel router (live panel wedge #3) (#205)
- CORS for the ComfyUI origin — the panel's credentials card couldn't fetch /api/secrets
- panel_connect slot aliases — stop silent auto-match on stripped params (#204)
- re-queue the in-flight message when the agent crashes mid-turn
- a tool-using turn can never end in silence (#202)
- community fixes — get_node_info summary, comfy-api-key fallback, save_workflow doc clarity (from community forks) (#196)
- live-E2E follow-ups — honest stop copy + empty-final recovery (#193)
- harden comfy-cli integration
- stop the 'circles' loop on unsatisfiable searches (Discord report) (#191)


## [0.30.0] - 2026-07-09

### MCP

#### Added
- render mailbox — never lose a render while the phone is away (#182)

#### Docs
- LLM Arena results for the gemma4-comfyui-mcp fine-tune ladder — `:e4b` 14/20
  (best local model tested), `:12b` 13/20, `:e2b` honestly flagged at 4/20
  pending the v2 training fix (#183); leaderboard SVGs + sizing guidance
  updated across docs, the local-llm-free skill, and the Ollama ack copy (#184)
- "try the knowledge first": skills documented as standalone-readable plain
  markdown, with a direct link to prompt-engineering/SKILL.md (#181, #185)


## [0.29.0] - 2026-07-09

### MCP

#### Added
- on-demand phone pairing — token-gated LAN/tunnel listener (#180)
- graph query — filter/traverse/aggregate over big workflows (#169) (#179)
- inline media bytes in show_media for headless clients (#171)
- Custom OpenAI-compatible endpoint as a first-class backend (#162) (#170)
- llama.cpp (llama-server) as a first-class local backend (#161) (#167)
- graph-health findings in validate_workflow / analyze_workflow — disconnected
  nodes, missing required inputs, duplicate model loads, orphaned branches,
  muted/bypassed (#175)
- node-dev tools: path-jailed read/search/write/patch + per-pack git for
  custom_nodes; commit/push behind COMFYUI_MCP_ALLOW_GIT_WRITES (#173)
- get_comfyui_settings / set_comfyui_setting — read/write ComfyUI's own user
  settings store (#174)
- calculate — safe batch math evaluator with variables + seeded RNG (#176)
- panel_auto_layout — one-shot topological canvas auto-arrange (#177, panel #75)
- panel_connect auto-match by type + full slot diagnostics; dsl_to_workflow
  advisory wiring warnings (#178, panel #76)


## [0.28.0] - 2026-07-09

### RunPod image

#### Added
- generalize boot auto-update to all baked git nodes (panel + Crystools) (#157)
- bake ComfyUI-Crystools — VRAM/RAM/CPU/GPU monitor in the topbar (#156)

### MCP

#### Added
- full hands-off model/server lifecycle (#160 follow-up) (#164)
- LM Studio as a first-class local backend (#160) (#163)

#### Fixed
- pin temperature 0 — nondeterministic empty finals after tool results (#166)
- deliver renders in-turn for headless (mobile/remote) tabs (#165)


## [0.27.0] - 2026-07-08

_No user-facing changes._

## [0.26.5] - 2026-07-08

### MCP

#### Added
- free local-model VRAM during generation + pause chat until it finishes (#154)
- default Ollama to our fine-tuned gemma4-comfyui-mcp ladder (#151)

#### Fixed
- tool-loop breaker — block identical repeat calls, end the turn at 4 repeats (#153)
- stop clamping the fine-tune's context to 16K — model-aware num_ctx (#152)

## [0.26.4] - 2026-07-08

### RunPod image

#### Added
- honor COMFY_AUTOUPDATE_MANAGER — Manager fast-forward at boot (#148)

#### Fixed
- manager_core shim comfy_path must be EMPTY — non-empty stripped custom-node zip paths, breaking CNR installs (#150)

### MCP

#### Fixed
- re-advertise the bridge URL on a timer — restart-after-install wiped the pod store, wedging reconnect (#149)

## [0.26.3] - 2026-07-08

### MCP

#### Fixed
- panel download tray for Manager-dispatched (remote/RunPod) model installs (#147)

## [0.26.2] - 2026-07-08

### RunPod image

#### Fixed
- shim verify step needs the ComfyUI root on sys.path
- manager_core shim — pip Manager's aria2 install-model path crashed on a legacy import (#142)

### MCP

#### Added
- takeover clears the port itself — tree-kill, port-resolved holders, one consent (#146)

## [0.26.1] - 2026-07-08

### MCP

#### Fixed
- remote-mode banner read as a failure ('no COMFYUI_PATH, tools limited') (#141)

## [0.26.0] - 2026-07-08

### RunPod image

#### Added
- npm-publish-style release — version, build, gate, publish, verify, pin template (#135)

#### Fixed
- harden the aria2 sidecar per codex review (#139)
- aria2 download sidecar — Manager's built-in downloader ran at <1-4 MB/s (#138)
- deploy-dockerhub.sh — fall back to 'python' when python3 is absent (Git Bash on Windows) (#134)
- 0-byte panel/custom-nodes on full volumes — self-heal + integrity gates (#133)
- File Browser — pinned release binary instead of the deleted get.sh installer (#132)

### MCP

#### Added
- auto-convert API-format graphs to Web UI format (#126) (#136)

#### Fixed
- find Desktop-recorded installs + auto-detect in the orchestrator (#137)

## [0.25.2] - 2026-07-08

### MCP

#### Fixed
- un-mangle the topbar star — double-encoded UTF-8 rendered as 'â­' (#129)
- warn when saving API format — the canvas can't open it (#125)
- ACP mcpServers — live CLI rejects type 'http'; use the SSE variant (#124)

## [0.25.1] - 2026-07-08

_No user-facing changes._

## [0.25.0] - 2026-07-08

### RunPod image

#### Fixed
- default the image to cu128 (driver >=570) — cu130 perf stack becomes an opt-in variant (#119)

## [0.24.5] - 2026-07-08

### MCP

#### Added
- LAN bind for the panel bridge - server-side orchestrator topology (panel #54)

## [0.24.4] - 2026-07-08

### MCP

#### Added
- graceful legacy-Manager degradation messaging

## [0.24.3] - 2026-07-08

### RunPod image

#### Fixed
- default Manager security_level to weak so git-URL node installs work

### MCP

#### Fixed
- speak BOTH ComfyUI-Manager API generations (fixes #116) + troubleshooting docs

## [0.24.2] - 2026-07-08

### MCP

#### Added
- comfyui-launch-flags — VRAM/attention/cache/perf launch-flag matrix (#101)

#### Fixed
- re-advertise secure bridge on every hello + offer interactive port reclaim (#115)
- readable fatal errors + correct Docker HTTP recipe

## [0.24.1] - 2026-07-08

### RunPod image

#### Added
- panel auto-update on boot, independent of the image (#111 follow-up)

### MCP

#### Added
- add --force-remote to override loopback detection
- OpenAI-compatible panel backend, tiered LLM Arena v3, panel smoke harness, all-LLM repositioning
- Ollama backend — drive the sidebar panel with a local LLM
- ComfyUI LLM Arena + compact-mode catalog search over param docs
- first-class Hermes/OpenClaw/Copilot CLI support + Gemma 4 validation
- compact tool mode for Hermes Agent / Ollama / small models (#97)
- opt-in relay backend for the secure bridge (comfyui-mcp-relay)

#### Fixed
- scope force-remote forwarding to opted-in / non-loopback targets
- keep generations.db out of CWD for remote ComfyUI
- local models were flying blind — dedicated system prompt, forgiving dispatch, markdown reconciliation, cold-load keepalive

#### Changed
- trim redundant comments in force-remote flag

## [0.24.0] - 2026-07-08

### MCP

#### Added
- OpenAI-compatible panel backend, tiered LLM Arena v3, panel smoke harness, all-LLM repositioning
- Ollama backend — drive the sidebar panel with a local LLM
- ComfyUI LLM Arena + compact-mode catalog search over param docs
- first-class Hermes/OpenClaw/Copilot CLI support + Gemma 4 validation
- compact tool mode for Hermes Agent / Ollama / small models (#97)

#### Fixed
- local models were flying blind — dedicated system prompt, forgiving dispatch, markdown reconciliation, cold-load keepalive

## [0.23.6] - 2026-07-08

### MCP

#### Added
- opt-in relay backend for the secure bridge (comfyui-mcp-relay)

## [0.23.5] - 2026-07-08

### RunPod image

#### Added
- persist custom_nodes on the volume (survive restarts) (#111)

### MCP

#### Added
- secure wss:// bridge by default when driving a remote https pod

#### Fixed
- WebSocket keepalive so the secure wss tunnel doesn't drop mid-turn

## [0.23.4] - 2026-07-08

### MCP

#### Added
- secure wss:// bridge by default when driving a remote https pod

## [0.23.3] - 2026-07-08

### MCP

#### Added
- banner clarifies the terminal stays quiet until you click Connect

## [0.23.2] - 2026-07-08

### RunPod image

#### Added
- port GPU driver preflight into venv-in-image (CUDA 13 / driver >= 580)
- perf variant — cu130 + torch 2.9.1 + SageAttention 2.2 + Triton

#### Fixed
- --enable-cors-header (proxy browser 403) + create ComfyUI 0.27 DB dir

### MCP

#### Added
- match the frontend — every out-of-list combo value is an error (#110)

## [0.23.1] - 2026-07-08

### RunPod image

#### Added
- GPU driver preflight — fail fast on a too-old host driver

### MCP

#### Fixed
- report real provider readiness over the bridge + bump SDK for Sonnet 5 (#108)

## [0.23.0] - 2026-07-08

### RunPod image

#### Added
- clean, progressive seed-extract progress (pv, no log spam)

#### Fixed
- adopt an already-seeded volume without a marker (migration safety)

#### Changed
- seed the volume from ONE archive + completion marker (no re-copy)

### MCP

#### Added
- retarget ComfyUI from the panel's hello.comfyui_url
- wan-multitalk — audio-driven talking-avatar pack + skill
- single-port multi-provider — per-tab backend selection
- custom RunPod image for the comfyui-mcp agent (draft) (#98)
- one-command `connect <comfyui-url>` to drive a remote ComfyUI locally (#99)
- remote-mode parity — route model install/manifest/output-listing through Manager v2 HTTP (#96)

#### Fixed
- detect host Triton/SageAttention from the ComfyUI LOG (fixes remote mode)
- orchestrator-owned session is authoritative on reconnect


## [0.22.0] - 2026-06-29

### Added

- **Panel graph-navigation tools** — read/refactor a large live graph without dumping
  JSON or shelling out:
  - `panel_graph_outline` — a compact, dependency-ordered TEXT map of the open graph
    (topo-sorted, each node with key widgets + `←`/`→` wiring, plus a groups index),
    built for an LLM to read top-to-bottom.
  - `panel_find_nodes` — search the live graph by type, title, input/output port, widget
    name, widget value, `is_output`, `is_subgraph`, or mode (or a free-text query across
    all), returning enriched matches with a `matched_on` reason.
  - `panel_subgraph_group` — wrap an existing group's nodes into one toggleable subgraph
    node in a single step; `panel_get_graph` groups now also report member `node_ids`.
  - System prompt steers the agent: outline to understand → find to pinpoint →
    `panel_get_graph` for one node's detail; never grep/jq/python a saved graph.
  - Requires panel >= 0.4.6 for the frontend executors.
- **Manual-edit awareness.** When the user edits the canvas by hand between turns (bypass/
  mute a node, change a widget, rewire, add/remove nodes), the next turn opens with a
  "⟳ MANUAL CANVAS CHANGES" change-list and the agent is told to treat it as ground truth
  over its memory of the graph (diff + injection ship in panel >= 0.4.6).

### Changed

- **`artokun-flow` pack** now ships the subgraph-organized WAN Animate workflow (named
  subgraphs: MODEL LOADERS, PREPROCESS, REACTOR FACE LOCK, REPLACEMENT MODE, DECODE·COLOR,
  SAM 3, Upscale4x-RIFE-1080p) — far easier to read/navigate. Sanitized for shipping:
  driving video unset, character refs → `character.png`, save prefix → `wananimate`,
  personal paths removed. Manifest/model coverage re-verified.

## [0.21.1] - 2026-06-29

### Added

- **`wan-animate-ofm` pack** — WAN Animate 2.2 video-to-video character animation, the
  "OFM hub" variant (ViTPose+YOLO pose/face detection, Uni3C controlnet for temporal
  stability, color-match, optional bypassed SAM2 face-swap branch) on the Kijai WanVideo
  stack. **Personal pack:** requires four private teskor-hub nodes (or standard
  equivalents) and is static-validated only — not render-verified here. Caveats are
  documented in its `pack.yaml`/`manifest.yaml`. Distinct from the SeC-based `wan-animate`.

## [0.21.0] - 2026-06-29

### Added — Comfy MCP parity

Closes the capability gap with Comfy's official cloud MCP (we stay local-first + far broader):

- **`run_workflow_url`** — fetch a workflow from a shared / registry / raw-JSON URL, validate it
  (API or UI format, auto-converted), then load it or run it (`run: true`). SSRF-hardened: the host
  is DNS-resolved and every resolved address is checked against private/loopback/link-local/metadata
  ranges, redirects are rejected, and only http/https with bounded size/timeout is fetched.
- **`rerun_generation`** — re-enqueue the exact workflow behind a prior generation (newest if no
  `prompt_id`), with optional input overrides — reproducibility in one call.
- **`generate_video`** — one-call LTX-2.3 text/image-to-video on our render-verified pack stack
  (encodes the i2v strength gotcha; needs the LTX pack/models).
- **`remove_background`** — one-call BiRefNet/RMBG cutout (needs ComfyUI-RMBG).
- **`upscale_image`** — one-call model upscale (`UpscaleModelLoader` + `ImageUpscaleWithModel`).
- **Remote / hosted connector** — token auth (`Authorization: Bearer` **or** `X-API-Key`,
  constant-time) on the Streamable-HTTP `/mcp` transport, plus a one-command public tunnel
  (`npx -y comfyui-mcp --tunnel`, via the bundled `cloudflared`) that prints a paste-ready Claude
  Desktop Custom Connector URL + token. Binding `/mcp` to a non-loopback host without a token is now
  a hard error (escape hatch: `--allow-unauthenticated-non-loopback`). Browser OAuth is a tracked
  follow-up; `generate_3d` is tracked separately (needs a new 3D pack + mesh output type).

### Added — run-to-node (partial-execution debugging)

- **`panel_run` gains `to_node_id`** — "run to node": render only one output branch
  (the target output node plus everything upstream of it) via ComfyUI's native partial
  execution, skipping every other branch. A fast/cheap way to preview or debug part of a
  big graph; the target must be an output node (tagged `is_output:true` in
  `panel_get_graph`). Omit it to run the whole graph as before.
- **`debug-render` skill** — a method for diagnosing renders that *complete but look
  wrong* (artifacts, wrong subject/pose/color, a ControlNet/IPAdapter/mask/LoRA not
  taking, a refiner/upscale degrading the result): localize the first bad stage with
  run-to-node, preview-tap intermediate latents/masks/preprocessor maps, fix, confirm.
  Cross-linked from the troubleshooting skill (which stays for hard errors/OOM).
- Orchestrator guidance + tests for the above. (Panel side ships in panel ≥ 0.4.5.)

### Fixed — live-render verification (RTX 4090, ComfyUI 0.26.2)

Verifying the new generation tools on real hardware surfaced two graph bugs that only
appear against the installed node schemas (unit tests don't validate live nodes):

- **`generate_video`** — the composed LTX-2.3 graph was rejected at submit (HTTP 400).
  Added the required widgets the installed `comfy_extras` nodes demand:
  `LTXAVTextEncoderLoader.device` (`"default"`) and `SaveVideo.format` / `SaveVideo.codec`
  (`"auto"`). Matches the render-verified `packs/ltx-2.3-img2vid/workflow.json`; corrected
  graph renders end-to-end (8 steps, 768×512×49 → `output/video/*.mp4`).
- **`remove_background`** — `BiRefNetRMBG` raised a runtime `'mask_blur'`: ComfyUI-RMBG
  declares `mask_blur`/`mask_offset`/`invert_output`/`refine_foreground`/`background_color`
  as optional but reads them by key, so omitting them over the API KeyErrors. Now passes
  every widget explicitly with the node's documented defaults; produces a transparent RGBA
  cutout.
- Regression-guard unit tests assert these required widgets so they can't silently drop.

All five parity tools (`run_workflow_url`, `rerun_generation`, `upscale_image`,
`generate_video`, `remove_background`) are now live-verified on a local GPU.

## [0.20.9] - 2026-06-27

### Added

- **`analyze_color` tool** — palette / contrast / color statistics for a generated
  image (dominant colors, average + luminance stats, contrast checks) so the agent
  can reason about an image's color without a vision round-trip.
- **Queue/render wedge watchdog** — three guards against the "stuck render + blind
  re-queue" failure where a wedged high-res sampler step let the agent stack jobs
  behind a zombie it couldn't see or kill:
  - **`panel_run` backpressure** — appends a QUEUE WARNING to the tool result when a
    render is already running, so the agent stops stacking behind it.
  - **Passive `QueueMonitor`** — a best-effort WS to ComfyUI tracking the running
    prompt / node / progress; a stuck step (the same progress value re-emitted) trips
    a one-line STALL/BACKLOG note prepended to the agent's next turn, deduped per
    episode. Threshold via `COMFYUI_MCP_STALL_S` (default 180s).
  - **`cancel_job` escalation** — interrupt → verify it actually stopped → escalate to
    `/free` → report WEDGED and suggest `restart_comfyui` if it still won't die. A new
    `clear_pending` also drops all pending jobs in the same call.
  All best-effort and fail-safe: if the watchdog WS never opens, nothing changes.

### Changed

- **Stall-warning threshold is now live-tunable.** A `set_config` bridge frame lets the
  panel change the stall threshold without a reconnect (precedence: live value →
  `COMFYUI_MCP_STALL_S` → 180s default; clamped 15–3600s).

### Fixed

- **Clone fallback fails fast instead of hanging on a credential prompt.** A custom-node
  install of a missing/private git URL used to block for minutes on a username/password
  prompt; git network ops now run non-interactively (`GIT_TERMINAL_PROMPT=0` +
  `GIT_ASKPASS`), failing in ~1s, with a tightened 180s clone timeout.

## [0.20.8] - 2026-06-27

### Fixed

- **Custom-node installs no longer silently no-op.** `install_custom_node` /
  `apply_manifest` passed the full git URL as the Manager's `id`, but ComfyUI-Manager
  keys its node DB by repo-name / CNR id (never a URL), so `resolve_node_spec`
  matched nothing and the queue reported "done" without cloning — a false success.
  Install is now **registry-first with a clone fallback**: git URLs are looked up the
  way the Manager UI does (repo name, `selected_version` `nightly`, `channel` `dev`,
  `mode` `cache`); the result is **verified** against `/v2/customnode/installed`
  (reflects on-disk packs, so it sees a freshly-installed node before a reboot); and
  only when the Manager genuinely can't resolve the pack (an unregistered repo) does
  it fall back to a direct `git clone` (+ best-effort `pip install -r requirements.txt`
  via the ComfyUI venv) — which is what the Manager does internally. A non-URL id that
  doesn't install is reported as a hard failure rather than a false success.
- **`update_all` now applies its `mode`.** It sent `mode`/`client_id` in the request
  body, but ComfyUI-Manager reads `update_all` params from the query string only, so
  they were silently ignored. They're now sent as query params.

### Security

- Hardened the custom-node install path against git-option injection (a URL starting
  with `-`) and path traversal (a repo name resolving outside `custom_nodes`, e.g.
  `..`). The git URL is validated up front (before cm-cli / Manager / clone), and the
  repo name + a `custom_nodes` containment check guard every on-disk use
  (`runGitCheckout`, the clone fallback); `git clone`/`checkout` use `--end-of-options`.



## [0.20.7] - 2026-06-27

### Fixed

- **`get_history` (no `prompt_id`) no longer returns the previous run.** It took the
  last entry in `/history`'s object iteration order, which isn't guaranteed
  newest-last and can be read before ComfyUI commits the just-finished prompt — so it
  lagged one run behind. It now selects by ComfyUI's monotonic queue number
  (`prompt[0]`), and the description steers callers to pass a `prompt_id` (or use the
  run-finished event) when naming a just-produced output. This was also the source of
  the panel's stale "Run finished" card — the panel's own event path is correct; the
  off-by-one only appeared when "the latest output" was resolved via `get_history`.
- **`apply_manifest` no longer reports a custom-node install as "applied" when nothing
  was installed.** ComfyUI-Manager drains a git-URL install task as "done" even when
  the repo isn't in its registry and nothing is cloned. `apply_manifest` now verifies
  the node is actually present afterward (via Manager's on-disk
  `/v2/customnode/installed`, which sees a freshly-cloned node even before a reboot)
  and reports "failed" with a clear message when it isn't.

## [0.20.6] - 2026-06-27

### Fixed

- **`list_output_images` now finds outputs in subfolders.** It did a flat scan of
  the output directory, so it silently missed files ComfyUI writes into subfolders —
  SaveVideo / VHS with a path-containing `filename_prefix` land at
  `output/video/clip_00001.mp4`. A finished video then looked "not found" even though
  the output directory resolved correctly. The scan is now recursive; each result
  carries its `subfolder` (`""` at top level), the pattern filter matches the
  subfolder-relative path (`video/clip`), and the listing shows the location — pass
  `{ filename, subfolder }` straight to `stage_output_as_input` / `get_image`.

## [0.20.4] - 2026-06-27

### Fixed

- **"Send now" / interrupt no longer wedges the agent.** Interrupting a turn used to
  force the turn gate open synchronously, which fed the next batch (the re-queued
  turn + the new message) into the backend before the aborted turn had settled — the
  SDK accepted the message into the session but started no turn on it, so it sat
  wedged until the slow idle watchdog (or the user's next message) nudged it. Now the
  aborted turn's `result` event drives the gate release at the right moment, with a
  bounded fallback (`COMFYUI_MCP_INTERRUPT_RELEASE_MS`, default 1500ms, keyed to the
  interrupted turn) that releases only if no result ever arrives — so an interrupt can
  never stop cold and can never run the gate ahead. The fallback is cleared on turn
  completion and on session restart (so a stale timer from a dead session can't
  force-release the next session's first turn).

## [0.20.3] - 2026-06-27

### Fixed

- **`list_output_images` now lists video outputs too.** It scans video/animation
  extensions (`.mp4 .webm .mov .mkv .m4v .avi .gif .webp`) in addition to images and
  tags each entry `kind: "image" | "video"`. This lets the agent confirm a VHS /
  LTX / WAN video render even when ComfyUI's `/history` shows the prompt done but
  lists no output (VHS_VideoCombine writes the file but often doesn't register in
  history). Guidance added: verify a video render via `list_output_images`, not
  `/history`. (#73)

### Internal

- Added a deterministic regression guard for the turn-gate drain invariant — a
  completed turn opens the gate and the next queued batch is delivered even if no
  further message arrives. (Investigation found no gate deadlock; the reported
  "stuck thinking" was a panel-side hidden-tab render issue, fixed in
  comfyui-agent-panel 0.4.3.) (#74)

## [0.20.2] - 2026-06-26

### Added

- **Subgraph I/O + unpack panel tools** — `panel_expose_subgraph_output` /
  `panel_expose_subgraph_input` let the agent wire an interior node to the
  subgraph boundary rails from inside a subgraph; `panel_unpack_subgraph` expands
  (dissolves) a subgraph back into its parent. `panel_get_graph` now reports the
  boundary rails' ids + slots when viewing a subgraph.
- **Agent guidance** — wire subgraph I/O via the expose tools (not a guessed rail
  id) and read `rails`; use `panel_unpack_subgraph` to dissolve; and **bypass
  completed pipeline stages** with `panel_set_node_mode` before queuing the next so
  finished work isn't re-run.

### Fixed

- **LTX i2v strength gotcha** — the `ltxv2-video` skill now flags that
  `LTXVImgToVideo.strength = 1.0` pins every frame to the start image (a frozen i2v
  with no motion); keep the verified ~0.6 for proper motion.

## [0.20.1] - 2026-06-26

### Added

- **`stage_output_as_input` tool** — pipe one stage's output into the next stage's
  loader (`LoadImage` / `VHS_LoadVideo` / `LoadAudio`) in one step. Fetches the output
  via the server `/view` API and re-registers it as an input via `/upload`, returning
  the input filename — so it works with **custom input/output dirs** (no filesystem
  guessing, which previously failed a render with "Invalid image file"). (#71)
- **`panel_set_node_mode` tool** — set a live-canvas node to `active` / `bypass` / `mute`
  (undo-able), and the live graph read (`panel_get_graph`) now reports each node's mode.
  Closes the gap where the agent couldn't enable a bypassed path (e.g. the KREA
  Ideogram-JSON builder) and silently rendered the wrong result. (#69)
- Agent guidance (system prompt + skills): inspect node modes and un-bypass the intended
  path before running; verify the rendered output matches the request before declaring
  success; stage outputs via the API, never by guessing filesystem paths. (#69, #71)

### Fixed

- **Reasoning-effort dropdown now works for Codex/ChatGPT models.** Codex model metadata
  now advertises `supportedEffortLevels` (none–xhigh) — the backend already applied
  effort, it just wasn't reported, so the panel hid the picker. (#67)
- **`apply_manifest` no longer re-downloads a model you already have.** The
  already-exists check now looks across **all** ComfyUI model roots (extra model paths,
  custom base dir) instead of a single computed path, with exact matching for nested
  `local_path` targets. (#68)
- Added `resolveInputDir` (mirrors `resolveOutputDir`) so path-based tools honor a custom
  `--input-directory`. (#71)

## [0.20.0] - 2026-06-26

### Added

- **`install_panel` tool + on-load install-if-missing of the ComfyUI Agent panel.**
  The orchestrator installs/updates the `comfyui-agent-panel` custom node (nightly) on
  start if it's missing, using the same path resolution as `install_custom_node`. Fully
  **dev-safe**: a linked dev checkout (a `mklink /J` junction into `custom_nodes`) is
  detected and never clobbered. Opt out with `COMFYUI_MCP_PANEL_AUTOINSTALL=0`. (#62)
- **Server self-update on start.** The orchestrator checks npm for a newer
  `comfyui-mcp` and updates itself in place, then asks you to reconnect. Install-mode is
  classified safely (global / local / npx / linked) and **a linked dev install is never
  updated**; ambiguous layouts (pnpm, nested `node_modules`) safe-fail to no-op. Opt out
  with `COMFYUI_MCP_AUTOUPDATE=0`. (#63)

## [0.19.1] - 2026-06-25

### Fixed

- **Tool robustness** (live-tested): `convert_image` / `list_output_images` now honor
  ComfyUI's `--output-directory` / `--base-directory` redirect (resolved from
  `/system_stats` argv) instead of assuming `<COMFYUI_PATH>/output`;
  `verify_workflow_lock` reports "no lock" gracefully instead of crashing; the whole
  Manager snapshot family (`list`/`save`/`restore_node_snapshot`) degrades gracefully
  on builds without the `/snapshot/*` endpoints; registry versions render as strings
  (no more `[object Object]`); `generate_node_skill` works on a bare registry id.
- **Models / queue**: `remove_model` resolves across `extra_model_paths` roots (e.g.
  a model on another drive), with a cross-platform absolute-path guard (rejects
  posix-absolute, Windows drive-letter `E:\`, and UNC paths on all hosts);
  `verify_custom_node` infers class types for re-exporting packs; `move_queued_job`
  reports a real (non-negative) queue count.
- **v3 dynamic-combo API nodes** (e.g. Nano Banana 2) serialize their dotted
  `model.<nested>` widgets into the API/prompt format, so `generate_with_api_node`
  and the UI→API conversion no longer 400.
- **`request_secret` reaches the built-in comfyui MCP server**: tool secrets
  (`CIVITAI_API_TOKEN` / `HUGGINGFACE_TOKEN` / `HF_TOKEN`, allowlisted) persist to a
  0600 store and inject into the server's spawn env on both backends, with an
  in-process respawn so a saved token applies without fighting reloads (downloads no
  longer stay 401).

## [0.19.0] - 2026-06-25

### Added

- **Multi-provider panel agent: Claude + ChatGPT/Codex at full parity.** The panel
  orchestrator is now driven through a provider-neutral **`AgentBackend`** port
  (dependency injection), so the same panel/orchestrator runs on **either** the
  Claude Agent SDK **or** OpenAI Codex — selected by the panel's backend picker
  ("pick a provider, not a port"), each on its own loopback bridge port. Both run
  on the user's own subscription (claude.ai OAuth / ChatGPT login), no API keys.
  - **`ClaudeBackend`** — the Agent SDK over a persistent streaming session
    (`@anthropic-ai/claude-agent-sdk`, optional dep).
  - **`CodexBackend`** — Codex over the `codex app-server` JSON-RPC protocol
    (`@openai/codex`, optional dep), with interrupt via `turn/interrupt` and models
    via `config/read`. A capability matrix degrades the panel gracefully
    (conversation-rollback is Claude-only for now — the app-server resumes whole
    threads only).
  - **Provider switch + effort persistence** — switching providers starts a fresh
    session; the chosen reasoning effort is preserved by mapping to the nearest
    valid level for the target backend.
- **Full Codex tool parity with Claude.** The `panel_*` live-canvas tools live in
  one shared definition list, registered onto both the in-process Claude SDK MCP
  server **and** a `@modelcontextprotocol/sdk` server over a loopback
  **streamable-HTTP MCP** the orchestrator hosts for Codex (routed by tab id). The
  headless `comfyui` MCP is injected into both backends (in-process for Claude;
  declared via `codex app-server -c mcp_servers` for Codex). The shared list means
  the surface — including the destructive-confirm gating for `panel_clear` /
  `panel_restart_comfyui` — is identical across providers.
- **Knowledge parity across backends.** New `list_skills` / `read_skill` /
  `list_packs` / `read_pack_workflow` / `list_workflow_templates` tools expose the
  bundled model-family + workflow skills, one-command installer packs, and the
  connected server's official workflow templates to any MCP client (so the Codex
  backend has the same expertise Claude loads natively), with steering toward
  packs over hand-built graphs.
- **One-shot `panel_load_workflow` + `graph_load`.** Load a full workflow onto the
  live canvas in a single call — by bundled `pack` name (read server-side, so the
  large graph never shuttles through the conversation) or by graph JSON — replacing
  the current graph and capturing it as an undo point.
- **API-node-vs-local-GPU awareness (`check_workflow_runtime`).** Classifies a
  workflow as **local** (the user's own GPU, free) or **api** / **mixed** /
  **unknown** (hosted API nodes that consume **paid** credits), using the same
  signal as `list_api_nodes`. Bundled packs are local/free; the agent is steered to
  **ASK before spending paid API credits** on any ad-hoc or generated workflow.
- **Live environment block in the system prompt.** The orchestrator gathers the
  machine once at startup (OS/GPU/VRAM/CUDA/torch/ComfyUI/python · Triton &
  SageAttention presence · local-vs-cloud · backend) — every probe hard-timed-out
  so session start never hangs — and prepends it to the prompt for both backends,
  so the agent picks models/precision and the sdpa-vs-acceleration path knowingly.
- **`panel_show_media`** — the agent can DISPLAY an image/video on demand (a disk
  path it made/downloaded, or a ComfyUI output ref) as a media card in chat
  (guarded disk read), instead of describing it in text.
- **`panel_free_vram`** — unload models + free VRAM (ComfyUI `/free`) so the agent
  can unwedge a stuck/OOM ComfyUI before retrying or restarting.
- **`strip_workflow` / `slice_workflow`** (+ `panel_*` variants) — de-virtualize any
  workflow file (Get/Set/Reroute, bypassed/muted, subgraphs) and un-chunk rgthree
  toggled pipelines.
- **Skills**: `video-extend` (Pusa 2.2 temporal flowmatching) and
  `triton-sageattention` (per-OS install with pinned wheels + sdpa fallback). Four
  new SEO blog posts (multi-provider flagship, self-healing agent, video upscale,
  Pusa extend) + a default Open Graph social card for the docs/blog.

### Fixed

- **Self-heal a Desktop-nested ComfyUI path** (the "doubled `COMFYUI_PATH`" bug):
  detection now validates a candidate is a real ComfyUI root and descends one level
  into `/ComfyUI` if it's the empty wrapper — so model downloads, crash recovery,
  and output scans target the real install. No-op for non-nested installs.
- **WMI process-creation-time read** was feeding CIM's `DateTime` back through a
  DMTF-string converter → threw on every call (disabling the pid-reuse identity
  check and flooding ComfyUI's log). Reads the `DateTime` directly now, stderr
  suppressed.
- **Finished renders auto-deliver, no polling.** `panel_run` tells the agent it
  will be notified with the output when the render finishes — so it ends its turn
  and the executed-event image injects promptly (was sometimes delayed behind the
  agent's own busy-poll turns).
- **ComfyUI run errors interrupt the agent** so it stops running blind after a
  failed queue, and **session ids persist to disk** so the chat survives an
  orchestrator restart. **Send-now** re-queues the interrupted message (both get
  answered) without re-running on a plain Stop. **Reasoning effort** snaps to the
  nearest level a model supports on a provider/model switch instead of silently
  dropping.

See the design doc: [docs/design/agent-backend-injection.md](docs/design/agent-backend-injection.md).

## [0.18.0] - 2026-06-25

### Added

- **Remote self-hosted ComfyUI behind a reverse proxy / API gateway (#52).**
  `COMFYUI_URL` now **preserves a path prefix** (e.g. `https://host/comfyapi`),
  so requests route under the prefix instead of hitting `/prompt`,
  `/system_stats`, … at the root. New `COMFYUI_AUTH_TOKEN` (+ optional
  `COMFYUI_AUTH_HEADER`, default `Authorization`, and `COMFYUI_AUTH_SCHEME`,
  default `Bearer`) attaches a generic auth header to **every** ComfyUI request
  — both the direct HTTP calls and the underlying client/WebSocket library.
  This is independent of Comfy Cloud mode (`COMFYUI_API_KEY` / `X-API-Key`), so
  a normal self-hosted instance behind a gateway no longer gets misread as
  Comfy Cloud. Requested by [@NitishMamadgi](https://github.com/NitishMamadgi).

## [0.17.1] - 2026-06-23

### Fixed

- **Broken install on 0.17.0.** The 0.17.0 `files` allowlist dropped `scripts/`
  while `package.json` still declared `postinstall: node scripts/postinstall.mjs`,
  so `npm install` / `npx -y comfyui-mcp` crashed on a missing file. Restore
  `scripts/` to the published tarball (also ships `sync-agents.mjs` so
  `npm run sync-agents` works from an install). Thanks
  [@NeoAnthropocene](https://github.com/NeoAnthropocene) (#51).

### Changed

- **Release smoke test.** CI and the release workflow now pack the tarball,
  install it into a clean project (running the postinstall hook), and boot the
  entrypoint — so a packaging regression like the above is caught before publish
  instead of after. Run locally with `npm run smoke`.

## [0.17.0] - 2026-06-22

### Added

- **Google Antigravity / `.agents` support.** A new `npm run sync-agents` script
  transpiles the Claude Code plugin — skills, agents, commands, and hooks — into
  Google Antigravity's `.agents` + `.gemini` formats (and other AI IDEs that read
  `.agents`), with a `GEMINI.md` developer guide. It's a manual dev step (no
  install/build-time side effects). Contributed by
  [@NeoAnthropocene](https://github.com/NeoAnthropocene) (#50).

### Changed

- **Leaner npm package.** Publishing now uses an explicit `files` allowlist
  (`dist`, `plugin`, `packs`, `model-settings.json` + its override template),
  dropping dev/CI/docs cruft (`scripts/`, `blog/`, `docs/`, the legacy
  `web/extensions` drop-in, dotfiles) from the tarball while keeping everything
  the server and agent actually use.

## [0.16.0] - 2026-06-19

### Added

- **Conversation rewind (`forkSession`).** The orchestrator can fork the panel
  agent's session at a chosen turn anchor, dropping everything after it from the
  agent's memory — the backend for the panel's per-message rollback (code /
  conversation / both) and double-Esc rewind.
- **Reorder queued messages.** A new `reorder` bridge frame lets the panel set the
  flush order of still-queued messages; the orchestrator stable-sorts its queue to
  match (a turn already in flight is untouched).
- **Destructive-op confirmation (#46).** `panel_clear` and `panel_restart_comfyui`
  now pop a yes/no card in the panel and only act on an explicit "yes" (gated
  in-tool, since `canUseTool` is bypassed under `bypassPermissions`).
- **Workflow layout tools + skill.** Graph reads now include node `pos`/`size` and
  subgraph I/O rail positions; new `panel_move_rail`, group create/edit,
  `panel_set_node_collapsed`, `panel_set_node_color`, and `panel_screenshot` (a
  visual verify loop) give the agent spatial control. Ships a `workflow-layout`
  skill (incl. the "expose inputs/outputs" rule).
- **ComfyUI extra search-path config tools.** Added `list_extra_paths`,
  `add_extra_path`, and `remove_extra_path` to inspect and edit standalone
  `<ComfyUI>/extra_model_paths.yaml` or ComfyUI Desktop's app-data
  `extra_models_config.yaml`. Categories are generic ComfyUI search-path keys,
  so model folders (`checkpoints`, `loras`, `vae`, etc.) and `custom_nodes`
  entries can both be managed when supported by the running ComfyUI build.
- **Queue payload inspection and pending-job edits.** `get_queue` can now include
  queued workflow payloads, `get_queued_workflow` returns one pending job's
  payload, and `move_queued_job` / `edit_queued_job` requeue pending jobs at the
  front/back with patched node inputs or a replacement workflow. Requeued jobs
  receive a new `prompt_id`; running jobs are still interrupt-only.
- **Wan Blackwell (fp16) pack tiers.** Added `-96gb` siblings for i2v / v2v /
  transparent and `wan-longer-videos-t2v-96gb` for RTX PRO 6000 Blackwell.

### Fixed

- **The panel agent never lingers as a zombie.** A wedged orchestrator used to stay
  alive but stop serving the bridge, so reloads — and even a full ComfyUI restart —
  reattached to a dead process ("the panel agent will no longer reconnect"). The
  bridge now exits on a post-startup server error, an `uncaughtException` exits
  instead of being swallowed, and Connect reclaims a lockfile-less orchestrator
  zombie that still holds the port.
- **Rewind correctness** (post-review): reset the last-assistant anchor on each
  session (re)start so a fork can't report a stale pre-fork anchor; dropped a dead
  `text` parameter from the rewind path.
- **Workflow converter robustness:** translate rgthree Power Lora Loader loras to
  `lora_N` inputs, detect `control_after_generate` on seed-named INT widgets,
  default invalid combo values, and drop type-mismatched links.
- **Wan packs:** use the official lightx2v 4-step lightning loras (2+2 split),
  switch A14B unets Q8_0 → Q4_K_S for speed, ModelSamplingSD3 shift 8 → 5 to match
  the official Wan2.2 template, and VRAM-fit settings for 24GB cards.

## [0.15.0] - 2026-06-19

### Added

- **Live-streaming panel chat.** The orchestrator streams extended-thinking and
  reply deltas to the sidebar (collapsible "see thinking" + typewriter reveal),
  with a live thinking-token counter.
- **SDK slash commands in the composer.** The orchestrator probes
  `query.supportedCommands()` and surfaces the useful built-ins — `/compact`,
  `/context`, `/usage`, `/loop`, `/goal`, `/clear` — in the panel's `/` menu
  (the user's unrelated skills/plugins are filtered out).
- **Subgraph authoring + canvas tools** — `panel_promote_widget` (expose/retract
  an inner subgraph widget on the parent node), plus the live-graph tool surface
  (subgraph enter/exit/create, node-title rename, workflow tabs, built-in Manager
  install→restart→resume).
- **Live model-download progress** streamed to the panel's status tray; **loop
  mode** drives a `panel_set_todo` checklist to completion.
- **Workflow-converter robustness** — a de-virtualization pre-pass (strips
  Get/Set + Reroute), subgraph→subgraph edge relink, top-level virtual
  `PrimitiveNode` resolution, V3 dynamic-combo recognition, default-fill of
  required inputs, and VHS object-form widgets. Packs render-verified: ideogram,
  z-image (turbo/base) ControlNets, qwen-image-edit, ltx-2.3.

### Changed

- **Removed the legacy `--channels` mode entirely.** The panel runs only on the
  autonomous orchestrator (`--panel-orchestrator`, dedicated bridge **9180**).
  The `--channels` flag/env, the in-session `panel_*` tools (`panel_say`,
  `panel_inbox`, `panel_status`), and their docs are gone; the shared UI bridge
  stays. A stray session can no longer steal the panel's bridge port.
- **Panel display name → "ComfyUI Agent Panel"** (registry slug
  `comfyui-agent-panel`); docs and the full `panel_*` tool reference updated.

### Fixed

- **Pid-reuse-safe orchestrator kill.** The pack re-verifies a pid's identity
  (cmdline + recorded creation time) immediately before every terminate/kill, and
  records `pidStartedAt` in the lockfile — so a recycled pid can never be mistaken
  for the orchestrator and a user's unrelated process is never signalled.
- **Race-free turn gate.** Replaced the resolver gate (which could deadlock and
  strand queued messages) with monotonic counters; serialized the input queue
  (one turn per batch, no SDK read-ahead) with true read-receipts.
- **Installers** target the ComfyUI venv and resolve each custom node's
  `requirements.txt` after clone (was using system Python / skipping deps).

## [0.14.0] - 2026-06-17

### Added

- **Autonomous panel orchestrator — drive the ComfyUI sidebar with a background
  agent on your Claude subscription (no API key).** `comfyui-mcp --panel-orchestrator`
  owns the loopback bridge and spawns one persistent Claude Agent SDK session per
  panel tab, so the sidebar works on its own and your interactive Claude session
  stays free. Agents authenticate via the on-disk Claude login (`apiKeySource=none`)
  and load the bundled plugin's skills, so they're ComfyUI experts out of the box.
  Replaces the unshippable `--sdk-url`/CCR-v2 path (guarded on current Claude
  Code). The panel pack auto-starts the orchestrator on ComfyUI load, and a
  parent-PID beacon shuts it down when ComfyUI exits. See
  `docs/blog/panel-agent-subscription`.

- **`installer-packs` skill.** Teaches agents how to use, build, and derive
  packs (manifest → generated install scripts) and to **proactively invite users
  to contribute new packs upstream** — an issue/PR with `manifest.yaml` +
  `pack.yaml` + `workflow.json`, reviewed for safety and CI-validated on merge.

- **`ai-toolkit-trainer` skill (renamed from `wan-lora-trainer`).** Generalized
  the ostris AI-Toolkit trainer skill to cover **Z-Image** (Turbo & Base, low-VRAM
  image LoRAs) alongside WAN 2.2 — Z-Image is single-stream (no hi/lo multi-stage),
  plus the V2 embedded-Python installer and the `No module named 'torchaudio'` fix.

- **Eight more installer packs + a WAN LoRA-trainer skill.** New `packs/`: WAN
  (`wan-animate`, `wan-longer-videos`, `wan-transparent`), Qwen (`qwen-image`,
  `qwen-image-edit`) and Z-Image (`z-image-turbo`, `z-image-base`,
  `z-image-xy-plot`), plus `cozy-flow` (AI-influencer image+video, derived from
  its workflow with no upstream installer) — bringing the catalog to **13 packs**, each manifest-driven
  with generated `install-windows.bat` / `install-runpod.sh` and CI URL+size
  validation. New `wan-lora-trainer` skill (ostris AI-Toolkit) for training WAN
  2.2 LoRAs. The LTX pack ships its kornia import fix as both `.bat` and `.sh`.

- **Blog — "Installer packs that can't rot."** Why the packs are a single
  manifest driving both the double-click scripts and an MCP-native install, with
  CI that fails the build the moment a model link dies
  (`docs/blog/installer-packs-that-cant-rot`).

- **Five new model-family skills.** `ideogram-ultra` (Ideogram 4 — open-weight
  text-to-image with area prompting, logos, posters, readable text),
  `ernie-image` (ERNIE-Image — fast text-to-image with precise multilingual text
  rendering, runs on <8GB VRAM), `anima-base` (ANIMA 1.0 — ~2B anime/illustration
  model, Danbooru tags + natural language, anime inpainting, <6GB VRAM), and
  `anima-lora-trainer` (kohya `sd-scripts` Gradio trainer for custom anime
  LoRAs). Each frontmatter `description` is tuned as an agent routing signal so
  Claude picks the right model per task (anime → ANIMA, typography/control →
  Ideogram, fast text-render → ERNIE, editing → Qwen-Edit, video → LTX).

- **Installer packs (`packs/`) — manifest-driven, one-command ComfyUI setups.**
  Each pack (`anima`, `ideogram`, `ltx-2.3`, `ernie`) is a `manifest.yaml` (a
  pure `ComfyManifest` consumable by `apply_manifest`) plus `pack.yaml` metadata
  and the workflow, with cross-platform `install-windows.bat` /
  `install-runpod.sh` generated from the manifest by
  `scripts/gen-pack-installers.mjs` (`npm run packs:gen`). Validation tooling:
  `npm run packs:validate` (schema), `packs:test` (offline idempotency dry-run
  with `git`/`curl` stubbed), and `packs:check-urls` (HEAD/range check that every
  model URL resolves and its payload size is sane for the model type — no full
  downloads). A `.github/workflows/packs.yml` CI job runs all of these on
  `ubuntu-latest`.

### Changed

- **Migrated to zod 4.** Lets the Claude Agent SDK be a clean optional
  dependency (its zod 4 peer is now satisfied); `gen-tool-docs` uses zod's native
  `toJSONSchema`, and tool schemas use the two-arg `z.record(key, value)` form.

- **The plugin now ships in the npm package.** A stale `.npmignore` rule was
  excluding `plugin/` (skills, agents, commands, hooks); anchored those patterns
  to repo root so the bundled plugin is published — which is what lets the
  orchestrator's agents load skills and be experts out of the box.

- **`ltxv2-video` skill upgraded to LTX-2.3.** GGUF UNet via `UnetLoaderGGUF`,
  separate video/audio VAEs + text-projection, the spatial upscaler and new
  LoRAs, the kornia 0.8.3+ import fix (`fix-ltxvideo-kornia.{bat,sh}`), and
  guidance for swapping in alternate / GGUF base models (incl. the community
  "sulphur" LTX-2.3 finetune).

### Fixed

- **Windows dev: the full test suite is green.** Fixed 27 tests that assumed
  POSIX paths/commands (`/fake` separators, `which` vs `where`) — test-only
  changes; the product itself was already cross-platform.

- **UI bridge survives fast `/mcp` reconnects.** The `--channels` WebSocket
  bridge now retries binding `127.0.0.1:9101` with exponential backoff
  (5 attempts, ~6s) when a previous session hasn't released the port yet,
  instead of failing with `-32000`. It logs "listening" only once truly bound,
  uses a cross-platform port-in-use hint, and clears the retry timer on `stop()`.

## [0.13.0] - 2026-06-15

### Added

- **`generate_audio` tool — audio generation from text prompts.** Supports ACE Step 1.5 (music with lyrics/structure/ key/language) and Stable Audio 3 (music, instruments, SFX). Builds the appropriate workflow graph, auto-selects local models (`diffusion_models`, `vae`, `text_encoders`, `checkpoints`), and enqueues via the existing pipeline. Two new `create_workflow` templates: `ace_step_15` and `stable_audio_3`. Requires a ComfyUI build with built-in audio nodes (`EmptyLatentAudio`, `VAEDecodeAudio`, `SaveAudioMP3`, etc.) — included in ComfyUI ≥0.11.1. Now covered by a `generate-audio` smoke-test suite (graph construction + model auto-resolution + validation for both families) and the generated tool docs (89/89 tools documented).

- **Plugin bundles the Civitai MCP — headless pairing.** `plugin/.mcp.json`
  now declares the official [Civitai MCP](https://mcp.civitai.com/mcp) remote
  server (streamable HTTP) alongside comfyui, so `/plugin install comfy`
  auto-wires `mcp__civitai__*` with no `claude mcp add` and no API key for
  browsing — the `Authorization` header defaults to an empty Bearer
  (`Bearer ${CIVITAI_API_TOKEN:-}`), which Civitai accepts for its read tools
  (verified: `tools/list` + `search_models` both work unauthenticated). Set
  `CIVITAI_API_TOKEN` to unlock gated downloads and account context — the same
  variable comfyui-mcp already uses for `download_civitai_model`.

- **`requireLocalComfyUI()` guard in client.** New assertion that blocks tools
  needing local ComfyUI filesystem access when using `--comfyui-url` with a
  non-loopback host and when `COMFYUI_PATH` is unset.

- **`RemoteModeError` error class.** Dedicated error type for operations that
  are incompatible with remote ComfyUI targets.

- **Remote mode guard for install/start/stop/restart tools.** `install_comfyui`,
  `start_comfyui`, `stop_comfyui`, and `restart_comfyui` now throw a clear error
  when `--comfyui-url` points at a remote (non-loopback) host.

  _The `generate_audio` tool and the remote-mode guards / Windows test fixes in
  this release were contributed by [@x-yahya997](https://github.com/x-yahya997)
  (`x-yahya997/comfyui-mcp@c2ff7a9`, `@27e7f02`) — thank you._

### Fixed

- **Warn when COMFYUI_URL and COMFYUI_PATH conflict.** Config now prints a
  warning to stderr when both variables are set simultaneously.

- **process-control tests pass on Windows.** Port-detection mocks now handle
  both `netstat` (Windows) and `lsof` (Unix) commands, and the config mock
  exports `isRemoteMode`.

## [0.12.0] - 2026-06-13

### Fixed

- **Panel messages now push into Claude Code for real.** The server now
  declares the experimental `claude/channel` capability and sends
  `notifications/claude/channel` with the host's expected
  `{ content, meta }` shape — previously the capability was missing and
  the params were a flat custom object, so Claude Code silently dropped
  every panel message and only `panel_inbox` polling worked.

### Added

- **`civitai` plugin skill (16 skills total).** Pairs the official
  [Civitai MCP](https://mcp.civitai.com/mcp) with comfyui-mcp instead of
  proxying it: Claude discovers models on Civitai, hands the returned
  model-version id to `download_civitai_model`, and installs/wires/generates
  locally — falling back to HuggingFace search when the Civitai MCP isn't
  connected. The `comfy-researcher` agent now prefers Civitai discovery for
  model (not node-pack) requests when those tools are present. Docs gained a
  "Pairs with the official Civitai MCP" section.
- **Multi-tab panel bridge.** Each ComfyUI browser tab now holds its own
  identified bridge connection — the panel sends a `hello` frame with a
  per-tab session id and the open workflow's title, `panel_status` lists
  every connected tab, and all graph tools accept an optional `tab_id`
  (full id or 8-char prefix). Routing default when omitted: the only
  connected tab → the tab the user most recently typed in → an error
  listing the tabs. `panel_say` broadcasts unless targeted; inbox entries
  and channel notifications carry which tab/workflow spoke. Previously a
  second tab silently stole the single connection.
- **`panel_clear` tool** — remove every node from the open graph in one
  step; the whole wipe is a single Ctrl+Z undo (panel pack executes it
  inside one `beforeChange`/`afterChange` pair).
- **Six more panel tools — full control of the open ComfyUI tab:**
  `panel_move_node`, `panel_canvas` (fit / center-on-node / pan / zoom),
  `panel_run` (queue the open workflow with live widget values),
  `panel_get_errors` (last execution error + node validation errors),
  `panel_save_workflow` (Ctrl+S or save-as/duplicate), and
  `panel_get_subgraph` (drill into a subgraph node). `panel_get_graph` now
  reports which graph the user is viewing and summarizes subgraph nodes
  shallowly (boundary slots + inner count). Panel user messages carry the
  opened subgraph in channel-event meta and inbox entries.
- **Panel v0.3 (in progress, [comfyui-mcp-panel](https://github.com/artokun/comfyui-mcp-panel)):**
  native ComfyUI design-system restyle (PrimeVue semantic tokens, theme-
  tracking), activity cards for every agent graph edit, empty-state
  onboarding, "Claude is working…" typing indicator. Polished registry
  release **coming soon**.

[0.13.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.13.0
[0.12.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.12.0

## [0.11.1] - 2026-06-12

### Added

- **`model-registry` plugin skill** — one curated table of download URLs +
  target `models/` subdirs for every model the skills reference (Flux, WAN,
  LTX, Qwen, Z-Image, shared VAEs/text-encoders), consolidating rows that
  were scattered across `model-settings.json` and individual skills. Grows
  each release. Plugin is now **15 skills**.
- **Plugin ships channels mode by default** — `plugin/.mcp.json` now passes
  `--channels`, so plugin users get the panel bridge + `panel_*` tools
  automatically (pair with the
  [comfyui-mcp-panel](https://github.com/artokun/comfyui-mcp-panel) pack).

### Changed

- **Discoverability:** README leads with "the Claude Code plugin for
  ComfyUI" and the real asset counts (88 tools / 15 skills / 11 commands /
  4 agents / 4 hooks — previously undersold as 6 skills / 10 commands);
  corrected the plugin install command (`/plugin marketplace add` +
  `/plugin install comfy`); npm description + keywords expanded; GitHub
  repo topics added (both repos had zero); new docs page
  [`/plugin`](https://comfyui-mcp.artokun.io/docs/plugin) documenting the
  full skill/command/agent/hook surface.

## [0.11.0] - 2026-06-12

### Added

- **Channels mode (`--channels`) — your own agent session drives the ComfyUI
  sidebar panel. No LLM API keys.** The server hosts a loopback WebSocket
  bridge (`COMFYUI_MCP_BRIDGE_PORT`, default 9101) that the
  [comfyui-mcp-panel](https://github.com/artokun/comfyui-mcp-panel) pack
  connects to, and registers nine `panel_*` MCP tools (`status`, `get_graph`,
  `add_node`, `remove_node`, `connect`, `disconnect`, `set_widget`, `say`,
  `inbox`). The agent — your existing Claude Code (or any MCP client) session,
  subscription-billed — edits the user's live graph through its MCP
  connection; every mutation is Ctrl+Z-undoable. Messages typed into the panel
  queue for `panel_inbox` and are pushed as `notifications/claude/channel`
  events on hosts that surface them. Bridge design (rid-correlated
  request/reply, loopback-only, last-writer-wins) ported from the author's
  node-lab project. New dependency: `ws`.
- **Live graph edits for the agent panel** (superseded same-day by channels
  mode above, retained as the legacy API-key path). The experimental
  `/api/chat` backend declares six client-side `graph_*` tools that the
  sidebar panel executes against the user's open LiteGraph graph. The panel
  ships as the **comfyui-mcp-panel** pack (the manual drop-in under
  `web/extensions/` is deprecated and will be removed next minor). Epic B
  step 4, built on v1 LiteGraph shims instead of waiting for
  `@comfyorg/extension-api` v2.

## [0.10.1] - 2026-06-12

### Fixed

- **Long jobs no longer killed at 10 minutes.** The job watcher's completion
  timeout was hardcoded to 10 minutes — a 15-minute LTX/WAN video render lost
  its completion notification mid-run. The timeout is now `COMFYUI_JOB_TIMEOUT_S`
  (default 1800 s = 30 min) and the poll cadence is
  `COMFYUI_JOB_POLL_INTERVAL_S` (default 2 s). Gap flagged by
  [josephoibrahim/comfy-cozy](https://github.com/josephoibrahim/comfy-cozy).

### Changed

- **`/object_info` is now memoized for the life of the server process.**
  `validate_workflow`, dependency extraction, and `lock_workflow` each
  triggered a fresh 300–800 ms `/object_info` fetch; repeat validations now
  serve from cache (comfy-cozy reports the same change took their re-validate
  from ~7 s to ~0.5 s). The cache resets automatically on
  `stop_comfyui` / `restart_comfyui` (the only paths that change the node
  set), with in-flight coalescing on the first fetch. Cloud mode is
  unaffected. Idea from
  [josephoibrahim/comfy-cozy](https://github.com/josephoibrahim/comfy-cozy).

## [0.10.0] - 2026-06-11

### Added

- **`lock_workflow` + `verify_workflow_lock`** — provenance sidecars for
  saved workflows. `lock_workflow` walks a workflow's model loaders
  (`CheckpointLoaderSimple`, `UNETLoader`, `VAELoader`, `LoraLoader`,
  `ControlNetLoader`, `CLIPLoader`/`DualCLIPLoader`, `UpscaleModelLoader`,
  …), SHA-256s every referenced model, records the git commit currently
  checked out for every custom node pack the workflow's `class_type`s
  resolve to, captures ComfyUI's reported version, and writes
  `<filename>.lock.json` next to the workflow in ComfyUI's user library.
  `verify_workflow_lock` re-computes the lock and surfaces structured drift
  (changed model SHA-256s, packs on different commits, ComfyUI version
  bumps). Local install required for v1 (SHA-256 needs file bytes;
  commits come from `custom_nodes/*/.git/HEAD`). Idea from
  [josephoibrahim/comfy-cozy](https://github.com/josephoibrahim/comfy-cozy).
- **Resumable model downloads.** Big-model fetches (10–40 GB checkpoints over
  flaky connections to HuggingFace / CivitAI / S3) used to start from byte 0
  every retry. The download cache now writes to a deterministic
  `~/.comfyui-mcp/cache/.<hash>.<ext>.partial` file, sends `Range: bytes=N-`
  on the next attempt, appends on `206 Partial Content`, and falls back
  cleanly to a full overwrite when the server replies `200` (Range
  unsupported). Idea from
  [josephoibrahim/comfy-cozy](https://github.com/josephoibrahim/comfy-cozy).

### Fixed

- **`list_local_models` now sees `extra_model_paths.yaml` redirects + works
  remotely.** The tool previously did only a filesystem scan of
  `${COMFYUI_PATH}/models/`, so models the user had pointed at via
  `extra_model_paths.yaml` (symlinked to a shared drive, mounted from a NAS,
  etc.) were invisible — a common setup for serious rigs. It also threw
  `ModelError: COMFYUI_PATH is not configured` against remote/cloud
  ComfyUI. We now query ComfyUI's `/models/<dir>` REST endpoint first
  (which reports what's actually available to workflows), fall back to the
  filesystem scan only when the HTTP path yields nothing, and return an
  empty list rather than throwing when neither is available. Size and
  modified time are only populated when the filesystem path is taken.
  Originally contributed by [@joaolvivas](https://github.com/joaolvivas) in
  [`joaolvivas/comfyui-mcp-byjlucas@e2ae39c8`](https://github.com/joaolvivas/comfyui-mcp-byjlucas/commit/e2ae39c8).

## [0.9.5] - 2026-06-11

Interoperability + paperwork.

### Added

- **MIT `LICENSE` file** at the repo root — `package.json` and the npm registry
  have always declared MIT, but the file itself was absent and downstream
  paperwork checks flagged it. Reported by
  [@ductiletoaster](https://github.com/ductiletoaster) in
  [#27](https://github.com/artokun/comfyui-mcp/issues/27).

### Fixed

- **Federation timeouts on `resources/list` / `prompts/list`** — federating
  clients (LiteLLM, etc.) probe every standard list endpoint on `initialize`
  fan-out regardless of advertised capabilities. We don't expose resources or
  prompts today, so those calls hit the SDK's default "Method not found" path
  and each downstream paid a per-server timeout (~30 s default). We now
  declare both capabilities and answer with empty lists from
  `resources/list`, `resources/templates/list`, and `prompts/list`. No
  behavioral change for clients that only use `tools/*`. Reported by
  [@ductiletoaster](https://github.com/ductiletoaster) in
  [#29](https://github.com/artokun/comfyui-mcp/issues/29).

## [0.9.4] - 2026-06-03

### Fixed

- **TS2742 portability error on pnpm builds (e.g. Glama)** — `tsc` previously
  failed to emit `dist/experimental/provider-registry.d.ts` under pnpm because
  the inferred return type of `getRegistry()` referenced a transitive type from
  `@ai-sdk/provider`, whose pnpm store path (`.pnpm/@ai-sdk+provider@…`) TS
  considers non-portable. We're a CLI/executable, not a library, so declaration
  emission was useless overhead — disabled `declaration` + `declarationMap` in
  `tsconfig.json`. `dist/` now contains only `.js` + `.js.map`; builds pass
  under both `npm` and `pnpm`.

## [0.9.3] - 2026-06-01

### Added

- **`llms-install.md`** — agent-focused install guide at the repo root, what
  Cline and similar agents read preferentially over `README.md` when setting up
  the MCP server. Covers the Node ≥ 22 prerequisite, the three deployment modes
  (local/remote/Comfy Cloud), Claude Code / Cline / Cursor settings recipes,
  optional env vars, verification, and common issues.
- **400×400 marketplace logo** at `docs/logo/mcpmarket-icon-400.png` for the
  Cline MCP Marketplace listing.

## [0.9.2] - 2026-06-01

### Fixed

- **Docker build hang on rate-limited CI (e.g. Glama)** — `npm ci` in the
  Dockerfile no longer runs the `cloudflared` postinstall, which fetches a
  ~40 MB binary from GitHub releases over an `https.get()` call with no
  timeout. On networks where GitHub rate-limits (or otherwise stalls)
  unauthenticated requests, that fetch hung indefinitely and blocked image
  builds. Install scripts are now skipped with `--ignore-scripts` and the
  two native deps we actually need (`better-sqlite3`, `sharp`) are rebuilt
  explicitly. The runtime tunnel helper already downloads the cloudflared
  binary lazily on first use, so no functionality is lost.

## [0.9.1] - 2026-06-01

### Added

- **`get_job_status` cloud-mode coverage** — when `COMFYUI_API_KEY` is set,
  `get_job_status` now dispatches to `cloud-client.getJobStatus` (which calls
  `/api/job/<id>/status`) and maps the cloud
  `{ pending | in_progress | completed | failed }` shape to the existing
  local `JobStatus`. Completed jobs are still enriched from history when
  available; failed jobs surface the cloud's error string via
  `error.exception_message`. Closes part of `comfyui-mcp-eik`.

### Changed

- Refined the `CLOUD_UNSUPPORTED` error message surfaced by tools that need
  a direct ComfyUI session (workflow library, memory management, etc.). The
  message no longer leaks the internal `getClient` function name and clearly
  tells the user to unset `COMFYUI_API_KEY` to target a local or remote
  ComfyUI.
- **Upgraded vitest to ^4.1.0** (dev-only). Clears
  [GHSA-5xrq-8626-4rwp](https://github.com/advisories/GHSA-5xrq-8626-4rwp)
  (Vitest UI server arbitrary file read/exec). Test infrastructure tweaks:
  S3 mock now uses a `function` declaration (vitest 4 invokes mocked
  constructors via `new`) and manager-config fallback tests call
  `vi.clearAllMocks()` explicitly (vitest 4's `restoreAllMocks` no longer
  resets `.mock.calls`). Closes `comfyui-mcp-g6e`.

## [0.9.0] - 2026-06-01

Three deployment modes, slimmer install footprint, and first-class
[Comfy Cloud](https://cloud.comfy.org) support — built from a survey of
forks and a port of the cloud-dispatch architecture from
[@picoSols](https://github.com/picoSols)'s `comfyui-cloud-mcp` fork.

### Added

- **Comfy Cloud mode** — set `COMFYUI_API_KEY` to route HTTP-backed primitives
  (enqueue, history, system stats, queue, view, upload) to `cloud.comfy.org`
  with `X-API-Key` authentication. WebSocket-bound and local-FS/process
  tools throw a clear `CLOUD_UNSUPPORTED` error in this mode. New
  `src/comfyui/cloud-client.ts` mirrors the local client interface so the
  rest of the server is transparent to which backend it's talking to.
  Architecture and dispatcher pattern originally shipped by
  [@picoSols](https://github.com/picoSols) in
  [`picoSols/comfyui-cloud-mcp@7a812069`](https://github.com/picoSols/comfyui-cloud-mcp/commit/7a812069).
- **Explicit remote mode + smart-detect** — when `--comfyui-url` points at a
  non-loopback host (anything other than `127.0.0.1` / `localhost` / `::1` /
  `0.0.0.0`), the server skips `COMFYUI_PATH` auto-detection. This closes
  the root cause behind the 0.8.1 `upload_*` fix — a stale local install can
  no longer silently absorb uploads/downloads the agent intended for the
  remote target. An explicit `COMFYUI_PATH` env var still wins.
- **`isCloudMode()` / `isRemoteMode()` / `isLocalMode()`** config helpers and
  `COMFYUI_CLOUD_URL` (defaults to `https://cloud.comfy.org`).

### Changed

- **Slim install** — moved seven heavy/feature-gated packages out of
  `dependencies` into `optionalDependencies` and dynamic-import them lazily
  via a new `requireOptionalDep` helper:
  `@aws-sdk/client-s3`, `@azure/storage-blob`, `cloudflared`,
  `ai`, `@ai-sdk/anthropic`, `@ai-sdk/google`, `@ai-sdk/openai`. A
  `npm install --no-optional comfyui-mcp` now yields a working core server;
  features that need a missing optional dep surface a clear
  `OPTIONAL_DEP_MISSING` error with the exact `npm install <pkg>` hint.

### Documentation

- New "Deployment modes" section in `docs/configuration.mdx` covering the
  local / remote / cloud feature parity matrix and the `COMFYUI_API_KEY` /
  `COMFYUI_CLOUD_URL` env vars.

## [0.8.1] - 2026-06-01

Bug-fix release picking up upstream contributions from
[@joaolvivas](https://github.com/joaolvivas)'s fork of comfyui-mcp.

### Added

- **`health_check`** — single-call pre-flight diagnostic that reports
  ComfyUI/Python/PyTorch versions, GPU + VRAM, queue depth, per-category
  `/models` populations (catches empty-dropdown surprises from a
  misconfigured `extra_model_paths.yaml`), and recent errors from
  `/internal/logs`. Read-only. Useful before a long batch or when triaging an
  unexplained failure. Originally contributed by
  [@joaolvivas](https://github.com/joaolvivas) in
  [`joaolvivas/comfyui-mcp-byjlucas@de82ecda`](https://github.com/joaolvivas/comfyui-mcp-byjlucas/commit/de82ecda).

### Fixed

- **`search_custom_nodes`** — `api.comfy.org/nodes` accepts a `search` query
  parameter but ignores it server-side, returning the same paginated default
  list regardless of query. We now fetch a larger window (limit=100) and
  rank-filter client-side by id / name / author / description with a
  popularity boost, so query-relevant packs actually appear. Diagnosed and
  patched by [@joaolvivas](https://github.com/joaolvivas) in
  [`joaolvivas/comfyui-mcp-byjlucas@f066b597`](https://github.com/joaolvivas/comfyui-mcp-byjlucas/commit/f066b597);
  port adds a guard so popularity no longer inflates non-matching packs.
- **`upload_image` / `upload_video` / `upload_audio`** — HTTP-only.
  Previously these tools fell back to a local filesystem copy if HTTP upload
  failed and `COMFYUI_PATH` was set. When `COMFYUI_PATH` was auto-detected to
  an unrelated install (common for users targeting a remote `--comfyui-url`),
  the fallback wrote the file to the wrong tree and reported success, while
  the remote ComfyUI never received it — the next `LoadImage` then failed
  mysteriously. Now HTTP-only against the connected ComfyUI's
  `/upload/image` endpoint, which works for both local and remote. Diagnosed
  and patched by [@joaolvivas](https://github.com/joaolvivas) in
  [`joaolvivas/comfyui-mcp-byjlucas@089180ad`](https://github.com/joaolvivas/comfyui-mcp-byjlucas/commit/089180ad).

## [0.8.0] - 2026-05-26

Completes the custom-node authoring lifecycle, adds cloud storage I/O and
declarative setup, and adds node discovery — all built and reviewed in a
codex implement→review→fix loop.

### Added

- **`apply_manifest`** — declarative environment setup from an inline object or
  a JSON/YAML manifest: `pip` packages, `custom_nodes` (registry ids or git URLs
  with `@ref`), and `models`. Idempotent, per-item structured report; `apt`
  entries are accepted but skipped (manual/root). Local-only.
- **`verify_custom_node`** — the "test" step of the author loop: restarts ComfyUI
  (with a bounded readiness wait) and confirms a pack's `NODE_CLASS_MAPPINGS`
  class_types registered in `/object_info` (a failed import simply never appears).
- **`scaffold_custom_node`** now also emits `.comfyignore`/`.gitignore` and, with
  `with_ci`, a `.github/workflows/publish_action.yml` (Comfy-Org/publish-node-action).
- **`convert_image`** — re-encode a generated image (by `asset_id` or output-dir
  path) to PNG/JPEG/WebP via `sharp`; returns inline base64 + optional file write
  (output-dir confined), and reports bytes saved.
- **Cloud storage** — model downloads may be `s3://` or Azure Blob URLs
  (`download_model` gains `s3` auth); new **`upload_output`** pushes a generated
  output to S3 / Azure / HTTP / Hugging Face and returns URL(s).
- **`download_model` `auth`** — per-request `bearer`/`basic`/`header`/`query`
  authentication for gated/private hosts (carried over and extended).
- **`comfy-researcher` agent** — turns a problem statement into ranked custom-node
  pack recommendations (searches the Registry, evaluates, delegates deep dives to
  `comfy-explorer`).
- **Cached `generate_node_skill`** — read-through cache keyed by source@version
  (`COMFYUI_SKILL_CACHE_DIR`; `refresh` to bypass), so repeat analyses are instant.

### Security

- `apply_manifest` rejects pip argv-option injection; realpath/symlink-safe path
  containment for manifest model paths, `convert_image`, and upload sources;
  `convert_image` caps source size + sharp pixels.
- Cloud storage: Azure SAS / AWS presigned secrets redacted from logs/errors;
  Azure URL-vs-env account mismatch rejected; HF-CLI remote-path argv hardening;
  manual redirect handling (no cross-origin auth replay or upload-redirect SSRF).

### Fixed

- `generate_node_skill` cache resolves the current pack version before lookup
  (no stale docs served after a pack updates) and writes atomically (temp +
  rename with a content-hash check).

### Dependencies

- Added `yaml` (manifest parsing), `sharp` (image conversion), `@aws-sdk/client-s3`
  and `@azure/storage-blob` (cloud storage). `npm audit`: 0 high vulnerabilities.

## [0.7.0] - 2026-05-25

Stability + authoring release: hardens model downloads and the ComfyUI process
lifecycle, makes failures actionable, and adds a custom-node authoring/publishing
lifecycle. Plus a hosted docs site and an experimental embedded-agent backend.

### Added

- **Custom-node authoring** — `scaffold_custom_node` (generate a Python node pack
  from a template) and `publish_custom_node` (publish to the Comfy Registry via
  comfy-cli; key via `REGISTRY_ACCESS_TOKEN`, never logged) (#24).
- **`install_custom_node` ref pinning** — pin a pack to a commit/branch/tag, parsed
  from GitHub/GitLab/Bitbucket URLs or `repo@ref`, or an explicit `ref` arg.
- **`download_model` auth** — per-request `bearer` / `basic` / `header` / `query`
  authentication for gated/private model hosts.
- **Model download cache** — content-addressed dedup, concurrent-download coalescing,
  and optional LRU eviction (`COMFYUI_DOWNLOAD_CACHE_DIR`, `COMFYUI_LRU_CACHE_SIZE_GB`).
- **ComfyUI process supervision** — bounded startup readiness checks
  (`COMFYUI_STARTUP_CHECK_INTERVAL_S`/`_MAX_TRIES`) and opt-in bounded
  auto-restart-on-crash (`COMFYUI_ALWAYS_RESTART`, `COMFYUI_RESTART_MAX_ATTEMPTS`,
  `COMFYUI_RESTART_WINDOW_S`).
- **Plugin skills** — `comfyui-frontend-extensions` (v2 `@comfyorg/extension-api`
  authoring + v1→v2 migration) and `comfyui-node-registry` (node authoring/publishing).
- **Hosted docs** — Mintlify site with a schema-generated tool reference at
  [comfyui-mcp.artokun.io/docs](https://comfyui-mcp.artokun.io/docs).

### Changed

- **`get_job_status` + completion notifications** now surface ComfyUI
  `execution_error` detail (node id/type, exception type/message, truncated traceback,
  `current_inputs`, OOM flag) and optional per-node + total execution timing.
  Additive and backward-compatible.

### Security

- `download_model` auth inputs are validated (reject CR/LF/control chars; HTTP-token
  header names); query-auth secrets are redacted from logs and error details.
- `install_custom_node` git refs are validated and run via `git checkout
  --end-of-options <ref>`, closing an argv-option-injection vector.
- Spawned ComfyUI children now have `error` listeners so a missing/failed executable
  can't crash the MCP server.

### Experimental

- **Embedded-agent backend POC** (flag-gated via `COMFYUI_MCP_AGENT_POC`): a cloudflared
  quick-tunnel helper + an AI SDK `/api/chat` endpoint with bearer auth, a request body
  cap, and a server-side model allowlist. Not part of default startup. See
  `design/embedded-agent-panel.md` and `ROADMAP.md`.

### Dependencies

- Added `ai` + `@ai-sdk/anthropic`/`openai`/`google` + `cloudflared` (experimental POC)
  and declared `zod-to-json-schema` (docs generation). `npm audit`: 0 high vulnerabilities.

## [0.6.1] - 2026-05-25

### Added

- **Media upload** — `upload_video` and `upload_audio` copy local video/audio
  files into ComfyUI's input directory so they can be referenced as workflow
  inputs, mirroring the existing `upload_image` (closes #12).

## [0.6.0] - 2026-05-25

A large feature release that ports much of the [`comfy-cli`](https://github.com/Comfy-Org/comfy-cli)
workflow into MCP tools. New tools operate on the connected ComfyUI (local or a
remote `--comfyui-url` target), preferring the ComfyUI-Manager HTTP API with a
subprocess fallback where the API can't do the job.

### Added — comfy-cli capability port

- **Custom-node management** — `install_custom_node`, `update_custom_node`,
  `reinstall_custom_node`, `fix_custom_node`, `list_installed_nodes`,
  `sync_node_dependencies` (#15)
- **Node snapshots** — `save_node_snapshot`, `restore_node_snapshot`,
  `list_node_snapshots`; honors comfy-cli's `.json`/`.yaml` snapshot contract (#13)
- **Node bisect** — `bisect_start`, `bisect_good`, `bisect_bad`, `bisect_reset`,
  `bisect_status` to isolate a faulty custom node; never re-enables packs you had
  disabled before the session (#14)
- **Workflow dependencies** — `extract_workflow_dependencies`,
  `install_workflow_dependencies` (handles API- and UI-format workflows) (#16)
- **Install ComfyUI** — `install_comfyui`: clones ComfyUI (+ ComfyUI-Manager) and
  installs requirements into a dedicated workspace virtualenv (#17)
- **Update** — `update_comfyui` (core) and `update_all` (all custom nodes) (#18)
- **Models** — `remove_model` (path-safe) and `download_civitai_model` (#19)
- **Workspace & environment** — `get_workspace`, `set_default_workspace`,
  `list_workspaces`, `get_environment` (#20)
- **API / partner nodes** — `list_api_nodes`, `get_api_node_schema`,
  `generate_with_api_node` (#21)
- **ComfyUI-Manager configuration** — `configure_manager` (#22)

### Changed

- Rewrote tool descriptions and parameter docs across the core tool set for
  clearer purpose, usage guidance, and behavioral transparency — improving agent
  tool-selection quality (#23).
- Added a `Dockerfile`, `.dockerignore`, `glama.json`, and Glama quality badges
  for the [glama.ai](https://glama.ai) listing.

### Security

- CivitAI authentication is now sent as an `Authorization: Bearer` header instead
  of a `?token=` query parameter, so the API token no longer leaks into logs,
  errors, or redirect URLs. Model-download filenames are validated to stay within
  the models directory (closes a path-traversal hole shared with `download_model`) (#19).
- `COMFY_API_KEY` is delivered to API nodes via the `/prompt` `extra_data` payload
  rather than being placed in the workflow (#21).

### Notes

- Local-management tools (install/update ComfyUI, custom-node installs, model
  removal) require a local install (`COMFYUI_PATH`) and return a clear error when
  targeting a remote instance where the operation cannot apply.

Earlier releases predate this changelog.

[0.11.1]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.11.1
[0.11.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.11.0
[0.10.1]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.10.1
[0.10.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.10.0
[0.9.5]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.5
[0.9.4]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.4
[0.9.3]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.3
[0.9.2]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.2
[0.9.1]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.1
[0.9.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.9.0
[0.8.1]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.8.1
[0.8.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.8.0
[0.7.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.7.0
[0.6.1]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.6.1
[0.6.0]: https://github.com/artokun/comfyui-mcp/releases/tag/v0.6.0
