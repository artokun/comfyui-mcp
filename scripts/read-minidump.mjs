// Read a Windows minidump far enough to say WHICH crash it is (panel#2023).
//
//   node scripts/read-minidump.mjs <file.dmp> [more.dmp …]
//
// panel#2023 — Comfy Desktop's renderer dies with `render-process-gone
// exitCode=-1073741819` and takes the ComfyUI server down with it, several times
// a day. Its first requested step is to symbolise the renderer dump against
// Electron symbols. That needs a symbol server and a Windows debugging
// toolchain, so it does not get done, and the reports arrive as a screenshot of
// a browser error page.
//
// The three facts that decide whether two reports are the SAME crash need none of
// that, because they are in the file already:
//
//   * the exception CODE — 0xC0000005 (access violation) is a different bug from
//     0x80000003 (a deliberate breakpoint) or Crashpad's own simulated-dump code,
//     and a report that quotes only "the app crashed" cannot tell them apart;
//   * the faulting ADDRESS;
//   * which loaded MODULE owns that address.
//
// That last one is the whole question on panel#2023, whose hypothesis is a
// DirectWrite text-layout fault. It does not resolve a function name — for that
// the symbols really are needed — but it does say whether the fault is even in
// the module the hypothesis blames, which is what turns "we think it is DWrite"
// into something checkable by whoever has the file.
//
// Structures per the documented layout (MINIDUMP_HEADER, MINIDUMP_DIRECTORY,
// MINIDUMP_EXCEPTION_STREAM, MINIDUMP_MODULE_LIST, MINIDUMP_SYSTEM_INFO). All
// little-endian. Nothing here writes, uploads, or phones anywhere: a crash dump
// contains process memory, so this stays a local read.
import { readFileSync } from "node:fs";

const MDMP_SIGNATURE = 0x504d444d; // 'MDMP'
const STREAM_TYPE = { threadList: 3, moduleList: 4, exception: 6, systemInfo: 7 };
/** MINIDUMP_MODULE is a fixed 108 bytes on both 32- and 64-bit dumps. */
const MODULE_RECORD_BYTES = 108;

/** Exception codes worth naming, because the number alone hides the difference. */
const KNOWN_CODES = new Map([
  [0xc0000005, "EXCEPTION_ACCESS_VIOLATION — a read/write of an address the process does not own"],
  [0xc00000fd, "EXCEPTION_STACK_OVERFLOW"],
  [0xc000001d, "EXCEPTION_ILLEGAL_INSTRUCTION"],
  [0xc0000094, "EXCEPTION_INT_DIVIDE_BY_ZERO"],
  [0x80000003, "EXCEPTION_BREAKPOINT — a deliberate __debugbreak/abort, NOT a memory fault"],
  [0xe0000008, "a RAISED exception (RaiseException), not a hardware fault"],
  [0x0517a7ed, "Crashpad's SIMULATED code — a dump someone REQUESTED, not a crash"],
]);

/** MINIDUMP_STRING: a u32 byte length followed by UTF-16LE. */
function readMinidumpString(buf, rva) {
  if (!rva || rva + 4 > buf.length) return "";
  const bytes = buf.readUInt32LE(rva);
  return buf.toString("utf16le", rva + 4, Math.min(rva + 4 + bytes, buf.length));
}

/**
 * Parse a minidump into the facts above.
 *
 * Returns `{ error }` rather than throwing for anything unreadable — a truncated
 * or non-minidump file is a normal thing to be handed when someone is chasing a
 * crash, and it must not look like a tool failure.
 */
