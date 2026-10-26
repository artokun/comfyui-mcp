// pi.dev MCP-bridge detection and the capability note it selects (#2996).
//
// The defect: PI_CAPABILITY_OVERRIDE told every pi turn that pi "has NO ComfyUI
// tools … NONE of them exist in your runtime". True for a stock pi; false for a
// pi carrying the pi-mcp-adapter extension or pi 0.99+'s built-in MCP, pointed at
// the comfyui / panel servers by the user. The model obeyed the prompt and refused
// the canvas work the user had wired up.
//
// Two things are pinned here. (1) The detector greens ONLY on a well-formed,
// present bridge (package listed or built-in on, plus an enabled server in a file
// that bridge reads) — read from an injected home, never the developer's ~/.pi.
// (2) The note selection and the makeBackend call site: the stock retraction for
// a bare pi, the bridge-aware correction otherwise, and the orchestrator actually
// consulting the detector rather than the constant.

import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectPiMcpBridge,
  enabledMcpServerNames,
  isMcpAdapterPackageSource,
} from "../../orchestrator/pi-mcp-bridge.js";
import { piCapabilityNote } from "../../orchestrator/index.js";

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "pi-bridge-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/** An env with no PI_CODING_AGENT_DIR, so `home` is the only signal. */
const env: NodeJS.ProcessEnv = {};

function write(rel: string, body: string): void {
  const file = join(home, rel);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, body);
}

const ADAPTER_SETTINGS = JSON.stringify({
  packages: ["npm:pi-mcp-adapter@2.24.0"],
});
const COMFY_SERVERS = JSON.stringify({
  mcpServers: {
    comfyui: { command: "node", args: ["C:/x/comfyui-mcp/dist/index.js"] },
    "comfyui-panel": { url: "http://127.0.0.1:9181/orchestrator" },
  },
});

// ---------------------------------------------------------------------------
// the reporter's install, and the stock install
// ---------------------------------------------------------------------------

