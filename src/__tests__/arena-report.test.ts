// Tests for the shared arena report builder (#792) — the VRAM/quant axes, the
// version-stamp comparability note, and the wrong-tool suspect analysis that
// separates "model chose wrong" from "our description made wrong look right".

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
// @ts-expect-error plain-JS module under scripts/, no type declarations
import { axisCell, buildArenaReport, mergeRunAxes, suspectScenarioLines, vramLabel } from "../../scripts/arena-report.mjs";

function entry(over: Record<string, unknown>) {
  return {
    model: "gemma4:e4b",
    tier: "local",
    total: 0,
    max: 4,
    mcpVersion: "0.49.6",
    results: [],
    ...over,
  };
}

function result(over: Record<string, unknown>) {
  return {
    scenario: "health",
    score: 0,
    verdict: "FAIL",
    rounds: 3,
    nudges: 0,
    seconds: 10,
    okTools: [],
    attemptedTools: [],
    ...over,
  };
}

const SCEN = [
  { id: "health", title: "Server health", primary: ["get_system_stats"], partial: [] },
  { id: "models", title: "Checkpoint discovery", primary: ["list_local_models"], partial: [] },
];

describe("arena-report (#792)", () => {
  it("vramLabel renders GiB with one decimal and refuses unknowns", () => {
    expect(vramLabel(8 * 1024 * 1024 * 1024)).toBe("8.0");
    expect(vramLabel(Math.round(3.46 * 1024 * 1024 * 1024))).toBe("3.5");
    expect(vramLabel(undefined)).toBeNull();
    expect(vramLabel(0)).toBeNull();
    expect(vramLabel(-5)).toBeNull();
  });

  it("renders the Params/Quant/VRAM columns when probed, an em-dash when not", () => {
    const withFacts = entry({
      model: "a:e4b",
      params: "7.5B",
      quant: "Q4_K_M",
      vramResidentBytes: 4 * 1024 * 1024 * 1024,
      results: [result({ score: 2, verdict: "PASS" })],
    });
    const without = entry({ model: "b:7b", results: [result({ score: 1, verdict: "PARTIAL" })] });
    const md = buildArenaReport({ gpu: "RTX 3070", mcpVersion: "0.49.6", scenarios: SCEN, leaderboard: [withFacts, without] });
    expect(md).toContain("| Params | Quant | VRAM |");
    expect(md).toContain("7.5B");
    expect(md).toContain("Q4_K_M");
    expect(md).toContain("4.0 GiB");
    // unknown axes are an honest dash, never a zero or a guess
    expect(md).toMatch(/\| `b:7b` \| local \| — \| — \| — \|/);
  });

  it("stamps a single-version leaderboard as same-version-comparable only", () => {
    const md = buildArenaReport({
      gpu: "g",
      mcpVersion: "0.49.6",
      scenarios: SCEN,
      leaderboard: [entry({ results: [result({})] })],
    });
    expect(md).toContain("comfyui-mcp v0.49.6");
    expect(md).toContain("only directly comparable within the same comfyui-mcp version");
    expect(md).not.toContain("do NOT compare");
  });

  it("warns against direct comparison when entries mix versions or predate stamping", () => {
    const md = buildArenaReport({
      gpu: "g",
      mcpVersion: "0.50.0",
      scenarios: SCEN,
      leaderboard: [
        entry({ model: "a", mcpVersion: "0.49.6", results: [result({})] }),
        entry({ model: "b", mcpVersion: "0.50.0", results: [result({})] }),
        entry({ model: "c", mcpVersion: undefined, results: [result({})] }),
      ],
    });
    expect(md).toContain("do NOT compare");
    expect(md).toContain("v0.49.6");
    expect(md).toContain("v0.50.0");
    expect(md).toContain("could not be read");
  });

  it("flags a scenario where 2+ failing models reached for the same non-primary tool — and only then", () => {
    const mkFail = (tool) => result({ score: 0, attemptedTools: [tool] });
    const data = {
      gpu: "g",
      scenarios: SCEN,
      leaderboard: [
        entry({ model: "a", results: [mkFail("panel_screenshot")] }),
        entry({ model: "b", results: [mkFail("panel_screenshot")] }),
        entry({ model: "c", results: [result({ score: 2, attemptedTools: ["get_system_stats"] })] }),
      ],
    };
    const lines = suspectScenarioLines(data);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("health");
    expect(lines[0]).toContain("panel_screenshot");
    expect(lines[0]).toContain("description suspect");

    // the same tool used by a PASSING run is not "wrong" for the scenario
    const withPasser = {
      ...data,
      leaderboard: [
        ...data.leaderboard.slice(0, 2),
        entry({ model: "c", results: [result({ score: 2, attemptedTools: ["get_system_stats", "panel_screenshot"] })] }),
      ],
    };
    expect(suspectScenarioLines(withPasser)).toHaveLength(0);

    // legacy entries record only okTools (successes) — a legacy fail that TRIED
    // the right tool reads as "never selected it" if okTools stand in for
    // attempts, so they must not count as selection failures at all
    const legacyOkToolsOnly = {
      ...data,
      leaderboard: [
        entry({ model: "a", results: [{ ...result({ score: 0 }), attemptedTools: undefined, okTools: ["panel_screenshot"] }] }),
        entry({ model: "b", results: [{ ...result({ score: 0 }), attemptedTools: undefined, okTools: ["panel_screenshot"] }] }),
      ],
    };
    expect(suspectScenarioLines(legacyOkToolsOnly)).toHaveLength(0);

    // "?" (an unparseable call_tool from an older run) is not a real selection
    const questionMarks = {
      ...data,
      leaderboard: [
        entry({ model: "a", results: [result({ score: 0, attemptedTools: ["?"] })] }),
        entry({ model: "b", results: [result({ score: 0, attemptedTools: ["?"] })] }),
      ],
    };
    expect(suspectScenarioLines(questionMarks)).toHaveLength(0);

    // a failure that DID reach the right tool lost on execution/verification,
    // not on selection — its other calls are not a description signal
    const reachedPrimary = {
      ...data,
      leaderboard: [
        entry({ model: "a", results: [result({ score: 0, attemptedTools: ["get_system_stats", "panel_screenshot"] })] }),
        entry({ model: "b", results: [result({ score: 0, attemptedTools: ["get_system_stats", "panel_screenshot"] })] }),
      ],
    };
    expect(suspectScenarioLines(reachedPrimary)).toHaveLength(0);

    // ...but a PARTIAL run using it vindicates nothing — the flag stands
    const withPartial = {
      ...data,
      leaderboard: [
        ...data.leaderboard.slice(0, 2),
        entry({ model: "c", results: [result({ score: 1, attemptedTools: ["get_system_stats", "panel_screenshot"] })] }),
      ],
    };
    expect(suspectScenarioLines(withPartial)).toHaveLength(1);

    // a best-of range that MIXED a stamped and an unstamped run keeps
    // mcpVersions but drops mcpVersion — it is NOT safely one version
    const mixedRange = {
      ...data,
      leaderboard: [
        entry({ model: "a", mcpVersion: undefined, mcpVersions: ["0.49.6"], results: [mkFail("panel_screenshot")] }),
        entry({ model: "b", mcpVersion: undefined, mcpVersions: ["0.49.6"], results: [mkFail("panel_screenshot")] }),
      ],
    };
    expect(suspectScenarioLines(mixedRange)).toHaveLength(0);

    // two models on DIFFERENT comfyui-mcp versions are not one field —
    // tool descriptions may differ between versions
    const crossVersion = {
      ...data,
      leaderboard: [
        entry({ model: "a", mcpVersion: "0.49.6", results: [mkFail("panel_screenshot")] }),
        entry({ model: "b", mcpVersion: "0.50.0", results: [mkFail("panel_screenshot")] }),
      ],
    };
    expect(suspectScenarioLines(crossVersion)).toHaveLength(0);

    // an unversioned entry is excluded from the signal entirely
    const oneUnversioned = {
      ...data,
      leaderboard: [
        entry({ model: "a", results: [mkFail("panel_screenshot")] }),
        entry({ model: "b", mcpVersion: undefined, results: [mkFail("panel_screenshot")] }),
      ],
    };
    expect(suspectScenarioLines(oneUnversioned)).toHaveLength(0);

    // two entries for the SAME model are one model, not a field-wide signal
    const dupModel = {
      ...data,
      leaderboard: [
        entry({ model: "a", results: [mkFail("panel_screenshot")] }),
        entry({ model: "a", results: [mkFail("panel_screenshot")] }),
      ],
    };
    expect(suspectScenarioLines(dupModel)).toHaveLength(0);

    // a single failing model is not a field-wide signal
    expect(
      suspectScenarioLines({ ...data, leaderboard: data.leaderboard.slice(0, 1) }),
    ).toHaveLength(0);

    // failing models reaching for DIFFERENT tools is model behaviour, not a description bug
    const divergent = {
      ...data,
      leaderboard: [
        entry({ model: "a", results: [mkFail("panel_screenshot")] }),
        entry({ model: "b", results: [mkFail("get_image")] }),
      ],
    };
    expect(suspectScenarioLines(divergent)).toHaveLength(0);
  });

  it("a legacy results file without primary/partial lists is UNKNOWN — never a false suspect", () => {
    const mkFail = (tool) => result({ score: 0, attemptedTools: [tool] });
    const legacy = {
      gpu: "g",
      // pre-#792 shape: id/title/task only, no primary — even the CORRECT tool
      // shared by two failing runs must not read as a wrong-tool suspect.
      scenarios: SCEN.map(({ id, title }) => ({ id, title })),
      leaderboard: [
        entry({ model: "a", results: [mkFail("get_system_stats")] }),
        entry({ model: "b", results: [mkFail("get_system_stats")] }),
      ],
    };
    expect(suspectScenarioLines(legacy)).toHaveLength(0);
  });

  it("the suspect section lands in the rendered report", () => {
    const mkFail = (tool) => result({ score: 0, attemptedTools: [tool] });
    const md = buildArenaReport({
      gpu: "g",
      scenarios: SCEN,
      leaderboard: [
        entry({ model: "a", results: [mkFail("panel_screenshot")] }),
        entry({ model: "b", results: [mkFail("panel_screenshot")] }),
      ],
    });
    expect(md).toContain("Suspect scenarios");
    expect(md).toContain("panel_screenshot");
  });
});

