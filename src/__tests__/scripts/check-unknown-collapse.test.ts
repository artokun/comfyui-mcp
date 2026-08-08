// #796 — the gate for the "could not determine" -> "determined not" collapse.
//
// Twenty-seven instances of the class have been fixed across two months. The
// issue asks for a lint because the common ones share a greppable shape, and the
// hard part is not finding `.catch(() => null)` — it is finding only the ones
// where somebody READS the answer. `await close().catch(() => {})` is not this
// defect, and on this repo that shape is 40 of 99 raw matches. A gate that cries
// about those gets switched off within a week.
//
// So most of what follows is the NEGATIVE half: proof that the noisy shapes stay
// quiet. Those tests are the ones that keep the gate usable.

import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(process.cwd(), "scripts", "check-unknown-collapse.mjs");

let dir: string;
let src: string;
let baselineFile: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "unkcollapse-"));
  src = join(dir, "src");
  mkdirSync(src, { recursive: true });
  baselineFile = join(dir, "baseline.txt");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function write(name: string, body: string) {
  writeFileSync(join(src, name), body, "utf8");
}

/** Run the gate. Returns the exit code and the combined output — the gate's
 *  MESSAGE is part of its contract, since a developer who cannot tell why it
 *  fired will reach for the baseline instead of the fix. */
function run(...extra: string[]) {
  try {
    const out = execFileSync(
      process.execPath,
      [SCRIPT, "--src", src, "--baseline-file", baselineFile, ...extra],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, out };
  } catch (e) {
    const err = e as { status: number; stdout: string; stderr: string };
    return { code: err.status, out: (err.stdout ?? "") + (err.stderr ?? "") };
  }
}

function baseline() {
  run("--baseline");
  return readFileSync(baselineFile, "utf8");
}

describe("#796 what the gate FLAGS", () => {
  it("a caught failure answered with null, bound to a name", () => {
    write("a.ts", `export async function f() {\n  const pack = await list().catch(() => null);\n  return pack;\n}\n`);
    baseline();
    write(
      "a.ts",
      `export async function f() {\n  const pack = await list().catch(() => null);\n  const other = await list2().catch(() => null);\n  return pack;\n}\n`,
    );
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("1 new site");
    expect(r.out).toContain("a.ts:3");
  });

  it("`.catch(() => [])` — the instance the issue opens with", () => {
    write("b.ts", `export const go = async () => {\n  const rows = await q().catch(() => []);\n  return rows.length;\n};\n`);
    expect(run().code).toBe(1);
    expect(run().out).toContain("b.ts:2");
  });

  it("returned directly, without a binding", () => {
    write("c.ts", `export async function g() {\n  return await probe().catch(() => false);\n}\n`);
    expect(run().code).toBe(1);
  });

  it("a chain broken across lines — the form long chains actually take", () => {
    // The binding is three lines up and mid-line. Reading only the `.catch` line
    // sees indentation and would call this discarded, hiding the more involved
    // sites in favour of the simple ones.
    write(
      "d.ts",
      `export async function h() {\n  const restored = await fs\n    .rename(a, b)\n    .then(() => true)\n    .catch(() => false);\n  return restored;\n}\n`,
    );
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("d.ts:5");
  });

  it("appended to the closing paren of a WRAPPED argument list", () => {
    // Found by the gate missing a real site: when a call's arguments are wrapped,
    // the catch attaches to `)` on its own line, so the text before it is a bare
    // closer and the text after it is empty. Both of the earlier heuristics read
    // that as a discarded statement. The site it missed was the #1086 download
    // verification — the most safety-critical shape in the repo.
    write(
      "wrap.ts",
      `export async function w() {\n` +
        `  const seen = job.viaManager\n` +
        `    ? await verify(\n` +
        `        job.target_subfolder,\n` +
        `        job.filename,\n` +
        `      ).catch(() => undefined)\n` +
        `    : undefined;\n` +
        `  return seen;\n` +
        `}\n`,
    );
    const r = run();
    expect(r.code, r.out).toBe(1);
    expect(r.out).toContain("wrap.ts:6");
  });

  it("chained onward, where the empty value is immediately read", () => {
    write("e.ts", `export async function i() {\n  const n = (await t().catch(() => "")).length;\n  return n;\n}\n`);
    expect(run().code).toBe(1);
  });

  it("passed as an argument", () => {
    write("f.ts", `export async function j() {\n  return use(\n    await load().catch(() => null),\n  );\n}\n`);
    expect(run().code).toBe(1);
  });
});

describe("#796 what the gate must stay QUIET about", () => {
  it("fire-and-forget cleanup — 40 of 99 raw matches on this repo", () => {
    // Nothing reads the value. The catch is there so a failure on the way out
    // cannot mask the real error. Flagging these buries every real hit.
    write(
      "g.ts",
      `export async function k() {\n` +
        `  await client.close().catch(() => {});\n` +
        `  await rm(tmp, { force: true }).catch(() => undefined);\n` +
        `  void poll.catch(() => undefined);\n` +
        `  await reader.cancel().catch(() => undefined);\n` +
        `}\n`,
    );
    const r = run();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("0 known site");
  });

  it("a chain whose CALLBACK contains a `return`", () => {
    // A real false positive this gate produced. Walking back to the statement
    // start sweeps up the callback body, and a bare `return` inside it read as
    // the outer statement returning the value — turning a fire-and-forget
    // readiness probe into a reported defect. Consumption is judged from the line
    // the statement BEGINS on, not from everything swept up reaching it.
    write(
      "cb.ts",
      `export function p() {\n` +
        `  fetchIt(url)\n` +
        `    .then((r) => {\n` +
        `      if (!r.ok) return;\n` +
        `      push({ ready: true });\n` +
        `    })\n` +
        `    .catch(() => {});\n` +
        `}\n`,
    );
    const r = run();
    expect(r.code, r.out).toBe(0);
  });

  it("a catch that returns a REAL value, not an empty one", () => {
    // `catch(() => cachedFallback)` may be wrong for other reasons, but it is not
    // this defect: it does not assert a negative.
    write("h.ts", `export async function l() {\n  const v = await load().catch(() => LAST_GOOD);\n  return v;\n}\n`);
    expect(run().code).toBe(0);
  });

  it("a catch that rethrows or handles — the correct shape", () => {
    write(
      "i.ts",
      `export async function m() {\n  const v = await load().catch((e) => {\n    throw new Error("load failed: " + e.message);\n  });\n  return v;\n}\n`,
    );
    expect(run().code).toBe(0);
  });

  it("test files, which are full of deliberate empties", () => {
    mkdirSync(join(src, "__tests__"), { recursive: true });
    writeFileSync(
      join(src, "__tests__", "x.test.ts"),
      `const v = await load().catch(() => null);\n`,
      "utf8",
    );
    write("j.test.ts", `const v = await load().catch(() => null);\n`);
    expect(run().code).toBe(0);
  });
});

