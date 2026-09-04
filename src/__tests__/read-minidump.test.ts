// panel#2023 — the crash report that could not be triaged.
//
// Comfy Desktop's renderer dies with `render-process-gone exitCode=-1073741819`
// and takes the ComfyUI server with it, several times a day. Step one of the
// reporter's own fix list is to symbolise the renderer dump — which needs a symbol
// server and a Windows debugging toolchain, so it does not happen, and reports
// arrive quoting a browser error page instead.
//
// The reader does not resolve function names; it answers the three questions that
// decide whether two reports are the same crash, and it answers them from the file
// alone. These pin the distinctions that matter, against SYNTHESISED dumps rather
// than a checked-in binary: a fixture built from the documented layout states what
// the parser is supposed to read, where a 2MB blob would only state what one
// machine happened to produce.

import { describe, expect, it } from "vitest";
// @ts-expect-error plain-JS module under scripts/, no type declarations
import { readMinidump, describeMinidump } from "../../scripts/read-minidump.mjs";

interface Mod {
  base: bigint;
  size: number;
  name: string;
}

/**
 * A minimal but structurally REAL minidump: header, stream directory, exception
 * stream, module list, system info. Built to the documented offsets, so a parser
 * that reads the wrong field fails here rather than on someone's crash.
 */
function makeDump(opts: {
  code?: number;
  address?: bigint;
  modules?: Mod[];
  omitException?: boolean;
  signature?: number;
}): Buffer {
  const modules = opts.modules ?? [];
  const parts: Buffer[] = [];
  const HEADER = 32;
  const streams: Array<{ type: number; size: number; rva: number }> = [];

  // Lay the strings out first so module records can point at them.
  const nameRvas: number[] = [];
  let cursor = HEADER + 3 * 12; // header + 3 directory entries
  const stringBufs: Buffer[] = [];
  for (const m of modules) {
    const utf16 = Buffer.from(m.name, "utf16le");
    const b = Buffer.alloc(4 + utf16.length + 2);
    b.writeUInt32LE(utf16.length, 0);
    utf16.copy(b, 4);
    nameRvas.push(cursor);
    cursor += b.length;
    stringBufs.push(b);
  }

  const exceptionRva = cursor;
  const exception = Buffer.alloc(168);
  exception.writeUInt32LE(1234, 0); // ThreadId
  exception.writeUInt32LE(opts.code ?? 0xc0000005, 8); // ExceptionCode
  exception.writeBigUInt64LE(opts.address ?? 0n, 8 + 16); // ExceptionAddress
  cursor += exception.length;

  const moduleListRva = cursor;
  const moduleList = Buffer.alloc(4 + modules.length * 108);
  moduleList.writeUInt32LE(modules.length, 0);
  modules.forEach((m, i) => {
    const at = 4 + i * 108;
    moduleList.writeBigUInt64LE(m.base, at);
    moduleList.writeUInt32LE(m.size, at + 8);
    moduleList.writeUInt32LE(nameRvas[i], at + 20);
  });
  cursor += moduleList.length;

  const systemInfoRva = cursor;
  const systemInfo = Buffer.alloc(56);
  systemInfo.writeUInt32LE(10, 8);
  systemInfo.writeUInt32LE(0, 12);
  systemInfo.writeUInt32LE(26200, 16);
  cursor += systemInfo.length;

  streams.push({ type: 6, size: exception.length, rva: exceptionRva });
  streams.push({ type: 4, size: moduleList.length, rva: moduleListRva });
  streams.push({ type: 7, size: systemInfo.length, rva: systemInfoRva });
  if (opts.omitException) streams[0] = { type: 3, size: 0, rva: 0 }; // ThreadList instead

  const header = Buffer.alloc(HEADER);
  header.writeUInt32LE(opts.signature ?? 0x504d444d, 0);
  header.writeUInt32LE(streams.length, 8);
  header.writeUInt32LE(HEADER, 12);

  const directory = Buffer.alloc(3 * 12);
  streams.forEach((s, i) => {
    directory.writeUInt32LE(s.type, i * 12);
    directory.writeUInt32LE(s.size, i * 12 + 4);
    directory.writeUInt32LE(s.rva, i * 12 + 8);
  });

  parts.push(header, directory, ...stringBufs, exception, moduleList, systemInfo);
  return Buffer.concat(parts);
}

const DWRITE: Mod = { base: 0x7ff8_0000_0000n, size: 0x100000, name: "C:\\Windows\\System32\\DWrite.dll" };
const APP: Mod = { base: 0x7ff6_0000_0000n, size: 0x8000000, name: "C:\\Program Files\\Comfy Desktop\\Comfy Desktop.exe" };