describe("detectPiMcpBridge", () => {
  it("finds the reporter's setup: adapter package + ~/.pi/agent/mcp.json servers", () => {
    write(".pi/agent/settings.json", ADAPTER_SETTINGS);
    write(".pi/agent/mcp.json", COMFY_SERVERS);
    expect(detectPiMcpBridge(home, env)).toEqual({
      kind: "pi-mcp-adapter",
      servers: ["comfyui", "comfyui-panel"],
    });
  });

  it("is null for a stock pi: no settings, no mcp.json", () => {
    write(".pi/agent/auth.json", "{}");
    expect(detectPiMcpBridge(home, env)).toBeNull();
  });

  it("is null when the adapter is installed but no file it reads lists a server", () => {
    write(".pi/agent/settings.json", ADAPTER_SETTINGS);
    expect(detectPiMcpBridge(home, env)).toBeNull();
    write(".pi/agent/mcp.json", JSON.stringify({ mcpServers: {} }));
    expect(detectPiMcpBridge(home, env)).toBeNull();
  });

  it("is null when every configured server is disabled", () => {
    write(".pi/agent/settings.json", ADAPTER_SETTINGS);
    write(
      ".pi/agent/mcp.json",
      JSON.stringify({
        mcpServers: { comfyui: { command: "node", enabled: false } },
      }),
    );
    expect(detectPiMcpBridge(home, env)).toBeNull();
  });

  it("reads the adapter's shared user-global files too (~/.config/mcp/mcp.json, ~/.agents)", () => {
    write(".pi/agent/settings.json", ADAPTER_SETTINGS);
    write(
      ".config/mcp/mcp.json",
      JSON.stringify({ mcpServers: { comfyui: { command: "x" } } }),
    );
    write(
      ".agents/mcp.json",
      JSON.stringify({ mcpServers: { panel: { url: "http://h" } } }),
    );
    expect(detectPiMcpBridge(home, env)).toEqual({
      kind: "pi-mcp-adapter",
      servers: ["comfyui", "panel"],
    });
  });

  it("reads the adapter-owned ~/.pi/agent/mcp-adapter.json, which carries its own mcpServers (gate P1)", () => {
    write(".pi/agent/settings.json", ADAPTER_SETTINGS);
    write(
      ".pi/agent/mcp-adapter.json",
      JSON.stringify({
        settings: {},
        mcpServers: { comfyui: { command: "node" } },
      }),
    );
    expect(detectPiMcpBridge(home, env)).toEqual({
      kind: "pi-mcp-adapter",
      servers: ["comfyui"],
    });
  });

  it("reads project-scoped files in the spawn cwd for the adapter (.mcp.json, .pi/mcp.json) (gate P1)", () => {
    write(".pi/agent/settings.json", ADAPTER_SETTINGS);
    const cwd = join(home, "ComfyUI");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { comfyui: { command: "node" } } }),
    );
    writeFileSync(
      join(cwd, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { panel: { url: "http://h" } } }),
    );
    expect(detectPiMcpBridge(home, env)).toBeNull(); // no cwd → user-global only
    expect(detectPiMcpBridge(home, env, cwd)).toEqual({
      kind: "pi-mcp-adapter",
      servers: ["comfyui", "panel"],
    });
  });

  it("reads the project .pi/mcp.json for the built-in too, but not .mcp.json (the built-in does not read it)", () => {
    const cwd = join(home, "ComfyUI");
    mkdirSync(join(cwd, ".pi"), { recursive: true });
    writeFileSync(
      join(cwd, ".mcp.json"),
      JSON.stringify({ mcpServers: { shared: { command: "node" } } }),
    );
    expect(detectPiMcpBridge(home, env, cwd)).toBeNull();
    writeFileSync(
      join(cwd, ".pi", "mcp.json"),
      JSON.stringify({ mcpServers: { comfyui: { command: "node" } } }),
    );
    expect(detectPiMcpBridge(home, env, cwd)).toEqual({
      kind: "builtin",
      servers: ["comfyui"],
    });
  });

  it("accepts the object form of a package entry", () => {
    write(
      ".pi/agent/settings.json",
      JSON.stringify({
        packages: [{ source: "npm:pi-mcp-adapter", extensions: ["index.ts"] }],
      }),
    );
    write(".pi/agent/mcp.json", COMFY_SERVERS);
    expect(detectPiMcpBridge(home, env)?.kind).toBe("pi-mcp-adapter");
  });

  it("does not mistake another package for the adapter", () => {
    write(
      ".pi/agent/settings.json",
      JSON.stringify({
        packages: ["npm:pi-tools", "npm:@x/pi-mcp-adapter-ui"],
      }),
    );
    write(".config/mcp/mcp.json", COMFY_SERVERS);
    // No adapter → only pi's own mcp.json counts, and it is absent.
    expect(detectPiMcpBridge(home, env)).toBeNull();
  });

  // --- pi 0.99+ built-in MCP -------------------------------------------------

  it("finds pi's built-in MCP: servers in ~/.pi/agent/mcp.json with no adapter package", () => {
    write(".pi/agent/settings.json", JSON.stringify({ packages: [] }));
    write(".pi/agent/mcp.json", COMFY_SERVERS);
    expect(detectPiMcpBridge(home, env)).toEqual({
      kind: "builtin",
      servers: ["comfyui", "comfyui-panel"],
    });
  });

  it("finds the built-in with no settings.json at all", () => {
    write(".pi/agent/mcp.json", COMFY_SERVERS);
    expect(detectPiMcpBridge(home, env)?.kind).toBe("builtin");
  });

  it("is null when the built-in is disabled with -builtin:mcp and no adapter is installed", () => {
    write(
      ".pi/agent/settings.json",
      JSON.stringify({ extensions: ["-builtin:mcp"] }),
    );
    write(".pi/agent/mcp.json", COMFY_SERVERS);
    expect(detectPiMcpBridge(home, env)).toBeNull();
  });

  it("still reports the adapter when it disabled the built-in for itself (its documented install step)", () => {
    write(
      ".pi/agent/settings.json",
      JSON.stringify({
        packages: ["npm:pi-mcp-adapter"],
        extensions: ["-builtin:mcp"],
      }),
    );
    write(".pi/agent/mcp.json", COMFY_SERVERS);
    expect(detectPiMcpBridge(home, env)?.kind).toBe("pi-mcp-adapter");
  });

  it("ignores the shared adapter files when only the built-in is in play", () => {
    write(".config/mcp/mcp.json", COMFY_SERVERS);
    expect(detectPiMcpBridge(home, env)).toBeNull();
  });

  // --- file hygiene ----------------------------------------------------------

  it("tolerates a UTF-8 BOM and JSONC comments in both files (cf. #2995)", () => {
    write(".pi/agent/settings.json", "\uFEFF" + ADAPTER_SETTINGS);
    write(
      ".pi/agent/mcp.json",
      "\uFEFF// servers\n" +
        JSON.stringify({ mcpServers: { comfyui: { command: "x" } } }),
    );
    expect(detectPiMcpBridge(home, env)).toEqual({
      kind: "pi-mcp-adapter",
      servers: ["comfyui"],
    });
  });

  it("treats a malformed or non-object file as absent, never throws", () => {
    write(".pi/agent/settings.json", ADAPTER_SETTINGS);
    write(".pi/agent/mcp.json", "{ mcpServers: ");
    expect(detectPiMcpBridge(home, env)).toBeNull();
    write(".pi/agent/mcp.json", JSON.stringify({ mcpServers: ["comfyui"] }));
    expect(detectPiMcpBridge(home, env)).toBeNull();
    write(
      ".pi/agent/mcp.json",
      JSON.stringify([{ mcpServers: { comfyui: {} } }]),
    );
    expect(detectPiMcpBridge(home, env)).toBeNull();
    write(".pi/agent/settings.json", "null");
    write(".pi/agent/mcp.json", COMFY_SERVERS);
    // settings unreadable → no adapter, built-in not provably disabled → built-in.
    expect(detectPiMcpBridge(home, env)?.kind).toBe("builtin");
  });

  it("honours PI_CODING_AGENT_DIR like pi-credentials does, and refuses a relative one", () => {
    const alt = join(home, "elsewhere");
    mkdirSync(alt, { recursive: true });
    writeFileSync(join(alt, "settings.json"), ADAPTER_SETTINGS);
    writeFileSync(join(alt, "mcp.json"), COMFY_SERVERS);
    expect(detectPiMcpBridge(home, { PI_CODING_AGENT_DIR: alt })?.kind).toBe(
      "pi-mcp-adapter",
    );
    expect(
      detectPiMcpBridge(home, { PI_CODING_AGENT_DIR: "elsewhere" }),
    ).toBeNull();
  });
});