export function readMinidump(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 32) return { error: "file is too small to be a minidump" };
  if (buf.readUInt32LE(0) !== MDMP_SIGNATURE) return { error: "not a minidump (no MDMP signature)" };

  const streamCount = buf.readUInt32LE(8);
  const directoryRva = buf.readUInt32LE(12);
  const streams = new Map();
  for (let i = 0; i < streamCount; i += 1) {
    const at = directoryRva + i * 12;
    if (at + 12 > buf.length) break;
    streams.set(buf.readUInt32LE(at), { size: buf.readUInt32LE(at + 4), rva: buf.readUInt32LE(at + 8) });
  }

  const out = { streamCount, modules: [] };

  const exception = streams.get(STREAM_TYPE.exception);
  if (exception && exception.rva + 40 <= buf.length) {
    const record = exception.rva + 8; // past ThreadId + alignment
    const code = buf.readUInt32LE(record);
    const address = buf.readBigUInt64LE(record + 16);
    out.exception = {
      code,
      codeHex: "0x" + code.toString(16).toUpperCase().padStart(8, "0"),
      meaning: KNOWN_CODES.get(code) ?? null,
      address,
      addressHex: "0x" + address.toString(16),
    };
  }

  const moduleList = streams.get(STREAM_TYPE.moduleList);
  if (moduleList && moduleList.rva + 4 <= buf.length) {
    const count = buf.readUInt32LE(moduleList.rva);
    for (let i = 0; i < count; i += 1) {
      const at = moduleList.rva + 4 + i * MODULE_RECORD_BYTES;
      if (at + MODULE_RECORD_BYTES > buf.length) break;
      out.modules.push({
        base: buf.readBigUInt64LE(at),
        size: buf.readUInt32LE(at + 8),
        name: readMinidumpString(buf, buf.readUInt32LE(at + 20)),
      });
    }
    if (out.exception) {
      const addr = out.exception.address;
      const owner = out.modules.find((m) => addr >= m.base && addr < m.base + BigInt(m.size));
      // NULL, not "unknown": an address inside no loaded module is itself a
      // finding (a jump through a freed pointer), and collapsing it into the
      // same answer as "we could not read the module list" would hide that.
      out.faultingModule = owner ? { name: owner.name, offset: "0x" + (addr - owner.base).toString(16) } : null;
    }
  }

  const systemInfo = streams.get(STREAM_TYPE.systemInfo);
  if (systemInfo && systemInfo.rva + 20 <= buf.length) {
    out.system = {
      major: buf.readUInt32LE(systemInfo.rva + 8),
      minor: buf.readUInt32LE(systemInfo.rva + 12),
      build: buf.readUInt32LE(systemInfo.rva + 16),
    };
  }
  return out;
}

/** The text a bug report should carry. Kept separate so it is testable. */
export function describeMinidump(name, dump) {
  const lines = [`=== ${name} ===`];
  if (dump.error) return [...lines, `  ${dump.error}`].join("\n");
  if (dump.system) lines.push(`  Windows ${dump.system.major}.${dump.system.minor} build ${dump.system.build}`);
  if (dump.exception) {
    lines.push(`  exception  ${dump.exception.codeHex} at ${dump.exception.addressHex}`);
    if (dump.exception.meaning) lines.push(`             ${dump.exception.meaning}`);
  } else {
    lines.push("  exception  <none recorded — not a crash dump>");
  }
  if (dump.faultingModule) {
    lines.push(`  faulting   ${dump.faultingModule.name}+${dump.faultingModule.offset}`);
  } else if (dump.faultingModule === null) {
    // STRICT null. The parser distinguishes "the address is in no module" (a
    // finding: a jump through a freed pointer) from "the module list could not be
    // read" (undefined, a gap in what we know) and says so in its own comment --
    // and this line used to collapse them with a truthiness test, reporting the
    // first for both. That turns a missing stream into a false diagnosis.
    lines.push("  faulting   <the address is inside NO loaded module>");
  } else if (dump.exception) {
    lines.push("  faulting   <unknown — the module list could not be read>");
  }
  const text = dump.modules.filter((m) => /dwrite|d2d1|dcomp|gdi32/i.test(m.name));
  lines.push(
    `  modules    ${dump.modules.length} loaded` +
      (text.length
        ? `; text stack LOADED (not implicated): ${text.map((m) => m.name.split(/[\\/]/).pop()).join(", ")}`
        : "; no DirectWrite/Direct2D loaded"),
  );
  // panel#2023 asks ONE question -- is the faulting module a text-rendering DLL --
  // and the module list answers a different one. DWrite.dll is loaded in every GUI
  // process (present in all three real Comfy Desktop dumps on the machine this was
  // written on, including a 37-module one), so listing it carries no discriminating
  // value and reads, to someone scanning for 'DWrite', exactly like a hit. State the
  // verdict instead of leaving it to be inferred from a list.
  if (dump.faultingModule) {
    const faultingIsText = /dwrite|d2d1|dcomp|gdi32/i.test(dump.faultingModule.name);
    lines.push(
      faultingIsText
        ? '  verdict    the FAULTING module is a text-rendering DLL -- the panel#2023 shape'
        : '  verdict    the faulting module is NOT a text-rendering DLL -- not the panel#2023 shape',
    );
  } else {
    lines.push('  verdict    <no faulting module resolved -- cannot say either way>');
  }
  return lines.join("\n");
}

const invokedDirectly =
  process.argv[1] && process.argv[1].replace(/\\/g, "/").endsWith("scripts/read-minidump.mjs");
if (invokedDirectly) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: node scripts/read-minidump.mjs <file.dmp> [more.dmp …]");
    console.error("Windows Crashpad dumps live under %APPDATA%/<app>/Crashpad/reports/.");
    process.exit(2);
  }
  for (const file of files) {
    let buf;
    try {
      buf = readFileSync(file);
    } catch (err) {
      console.log(describeMinidump(file, { error: `could not read: ${err.message}` }));
      continue;
    }
    console.log(describeMinidump(file, readMinidump(buf)));
    console.log("");
  }
}