describe("panel#2023 the reader answers which crash this is", () => {
  it("reads the access violation the report quotes as exitCode=-1073741819", () => {
    // -1073741819 IS 0xC0000005 read as a signed 32-bit int, which is the join
    // between the Electron log line and the dump.
    expect(0xc0000005 | 0).toBe(-1073741819);
    const d = readMinidump(makeDump({ code: 0xc0000005, address: 0x7ff8_0000_1234n, modules: [DWRITE, APP] }));
    expect(d.exception.codeHex).toBe("0xC0000005");
    expect(d.exception.meaning).toMatch(/ACCESS_VIOLATION/);
  });

  it("names the module that owns the faulting address", () => {
    // The whole panel#2023 question: is the fault even in the module the
    // hypothesis blames?
    const d = readMinidump(makeDump({ address: 0x7ff8_0000_1234n, modules: [DWRITE, APP] }));
    expect(d.faultingModule.name).toMatch(/DWrite\.dll$/);
    expect(d.faultingModule.offset).toBe("0x1234");
  });

  it("distinguishes a DELIBERATE breakpoint from a memory fault", () => {
    // Two of the three dumps on the machine I checked were 0x80000003 and
    // Crashpad's simulated code. Reported as "the app crashed", they are
    // indistinguishable from the real thing; they are not the same bug.
    const brk = readMinidump(makeDump({ code: 0x80000003, modules: [APP] }));
    expect(brk.exception.meaning).toMatch(/NOT a memory fault/);
    const sim = readMinidump(makeDump({ code: 0x0517a7ed, modules: [APP] }));
    expect(sim.exception.meaning).toMatch(/SIMULATED|REQUESTED/i);
  });

  it("reports an address inside NO module as null, not as unknown", () => {
    // A jump through a freed pointer is itself a finding. Collapsing it into the
    // same answer as "the module list was unreadable" would hide it.
    const d = readMinidump(makeDump({ address: 0x1n, modules: [DWRITE] }));
    expect(d.faultingModule).toBeNull();
    expect(describeMinidump("x", d)).toMatch(/inside NO loaded module/);
  });

  it("does not throw on a file that is not a minidump", () => {
    // Being handed the wrong file is normal when someone is chasing a crash, and
    // it must not look like a tool failure.
    expect(readMinidump(Buffer.from("not a dump at all")).error).toMatch(/too small|no MDMP/);
    expect(readMinidump(makeDump({ signature: 0xdeadbeef })).error).toMatch(/no MDMP signature/);
    expect(readMinidump(Buffer.alloc(0)).error).toBeTruthy();
  });

  it("says so when the dump carries no exception at all", () => {
    const d = readMinidump(makeDump({ omitException: true, modules: [APP] }));
    expect(d.exception).toBeUndefined();
    expect(describeMinidump("x", d)).toMatch(/not a crash dump/);
  });

  it("reports whether the text stack was even loaded", () => {
    const withText = describeMinidump("x", readMinidump(makeDump({ modules: [DWRITE, APP] })));
    // Labelled "LOADED (not implicated)" since DWrite.dll is loaded in EVERY GUI
    // process — measured on three real Comfy Desktop dumps. The old wording read as
    // a hit to anyone scanning for it, which is the one thing this tool must not do.
    expect(withText).toMatch(/text stack LOADED \(not implicated\): DWrite\.dll/);
    const without = describeMinidump("x", readMinidump(makeDump({ modules: [APP] })));
    expect(without).toMatch(/no DirectWrite\/Direct2D loaded/);
  });
});

describe("#2023 an unread module list is not a finding about the address", () => {
  it("distinguishes 'in NO module' from 'the list could not be read'", () => {
    const base = {
      streamCount: 1,
      modules: [] as Array<{ base: bigint; size: number; name: string }>,
      exception: { codeHex: "0xc0000005", addressHex: "0x7ffd" },
    };
    // undefined: the moduleList stream was missing or out of bounds, so the
    // parser never assigned faultingModule. We know NOTHING about the address.
    const unread = describeMinidump("x", base as never);
    // null: the parser DID read the list and the address matched no module --
    // itself a finding (a jump through a freed pointer).
    const noOwner = describeMinidump("x", { ...base, faultingModule: null } as never);

    expect(unread).toContain("the module list could not be read");
    expect(unread).not.toContain("inside NO loaded module");
    expect(noOwner).toContain("inside NO loaded module");
    expect(noOwner).not.toContain("could not be read");
  });
});