describe("isMcpAdapterPackageSource", () => {
  it.each([
    "npm:pi-mcp-adapter",
    "npm:pi-mcp-adapter@2.24.0",
    "npm:pi-mcp-adapter@latest",
    "git:github.com/nicobailon/pi-mcp-adapter",
    "git:github.com/nicobailon/pi-mcp-adapter@v1",
    "git:github.com/nicobailon/pi-mcp-adapter@abc1234",
    "https://github.com/nicobailon/pi-mcp-adapter.git",
    "/home/u/src/pi-mcp-adapter",
    "C:\\Users\\u\\src\\pi-mcp-adapter\\",
  ])("accepts %s", (src) => {
    expect(isMcpAdapterPackageSource(src)).toBe(true);
  });

  it.each([
    "",
    "npm:pi-mcp-adapter-ui",
    "npm:@scope/pi-mcp-adapter-fork@1.0.0",
    "npm:pi-tools",
    "git:github.com/nicobailon/pi-mcp-adapter-docs",
    "git:github.com/nicobailon/pi-mcp-adapter-docs@v1",
    "/home/u/pi-mcp-adapter/examples",
  ])("rejects %s", (src) => {
    expect(isMcpAdapterPackageSource(src)).toBe(false);
  });
});

describe("enabledMcpServerNames", () => {
  it("keeps object entries that are not enabled:false, in file order", () => {
    expect(
      enabledMcpServerNames({
        mcpServers: {
          a: {},
          b: { enabled: false },
          c: "nope",
          d: { enabled: true },
        },
      }),
    ).toEqual(["a", "d"]);
    expect(enabledMcpServerNames(null)).toEqual([]);
    expect(enabledMcpServerNames({ mcpServers: null })).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// the note, and the call site that picks it
// ---------------------------------------------------------------------------

describe("piCapabilityNote", () => {
  it("is the stock hard retraction for a pi with no bridge", () => {
    const note = piCapabilityNote(null);
    expect(note).toContain("NO ComfyUI tools");
    expect(note).toContain("NONE of them exist in your runtime");
    expect(note).toContain(
      "switch to the Claude, Codex, Gemini, or Antigravity backend",
    );
  });

  it("drops the NONE assertion when a bridge is present and names the user's bridge instead", () => {
    const note = piCapabilityNote({
      kind: "pi-mcp-adapter",
      servers: ["comfyui", "comfyui-panel"],
    });
    expect(note).not.toContain("NONE of them exist");
    expect(note).not.toContain("has NO ComfyUI tools");
    expect(note).not.toContain(
      "switch to the Claude, Codex, Gemini, or Antigravity backend",
    );
    expect(note).toContain("pi-mcp-adapter");
    expect(note).toContain("proxy tool named `mcp`");
    expect(note).toContain("`directTools`");
    expect(note).toContain("`comfyui`, `comfyui-panel`");
  });

  it("describes the built-in bridge by its own tool shape", () => {
    const note = piCapabilityNote({ kind: "builtin", servers: ["comfyui"] });
    expect(note).toContain("mcp__<server>__<tool>");
    expect(note).toContain("`codemode`");
    expect(note).toContain("`tool_search`");
    expect(note).not.toContain("pi-mcp-adapter");
  });

  it("still retracts what stays true with a bridge, and asserts no tool it did not observe", () => {
    for (const kind of ["pi-mcp-adapter", "builtin"] as const) {
      const note = piCapabilityNote({ kind, servers: ["comfyui"] });
      // The panel hands pi nothing — that retraction survives.
      expect(note).toContain("does NOT hand pi its ComfyUI MCP servers");
      expect(note).toContain("panel_add_mcp / panel_reload do not add them");
      // It defers to the real tool list rather than promising panel_* exist.
      expect(note).toContain("Go by the tool list you were actually given");
      expect(note).toContain("say plainly that no ComfyUI tool is reachable");
      expect(note).not.toMatch(/panel_\w+ (is|are) available/);
      // And it never tells the model to deny the user's own setup.
      expect(note).toContain(
        "do not tell the user pi cannot have ComfyUI tools",
      );
    }
  });
});

describe("makeBackend's pi branch consults the detector (call-site pin)", () => {
  // The selector above is pure and the detector is pure, so the one way this fix
  // silently un-ships is the call site going back to the constant. makeBackend is
  // a closure inside the 5000-line orchestrator entry, unreachable from a test
  // without spawning the whole process, so the wiring is pinned on the source:
  // the `backend === "pi"` branch must pass piCapabilityNote(detectPiMcpBridge())
  // and must not pass PI_CAPABILITY_OVERRIDE directly any more.
  const src = readFileSync(
    join(
      dirname(fileURLToPath(import.meta.url)),
      "../../orchestrator/index.ts",
    ),
    "utf8",
  );
  const piBranch =
    /if \(backend === "pi"\) \{([\s\S]*?)return new PiBackend\(\{([\s\S]*?)\}\);/.exec(
      src,
    );

  it("finds the one turn-driving pi construction site (the model-probe site carries no note)", () => {
    expect(piBranch).not.toBeNull();
    // Two `new PiBackend(` sites exist: makeBackend's (drives turns, carries the
    // note) and getProbeBackend's (listModels only). Exactly one passes a note.
    expect(src.match(/capabilityNote:/g)?.length).toBe(1);
  });

  it("passes the detector's verdict through piCapabilityNote, not the raw constant", () => {
    const branch = (piBranch?.[1] ?? "") + (piBranch?.[2] ?? "");
    // cwd threaded in: the bridge's project files live where pi is spawned.
    expect(branch).toMatch(
      /detectPiMcpBridge\(undefined, undefined, comfyuiPath \?\? process\.cwd\(\)\)/,
    );
    expect(branch).toMatch(/capabilityNote:\s*piCapabilityNote\(/);
    expect(branch).not.toMatch(/capabilityNote:\s*PI_CAPABILITY_OVERRIDE/);
  });
});