describe("#796 the waiver — a reason, or nothing", () => {
  // The marker belongs in the comment block DIRECTLY above the site. That is
  // worth pinning rather than leaving to chance: a waiver at the top of a file
  // must not silently cover a collapse five hundred lines below it.
  const site = (lead: string) =>
    `export async function n() {\n${lead}  const q = await poll().catch(() => null);\n  if (!q) { failed = true; return; }\n  return q;\n}\n`;

  it("a reasoned marker clears the site", () => {
    write(
      "k.ts",
      site(
        "  // unknown-ok: a failed poll is recorded as a failed poll, not as an\n" +
          "  // empty queue — the flag is carried into the returned result.\n",
      ),
    );
    const r = run();
    expect(r.code, r.out).toBe(0);
    expect(r.out).toContain("0 known site");
  });

  it("a BARE marker is rejected — the reason is the deliverable", () => {
    // A marker with nothing behind it only hides the question, which is worse
    // than the unmarked line: the next reader assumes somebody thought about it.
    write("l.ts", site("  // unknown-ok\n"));
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("bare 'unknown-ok'");
  });

  it("a marker with only a ticket number is not a reason", () => {
    write("m.ts", site("  // unknown-ok: #796\n"));
    expect(run().code).toBe(1);
  });

  it("a WRAPPED reason counts in full, however many lines it takes", () => {
    // A good reason is usually two or three lines. A fixed lookback window would
    // push authors to shorten the explanation to fit the linter, which defeats
    // the only thing the waiver exists to produce.
    write(
      "n.ts",
      site(
        "  // unknown-ok: the cache is advisory, so a failed read and a cold\n" +
          '  // cache should both mean "fetch it now" — the collapse is the\n' +
          "  // intended behaviour here and nothing downstream tells them apart.\n",
      ),
    );
    expect(run().code, run().out).toBe(0);
  });

  it("a marker above the ENCLOSING FUNCTION does not reach the site", () => {
    write(
      "o2.ts",
      "// unknown-ok: this reason is real but it is attached to the wrong thing,\n" +
        "// several lines and a function signature away from the collapse.\n" +
        site(""),
    );
    expect(run().code).toBe(1);
  });
});

describe("#796 the ratchet only pays down", () => {
  it("a baselined site does not fail the build", () => {
    write("o.ts", `export async function o() {\n  const v = await load().catch(() => null);\n  return v;\n}\n`);
    expect(baseline()).toContain("o.ts");
    expect(run().code).toBe(0);
  });

  it("FIXING a site fails until its baseline line is deleted", () => {
    // Otherwise the list stops describing the code, and re-introducing the very
    // same defect later would land pre-approved.
    write("p.ts", `export async function p() {\n  const v = await load().catch(() => null);\n  return v;\n}\n`);
    baseline();
    write("p.ts", `export async function p() {\n  const v = await loadOrThrow();\n  return v;\n}\n`);
    const r = run();
    expect(r.code).toBe(1);
    expect(r.out).toContain("no longer exist");
    expect(r.out).toContain("--baseline");
  });

  it("the key survives the site moving lines, so unrelated edits do not churn it", () => {
    write("q.ts", `export async function q() {\n  const v = await load().catch(() => null);\n  return v;\n}\n`);
    const before = baseline();
    write(
      "q.ts",
      `// a new comment\n// and another\nexport async function q() {\n  const extra = 1;\n  const v = await load().catch(() => null);\n  return v + extra;\n}\n`,
    );
    const r = run();
    expect(r.code, r.out).toBe(0);
    expect(before).toContain("q.ts");
  });

  it("two sites in one file with the SAME text are distinguished by ordinal", () => {
    write(
      "r.ts",
      `export async function r() {\n  const a = await load().catch(() => null);\n  const b = await load().catch(() => null);\n  return [a, b];\n}\n`,
    );
    const b = baseline();
    expect(b).toContain("#1");
    expect(b).toContain("#2");
    expect(run().code).toBe(0);
  });
});

describe("#796 the real repo", () => {
  it("the checked-in baseline matches the checked-in source", () => {
    // Run against the actual defaults rather than a fixture: this is what CI runs,
    // and it is the assertion that catches a baseline someone forgot to update.
    let code = 0;
    let out = "";
    try {
      out = execFileSync(process.execPath, [SCRIPT], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const err = e as { status: number; stdout: string; stderr: string };
      code = err.status;
      out = (err.stdout ?? "") + (err.stderr ?? "");
    }
    expect(code, out).toBe(0);
  });
});