describe("#2023 the report states the verdict, rather than leaving it to be inferred", () => {
  // Found by running the reader on the three REAL Comfy Desktop dumps on this
  // machine. DWrite.dll was listed on every one of them -- including a 37-module
  // dump -- because it is loaded in every GUI process. The old line said "text stack
  // present: DWrite.dll" while the faulting module was Comfy Desktop.exe, which to
  // anyone scanning for "DWrite" reads exactly like a hit, in a tool built to answer
  // that one question.
  const dwrite = { base: 1n, size: 16, name: "C:/Windows/System32/DWrite.dll" };
  const base = {
    streamCount: 1,
    modules: [dwrite],
    exception: { codeHex: "0xc0000005", addressHex: "0x5" },
  };

  it("says NOT the #2023 shape when a text DLL is merely loaded", () => {
    const out = describeMinidump("x", {
      ...base,
      faultingModule: { name: "C:/Program Files/Comfy Desktop/Comfy Desktop.exe", offset: "0x1" },
    } as never);
    expect(out).toContain("is NOT a text-rendering DLL");
    // And the module list must not imply otherwise.
    expect(out).toContain("LOADED (not implicated)");
    expect(out).not.toContain("text stack present");
  });

  it("says it IS the shape when the FAULTING module is the text DLL", () => {
    const out = describeMinidump("x", {
      ...base,
      faultingModule: { name: dwrite.name, offset: "0x1" },
    } as never);
    expect(out).toContain("the FAULTING module is a text-rendering DLL");
  });

  it("refuses a verdict when no faulting module resolved", () => {
    // Neither direction is claimed from an unknown -- the same rule as the test above.
    expect(describeMinidump("x", base as never)).toContain("cannot say either way");
  });
});

// Found by pointing this at three REAL dumps rather than only the fixtures above:
// a genuine 0xC0000006 printed the bare hex and no gloss. That is a materially
// different diagnosis from an access violation — the pager could not read a page,
// which is a failing disk or a mapping that went away, not a pointer bug — and a
// reporter quoting only the number cannot tell those apart. Which is the entire
// premise of this script.
//
// The two corruption codes are here for the same reason and carry the caveat that
// matters for panel#2023: for both, the faulting module is where the damage was
// NOTICED, not where it was done, so "module X faulted" must not be read as
// "module X has the bug".
describe("#2023 exception codes a reporter would otherwise quote as bare hex", () => {
  const glossFor = (code: number) =>
    readMinidump(makeDump({ code, address: 0x7ff8_0000_1234n, modules: [DWRITE] })).exception?.meaning;

  it("names EXCEPTION_IN_PAGE_ERROR", () => {
    expect(glossFor(0xc0000006)).toMatch(/EXCEPTION_IN_PAGE_ERROR/);
    expect(glossFor(0xc0000006)).toMatch(/NOT a pointer bug/);
  });

  it("names the two corruption checks, and says the site is not the cause", () => {
    expect(glossFor(0xc0000409)).toMatch(/STACK_BUFFER_OVERRUN/);
    expect(glossFor(0xc0000409)).toMatch(/not the bug/);
    expect(glossFor(0xc0000374)).toMatch(/HEAP_CORRUPTION/);
    expect(glossFor(0xc0000374)).toMatch(/not where it happened/);
  });

  it("still leaves an unknown code as bare hex rather than inventing a name", () => {
    expect(glossFor(0x1234abcd)).toBeNull();
  });
});

// WHICH PROCESS crashed, which the report did not say. That is not cosmetic for
// panel#2023: a dump can arrive from the wrong place entirely and read as a
// perfectly valid answer to the wrong question. Four dumps in an Electron app's
// Crashpad directory looked like Comfy Desktop's by path alone; the module list
// named them `…\oculus-client\Client.exe`, and a browser- or GPU-process dump is
// likewise not the renderer dump a renderer crash needs.
describe("#2023 the report names the process, not just the fault", () => {
  it("reports the main image from module[0]", () => {
    const d = makeDump({
      code: 0xc0000005,
      address: 0x7ff8_0000_1234n,
      modules: [{ name: "C:/app/Comfy Desktop.exe", base: 0x7ff8_0000_0000n, size: 0x10000 }, DWRITE],
    });
    expect(describeMinidump("x", readMinidump(d))).toMatch(/process\s+C:\/app\/Comfy Desktop\.exe/);
  });

  it("says so plainly when there is no module list to name one", () => {
    const d = makeDump({ code: 0xc0000005, address: 0x1n, modules: [] });
    expect(describeMinidump("x", readMinidump(d))).toMatch(/process\s+<no module list>/);
  });
});

// Crashpad's SIMPLE annotation dictionary carries the Electron/Chromium build.
// That is the correlator a text-stack crash needs: two reports are only the same
// bug if they are the same renderer, and an app version does not give that.
//
// Only the simple dictionary is read. Crashpad also stores per-module annotation
// OBJECTS — where `ptype` lives, naming browser vs renderer vs gpu-process — but a
// first attempt at that nesting read garbage memory, so it is deliberately left
// unparsed. A diagnostic that prints rubbish is worse than one that omits a field.
describe("#2023 the report names the Electron build when the dump carries it", () => {
  it("survives a dump with no CrashpadInfo stream", () => {
    const d = readMinidump(makeDump({ address: 0x1n, modules: [DWRITE] }));
    expect(d.annotations).toEqual({});
    expect(describeMinidump("x", d)).not.toMatch(/built by/);
  });

  it("never invents a build line from an empty dictionary", () => {
    const d = readMinidump(makeDump({ address: 0x1n, modules: [DWRITE] }));
    expect(describeMinidump("x", d)).not.toMatch(/built by\s+\?/);
  });
});
