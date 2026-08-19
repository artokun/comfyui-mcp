// Shared LLM Arena report builder (#792) — used by BOTH scripts/llm-arena.mjs
// (fresh runs) and scripts/arena-bestof.mjs (best-of-N merge + regeneration),
// so the markdown shape can never drift between the two writers again.
//
// The report carries the three #792 axes:
//   1. VRAM — resident size of the model during its run (Ollama /api/ps), so a
//      reader on an 8 GB card can see which entries they can even load.
//   2. Quantization — the tag's quantization_level (/api/show), so the same
//      model at q4/q8/fp16 can be compared against the same ladder.
//   3. Version stamping — every run records the comfyui-mcp version, and the
//      report refuses to let pre/post-consolidation numbers be compared
//      directly (absolute scores move when the tool surface changes).
// Plus the methodology guard: a scenario where EVERY model failed after
// reaching for the same wrong tool reads as OUR description bug, not a
// field-wide capability gap (#557/#654 precedent) — flagged, never asserted.
//
// Ask 3 is the published community baseline: buildCommunityBaseline renders a
// consultable table (grouped by card capacity when VRAM was recorded) from
// benchmarks/arena-baseline.json, which docs/arena.mdx embeds verbatim.

/** Resident VRAM as "GiB" with one decimal, or null when unknown. */
export function vramLabel(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

/**
 * The condition axes (#792) for an entry that MERGED two runs.
 *
 * A best-of-N entry shows one score RANGE, and next to it one Params / Quant /
 * VRAM cell. Keeping the winning run's axes there states that the whole range
 * was recorded under that one condition — which is exactly what a re-pull from
 * q4 to q8 breaks: the same tag, two different models, one displayed quant, and
 * a reader comparing the ladder against a condition half those runs never had.
 *
 * So an axis survives the merge only when BOTH runs recorded the SAME value.
 * Where they differ, or where one run recorded nothing at all, the axis is
 * MIXED — reported as such rather than dropped, because "—" already means "not
 * recorded" and collapsing "spans two conditions" into "unknown" would hide the
 * thing the reader has to know. VRAM is the one exception worth a real number:
 * it is a measurement of the same condition rather than a condition itself, so
 * two known values become a RANGE.
 *
 * Callers that would rather not merge at all still have that option — the
 * quantization guard in arena-bestof.mjs refuses outright when the two runs are
 * demonstrably different quantizations, and this only ever sees what it lets by.
 */
export function mergeRunAxes(a, b) {
  const mixedAxes = [];
  const same = (x, y) => x !== undefined && x !== null && x === y;
  const out = {};
  for (const axis of ["params", "quant"]) {
    if (same(a[axis], b[axis])) out[axis] = a[axis];
    else if (a[axis] !== undefined || b[axis] !== undefined) mixedAxes.push(axis);
  }
  // An already-merged side carries a RANGE; folding only its top would quietly
  // shrink the span each time another run joins.
  const vramsOf = (m) =>
    (Array.isArray(m.vramResidentBytesRange) ? m.vramResidentBytesRange : [m.vramResidentBytes]).filter(
      (v) => typeof v === "number" && Number.isFinite(v) && v > 0,
    );
  const sideA = vramsOf(a);
  const sideB = vramsOf(b);
  const vrams = [...sideA, ...sideB];
  if (sideA.length && sideB.length) {
    out.vramResidentBytes = Math.max(...vrams);
    if (Math.min(...vrams) !== Math.max(...vrams)) out.vramResidentBytesRange = [Math.min(...vrams), Math.max(...vrams)];
  } else if (vrams.length) {
    // One run measured it and the other did not: the range is not a measured
    // range, so the entry must not present the one number as covering both.
    mixedAxes.push("vram");
  }
  // `mixed` is STICKY. A third run that happens to match the surviving value
  // does not un-mix a range that already spans two conditions — once an axis is
  // unknown for some run in the range, it stays unknown for the range.
  for (const axis of ["params", "quant", "vram"]) {
    if (mixedAxes.includes(axis)) continue;
    if (a.mixedAxes?.includes(axis) || b.mixedAxes?.includes(axis)) {
      mixedAxes.push(axis);
      delete out[axis];
      if (axis === "vram") {
        delete out.vramResidentBytes;
        delete out.vramResidentBytesRange;
      }
    }
  }
  if (mixedAxes.length) out.mixedAxes = mixedAxes;
  return out;
}

/** Cell text for an axis on a (possibly merged) entry: a value, `mixed` when
 *  the entry's runs disagree, or `—` when nothing recorded it. */
export function axisCell(entry, axis) {
  if (entry.mixedAxes?.includes(axis)) return "mixed";
  if (axis === "vram") {
    const range = entry.vramResidentBytesRange;
    if (Array.isArray(range) && range.length === 2) {
      const lo = vramLabel(range[0]);
      const hi = vramLabel(range[1]);
      // Two measurements that round to the same tenth print as that one figure,
      // deliberately: "5.0–5.0 GiB" is noise, and "5.0 GiB" is true of both at
      // the precision the column is stated in. The raw pair stays in the JSON.
      if (lo && hi) return lo === hi ? `${hi} GiB` : `${lo}–${hi} GiB`;
    }
    const one = vramLabel(entry.vramResidentBytes);
    return one ? `${one} GiB` : "—";
  }
  return entry[axis] ?? "—";
}

const GIB = 1024 * 1024 * 1024;

/**
 * Whether an entry's measured resident VRAM fits a card of `capGiB`.
 * `true` / `false` only when VRAM was recorded as one condition; `null` when
 * it was never recorded or the best-of range mixed two different footprints
 * — unknown is not a fit.
 */
export function fitsVramCap(entry, capGiB) {
  if (!entry || entry.mixedAxes?.includes("vram")) return null;
  const bytes = entry.vramResidentBytes;
  if (typeof bytes !== "number" || !Number.isFinite(bytes) || bytes <= 0) return null;
  if (typeof capGiB !== "number" || !Number.isFinite(capGiB) || capGiB <= 0) return null;
  return bytes <= capGiB * GIB;
}

/**
 * Partition a leaderboard by card capacity. Order inside each group is the
 * input order (already ranked). Unknown VRAM is its own group so an 8 GB
 * reader never has an unmeasured row presented as a fit.
 */
export function communityBaselineGroups(leaderboard, capGiB) {
  const fits = [];
  const over = [];
  const unknown = [];
  for (const m of leaderboard ?? []) {
    const fit = fitsVramCap(m, capGiB);
    if (fit === true) fits.push(m);
    else if (fit === false) over.push(m);
    else unknown.push(m);
  }
  return { fits, over, unknown };
}

/** Second-line hint for the leaderboard graphic: params/quant/VRAM when known. */
export function graphicAxisHint(entry) {
  const bits = [];
  for (const axis of ["params", "quant", "vram"]) {
    const cell = axisCell(entry, axis);
    if (cell !== "—") bits.push(cell);
  }
  return bits.join(" · ");
}

function scoreCell(m) {
  const totals = m.runs?.totals;
  if (Array.isArray(totals) && totals.length > 1) {
    return `${m.total}/${m.max} (best of ${totals.length}: ${Math.min(...totals)}–${Math.max(...totals)})`;
  }
  return `${m.total}/${m.max}`;
}

function baselineRows(entries) {
  return entries.map(
    (m) =>
      `| \`${m.model}\` | ${m.tier ?? "local"} | ${axisCell(m, "params")} | ${axisCell(m, "quant")} | ${axisCell(m, "vram")} | ${scoreCell(m)} |`,
  );
}

function versionCaveat(board) {
  const versions = [...new Set(board.map((m) => m.mcpVersion).filter(Boolean))];
  const unversioned = board.some((m) => !m.mcpVersion);
  if (versions.length === 1 && !unversioned) {
    return `Recorded with comfyui-mcp v${versions[0]} — scores are only directly comparable within the same comfyui-mcp version.`;
  }
  if (!versions.length) {
    return "These runs were recorded before version stamping (or could not read their package version). Absolute scores move when the tool surface changes — do not compare them to a current-surface run as if they were one ladder.";
  }
  return `⚠️ This baseline mixes recordings (versions ${versions.map((v) => `v${v}`).join(", ")}${unversioned ? " and unversioned runs — recorded before version stamping, or whose own version could not be read" : ""}) — do NOT compare scores across them directly.`;
}

/**
 * Compact community baseline (#792 ask 3): a table someone can consult
 * without running the arena. Groups by card capacity when VRAM was recorded
 * (default 8 GB — the reporter's question) and leaves unmeasured rows in
 * their own group rather than guessing them into a fit.
 */
export function buildCommunityBaseline(data, opts = {}) {
  const capGiB = opts.capGiB ?? 8;
  const board = data.leaderboard ?? [];
  const { fits, over, unknown } = communityBaselineGroups(board, capGiB);
  const header = "| Model | Tier | Params | Quant | VRAM | Score |";
  const sep = "| --- | --- | --- | --- | --- | --- |";
  const md = [];
  md.push(
    "Consultable without running the ladder. Resident VRAM is the model's footprint while it is loaded (Ollama `/api/ps`), not remaining headroom — ComfyUI shares the same card. Params/Quant come from `/api/show`. Hosted endpoints have no equivalent; those cells stay `—`, never guessed.",
    "",
  );
  md.push(versionCaveat(board), "");
  if (data.gpu) md.push(`Hardware: ${data.gpu}.`, "");
  if (data.source) md.push(data.source, "");
  const section = (title, rows) => {
    if (!rows.length) return;
    md.push(`**${title}**`, "", header, sep, ...baselineRows(rows), "");
  };
  section(`Fits ${capGiB} GB (resident VRAM ${capGiB} GiB or under)`, fits);
  section(`Needs more than ${capGiB} GB`, over);
  section("VRAM not recorded — hosted models, or runs from before the VRAM axis", unknown);
  return `${md.join("\n")}\n`;
}

const nudgesOf = (m) => m.results.reduce((s, r) => s + (r.nudges ?? 0), 0);
const roundsOf = (m) => m.results.reduce((s, r) => s + (r.rounds ?? 0), 0);
const secondsOf = (m) => m.results.reduce((s, r) => s + (r.seconds ?? 0), 0);

/**
 * The wrong-tool-dispatch signal (#792 methodology caveat): for each scenario,
 * look at the models that FAILED it and which non-primary tool they reached
 * for. One tool attempted by 2+ failing models (and by no passing one) is a
 * systematic wrong selection — that pattern is a tool-DESCRIPTION suspect, not
 * evidence about the field. Returns one line per suspect scenario.
 */
export function suspectScenarioLines(data) {
  const lines = [];
  const scen = data.scenarios ?? [];
  const board = data.leaderboard ?? [];
  // Tool descriptions move with the version, so the field-wide signal is only
  // meaningful WITHIN one known version: pool the majority cohort, exclude
  // unversioned entries (their version is unknown, not "the same") and any
  // minority-version ones. An all-legacy board yields no suspects at all.
  // Only a direct mcpVersion stamp counts: a best-of range that MIXED a
  // stamped and an unstamped run keeps mcpVersions but drops mcpVersion, and
  // that range is not safely one version.
  const versionOf = (m) => m.mcpVersion;
  const cohorts = new Map();
  for (const m of board) {
    const v = versionOf(m);
    if (v) cohorts.set(v, (cohorts.get(v) ?? 0) + 1);
  }
  const majority = [...cohorts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  if (majority === undefined) return lines;
  for (const s of scen) {
    // A legacy (pre-#792) results file carries no primary/partial lists — with
    // no notion of the RIGHT tool, any shared selection could be flagged
    // falsely. Unknown → no claim; skip the scenario entirely.
    if (!Array.isArray(s.primary)) continue;
    const rightTools = new Set([...(s.primary ?? []), ...(s.partial ?? [])]);
    const failed = [];
    const passed = [];
    for (const m of board) {
      if (versionOf(m) !== majority) continue;
      const r = (m.results ?? []).find((x) => x.scenario === s.id);
      if (!r) continue;
      // Only a SELECTION failure counts: a run that reached a primary/partial
      // tool and still failed lost on execution or verification, not on tool
      // choice — its other tool calls prove nothing about descriptions. And
      // only runs that RECORD attempts qualify: legacy results carry okTools
      // (successes only), so a legacy fail that tried the right tool and
      // watched it error looks identical to one that never selected it —
      // reading okTools as attempts would flag that as a wrong selection.
      if (
        r.score === 0 &&
        Array.isArray(r.attemptedTools) &&
        !r.attemptedTools.some((t) => rightTools.has(t))
      ) {
        failed.push({ model: m.model, r });
      }
      // Only a full PASS vindicates a tool: a PARTIAL is right-family but
      // incomplete — its tool use proves nothing about the selection being
      // right, so it must not suppress a suspect flag. (okTools suffices here:
      // a tool in a passing run's successes genuinely ran.)
      if (r.score === 2) passed.push(r);
    }
    // The signal is FIELD-WIDE: it needs 2+ DISTINCT failing models. Duplicate
    // entries for one model (a repeated ARENA_MODELS entry, an un-merged extra
    // run) are one model, not a field.
    const failedModels = new Set(failed.map((f) => f.model));
    if (failedModels.size < 2) continue;
    // Count, per non-primary tool, how many DISTINCT failing models reached it.
    const byTool = new Map();
    for (const f of failed) {
      for (const t of new Set(f.r.attemptedTools)) {
        // "?" is how older runs recorded an unparseable call_tool — not a real
        // selection, never a suspect.
        if (t === "?" || rightTools.has(t)) continue;
        if (!byTool.has(t)) byTool.set(t, new Set());
        byTool.get(t).add(f.model);
      }
    }
    for (const [tool, models] of byTool) {
      if (models.size < 2) continue;
      // A tool a PASSING run also used is not "wrong" for this scenario.
      const usedByPasser = passed.some((r) =>
        (r.attemptedTools ?? r.okTools ?? []).includes(tool),
      );
      if (usedByPasser) continue;
      lines.push(
        `- **${s.id}**: ${models.size} of ${failedModels.size} failing models reached for \`${tool}\` (none of the passing runs did). A field-wide wrong selection reads as a tool-description suspect, not a capability gap — check that tool's description before trusting this scenario's scores.`,
      );
    }
  }
  return lines;
}

/** Render the share-ready arena markdown report from a results JSON object. */
export function buildArenaReport(data) {
  const icon = { 2: "✅", 1: "🟡", 0: "❌" };
  const scen = data.scenarios ?? [];
  const board = data.leaderboard ?? [];
  const md = [];
  md.push("# ComfyUI LLM Arena", "");
  md.push(
    `Models driving a real ComfyUI (${data.gpu ?? "unknown GPU"}) through [comfyui-mcp](https://github.com/artokun/comfyui-mcp)'s ` +
      `compact tool mode — 3 meta-tools instead of ~200 schemas, so every model class can play. ` +
      `Each model gets the identical task set; results are verified against the ComfyUI server, not the model's claims.`,
    "",
  );
  const header = ["Model", "Tier", "Params", "Quant", "VRAM", ...scen.map((s) => s.id), "Score", "Nudges", "Rounds", "Time"];
  md.push(`| ${header.join(" | ")} |`, `|${header.map(() => "---").join("|")}|`);
  for (const m of board) {
    const cells = m.results.map((r) => icon[r.score]);
    const totals = m.runs?.totals;
    const score =
      totals && totals.length > 1
        ? `**${m.total}/${m.max}** (best of ${totals.length}: ${Math.min(...totals)}–${Math.max(...totals)})`
        : `**${m.total}/${m.max}**`;
    md.push(
      `| \`${m.model}\` | ${m.tier ?? "local"} | ${axisCell(m, "params")} | ${axisCell(m, "quant")} | ${axisCell(m, "vram")} | ${cells.join(" | ")} | ${score} | ${nudgesOf(m)} | ${roundsOf(m)} | ${secondsOf(m)}s |`,
    );
  }
  md.push("", `Scenarios: ${scen.map((s) => `**${s.id}** (${s.title.toLowerCase()})`).join(" · ")}`, "");
  md.push(`✅ completed & server-verified · 🟡 right tool family, incomplete outcome · ❌ failed`, "");
  if (board.some((m) => m.mixedAxes?.length)) {
    md.push(
      `\`mixed\` in Params/Quant/VRAM: that row is a best-of range whose runs did not all record the same value for ` +
        `that axis (a re-pulled tag, or a run from before the axis was recorded) — the score range there is not tied ` +
        `to one condition. \`—\` means the axis was never recorded at all.`,
      "",
    );
  }

  // Version comparability (#792 sequencing note): absolute scores move when the
  // tool surface changes, so the report must never invite a cross-version read.
  const versions = [...new Set(board.map((m) => m.mcpVersion).filter(Boolean))];
  const unversioned = board.some((m) => !m.mcpVersion);
  if (versions.length === 1 && !unversioned) {
    md.push(`Recorded with comfyui-mcp v${versions[0]} — scores are only directly comparable within the same comfyui-mcp version.`, "");
  } else if (versions.length || unversioned) {
    md.push(
      `⚠️ This leaderboard mixes recordings (${versions.length ? `versions ${versions.map((v) => `v${v}`).join(", ")}` : ""}${versions.length && unversioned ? " and " : ""}${unversioned ? "unversioned runs — recorded before version stamping, or whose own version could not be read" : ""}) — do NOT compare scores across them directly.`,
      "",
    );
  }

  const suspects = suspectScenarioLines(data);
  if (suspects.length) {
    md.push("### Suspect scenarios (systematic wrong-tool selection)", "");
    md.push(...suspects, "");
  }

  md.push("Reproduce: `npm run arena` — bring your own models via `ARENA_MODELS=...` (see docs/arena)");
  return `${md.join("\n")}\n`;
}