describe("arena-bestof cross-version merge guard (#792)", () => {
  const BESTOF = join(__dirname, "..", "..", "scripts", "arena-bestof.mjs");

  function fixture(baseEntry: Record<string, unknown>, extraEntry: Record<string, unknown>) {
    const root = mkdtempSync(join(tmpdir(), "arena-bestof-"));
    const base = join(root, "base");
    const extra = join(root, "extra");
    mkdirSync(base, { recursive: true });
    mkdirSync(extra, { recursive: true });
    const scen = [{ id: "health", title: "Server health", task: "t", primary: ["get_system_stats"], partial: [] }];
    writeFileSync(join(base, "arena-results.json"), JSON.stringify({ gpu: "g", scenarios: scen, leaderboard: [baseEntry] }));
    writeFileSync(join(extra, "arena-results.json"), JSON.stringify({ gpu: "g", scenarios: scen, leaderboard: [extraEntry] }));
    return { base, extra };
  }

  function run(base: string, extra: string) {
    const r = spawnSync(process.execPath, [BESTOF, base, extra], { encoding: "utf8" });
    return {
      out: `${r.stdout ?? ""}\n${r.stderr ?? ""}`,
      merged: JSON.parse(readFileSync(join(base, "arena-results.json"), "utf8")),
    };
  }

  const mkEntry = (version: string | undefined, total: number) => ({
    model: "m:e4b",
    tier: "local",
    total,
    max: 20,
    ...(version ? { mcpVersion: version } : {}),
    results: [result({ score: total > 10 ? 2 : 0 })],
  });

  it("refuses to best-of-merge runs from different comfyui-mcp versions — loudly", () => {
    const { base, extra } = fixture(mkEntry("0.49.6", 20), mkEntry("0.50.0", 19));
    const { out, merged } = run(base, extra);
    expect(out).toContain("not directly comparable");
    expect(merged.leaderboard[0].runs).toBeUndefined(); // NOT merged
    expect(merged.leaderboard[0].total).toBe(20);
  });

  it("merges same-version runs and keeps the version", () => {
    const { base, extra } = fixture(mkEntry("0.49.6", 20), mkEntry("0.49.6", 19));
    const { merged } = run(base, extra);
    expect(merged.leaderboard[0].runs.totals).toEqual([20, 19]);
    expect(merged.leaderboard[0].mcpVersion).toBe("0.49.6");
  });

  it("a merge with an unversioned run drops the version claim — the range mixes a stamped and an unstamped run", () => {
    const { base, extra } = fixture(mkEntry("0.49.6", 20), mkEntry(undefined, 19));
    const { merged } = run(base, extra);
    expect(merged.leaderboard[0].runs.totals).toEqual([20, 19]);
    expect("mcpVersion" in merged.leaderboard[0]).toBe(false);
  });

  it("a candidate that is itself an unversioned merged range is checked by its mcpVersions, both directions", () => {
    // base is v0.50.0; the candidate carries no mcpVersion but remembers v0.49.6
    const candidate = { ...mkEntry(undefined, 19), mcpVersions: ["0.49.6"] };
    const { base, extra } = fixture(mkEntry("0.50.0", 20), candidate);
    const { out, merged } = run(base, extra);
    expect(out).toContain("not directly comparable");
    expect(merged.leaderboard[0].runs).toBeUndefined();
  });

  it("refuses to merge two different QUANTIZATIONS of one tag — those are different models", () => {
    // `ollama pull` replaces the weights under the same name, so a q4 run and a
    // q8 run are not two samples of one model.
    const { base, extra } = fixture(
      { ...mkEntry("0.49.6", 20), quant: "Q4_K_M" },
      { ...mkEntry("0.49.6", 19), quant: "Q8_0" },
    );
    const { out, merged } = run(base, extra);
    expect(out).toContain("different models under one tag");
    expect(merged.leaderboard[0].runs).toBeUndefined(); // NOT merged
    expect(merged.leaderboard[0].quant).toBe("Q4_K_M");
  });

  it("a merge whose runs did not all record an axis reports it as mixed, not as the winner's value", () => {
    const { base, extra } = fixture(
      { ...mkEntry("0.49.6", 20), quant: "Q4_K_M", vramResidentBytes: 5 * 1024 * 1024 * 1024 },
      mkEntry("0.49.6", 19), // an older run with no axes recorded at all
    );
    const { merged } = run(base, extra);
    expect(merged.leaderboard[0].runs.totals).toEqual([20, 19]);
    // The winning run was q4 — but the RANGE was not, so the cell must not say q4.
    expect(merged.leaderboard[0].quant).toBeUndefined();
    expect(merged.leaderboard[0].mixedAxes).toEqual(expect.arrayContaining(["quant", "vram"]));
    expect(readFileSync(join(base, "arena-report.md"), "utf8")).toContain("mixed");
  });

  it("an unversioned intermediate merge does not launder a later cross-version run into the range", () => {
    const { base, extra } = fixture(mkEntry("0.49.6", 20), mkEntry(undefined, 19));
    run(base, extra); // merges; entry is now unversioned but remembers v0.49.6
    const root = dirname(base);
    const extra2 = join(root, "extra2");
    mkdirSync(extra2, { recursive: true });
    writeFileSync(
      join(extra2, "arena-results.json"),
      JSON.stringify({
        gpu: "g",
        scenarios: [{ id: "health", title: "Server health", task: "t", primary: ["get_system_stats"], partial: [] }],
        leaderboard: [mkEntry("0.50.0", 18)],
      }),
    );
    const { out, merged } = run(base, extra2);
    expect(out).toContain("not directly comparable"); // refused — v0.50.0 vs the v0.49.6 already in the range
    expect(merged.leaderboard[0].runs.totals).toEqual([20, 19]); // unchanged
  });
});

