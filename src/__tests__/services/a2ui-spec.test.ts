// a2ui-spec.test.ts — server-side wall for A2UI card specs (panel_ui_render /
// panel_ui_update). Mirrors the panel-side test coverage in
// comfyui-agent-panel/web/js/cmcp-a2ui.js (validateA2UISpec) — same caps, same
// bombs, so the two walls stay in lockstep. See a2ui-spec.ts for the four
// mirror-hardenings this suite locks in (children-array cap, render-tree
// INSTANCE counting for both the 64-component cap and the 4-image cap, and the
// chart x-array length cap).
import { describe, expect, it } from "vitest";
import { A2UI_CAPS, validateA2UISpecServer } from "../../services/a2ui-spec.js";

const minimal = () => ({
  root: "c1",
  components: [
    { id: "c1", type: "Column", children: ["t", "b"] },
    { id: "t", type: "Text", text: "hi" },
    { id: "b", type: "Button", label: "Go", reply: "go" },
  ],
});

describe("validateA2UISpecServer", () => {
  it("accepts a minimal card and applies the surface default", () => {
    const r = validateA2UISpecServer(minimal());
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.spec.surface).toBe("inline");
  });

  it("rejects unknown types, dangling refs, cycles, over-caps", () => {
    const unknown = minimal();
    (unknown.components as Record<string, unknown>[]).push({ id: "z", type: "Script" });
    expect(validateA2UISpecServer(unknown).ok).toBe(false);

    expect(validateA2UISpecServer({ root: "ghost", components: minimal().components }).ok).toBe(false);

    expect(
      validateA2UISpecServer({
        root: "a",
        components: [
          { id: "a", type: "Column", children: ["b"] },
          { id: "b", type: "Column", children: ["a"] },
        ],
      }).ok,
    ).toBe(false);

    expect(
      validateA2UISpecServer({
        root: "g",
        components: [
          {
            id: "g",
            type: "comfy:graph",
            nodes: Array.from({ length: 31 }, (_, i) => ({ id: `n${i}`, label: "n" })),
            edges: [],
          },
        ],
      }).ok,
    ).toBe(false);
  });

  it("rejects off-origin image src", () => {
    expect(
      validateA2UISpecServer({
        root: "i",
        components: [{ id: "i", type: "Image", src: "https://evil.example/x.png" }],
      }).ok,
    ).toBe(false);
    expect(
      validateA2UISpecServer({
        root: "i",
        components: [{ id: "i", type: "Image", src: "/view?filename=x.png" }],
      }).ok,
    ).toBe(true);
  });

  // --- mirror-hardening #1: children-array length cap (per-container, ≤64) ---
  it("rejects a children-array fill bomb (one container listing 50k children)", () => {
    const bomb = {
      root: "root",
      components: [
        { id: "root", type: "Column", children: Array.from({ length: 50000 }, (_, i) => `leaf${i % 2}`) },
        { id: "leaf0", type: "Text", text: "a" },
        { id: "leaf1", type: "Text", text: "b" },
      ],
    };
    const r = validateA2UISpecServer(bomb);
    expect(r.ok).toBe(false);
  });

  // --- mirror-hardening #2: render-tree INSTANCE counting in the DFS ---
  it("rejects a 10x10 nesting instance bomb (repeated child refs multiply the render tree)", () => {
    // A container with 10 children, each a DIFFERENT container that itself
    // lists the SAME 10 leaves as children — 10 declared "row" containers +
    // 10 leaves = 20 declared components (under the 64 cap), but the DFS
    // render tree is 1 (root) + 10 (rows) + 10*10 (leaf visits) = 111 instances,
    // which must be rejected even though nothing is individually over-cap.
    const leaves = Array.from({ length: 10 }, (_, i) => `leaf${i}`);
    const rows = Array.from({ length: 10 }, (_, i) => ({
      id: `row${i}`,
      type: "Row" as const,
      children: leaves,
    }));
    const bomb = {
      root: "root",
      components: [
        { id: "root", type: "Column", children: rows.map((r) => r.id) },
        ...rows,
        ...leaves.map((id) => ({ id, type: "Text" as const, text: "x" })),
      ],
    };
    const r = validateA2UISpecServer(bomb);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("render tree exceeds"))).toBe(true);
    }
  });

  // --- mirror-hardening #3: Image INSTANCE cap in the DFS (>4 counts visits, not declarations) ---
  it("rejects 5 references to a single Image component (instance bomb, not a declaration bomb)", () => {
    const refs = Array.from({ length: 5 }, () => "img");
    const bomb = {
      root: "root",
      components: [
        { id: "root", type: "Row", children: refs },
        { id: "img", type: "Image", src: "/view?filename=x.png" },
      ],
    };
    // Only ONE Image is declared, so the declared-count check (imageCount<=4)
    // would pass it — only the DFS instance count catches this.
    const r = validateA2UISpecServer(bomb);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.errors.some((e) => e.includes("image instances"))).toBe(true);
    }
  });

  // --- mirror-hardening #4: Chart x-array length cap (maxChartPoints) ---
  it("rejects a comfy:chart x array longer than maxChartPoints", () => {
    const bomb = {
      root: "c",
      components: [
        {
          id: "c",
          type: "comfy:chart",
          kind: "line",
          series: [{ label: "s", values: [1, 2, 3] }],
          x: Array.from({ length: A2UI_CAPS.maxChartPoints + 1 }, (_, i) => `x${i}`),
        },
      ],
    };
    const r = validateA2UISpecServer(bomb);
    expect(r.ok).toBe(false);
  });

  // --- lockstep parity: panel's capped() is MAX-ONLY — empty strings pass ---
  // everywhere except component ids (panel additionally checks `!c.id`). The
  // server wall must accept the exact same specs the panel wall accepts.
  it("accepts empty strings where the panel does (label/reply/caption/name/placeholder/value)", () => {
    expect(
      validateA2UISpecServer({
        root: "b",
        components: [{ id: "b", type: "Button", label: "", reply: "" }],
      }).ok,
    ).toBe(true);

    expect(
      validateA2UISpecServer({
        root: "i",
        components: [{ id: "i", type: "Image", src: "/view?filename=x.png", caption: "" }],
      }).ok,
    ).toBe(true);

    expect(
      validateA2UISpecServer({
        root: "f",
        components: [{ id: "f", type: "TextField", label: "", name: "", placeholder: "", value: "" }],
      }).ok,
    ).toBe(true);
  });

  it("still rejects an empty component id (panel's !c.id check)", () => {
    expect(
      validateA2UISpecServer({
        root: "",
        components: [{ id: "", type: "Text", text: "hi" }],
      }).ok,
    ).toBe(false);
  });

  it("accepts a comfy:chart x array at exactly maxChartPoints", () => {
    const ok = {
      root: "c",
      components: [
        {
          id: "c",
          type: "comfy:chart",
          kind: "line",
          series: [{ label: "s", values: [1, 2, 3] }],
          x: Array.from({ length: A2UI_CAPS.maxChartPoints }, (_, i) => `x${i}`),
        },
      ],
    };
    const r = validateA2UISpecServer(ok);
    expect(r.ok).toBe(true);
  });
});
