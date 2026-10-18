// Reads single entries out of ZIP files (jars, the JDK's lib/src.zip) without unpacking them: the central directory is
// read once per archive and each entry is inflated on demand. Stored and deflated entries, and ZIP64 archives, are
// supported, which is everything jar and src.zip writers produce. No vscode import: unit-testable.

import * as fs from "fs";
import * as zlib from "zlib";

interface Entry {
  method: number;
  compressedSize: number;
  localHeader: number;
}

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

export class ZipArchive {
  private constructor(private readonly file: string, private readonly entries: Map<string, Entry>, private readonly modified: number) {}

  private static cache = new Map<string, ZipArchive>();

  /** The archive at `file`, read once and reused until the file changes; undefined when it is not a readable ZIP. */
  static open(file: string): ZipArchive | undefined {
    let modified: number;
    try {
      modified = fs.statSync(file).mtimeMs;
    } catch {
      return undefined;
    }
    const cached = ZipArchive.cache.get(file);
    if (cached && cached.modified === modified) return cached;
    try {
      const archive = new ZipArchive(file, readDirectory(file), modified);
      ZipArchive.cache.set(file, archive);
      return archive;
    } catch {
      return undefined;
    }
  }

  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** The names of the entries, in archive order. */
  names(): string[] {
    return [...this.entries.keys()];
  }

  /** The entry's bytes, or undefined when the archive has no such entry. */
  read(name: string): Buffer | undefined {
    const entry = this.entries.get(name);
    if (!entry) return undefined;
    const fd = fs.openSync(this.file, "r");
    try {
      const header = Buffer.alloc(30);
      fs.readSync(fd, header, 0, 30, entry.localHeader);
      if (header.readUInt32LE(0) !== LOCAL) throw new Error("bad local header for " + name);
      const start = entry.localHeader + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
      const data = Buffer.alloc(entry.compressedSize);
      fs.readSync(fd, data, 0, entry.compressedSize, start);
      if (entry.method === 0) return data;
      if (entry.method === 8) return zlib.inflateRawSync(data);
      throw new Error("unsupported compression method " + entry.method + " for " + name);
    } finally {
      fs.closeSync(fd);
    }
  }

  readText(name: string): string | undefined {
    return this.read(name)?.toString("utf8");
  }
}

function readDirectory(file: string): Map<string, Entry> {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    // The end record is in the last 64 KiB + 22 bytes (its comment is at most 65535 bytes).
    const tailLength = Math.min(size, 65557);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(fd, tail, 0, tailLength, size - tailLength);
    let eocd = -1;
    for (let i = tailLength - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error("not a zip file");
    let count = tail.readUInt16LE(eocd + 10);
    let directorySize = tail.readUInt32LE(eocd + 12);
    let directoryOffset = tail.readUInt32LE(eocd + 16);
    if (eocd >= 20 && tail.readUInt32LE(eocd - 20) === ZIP64_LOCATOR) {
      const record = Number(tail.readBigUInt64LE(eocd - 20 + 8));
      const zip64 = Buffer.alloc(56);
      fs.readSync(fd, zip64, 0, 56, record);
      if (zip64.readUInt32LE(0) === ZIP64_EOCD) {
        count = Number(zip64.readBigUInt64LE(32));
        directorySize = Number(zip64.readBigUInt64LE(40));
        directoryOffset = Number(zip64.readBigUInt64LE(48));
      }
    }
    const directory = Buffer.alloc(directorySize);
    fs.readSync(fd, directory, 0, directorySize, directoryOffset);
    const entries = new Map<string, Entry>();
    let at = 0;
    for (let i = 0; i < count && at + 46 <= directory.length; i++) {
      if (directory.readUInt32LE(at) !== CENTRAL) break;
      const method = directory.readUInt16LE(at + 10);
      let compressedSize = directory.readUInt32LE(at + 20);
      const nameLength = directory.readUInt16LE(at + 28);
      const extraLength = directory.readUInt16LE(at + 30);
      const commentLength = directory.readUInt16LE(at + 32);
      let localHeader = directory.readUInt32LE(at + 42);
      const name = directory.toString("utf8", at + 46, at + 46 + nameLength);
      if (compressedSize === 0xffffffff || localHeader === 0xffffffff) {
        // ZIP64 extra field: the 8-byte values that overflowed, in the order uncompressed, compressed, offset.
        let extra = at + 46 + nameLength;
        const extraEnd = extra + extraLength;
        while (extra + 4 <= extraEnd) {
          const id = directory.readUInt16LE(extra);
          const length = directory.readUInt16LE(extra + 2);
          if (id === 0x0001) {
            let field = extra + 4;
            if (directory.readUInt32LE(at + 24) === 0xffffffff) field += 8;
            if (compressedSize === 0xffffffff) {
              compressedSize = Number(directory.readBigUInt64LE(field));
              field += 8;
            }
            if (localHeader === 0xffffffff) localHeader = Number(directory.readBigUInt64LE(field));
          }
          extra += 4 + length;
        }
      }
      entries.set(name, { method, compressedSize, localHeader });
      at += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
  } finally {
    fs.closeSync(fd);
  }
}
