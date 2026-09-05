// #1539 — `panel_install_node` took a git `repository` URL for a pack the reporter had
// just found with `panel_search_nodes`, answered `queued: true`, and the Manager queue
// then failed it with
//
//   Node 'comfyui-anima-ipadapter@nightly' not found in
//   [ManagerChannel.dev, ManagerDatabaseSource.cache]
//
// The first pass read that as an UPSTREAM limit — "v4 will not install a repo its
// registry does not list" — and shipped a description saying so. This commit measured
// that claim and it is FALSE for the report's own input.
//
// ## What was measured (2026-08-14, live ComfyUI-Manager V4.2.2 + its own source)
//
// 1. THE PACK IS LISTED. `Wenaka2004/comfyui-anima-ipadapter` is present in the
//    `default` channel's custom-node-list.json (5887 packs) AND in the live rig's own
//    cached copy of it. It is ABSENT from the `dev` channel list (1210 packs). Those
//    two lists are not a superset/subset pair — they share 3 entries.
//
// 2. WE ASKED `dev`. The panel's `buildInstallRequest` defaults the v4 git-URL payload
//    to `channel: "dev"` while defaulting the registry-ID payload — and both 3.x
//    shapes — to `"default"`. The Manager's error names the channel the REQUEST chose.
//
// 3. THE CHANNEL IS WHAT THE LOOKUP READS. `install_by_id` (glob/manager_core.py) for a
//    `nightly` spec does `get_custom_nodes(channel, mode)` → `load_nightly` →
//    `get_data_by_mode(mode, 'custom-node-list.json', channel_url)`, keys that map by
//    the bare repo name (`y.split('/')[-1]`), and clones `the_node['repository']` — the
//    CHANNEL's URL. The `repository` we send is stored in the task params and never
//    read on that path.
//
// 4. REPRODUCED AND ISOLATED on the live V4.2.2 by posting the panel's exact payload to
//    `/v2/manager/queue/task`: `channel:"dev"` → the reporter's error verbatim;
//    `channel:"default"` → the same failure naming `ManagerChannel.default`;
//    `channel:"default", mode:"remote"` → the same again naming `.remote`. The server
//    log shows all three reads landing on the package-BUNDLED node list, because
//    `is_manager_pip_package()` sends `get_data_by_mode` down its offline branch
//    unconditionally: a pip v4 reads the cache file for that exact channel URL or the
//    bundled snapshot, and never fetches. That rig is configured to a non-default
//    channel URL, so it has no `default` cache to hit.
//
// ## What that means for the two remedies the report proposed
//
// ROUTE THE URL THROUGH `install_custom_node` (source:"git") — NOT DONE. That path
// clones into the ORCHESTRATOR's configured ComfyUI; this tool drives whatever ComfyUI
// the PANEL is bound to, and those need not be the same install. Reporting a write into
// an install the running server never reads is a failure this repo has shipped before.
// The tool is still NAMED, with its precondition stated.
//
// REFUSE BEFORE DISPATCH WHEN THE REGISTRY DOES NOT LIST IT — NOT DONE, and this is the
// one the measurement kills. The only registry oracle reachable over the bridge is
// `nodes_search`, and it CANNOT answer this question:
//   - it reads `extension-node-map.json`, a different file from the node list the
//     install resolves against, cached separately and measured stale-by-a-different-
//     amount on the same rig;
//   - it is not channel-scoped at all — `getmappings?mode=cache` and the same route
//     with `&channel=dev` returned byte-identical bodies — so it cannot see the axis
//     that actually decides the outcome;
//   - and against the REPORT'S OWN INPUT it answers "listed", because that search is
//     literally where the reporter got the URL. A guard keyed on it would never have
//     fired on the case it was written for, while reading as good coverage.
//
// So the reply is not corrected by a refusal here. The REQUEST is corrected instead:
// the git-URL route stops asking a channel nobody chose.
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  nodesInstallCommandArgs,
  resetManagerApiCacheForTests,
  v4GitUrlQueueRefusal,
} from "../../services/node-management.js";

