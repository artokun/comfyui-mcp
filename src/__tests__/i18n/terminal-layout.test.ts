import { describe, it, expect } from "vitest";
import {
  displayWidth,
  padTo,
  widestLine,
  banner,
  labelRows,
  numberedSteps,
  RULE_MIN,
  RULE_MAX,
} from "../../i18n/terminal-layout.js";

describe("displayWidth", () => {
  it("counts ASCII one cell per character", () => {
    expect(displayWidth("comfyui-mcp")).toBe(11);
    expect(displayWidth("")).toBe(0);
  });

  it("counts CJK and Hangul as TWO cells — the failure this module exists for", () => {
    // Korean, Japanese and Chinese are the three of our twelve locales where a
    // character-counting pad is silently half as wide as it needs to be.
    expect(displayWidth("한국어")).toBe(6);
    expect(displayWidth("日本語")).toBe(6);
    expect(displayWidth("中文")).toBe(4);
    expect("한국어".length).toBe(3); // ...which is what the naive version would have used.
  });

  it("counts combining marks as ZERO — Arabic and Persian pad the other way", () => {
    // U+0651 SHADDA renders into the preceding cell rather than taking one of its own.
    expect(displayWidth("مَ")).toBe(1);
    expect(displayWidth("é")).toBe(1);
  });

  it("treats the characters the banners are DRAWN from as one cell each", () => {
    // If `═`, `—` or `•` were ever counted as wide, every rule in the CLI would double.
    expect(displayWidth("═".repeat(68))).toBe(68);
    expect(displayWidth("—")).toBe(1);
    expect(displayWidth("•")).toBe(1);
    expect(displayWidth("✓")).toBe(1);
  });

  it("counts an astral character once, not once per surrogate half", () => {
    expect("🎨".length).toBe(2);
    expect(displayWidth("🎨")).toBe(2); // wide, but for the right reason
    expect(displayWidth("𠀀")).toBe(2); // CJK Extension B
  });

  it("counts emoji by presentation, not by which block they happen to sit in", () => {
    // The emoji blocks are interleaved with narrow symbols, so any hand-picked range gets
    // some of these wrong: 🚀 sits above the Emoticons block and ✅ is not in an emoji block
    // at all, while ✓ and ✔ are text-presentation symbols one cell wide.
    for (const wide of ["🚀", "✅", "🎨", "📦", "🧪", "⏰"]) {
      expect(displayWidth(wide), `${wide} should be two cells`).toBe(2);
    }
    for (const narrow of ["✓", "✔", "→", "…", "±"]) {
      expect(displayWidth(narrow), `${narrow} should be one cell`).toBe(1);
    }
  });
});

describe("padTo", () => {
  it("pads to a cell column and never closer than the minimum separator", () => {
    expect(padTo("abc", 10).length).toBe(10);
    expect(displayWidth(padTo("한국어", 10))).toBe(10);
    // Over-long input still gets its separator rather than colliding with the next column.
    expect(padTo("a".repeat(20), 10, 3)).toBe(`${"a".repeat(20)}   `);
  });
});

describe("widestLine", () => {
  it("measures in cells and splits embedded newlines", () => {
    expect(widestLine(["ab", "abcd"])).toBe(4);
    expect(widestLine(["ab\nabcdef"])).toBe(6);
    expect(widestLine(["한국어"])).toBe(6);
  });
});

describe("labelRows", () => {
  it("reproduces the hand-typed English alignment exactly", () => {
    expect(
      labelRows(" ", [
        ["Agent bridge", "ws://127.0.0.1:9199"],
        ["Driving", "https://example.com"],
        ["Secure", "yes"],
      ]),
    ).toEqual([
      " Agent bridge : ws://127.0.0.1:9199",
      " Driving      : https://example.com",
      " Secure       : yes",
    ]);
  });

  it("aligns colons by CELLS, not characters", () => {
    // The discriminating case: a `.length`-based implementation passes the English test
    // above and fails this one, because here the two prefixes are the same number of cells
    // and a DIFFERENT number of characters.
    const rows = labelRows(" ", [
      ["에이전트 브리지", "ws://127.0.0.1:9199"],
      ["Driving", "https://example.com"],
    ]);
    const prefixes = rows.map((r) => r.slice(0, r.indexOf(": ")));
    expect(new Set(prefixes.map(displayWidth)).size).toBe(1);
    expect(new Set(prefixes.map((p) => p.length)).size).toBe(2);
  });

  it("returns nothing for no rows instead of throwing", () => {
    // Callers assemble these lists conditionally, so an empty one is reachable — and the
    // naive implementation throws RangeError from `" ".repeat(-Infinity)` on the startup
    // path, where a layout helper crashing is far worse than a section rendering empty.
    expect(labelRows(" ", [])).toEqual([]);
  });

  it("hangs a multi-line value under the value column, not under the label", () => {
    const rows = labelRows(" ", [
      ["Secure", "first line\nsecond line"],
      ["Agent bridge", "x"],
    ]);
    expect(rows).toEqual([
      " Secure       : first line",
      "                second line",
      " Agent bridge : x",
    ]);
    // The hanging indent is derived from the translated label's CELL width, so the
    // continuation still starts in the value column when the label is not English.
    const ko = labelRows(" ", [["보안", "one\ntwo"]]);
    const cellColumnOf = (line: string, text: string) =>
      displayWidth(line.slice(0, line.indexOf(text)));
    expect(cellColumnOf(ko[1], "two")).toBe(cellColumnOf(ko[0], "one"));
  });
});

describe("numberedSteps", () => {
  it("numbers from 1 and hangs continuations under the text", () => {
    expect(numberedSteps(["do a thing", "do another\non two lines"])).toEqual([
      "   1. do a thing",
      "   2. do another",
      "      on two lines",
    ]);
  });
});

describe("banner", () => {
  const ruleOf = (b: string) => b.split("\n")[1];

  it("keeps the legacy rule width for content that fits inside it", () => {
    expect(ruleOf(banner("title", [" short"]))).toBe("═".repeat(RULE_MIN));
  });

  it("widens the rule to its widest line rather than letting content overhang", () => {
    // The connect banner has always had a 71-cell line inside a 68-cell rule.
    expect(ruleOf(banner("t", [` ${"x".repeat(70)}`])).length).toBe(71);
  });

  it("measures that width in CELLS, so a CJK box is not drawn half-size", () => {
    // 35 ideographs = 35 characters but 70 cells. A `.length` rule would stay at the 68-cell
    // floor and the text would run past the end of its own box.
    expect(ruleOf(banner("t", [` ${"字".repeat(35)}`])).length).toBe(71);
  });

  it("caps the rule at a width every terminal has, so it can never wrap", () => {
    // A wrapped rule is not a wider box, it is two ragged lines and no box.
    expect(RULE_MAX).toBeLessThanOrEqual(80);
    expect(ruleOf(banner("t", [` ${"x".repeat(400)}`])).length).toBe(RULE_MAX);
  });

  it("drops null rows and fences the body between two identical rules", () => {
    const lines = banner("t", [" a", null, " b"]).split("\n");
    expect(lines[0]).toBe("");
    expect(lines[2]).toBe(" t");
    expect(lines.slice(4, -2)).toEqual([" a", " b"]);
    expect(lines[1]).toBe(lines[3]);
    expect(lines[1]).toBe(lines[lines.length - 2]);
    expect(lines[lines.length - 1]).toBe("");
  });
});
