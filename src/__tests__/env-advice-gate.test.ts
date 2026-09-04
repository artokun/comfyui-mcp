// The gate behind #2849: no orchestrator message may tell the user to set an env
// var the orchestrator deletes from its own process.env.
//
// The fixtures below are not hypothetical. Two earlier versions of this scanner
// each returned a WRONG answer on the real tree, and each fixture pins the exact
// construct that fooled one of them:
//
//   1. A quote-delimiter regex (`[^"'`]{40,}`) cannot cross a quote character, so
//      a literal containing an escaped backtick or a nested double quote is split
//      into fragments too short to match. That silently missed two real sites.
//   2. Skipping `${…}` by counting braces desyncs on a brace inside a nested
//      string, and every literal after that point in the file is read in the
//      wrong mode. That silently lost a real site 4000 lines further down.
//
// Both bugs were SILENT — a smaller finding count that still looked like a clean
// pass. So these assert exact extraction, not "at least one".
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// @ts-expect-error plain-JS module under scripts/, no type declarations
import { stringLiterals } from "../../scripts/lib/ts-string-literals.mjs";

const BT = String.fromCharCode(96);
const BS = String.fromCharCode(92);
const DQ = String.fromCharCode(34);
const SQ = String.fromCharCode(39);
const NL = String.fromCharCode(10);

describe("stringLiterals", () => {
  it("keeps a literal whole across an ESCAPED backtick", () => {
    // Shape of cli-remedy.ts: prose that quotes a shell command.
    const src = `const m = ${BT}run ${BS}${BT}claude setup-token${BS}${BT}, or set THE_KEY, then retry${BT};`;
    const lits = stringLiterals(src).map((l: { text: string }) => l.text);
    expect(lits).toHaveLength(1);
    expect(lits[0]).toBe("run `claude setup-token`, or set THE_KEY, then retry");
  });

  it("keeps a literal whole across a NESTED double quote", () => {
    // Shape of train.ts: a tool description quoting an action name.
    const src = `const d = '- action:"caption" — needs THE_KEY to be set somewhere';`;
    const lits = stringLiterals(src).map((l: { text: string }) => l.text);
    expect(lits).toHaveLength(1);
    expect(lits[0]).toContain("THE_KEY");
  });

  it("does not desync on a BRACE inside an interpolated string", () => {
    // The construct that lost a finding thousands of lines later: the naive
    // brace-counting skip ended at the `}` inside the nested string, leaving the
    // rest of the file parsed in the wrong mode.
    const src = [
      `const a = ${BT}x \${cond ? "}" : ""} y${BT};`,
      `const b = "a later message long enough to be prose, naming THE_KEY here";`,
    ].join("\n");
    const lits = stringLiterals(src).map((l: { text: string }) => l.text);
    expect(lits.some((t: string) => t.includes("THE_KEY"))).toBe(true);
  });

  it("ignores an apostrophe in a COMMENT rather than opening a string", () => {
    const src = [
      `// the user's key is deliberately unset here`,
      `const b = "a message long enough to count as prose that names THE_KEY";`,
    ].join("\n");
    const lits = stringLiterals(src).map((l: { text: string }) => l.text);
    expect(lits).toHaveLength(1);
    expect(lits[0]).toContain("THE_KEY");
  });

  it("treats a regex after a KEYWORD as a regex, not a division", () => {
    // `return /[quote]/` decided on the preceding CHARACTER reads as a division,
    // and the quote inside the character class then opens a string that swallows
    // the next real message. src/orchestrator holds a dozen keyword-preceded regex
    // literals; none contains a quote today, so only a probe like this shows it.
    const src = [
      `function f(s) { return /[${DQ}${SQ}]/.test(s); }`,
      `const msg = ${DQ}a later message long enough to be prose, naming THE_KEY${DQ};`,
    ].join(NL);
    const lits = stringLiterals(src).map((l: { text: string }) => l.text);
    expect(lits.some((t: string) => t.includes("THE_KEY"))).toBe(true);
  });

  it("reports the line the literal STARTS on", () => {
    const src = ["const a = 1;", "", `const b = "second";`].join("\n");
    expect(stringLiterals(src)[0].line).toBe(3);
  });
});

describe("check:env-advice", () => {
  it("passes on the current tree", () => {
    // Runs the real gate: if someone reintroduces the dead remedy, this fails
    // here as well as in the check run.
    const out = execFileSync("node", ["scripts/check-env-advice.mjs"], { encoding: "utf8" });
    expect(out).toContain("none named as a remedy");
  });
});