// The "unknown dialect" case must be UNDETERMINED on purpose, not because nothing
// happened to be listening. Relying on the probe failing made this file pass on CI
// and FAIL on any machine with ComfyUI actually running -- the probe succeeded
// there, returned a real dialect, and the guard refused.
const detect = vi.hoisted(() => ({ forceFailure: false }));
vi.mock("../../services/node-management.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../services/node-management.js")>();
  return {
    ...actual,
    detectManagerApi: async (...args: Parameters<typeof actual.detectManagerApi>) => {
      if (detect.forceFailure) throw new Error("manager dialect probe failed (test)");
      return actual.detectManagerApi(...args);
    },
  };
});

vi.mock("../../comfyui/client.js", () => ({
  getObjectInfo: vi.fn(),
  backfillObjectInfo: vi.fn(),
  resetClient: vi.fn(),
  resetObjectInfoCache: vi.fn(),
}));

const { buildPanelToolDefs, makePanelToolCtx } = await import("../../orchestrator/panel-tools.js");
import { WorkflowTargetStore } from "../../services/workflow-target-store.js";
import type { PanelToolCtx, ToolResult } from "../../orchestrator/panel-tools.js";

/** The reporter's own repository, verbatim from the issue. */
const REPORTED_URL = "https://github.com/Wenaka2004/comfyui-anima-ipadapter";
const TAB = "11111111-2222-3333-4444-555555555555";

function installNodeDef() {
  const def = buildPanelToolDefs().find((d) => d.name === "panel_install_node");
  if (!def) throw new Error("panel_install_node is not registered");
  return def;
}

/**
 * Drive the REAL tool definition against a fake bridge and return both what was put on
 * the wire and what the caller was told. A green unit test on nodesInstallCommandArgs
 * proves the helper computes a channel and a note, never that either reaches anyone —
 * deleting the `...cmdArgs` spread at the call site, or computing a note and never
 * appending it (#1129, which shipped once and never ran), fails here and nowhere else.
 */
afterEach(() => resetManagerApiCacheForTests());

async function dispatchInstall(
  args: Record<string, unknown>,
  dialect: "legacy" | "v2" | "v2-batch" | "unknown" = "legacy",
): Promise<{ sent: Record<string, unknown> | undefined; text: string; isError: boolean }> {
  // "unknown" primes NOTHING and forces the probe to FAIL, so the dialect is
  // undetermined by construction rather than by whether a server happens to be up.
  detect.forceFailure = dialect === "unknown";
  if (dialect === "unknown") resetManagerApiCacheForTests();
  else resetManagerApiCacheForTests(dialect);
  let sent: Record<string, unknown> | undefined;
  const bridge = {
    send: async (cmd: Record<string, unknown>) => {
      if (cmd.cmd === "nodes_install") {
        sent = cmd;
        // This MCP-only fixture represents the legacy direct-URL relay. The
        // panel's real v4 refusal is covered by browser_tests in the paired repo.
        return { queued: true, pending: true, id: "comfyui-anima-ipadapter", dialect: "legacy" };
      }
      // Leave the #1129 dropped-enqueue probe inconclusive so it appends nothing.
      return { status: { in_progress_count: 0, is_processing: true } };
    },
    tabIncarnation: () => "inc-A",
    push: () => 1,
    canReach: (id: string) => id === TAB,
    isHeadless: () => false,
    tabs: () => [{ tab_id: TAB, title: "wf", connected_at: 0 }],
    resolveActiveTabId: () => TAB,
    refreshWorkflowUuid: () => true,
    workflowUuidFor: () => ({ known: false }),
    tabCanMutateGraph: () => true,
    tabGraphMutationCapability: () => ({ known: true, canMutate: true }),
  } as unknown as PanelToolCtx["bridge"];
  const ctx = makePanelToolCtx(bridge, TAB, new WorkflowTargetStore());
  const res: ToolResult = await installNodeDef().handler(args as never, ctx);
  return {
    sent,
    text: res.content.map((c) => (c as { text?: string }).text ?? "").join(" "),
    isError: res.isError === true,
  };
}

