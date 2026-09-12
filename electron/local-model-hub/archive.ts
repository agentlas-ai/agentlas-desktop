import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { inflateRawSync } from "node:zlib";

const MAX_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 1024 * 1024 * 1024;
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crc32(bytes: Buffer): number {
  let value = 0xffffffff;
  for (const byte of bytes) value = crcTable[(value ^ byte) & 255]! ^ (value >>> 8);
  return (value ^ 0xffffffff) >>> 0;
}

/** Windows path aliases are rejected even when extraction is being tested on another OS. */
export function safeWindowsArchivePath(value: string): string {
  if (!value || value.length > 512 || /[\x00-\x1f\x7f]/.test(value)) throw new Error("engine_archive_path_rejected");
  const path = value.replaceAll("\\", "/");
  if (path.startsWith("/") || path.includes(":")) throw new Error("engine_archive_path_rejected");
  const trimmed = path.endsWith("/") ? path.slice(0,-1) : path;
  if (!trimmed || trimmed.split("/").some(part => !part || part === "." || part === ".." || /[. ]$/.test(part)
    || /[<>"|?*]/.test(part) || /^(con|conin\$|conout\$|clock\$|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part))) {
    throw new Error("engine_archive_path_rejected");
  }
  return trimmed;
}

type Entry = { name: string; directory: boolean; flags: number; method: number; checksum: number; compressed: number; size: number; offset: number };
export function readEngineZipEntries(archive: Buffer): Entry[] {
  if (archive.length < 22 || archive.length > MAX_ARCHIVE_BYTES) throw new Error("engine_archive_size_rejected");
  let end = -1;
  for (let i = archive.length - 22; i >= Math.max(0, archive.length - 65557); i--) {
    if (archive.readUInt32LE(i) === 0x06054b50 && i + 22 + archive.readUInt16LE(i+20) === archive.length) { end = i; break; }
  }
  if (end < 0) throw new Error("engine_zip_directory_missing");
  const count = archive.readUInt16LE(end+10), centralSize = archive.readUInt32LE(end+12), centralOffset = archive.readUInt32LE(end+16);
  if (archive.readUInt16LE(end+4) || archive.readUInt16LE(end+6) || count !== archive.readUInt16LE(end+8)
    || !count || count > 4096 || centralOffset + centralSize !== end) throw new Error("engine_zip_layout_rejected");
  let cursor = centralOffset, expanded = 0;
  const entries: Entry[] = [], names = new Set<string>();
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || archive.readUInt32LE(cursor) !== 0x02014b50) throw new Error("engine_zip_directory_invalid");
    const flags = archive.readUInt16LE(cursor+8), method = archive.readUInt16LE(cursor+10), checksum = archive.readUInt32LE(cursor+16);
    const compressed = archive.readUInt32LE(cursor+20), size = archive.readUInt32LE(cursor+24);
    const length = archive.readUInt16LE(cursor+28), extra = archive.readUInt16LE(cursor+30), comment = archive.readUInt16LE(cursor+32);
    const attributes = archive.readUInt32LE(cursor+38), offset = archive.readUInt32LE(cursor+42);
    if (cursor+46+length+extra+comment > end || flags & 1 || ![0,8].includes(method) || size > MAX_FILE_BYTES
      || archive.readUInt16LE(cursor+34) || offset === 0xffffffff || compressed === 0xffffffff) throw new Error("engine_zip_entry_unsupported");
    const rawName = archive.subarray(cursor+46,cursor+46+length);
    // Published engine packages use ASCII filenames. Do not guess legacy ZIP encodings.
    if (rawName.some(byte => byte > 127)) throw new Error("engine_zip_filename_encoding_unsupported");
    const sourceName = rawName.toString("utf8"), name = safeWindowsArchivePath(sourceName);
    const fileType = (attributes >>> 16) & 0xf000;
    if (![0,0x4000,0x8000].includes(fileType)) throw new Error("engine_archive_special_file_rejected");
    const directory = sourceName.endsWith("/") || sourceName.endsWith("\\");
    if (directory && size !== 0) throw new Error("engine_zip_directory_invalid");
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error("engine_zip_path_alias_rejected");
    names.add(key);
    expanded += size;
    if (expanded > MAX_EXPANDED_BYTES) throw new Error("engine_zip_expansion_limit");
    if (offset + 30 > centralOffset || archive.readUInt32LE(offset) !== 0x04034b50) throw new Error("engine_zip_local_header_invalid");
    const localLength = archive.readUInt16LE(offset+26), localExtra = archive.readUInt16LE(offset+28);
    if (archive.readUInt16LE(offset+6) !== flags || archive.readUInt16LE(offset+8) !== method
      || !archive.subarray(offset+30,offset+30+localLength).equals(rawName)) throw new Error("engine_zip_header_mismatch");
    if (!(flags & 8) && (archive.readUInt32LE(offset+14) !== checksum || archive.readUInt32LE(offset+18) !== compressed || archive.readUInt32LE(offset+22) !== size)) {
      throw new Error("engine_zip_header_mismatch");
    }
    const dataOffset = offset + 30 + localLength + localExtra;
    if (dataOffset + compressed > centralOffset) throw new Error("engine_zip_data_bounds_rejected");
    entries.push({ name, directory, flags, method, checksum, compressed, size, offset: dataOffset });
    cursor += 46 + length + extra + comment;
  }
  if (cursor !== end) throw new Error("engine_zip_directory_invalid");
  // A file may not become another entry's parent, including case-insensitive aliases.
  const files = new Set(entries.filter(entry => !entry.directory).map(entry => entry.name.toLowerCase()));
  for (const entry of entries) {
    const parts = entry.name.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i++) if (files.has(parts.slice(0,i).join("/"))) throw new Error("engine_zip_path_alias_rejected");
  }
  return entries;
}

export async function extractEngineZip(archivePath: string, destination: string, signal?: AbortSignal): Promise<void> {
  if ((await stat(archivePath)).size > MAX_ARCHIVE_BYTES) throw new Error("engine_archive_size_rejected");
  signal?.throwIfAborted();
  const archive = await readFile(archivePath);
  const entries = readEngineZipEntries(archive);
  for (const entry of entries) {
    signal?.throwIfAborted();
    const output = join(destination, ...entry.name.split("/"));
    if (entry.directory) { await mkdir(output, { recursive: true, mode: 0o700 }); continue; }
    const compressed = archive.subarray(entry.offset, entry.offset+entry.compressed);
    const bytes = entry.method === 0 ? compressed : inflateRawSync(compressed, { maxOutputLength: Math.max(1,entry.size) });
    if (bytes.length !== entry.size || crc32(bytes) !== entry.checksum) throw new Error("engine_zip_content_mismatch");
    await mkdir(dirname(output), { recursive: true, mode: 0o700 });
    await writeFile(output, bytes, { flag: "wx", mode: 0o600 });
  }
}
