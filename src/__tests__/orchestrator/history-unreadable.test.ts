// #796 sweep — "you have no saved sessions" was also being said when the
// directory could not be READ.
//
// `listSessions` caught every `readdir` failure and returned `[]`. ENOENT is a
// real answer — a first run has no directory yet, and an empty list is the truth.
// EACCES, EPERM, EIO and a network path that went away are not.
//
// This one is worth fixing for what it says rather than what it does: it is a
// read, nothing is destroyed. But "you have no saved sessions" is the single
// wrong answer here that reads as DATA LOSS. Someone whose history is briefly
// unreadable is told their conversations are gone, and goes looking for them.
//
// It THROWS rather than returning a flag because the one caller in
// orchestrator/index.ts already wraps this in a `.catch` that pushes
// `{ sessions: [], error }` to the panel — plumbing that could never fire for a
// read failure, because this swallowed every one of them.

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hoisted = vi.hoisted(() => ({
  readdirError: undefined as NodeJS.ErrnoException | undefined,
}));

vi.mock("node:fs/promises", async () => {
  const actual = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    readdir: async (p: unknown, ...rest: unknown[]) => {
      if (hoisted.readdirError) throw hoisted.readdirError;
      return (actual.readdir as (...a: unknown[]) => Promise<unknown>)(p, ...rest);
    },
  };
});

const { listSessions } = await import("../../orchestrator/history.js");

let home: string;
let savedHome: string | undefined;

function errno(code: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: simulated`) as NodeJS.ErrnoException;
  e.code = code;
  return e;
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "hist796-"));
  savedHome = process.env.HOME;
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  hoisted.readdirError = undefined;
});

afterEach(() => {
  if (savedHome === undefined) delete process.env.HOME;
  else process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("an UNREADABLE history directory is not an empty one (#796)", () => {
  it.each(["EACCES", "EPERM", "EIO", "EBUSY"])("throws on %s rather than reporting none", async (code) => {
    hoisted.readdirError = errno(code);

    await expect(listSessions("C:/some/project")).rejects.toThrow(
      /NOT the same as having no saved sessions/,
    );
  });

  it("names the directory, so the reader can go and look", async () => {
    hoisted.readdirError = errno("EACCES");
    await expect(listSessions("C:/some/project")).rejects.toThrow(/projects/);
  });

  it("a MISSING directory is still an empty list — a first run looks like this", async () => {
    // The other direction, and the one that must not regress. Throwing here would
    // turn every fresh install into an error.
    hoisted.readdirError = errno("ENOENT");
    await expect(listSessions("C:/some/project")).resolves.toEqual([]);
  });

  it("ENOTDIR is also a real answer, not an unknown", async () => {
    hoisted.readdirError = errno("ENOTDIR");
    await expect(listSessions("C:/some/project")).resolves.toEqual([]);
  });

  it("an unparseable session FILE is still skipped, not fatal", async () => {
    // Content stays best-effort: one corrupt transcript must not hide the rest.
    // Only the DIRECTORY read changed.
    const dir = join(home, ".claude", "projects", "C--proj");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "broken.jsonl"), "{not json\n");
    writeFileSync(
      join(dir, "good.jsonl"),
      JSON.stringify({ message: { role: "user", content: "hello there" } }) + "\n",
    );

    const out = await listSessions("C:/proj");

    expect(out.map((s) => s.sessionId)).toEqual(["good"]);
  });

  it("a session ENTRY that cannot be read at all is skipped, not fatal", async () => {
    // The malformed-JSON case above is caught by an inner parse guard, so it
    // never reaches the per-file catch — found by mutation, which made that catch
    // rethrow and killed nothing. A DIRECTORY named `*.jsonl` makes readFile
    // throw EISDIR and does reach it. Content stays best-effort; only the
    // directory read changed.
    const dir = join(home, ".claude", "projects", "C--proj2");
    mkdirSync(join(dir, "a-directory.jsonl"), { recursive: true });
    writeFileSync(
      join(dir, "good.jsonl"),
      JSON.stringify({ message: { role: "user", content: "hello there" } }) + "\n",
    );

    const out = await listSessions("C:/proj2");

    expect(out.map((s) => s.sessionId)).toEqual(["good"]);
  });
});