async function dispatchLegacyInstall(
  args: Record<string, unknown>,
): Promise<{ sent: Record<string, unknown>; text: string }> {
  const out = await dispatchInstall(args, "legacy");
  expect(out.isError).not.toBe(true);
  if (!out.sent) throw new Error("nodes_install was never dispatched");
  return { sent: out.sent, text: out.text };
}

describe("the v4 git-URL refusal requires POSITIVE evidence of v4 (#1539)", () => {
  it("does not refuse when the Manager dialect could not be determined", async () => {
    // Regression: the guard first read `catch { api = "v2" }`, so ANY failure to
    // reach the Manager was treated as proof of v4. That refused legacy 3.x
    // `files:[url]` installs that still work, told the caller the wrong cause,
    // and broke nine tests in the #1129 suite — which installs by `repository`
    // and stubs no Manager at all. An unknown dialect is not evidence of v4.
    const out = await dispatchInstall({ repository: REPORTED_URL }, "unknown");
    expect(out.text).not.toContain("Refusing to queue");
    expect(out.text).not.toContain(v4GitUrlQueueRefusal(REPORTED_URL));
  });

  it("still refuses once v4 is actually detected", async () => {
    // The other direction, so the test above cannot be satisfied by deleting the
    // guard outright.
    const out = await dispatchInstall({ repository: REPORTED_URL }, "v2");
    expect(out.isError).toBe(true);
    expect(out.text).toContain("Refusing to queue");
  });
});

describe("legacy direct-URL normalization remains intact (#1539)", () => {
  it("normalizes the reporter's URL for the legacy direct-URL route", () => {
    // Manager v4 refuses arbitrary Git URLs before queueing. These fields remain
    // normalized because legacy Manager 3.x carries the URL directly.
    const out = nodesInstallCommandArgs({ repository: REPORTED_URL });
    expect(out.repository).toBe(REPORTED_URL);
    expect(out.version).toBe("nightly");
    expect(out.channel).toBe("default");
    expect(out.channel).not.toBe("dev");
  });

  it("a URL arriving as `id` takes the same legacy route", () => {
    // #789 reroutes a URL-shaped `id` onto the direct-URL path. If only the
    // `repository` spelling were normalized, the identical legacy request would
    // still fail when written the other way.
    const out = nodesInstallCommandArgs({ id: REPORTED_URL });
    expect(out.id).toBeUndefined();
    expect(out.repository).toBe(REPORTED_URL);
    expect(out.channel).toBe("default");
  });

  it("MUST STILL WORK: an explicit channel is the caller's, including 'dev'", () => {
    // The over-broad direction of this change would be to force "default" always,
    // which un-ships every pack that genuinely lives on another channel — 1207 of
    // dev's 1210 entries are not in default, so this is a real population, not a
    // hypothetical one.
    const out = nodesInstallCommandArgs({ repository: REPORTED_URL, channel: "dev" });
    expect(out.channel).toBe("dev");
    const forked = nodesInstallCommandArgs({ repository: REPORTED_URL, channel: "forked" });
    expect(forked.channel).toBe("forked");
  });

  it("MUST STILL WORK: a registry-id install is not touched at all", () => {
    // The panel already defaults THAT payload to "default"; sending a value from here
    // would be a change with no measurement behind it.
    const bare = nodesInstallCommandArgs({ id: "comfyui-kjnodes", version: "latest" });
    expect(bare.channel).toBeUndefined();
    expect(bare.repository).toBeUndefined();
    const chosen = nodesInstallCommandArgs({ id: "comfyui-kjnodes", channel: "recent" });
    expect(chosen.channel).toBe("recent");
  });

  it("a BLANK channel counts as unset, because the panel's `||` reads it that way", () => {
    // `channel || "dev"` substitutes dev for "" and "   ". Forwarding either would land
    // straight back on the channel this change exists to stop asking for — a fix that
    // passes a naive equality test while doing nothing.
    expect(nodesInstallCommandArgs({ repository: REPORTED_URL, channel: "" }).channel).toBe(
      "default",
    );
    expect(nodesInstallCommandArgs({ repository: REPORTED_URL, channel: "   " }).channel).toBe(
      "default",
    );
  });

  it("does not disturb the other dispatch fields", () => {
    const out = nodesInstallCommandArgs({
      repository: REPORTED_URL,
      version: "abc123",
      mode: "cache",
    });
    expect(out.version).toBe("abc123");
    expect(out.mode).toBe("cache");
    expect(out.conflict).toBeUndefined();
  });

  it("the conflict refusal still wins over any channel handling", () => {
    const out = nodesInstallCommandArgs({ id: "comfyui-kjnodes", repository: REPORTED_URL });
    expect(out.conflict).toMatch(/BOTH/);
    expect(out.channel).toBeUndefined();
  });
});

