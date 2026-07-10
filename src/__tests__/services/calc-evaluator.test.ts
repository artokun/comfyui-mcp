import { describe, expect, it } from "vitest";
import {
  evaluateBatch,
  MAX_EXPRESSIONS,
  MAX_EXPR_CHARS,
} from "../../services/calc-evaluator.js";

/** Convenience: evaluate a single expression and return its result. */
function one(expr: string, variables?: Record<string, number>, seed?: number): number | null {
  return evaluateBatch([expr], variables, seed).results[0];
}

describe("calc-evaluator: arithmetic & precedence", () => {
  it("basic arithmetic and precedence", () => {
    expect(one("1 + 2 * 3")).toBe(7);
    expect(one("(1 + 2) * 3")).toBe(9);
    expect(one("2 + 3 - 1")).toBe(4);
    expect(one("10 / 4")).toBe(2.5);
  });

  it("power is right-associative: 2**3**2 = 512", () => {
    expect(one("2**3**2")).toBe(512);
  });

  it("unary minus binds below power: -2**2 = -4", () => {
    expect(one("-2**2")).toBe(-4);
    expect(one("(-2)**2")).toBe(4);
    expect(one("-3")).toBe(-3);
    expect(one("--3")).toBe(3);
    expect(one("2 ** -1")).toBe(0.5);
  });

  it("floor division and modulo", () => {
    expect(one("7 // 2")).toBe(3);
    expect(one("-7 // 2")).toBe(-4); // floor toward -inf
    expect(one("7 % 3")).toBe(1);
    expect(one("-7 % 3")).toBe(2); // python-style, sign of divisor
    expect(one("7 % -3")).toBe(-2);
  });

  it("comparisons return 1/0", () => {
    expect(one("3 > 2")).toBe(1);
    expect(one("3 < 2")).toBe(0);
    expect(one("2 == 2")).toBe(1);
    expect(one("2 != 2")).toBe(0);
    expect(one("2 <= 2")).toBe(1);
    expect(one("2 >= 3")).toBe(0);
    expect(one("1 + (2 > 1)")).toBe(2);
  });

  it("scientific and float literals", () => {
    expect(one("1e3")).toBe(1000);
    expect(one("1.5e2")).toBe(150);
    expect(one(".5")).toBe(0.5);
    expect(one("2.5e-1")).toBe(0.25);
  });
});

describe("calc-evaluator: constants & functions", () => {
  it("constants", () => {
    expect(one("pi")).toBeCloseTo(Math.PI);
    expect(one("e")).toBeCloseTo(Math.E);
    expect(one("tau")).toBeCloseTo(Math.PI * 2);
  });

  it("math functions incl. clamp", () => {
    expect(one("sqrt(16)")).toBe(4);
    expect(one("floor(2.9)")).toBe(2);
    expect(one("ceil(2.1)")).toBe(3);
    expect(one("min(3, 1, 2)")).toBe(1);
    expect(one("max(3, 1, 2)")).toBe(3);
    expect(one("abs(-5)")).toBe(5);
    expect(one("pow(2, 10)")).toBe(1024);
    expect(one("clamp(5, 0, 3)")).toBe(3);
    expect(one("clamp(-1, 0, 3)")).toBe(0);
    expect(one("clamp(2, 0, 3)")).toBe(2);
    expect(one("hypot(3, 4)")).toBe(5);
    expect(one("sign(-9)")).toBe(-1);
    expect(one("trunc(2.9)")).toBe(2);
    expect(one("radians(180)")).toBeCloseTo(Math.PI);
    expect(one("degrees(pi)")).toBeCloseTo(180);
    expect(one("log(8, 2)")).toBeCloseTo(3);
  });

  it("aspect-ratio snap-to-64 (motivating example)", () => {
    // floor(sqrt(1024*1024*ar)/64)*64
    expect(one("floor(sqrt(1024*1024*1.5)/64)*64", { ar: 1.5 })).toBe(1216);
  });

  it("arity errors", () => {
    const { errors } = evaluateBatch(["clamp(1, 2)", "sqrt()", "pow(1,2,3)"]);
    expect(errors).toHaveLength(3);
  });

  it("unknown identifier / function errors", () => {
    const { results, errors } = evaluateBatch(["nope", "frobnicate(1)"]);
    expect(results).toEqual([null, null]);
    expect(errors).toHaveLength(2);
  });
});

describe("calc-evaluator: assignment persistence", () => {
  it("assignments persist across lines and are returned", () => {
    const { results, variables } = evaluateBatch(["w = 1024", "h = w / 2", "w + h"]);
    expect(results).toEqual([1024, 512, 1536]);
    expect(variables).toEqual({ w: 1024, h: 512 });
  });

  it("input variables are respected and NOT mutated", () => {
    const input = { w: 100 };
    const { results, variables } = evaluateBatch(["w * 2", "w = 50"], input);
    expect(results).toEqual([200, 50]);
    expect(input).toEqual({ w: 100 }); // unchanged
    expect(variables.w).toBe(50);
  });

  it("cannot assign to constants or function names", () => {
    const { errors } = evaluateBatch(["pi = 3", "sqrt = 1"]);
    expect(errors).toHaveLength(2);
  });

  it("no chained assignment", () => {
    const { errors } = evaluateBatch(["a = b = 1"]);
    expect(errors).toHaveLength(1);
  });
});

