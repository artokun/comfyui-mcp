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
    expect(withText).toMatch(/text stack present: DWrite\.dll/);
    const without = describeMinidump("x", readMinidump(makeDump({ modules: [APP] })));
    expect(without).toMatch(/no DirectWrite\/Direct2D loaded/);
  });
});