describe("legacy direct-URL normalization covers every git spelling (#1539)", () => {
  // The hole the gate found, and it swallowed the reporter's own pack. The orchestrator
  // decided "is this a git install?" with a NARROWER predicate than the panel's:
  //
  //   orchestrator  /^(https?:\/\/|git@|git\+)/i  ||  endsWith(".git")
  //   panel         /^(https?|ssh|git):\/\//i  || /^git\+/ || /^git@/ || ".git"
  //                 || looksLikeOwnerRepoShorthand   ← #301
  //
  // So `id:"Wenaka2004/comfyui-anima-ipadapter"` — the `author/repo` form this tool's
  // OWN description tells callers to pass — was not rerouted here, dispatched with no
  // channel, and then the panel's `channel || "dev"` put it straight back on `dev`. The
  // fix reached the URL spelling and missed the documented shorthand.
  const CASES: Array<[string, string]> = [
    ["author/repo shorthand — the documented `id` form", "Wenaka2004/comfyui-anima-ipadapter"],
    ["ssh:// URL", "ssh://git@github.com/Wenaka2004/comfyui-anima-ipadapter"],
    ["git:// URL", "git://github.com/Wenaka2004/comfyui-anima-ipadapter"],
  ];

  for (const [label, spelling] of CASES) {
    it(`sends a channel for a ${label}, passed as id`, () => {
      const out = nodesInstallCommandArgs({ id: spelling });
      expect(out.channel).toBe("default");
      // Rerouted like any other git install: the URL travels as `repository`, never as
      // an `id` the Manager would try to resolve verbatim.
      expect(out.id).toBeUndefined();
      expect(out.repository).toBeTruthy();
    });

    it(`sends a channel for a ${label}, passed as repository`, () => {
      expect(nodesInstallCommandArgs({ repository: spelling }).channel).toBe("default");
    });
  }

  it("expands author/repo to a clonable URL, as the panel does (#301)", () => {
    // 3.x dialects put this value straight into Manager's `files` clone list, where the
    // bare shorthand is not fetchable.
    const out = nodesInstallCommandArgs({ id: "Wenaka2004/comfyui-anima-ipadapter" });
    expect(out.repository).toBe(REPORTED_URL);
  });

  it("still rewrites 'latest' to nightly for these spellings", () => {
    // The same predicate gates the #1254 rewrite. Leaving the shorthand out of it sent
    // `selected_version:"latest"` for a from-source install — the failure that helper
    // exists to prevent.
    const out = nodesInstallCommandArgs({ id: "Wenaka2004/comfyui-anima-ipadapter", version: "latest" });
    expect(out.version).toBe("nightly");
  });

  it("a plain registry id is STILL not a git install", () => {
    // The shorthand test must not swallow the ordinary case: no slash, no reroute.
    const out = nodesInstallCommandArgs({ id: "comfyui-kjnodes" });
    expect(out.id).toBe("comfyui-kjnodes");
    expect(out.repository).toBeUndefined();
    expect(out.channel).toBeUndefined();
  });

  it("REACHES THE PANEL for the shorthand too, not just the args object", async () => {
    const { sent } = await dispatchLegacyInstall({ id: "Wenaka2004/comfyui-anima-ipadapter" });
    expect(sent.channel).toBe("default");
    expect(sent.repository).toBe(REPORTED_URL);
  });
});

