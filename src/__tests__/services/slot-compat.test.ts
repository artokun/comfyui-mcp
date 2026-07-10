import { describe, expect, it } from "vitest";
import {
  compatibilityRank,
  isTypeCompatible,
  RANK_EXACT,
  RANK_INCOMPATIBLE,
  RANK_WILDCARD,
} from "../../services/slot-compat.js";

describe("slot-compat", () => {
  it("treats identical type names as an exact-rank match", () => {
    expect(compatibilityRank("MODEL", "MODEL")).toBe(RANK_EXACT);
    expect(isTypeCompatible("MODEL", "MODEL")).toBe(true);
  });

  it("rejects distinct concrete types", () => {
    expect(compatibilityRank("MODEL", "CLIP")).toBe(RANK_INCOMPATIBLE);
    expect(isTypeCompatible("MODEL", "CLIP")).toBe(false);
  });

  it("accepts `*` wildcards but ranks them below an exact match", () => {
    expect(compatibilityRank("*", "MODEL")).toBe(RANK_WILDCARD);
    expect(compatibilityRank("MODEL", "*")).toBe(RANK_WILDCARD);
    expect(isTypeCompatible("*", "ANYTHING")).toBe(true);
    expect(RANK_WILDCARD).toBeLessThan(RANK_EXACT);
  });

  it("orders exact > wildcard > incompatible", () => {
    const ranks = [
      compatibilityRank("IMAGE", "IMAGE"),
      compatibilityRank("*", "IMAGE"),
      compatibilityRank("IMAGE", "LATENT"),
    ];
    expect(ranks).toEqual([RANK_EXACT, RANK_WILDCARD, RANK_INCOMPATIBLE]);
    expect(ranks[0]).toBeGreaterThan(ranks[1]);
    expect(ranks[1]).toBeGreaterThan(ranks[2]);
  });

  it("matches comma-joined multi-types if ANY segment matches", () => {
    expect(compatibilityRank("IMAGE,MASK", "MASK")).toBe(RANK_EXACT);
    expect(compatibilityRank("IMAGE", "MASK,LATENT,IMAGE")).toBe(RANK_EXACT);
    expect(compatibilityRank("IMAGE, MASK", "MASK")).toBe(RANK_EXACT); // whitespace tolerant
    expect(isTypeCompatible("IMAGE,MASK", "LATENT")).toBe(false);
  });

  it("treats COMBO / enum arrays as identical-only", () => {
    expect(compatibilityRank(["a", "b", "c"], ["a", "b", "c"])).toBe(RANK_EXACT);
    expect(compatibilityRank(["a", "b"], ["a", "c"])).toBe(RANK_INCOMPATIBLE);
    expect(compatibilityRank(["a", "b"], ["a", "b", "c"])).toBe(RANK_INCOMPATIBLE);
    // an array never matches a plain type (and vice versa)
    expect(compatibilityRank(["a"], "a")).toBe(RANK_INCOMPATIBLE);
    expect(compatibilityRank("a", ["a"])).toBe(RANK_INCOMPATIBLE);
  });
});