describe("a best-of range must not display ONE condition it did not all run under (#792)", () => {
  const GIB = 1024 * 1024 * 1024;

  it("keeps an axis only when both runs recorded the SAME value", () => {
    const merged = mergeRunAxes(
      { params: "8.0B", quant: "Q4_K_M", vramResidentBytes: 5 * GIB },
      { params: "8.0B", quant: "Q4_K_M", vramResidentBytes: 5 * GIB },
    );
    expect(merged.params).toBe("8.0B");
    expect(merged.quant).toBe("Q4_K_M");
    expect(merged.mixedAxes).toBeUndefined();
  });

  it("marks an axis MIXED when only one run recorded it — not `—`, which means never recorded", () => {
    const merged = mergeRunAxes({ quant: "Q4_K_M" }, {});
    expect(merged.quant).toBeUndefined();
    expect(merged.mixedAxes).toContain("quant");
    expect(axisCell(merged, "quant")).toBe("mixed");
    // …and an axis nobody recorded stays the honest "not recorded" dash.
    expect(axisCell({}, "quant")).toBe("—");
  });

  it("turns two measured VRAM figures into a RANGE rather than the winner's number", () => {
    const merged = mergeRunAxes({ vramResidentBytes: 5 * GIB }, { vramResidentBytes: 6 * GIB });
    expect(axisCell(merged, "vram")).toBe("5.0–6.0 GiB");
    // and a third run widens it rather than folding to the last pair
    const wider = mergeRunAxes(merged, { vramResidentBytes: 7 * GIB });
    expect(axisCell(wider, "vram")).toBe("5.0–7.0 GiB");
  });

  it("VRAM measured by only ONE of the runs is mixed, never presented as the range's figure", () => {
    const merged = mergeRunAxes({ vramResidentBytes: 5 * GIB }, {});
    expect(axisCell(merged, "vram")).toBe("mixed");
  });

  it("`mixed` is sticky: a later matching run does not un-mix the range", () => {
    const first = mergeRunAxes({ quant: "Q4_K_M" }, {});
    const second = mergeRunAxes(first, { quant: "Q4_K_M" });
    expect(second.mixedAxes).toContain("quant");
    expect(axisCell(second, "quant")).toBe("mixed");
  });

  it("the report renders the merged cells and explains what `mixed` means", () => {
    const md = buildArenaReport({
      gpu: "4090",
      scenarios: SCEN,
      leaderboard: [
        entry({
          model: "m:e4b",
          runs: { totals: [20, 19] },
          quant: undefined,
          mixedAxes: ["quant"],
          vramResidentBytesRange: [5 * GIB, 6 * GIB],
          vramResidentBytes: 6 * GIB,
        }),
      ],
    });
    expect(md).toContain("| mixed |"); // the quant cell
    expect(md).toContain("5.0–6.0 GiB");
    expect(md).toContain("not tied");
  });
});