describe("calc-evaluator: seeded RNG", () => {
  it("same seed => identical sequences", () => {
    const spec = ["rand()", "rand()", "rand()"];
    const a = evaluateBatch(spec, undefined, 123);
    const b = evaluateBatch(spec, undefined, 123);
    expect(a.results).toEqual(b.results);
    expect(a.seed).toBe(123);
  });

  it("mulberry32 known-answer for seed 42", () => {
    const { results } = evaluateBatch(["rand()", "rand()", "rand()"], undefined, 42);
    expect(results[0]).toBeCloseTo(0.6011037519201636, 12);
    expect(results[1]).toBeCloseTo(0.44829055899754167, 12);
    expect(results[2]).toBeCloseTo(0.8524657934904099, 12);
  });

  it("omitted seed is drawn and echoed (reproducible after the fact)", () => {
    const first = evaluateBatch(["rand()"]);
    expect(Number.isInteger(first.seed)).toBe(true);
    expect(first.seed).toBeGreaterThanOrEqual(0);
    // Re-running with the echoed seed reproduces the value.
    const again = evaluateBatch(["rand()"], undefined, first.seed);
    expect(again.results[0]).toBe(first.results[0]);
  });

  it("seed is coerced with >>> 0", () => {
    const a = evaluateBatch(["rand()"], undefined, -1);
    const b = evaluateBatch(["rand()"], undefined, 0xffffffff);
    expect(a.results[0]).toBe(b.results[0]);
    expect(a.seed).toBe(0xffffffff);
  });

  it("randint is inclusive on both ends over many draws", () => {
    // Draw randint(1, 6) many times; every value must be within [1,6] and
    // both endpoints must appear.
    const spec = Array.from({ length: 900 }, () => "randint(1, 6)");
    const { results } = evaluateBatch(spec, undefined, 7);
    const seen = new Set<number>();
    for (const r of results) {
      expect(r).not.toBeNull();
      expect(Number.isInteger(r as number)).toBe(true);
      expect(r as number).toBeGreaterThanOrEqual(1);
      expect(r as number).toBeLessThanOrEqual(6);
      seen.add(r as number);
    }
    expect(seen.has(1)).toBe(true); // lower bound reachable
    expect(seen.has(6)).toBe(true); // upper bound reachable
  });

  it("uniform stays within [a, b)", () => {
    const spec = Array.from({ length: 500 }, () => "uniform(2, 5)");
    const { results } = evaluateBatch(spec, undefined, 99);
    for (const r of results) {
      expect(r as number).toBeGreaterThanOrEqual(2);
      expect(r as number).toBeLessThan(5);
    }
  });
});

describe("calc-evaluator: per-line error isolation", () => {
  it("an erroring line yields null but later lines still evaluate", () => {
    const { results, errors } = evaluateBatch(["1 + 1", "1 +", "3 * 3"]);
    expect(results[0]).toBe(2);
    expect(results[1]).toBeNull();
    expect(results[2]).toBe(9);
    expect(errors).toHaveLength(1);
    expect(errors[0].line).toBe(2);
    expect(errors[0].expr).toBe("1 +");
    expect(typeof errors[0].message).toBe("string");
  });

  it("assignment before an error still persists", () => {
    const { results, variables } = evaluateBatch(["x = 5", "bad(", "x * 2"]);
    expect(results[0]).toBe(5);
    expect(results[1]).toBeNull();
    expect(results[2]).toBe(10);
    expect(variables.x).toBe(5);
  });
});

describe("calc-evaluator: safety", () => {
  it("rejects property access and dangerous identifiers", () => {
    const specs = [
      "constructor",
      "__proto__",
      "x.constructor",
      "(1).constructor",
      "a.b",
      "this",
      "globalThis",
    ];
    const { results, errors } = evaluateBatch(specs);
    expect(results.every((r) => r === null)).toBe(true);
    expect(errors).toHaveLength(specs.length);
  });

  it("rejects string literals and non-numeric syntax", () => {
    const specs = ['"hello"', "'x'", "[1, 2]", "{a: 1}", "1 = 2", "@"];
    const { results } = evaluateBatch(specs);
    expect(results.every((r) => r === null)).toBe(true);
  });

  it("results are numbers or null only", () => {
    const { results } = evaluateBatch(["1", "bad", "2.5"]);
    for (const r of results) {
      expect(r === null || typeof r === "number").toBe(true);
    }
  });

  it("NaN and Infinity pass through as numbers", () => {
    expect(one("sqrt(-1)")).toBeNaN();
    expect(one("1 / 0")).toBe(Infinity);
    expect(one("-1 / 0")).toBe(-Infinity);
  });
});

describe("calc-evaluator: size caps", () => {
  it("rejects too many expressions", () => {
    const spec = Array.from({ length: MAX_EXPRESSIONS + 1 }, () => "1");
    expect(() => evaluateBatch(spec)).toThrow();
  });

  it("accepts exactly the max number of expressions", () => {
    const spec = Array.from({ length: MAX_EXPRESSIONS }, () => "1");
    expect(() => evaluateBatch(spec)).not.toThrow();
  });

  it("flags an over-long single expression as a per-line error", () => {
    const long = "1+".repeat(MAX_EXPR_CHARS) + "1"; // exceeds MAX_EXPR_CHARS
    const { results, errors } = evaluateBatch(["1", long]);
    expect(results[0]).toBe(1);
    expect(results[1]).toBeNull();
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toMatch(/too long/i);
  });
});