describe("the channel it picked is DISCLOSED, never silent (#1539 review P1)", () => {
  // Review, correctly: with default and dev near-disjoint, NO single default is right,
  // so the 1207 dev-only packs are on the losing side of whichever one is chosen. The
  // proposed remedy was to retry the other channel on a not-found. That premise is true
  // about the FIRST attempt — a not-found returns before any clone — and false about
  // the SECOND: v4 resolves by BARE REPO NAME and clones the CHANNEL's recorded URL, and
  // 35 bare names exist in both channels under DIFFERENT authors. An automatic retry
  // would sometimes install a repository the caller never named. So the choice is taken,
  // disclosed, and reversible in one argument instead.

  it("names the channel asked and refuses to generalise a miss beyond it", () => {
    const note = nodesInstallCommandArgs({ repository: REPORTED_URL }).note ?? "";
    expect(note).toMatch(/asked ComfyUI-Manager's "default" channel/i);
    // The P1-2 claim, in the note's own words: a miss is evidence about ONE list.
    expect(note).toMatch(/rules the pack out of "default" ONLY/);
    expect(note).toMatch(/says NOTHING about/i);
    // And the way out, spelled as an argument the caller can actually pass.
    expect(note).toMatch(/channel:"dev"/);
  });

  it("says WHY it does not retry the other channel for you", () => {
    // Without this the disclosure reads as laziness, and the next reviewer re-proposes
    // the retry. The hazard is specific and measured, so it is stated.
    const note = nodesInstallCommandArgs({ repository: REPORTED_URL }).note ?? "";
    expect(note).toMatch(/NOT retried for you on purpose/i);
    expect(note).toMatch(/BARE REPO ?NAME/i);
    // #1616 corrected the figure this sentence carries. "35 ... under DIFFERENT authors"
    // counted bare names case-SENSITIVELY and Manager's lookup does not — its
    // `NormalizedKeyDict.get` keys on `key.strip().lower()`. Counted the way the lookup
    // counts, 111 names resolve to different repositories depending on the channel.
    expect(note).toMatch(/111 bare names resolve to DIFFERENT repositories/i);
    expect(note).toMatch(/could install a repository you did not name/i);
  });

  it("discloses even when no OTHER note applies — an explicit version has none", () => {
    // `norm.note` rides only the "latest"→nightly rewrite. A caller passing an explicit
    // ref gets no such note, and would otherwise have a channel chosen for them in
    // silence — the exact thing this is meant to prevent.
    const out = nodesInstallCommandArgs({ repository: REPORTED_URL, version: "abc123" });
    expect(out.version).toBe("abc123");
    expect(out.note ?? "").toMatch(/asked ComfyUI-Manager's "default" channel/i);
  });

  it("keeps the #789 nightly-rewrite note as well, not instead", () => {
    const note = nodesInstallCommandArgs({ repository: REPORTED_URL }).note ?? "";
    expect(note).toMatch(/is a git repository URL, so this was queued as a from-source/i);
    expect(note).toMatch(/asked ComfyUI-Manager's "default" channel/i);
  });

  it("says NOTHING about the channel CHOICE when the caller made it themselves", () => {
    // Disclosing a choice the caller made is noise, and would misreport whose choice it
    // was. The nightly-rewrite note is still theirs to receive — and so is the
    // substitution warning below, which is about the route, not about the choice.
    const chosen = nodesInstallCommandArgs({ repository: REPORTED_URL, channel: "dev" });
    expect(chosen.note ?? "").not.toMatch(/asked ComfyUI-Manager's/i);
    expect(chosen.note ?? "").not.toMatch(/NOT retried for you on purpose/i);
    expect(chosen.note ?? "").toMatch(/from-source/i);
  });

  it("says nothing about the channel on a registry-id install", () => {
    // That route never had a channel chosen for it here.
    expect(nodesInstallCommandArgs({ id: "comfyui-kjnodes" }).note ?? "").not.toMatch(
      /asked ComfyUI-Manager's/i,
    );
  });
});

describe("the FIRST attempt's wrong-author risk is disclosed too (#1539 gate round 2)", () => {
  // The gate's P1: defaulting to `default` means a caller who passed the dev-channel
  // author's URL for one of the 35 colliding bare names gets the OTHER author's repo,
  // and the old note only framed that hazard as a reason not to RETRY. It is not a
  // regression — extension-node-map (what panel_search_nodes reads, and where the
  // reporter got their URL) carries the DEFAULT author for 33 of the 35 and the DEV
  // author for 0, so every colliding URL this tool can hand a caller was resolving to
  // the WRONG author under `dev` and resolves correctly now. But it is real, and a
  // caller cannot check it unless told, so the note names it.
  //
  // #1616 SPLIT THIS POPULATION IN TWO. For the 111 names measured to collide, a
  // defaulted-channel call is now REFUSED outright — see install-node-ambiguous-name.
  // What this note still covers, and what these tests now pin, is every name that
  // snapshot has NOT seen collide, plus the caller who names the very repository the
  // asked-for channel RESOLVES to. `default` resolves "ComfyUI_TiledKSampler" to
  // BlenderNeko's and that entry is reachable by the name, so it is allowed through and
  // still warned: there was nothing to pick between, which is not the same as a
  // guarantee about what lands.
  //
  // #1616 GATE ROUND 8 moved this example. It used to be hieuck/ComfyUI-BiRefNet, on the
  // basis that `default` carries it — but that repo is registered in the Comfy Registry
  // as id `viperyl_ComfyUI-BiRefNet`, so a lookup for the bare name misses it entirely
  // and the nightly fallback clones viperyl's instead. That call is REFUSED now, which
  // is why it can no longer stand in for the allowed-and-warned case.
  const COLLIDING = "https://github.com/BlenderNeko/ComfyUI_TiledKSampler";

  it("warns that the URL passed is not necessarily the URL cloned", () => {
    const note = nodesInstallCommandArgs({ repository: COLLIDING }).note ?? "";
    expect(note).toMatch(/NOT NECESSARILY THE URL YOU PASSED/i);
    expect(note).toMatch(/BARE REPO NAME \("ComfyUI_TiledKSampler"\)/);
    expect(note).toMatch(/still reports success/i);
  });

  it("names the OWNER the caller passed, so the check is concrete", () => {
    // A generic "verify what landed" is unactionable; the caller has to know which
    // author to compare against.
    const note = nodesInstallCommandArgs({ repository: COLLIDING }).note ?? "";
    expect(note).toMatch(/BlenderNeko\/ComfyUI_TiledKSampler you passed/);
    const other = nodesInstallCommandArgs({ repository: REPORTED_URL }).note ?? "";
    expect(other).toMatch(/Wenaka2004\/comfyui-anima-ipadapter you passed/);
    expect(other).not.toMatch(/BlenderNeko/);
  });

  it("rides an EXPLICIT channel too — the hazard is the route, not the choice", () => {
    // A caller who picked `dev` themselves faces the same bare-name substitution, so
    // scoping this to the defaulted case would leave them unwarned.
    const note = nodesInstallCommandArgs({ repository: REPORTED_URL, channel: "dev" }).note ?? "";
    expect(note).toMatch(/NOT NECESSARILY THE URL YOU PASSED/i);
    expect(note).toMatch(/against the "dev" channel's list/);
  });

  it("names the channel that will actually be consulted, not a hard-coded one", () => {
    const def = nodesInstallCommandArgs({ repository: REPORTED_URL }).note ?? "";
    expect(def).toMatch(/against the "default" channel's list/);
    const legacy = nodesInstallCommandArgs({ repository: REPORTED_URL, channel: "legacy" }).note ?? "";
    expect(legacy).toMatch(/against the "legacy" channel's list/);
    expect(legacy).not.toMatch(/against the "default" channel's list/);
  });

  it("stays off the registry-id route, which resolves by id as documented", () => {
    expect(nodesInstallCommandArgs({ id: "comfyui-kjnodes" }).note ?? "").not.toMatch(
      /NOT NECESSARILY THE URL YOU PASSED/i,
    );
  });

  it("THE NOTE DOES NOT CONTRADICT ITSELF — no 'absent from the whole registry' claim", () => {
    // Gate round 2, and the sharpest of its findings: the escape hatch rides the SAME
    // reply as the channel note, and said a not-found means the pack "is not in the
    // Manager's registry at all ... NO Manager route, by any spelling" — while the note
    // appended right after it said the miss rules out one channel and to retry another.
    // Two mutually exclusive conclusions in one message, and the first one sends a pack
    // that IS remotely installable (the reporter's own) down the local-only clone path.
    // The description test could not catch this: it reads the tool blurb, not the note.
    const note = nodesInstallCommandArgs({ repository: REPORTED_URL }).note ?? "";
    expect(note).not.toMatch(/not in the Manager's registry at all/i);
    expect(note).not.toMatch(/NO Manager route/i);
    expect(note).toMatch(/one LIST saying no, not the Manager's whole registry/i);
  });

  it("orders the recovery so the retry that CAN work comes before the local clone", () => {
    const note = nodesInstallCommandArgs({ repository: REPORTED_URL }).note ?? "";
    const retryAt = note.search(/try an explicit `channel` first/i);
    const cloneAt = note.search(/install_custom_node \(source:"git"\)/);
    expect(retryAt).toBeGreaterThanOrEqual(0);
    expect(cloneAt).toBeGreaterThan(retryAt);
    // And the local-only precondition survives the rewrite — install_custom_node writes
    // to the ORCHESTRATOR's filesystem, which need not be the panel's ComfyUI.
    expect(note).toMatch(/LOCAL ComfyUI/);
    expect(note).toMatch(/need not be the ComfyUI this panel drives/i);
  });

  it("does not append the v4-only warning to a legacy-shaped response", async () => {
    const cmd = await dispatchLegacyInstall({ repository: COLLIDING });
    expect(cmd.sent.channel).toBe("default");
    expect(cmd.text).not.toMatch(/NOT NECESSARILY THE URL YOU PASSED/i);
    expect(cmd.text).not.toMatch(/BlenderNeko\/ComfyUI_TiledKSampler you passed/);
  });
});

describe("panel_install_node preserves legacy direct-URL dispatch normalization (#1539)", () => {
  it("sends channel 'default' to the panel for the reporter's request", async () => {
    const { sent } = await dispatchLegacyInstall({ repository: REPORTED_URL });
    expect(sent.cmd).toBe("nodes_install");
    expect(sent.repository).toBe(REPORTED_URL);
    expect(sent.channel).toBe("default");
  });

  it("relays an explicit channel unchanged", async () => {
    const { sent } = await dispatchLegacyInstall({ repository: REPORTED_URL, channel: "dev" });
    expect(sent.channel).toBe("dev");
  });

  it("does not append the v4-only channel disclosure to a legacy-shaped response", async () => {
    const { sent, text } = await dispatchLegacyInstall({ repository: REPORTED_URL });
    expect(sent.channel).toBe("default");
    expect(text).not.toMatch(/asked ComfyUI-Manager's "default" channel/i);
    expect(text).not.toMatch(/rules the pack out of "default" ONLY/);
  });
});

describe("panel_install_node refuses Git URLs before Manager v4 queueing (#1539)", () => {
  const REPORTER_SEARCH_ID = "https://github.com/Slimy-Comfy/Slimy_ImageComparer";

  it("does not queue the reporter search id as a v4 registry lookup", async () => {
    const out = await dispatchInstall({ id: REPORTER_SEARCH_ID }, "v2");
    expect(out.isError).toBe(true);
    expect(out.sent).toBeUndefined();
    expect(out.text).toContain(v4GitUrlQueueRefusal(REPORTER_SEARCH_ID));
    expect(out.text).toMatch(/install_custom_node\(source:'git'\)/);
    expect(out.text).not.toMatch(/queued/i);
  });

  it("does not queue a repository URL on the v2 dialect either", async () => {
    const out = await dispatchInstall({ repository: REPORTED_URL }, "v2");
    expect(out.isError).toBe(true);
    expect(out.sent).toBeUndefined();
    expect(out.text).toMatch(/Refusing to queue/i);
  });

  it("still queues a registry id on v4", async () => {
    const out = await dispatchInstall({ id: "comfyui-kjnodes" }, "v2");
    expect(out.isError).not.toBe(true);
    expect(out.sent?.cmd).toBe("nodes_install");
    expect(out.sent?.id).toBe("comfyui-kjnodes");
    expect(out.sent?.repository).toBeUndefined();
  });

  it("still queues a git URL on legacy Manager 3.x", async () => {
    const out = await dispatchLegacyInstall({ id: REPORTER_SEARCH_ID });
    expect(out.sent.cmd).toBe("nodes_install");
    expect(out.sent.repository).toBe(REPORTER_SEARCH_ID);
  });
});

describe("panel_install_node advertises the supported contract (#1539)", () => {
  it("directs callers to registry ids and explains the v4 Git-URL refusal", () => {
    const text = installNodeDef().description ?? "";
    expect(text).toMatch(/Registry ids are supported/i);
    expect(text).toMatch(/id from panel_search_nodes/i);
    expect(text).toMatch(/panel runtime refuses Git URLs before Manager v4 queueing/i);
    expect(text).toMatch(/ignores the supplied repository/i);
    expect(text).toMatch(/resolves by bare name/i);
    expect(text).toMatch(/not a successful v4 from-source install/i);
    expect(text).toMatch(/install_custom_node\(source:'git'\)/i);
    expect(text).toMatch(/same ComfyUI/i);
    expect(text).toMatch(/ComfyUI host/i);
  });

  it("does not retain the old v4 from-source promise or channel retry advice", () => {
    const text = installNodeDef().description ?? "";
    expect(text).not.toMatch(/auto-routed to a from-source/i);
    expect(text).not.toMatch(/what gets cloned/i);
    expect(text).not.toMatch(/retry.*channel/i);
    expect(text).not.toMatch(/success can also be the wrong repo/i);
    expect(text).toMatch(/legacy Manager 3\.x direct-URL routing/i);
    expect(text).toMatch(/does not bypass the v4 Git-URL refusal/i);
  });

  it("repeats the same contract in the repository and channel schema", () => {
    const def = installNodeDef() as unknown as {
      schema?: Record<string, { description?: string; _def?: { description?: string } }>;
    };
    const descOf = (key: string): string => {
      const field = def.schema?.[key];
      return field?.description ?? field?._def?.description ?? "";
    };
    const repository = descOf("repository");
    const channel = descOf("channel");
    const version = descOf("version");
    const id = descOf("id");

    expect(id).toMatch(/Registry id returned by panel_search_nodes/i);
    expect(id).not.toMatch(/author\/repo/i);

    expect(repository).toMatch(/legacy Manager 3\.x direct-URL routing/i);
    expect(repository).toMatch(/panel runtime refuses arbitrary Git URLs before Manager v4 queueing/i);
    expect(repository).toMatch(/ignores the supplied repository/i);
    expect(repository).toMatch(/id from panel_search_nodes/i);
    expect(repository).toMatch(/install_custom_node\(source:'git'\)/i);
    expect(repository).toMatch(/same ComfyUI/i);
    expect(repository).toMatch(/ComfyUI host/i);

    expect(channel).toMatch(/supported registry-id install/i);
    expect(channel).toMatch(/does not bypass Manager v4.*refusal.*Git URLs/i);
    expect(channel).not.toMatch(/which node list/i);
    expect(version).not.toMatch(/nightly.*repository/i);
  });
});
