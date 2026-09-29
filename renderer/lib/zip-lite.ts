/**
 * 작은 ZIP 읽기·다시 쓰기 — xlsx/docx 미리보기용. 새 의존성 없이 DecompressionStream("deflate-raw") 만 쓴다.
 * (file-viewer-document-chrome 의 BoundedZipReader 와 같은 방식, 여기는 다시 쓰기까지 필요해서 따로 둔다.)
 *
 * 한도: 파일 64MB, 항목 하나 16MB. ZIP64·암호화 항목은 거절한다. 브라우저·Node(>=18) 둘 다에서 돈다.
 */

export const ZIP_LIMITS = { maxArchiveBytes: 64 * 1024 * 1024, maxEntryBytes: 16 * 1024 * 1024 } as const;

export interface ZipEntry {
  name: string;
  method: number;
  flags: number;
  crc32: number;
  compressedSize: number;
  size: number;
  modTime: number;
  modDate: number;
  /** 압축된 원본 바이트(로컬 헤더 뒤). 다시 쓸 때 그대로 복사한다. */
  raw: Uint8Array;
}

function u16(view: DataView, offset: number): number { return view.getUint16(offset, true); }
function u32(view: DataView, offset: number): number { return view.getUint32(offset, true); }

export function readZip(buffer: ArrayBuffer | Uint8Array): ZipEntry[] {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength > ZIP_LIMITS.maxArchiveBytes) throw new Error("zip too large");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let offset = bytes.length - 22; offset >= Math.max(0, bytes.length - 65_557); offset -= 1) {
    if (u32(view, offset) === 0x06054b50) { eocd = offset; break; }
  }
  if (eocd < 0) throw new Error("zip directory missing");
  const count = u16(view, eocd + 10);
  let cursor = u32(view, eocd + 16);
  const entries: ZipEntry[] = [];
  for (let index = 0; index < count; index += 1) {
    if (cursor + 46 > bytes.length || u32(view, cursor) !== 0x02014b50) throw new Error("invalid zip directory");
    const flags = u16(view, cursor + 8);
    const method = u16(view, cursor + 10);
    const modTime = u16(view, cursor + 12);
    const modDate = u16(view, cursor + 14);
    const crc32 = u32(view, cursor + 16);
    const compressedSize = u32(view, cursor + 20);
    const size = u32(view, cursor + 24);
    const nameLength = u16(view, cursor + 28);
    const extraLength = u16(view, cursor + 30);
    const commentLength = u16(view, cursor + 32);
    const localOffset = u32(view, cursor + 42);
    if ([compressedSize, size, localOffset].includes(0xffffffff)) throw new Error("zip64 unsupported");
    if (flags & 0x1) throw new Error("encrypted zip unsupported");
    const name = new TextDecoder().decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (localOffset + 30 > bytes.length || u32(view, localOffset) !== 0x04034b50) throw new Error("invalid zip entry");
    const start = localOffset + 30 + u16(view, localOffset + 26) + u16(view, localOffset + 28);
    const end = start + compressedSize;
    if (end > bytes.length) throw new Error("truncated zip entry");
    entries.push({ name, method, flags, crc32, compressedSize, size, modTime, modDate, raw: bytes.subarray(start, end) });
    cursor += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

export async function inflateEntry(entry: ZipEntry): Promise<Uint8Array> {
  if (entry.size > ZIP_LIMITS.maxEntryBytes) throw new Error("zip entry too large");
  if (entry.method === 0) return entry.raw.slice();
  if (entry.method !== 8 || typeof DecompressionStream === "undefined") throw new Error("unsupported zip compression");
  const stream = new Blob([entry.raw.slice()]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > entry.size || total > ZIP_LIMITS.maxEntryBytes) {
      await reader.cancel();
      throw new Error("zip entry exceeds its declared size");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
  return out;
}

export async function entryText(entries: ZipEntry[], name: string): Promise<string | null> {
  const entry = entries.find((item) => item.name === name);
  return entry ? new TextDecoder().decode(await inflateEntry(entry)) : null;
}

let crcTable: Uint32Array | null = null;
export function crc32(data: Uint8Array): number {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i += 1) crc = crcTable[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * 항목을 다시 쓴다. replacements 에 있는 이름은 새 바이트로(무압축 저장), 나머지는 압축 바이트를 그대로 복사.
 */
export function writeZip(entries: ZipEntry[], replacements: Map<string, Uint8Array>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const entry of entries) {
    const replaced = replacements.get(entry.name);
    const name = encoder.encode(entry.name);
    const method = replaced ? 0 : entry.method;
    const raw = replaced ?? entry.raw;
    const crc = replaced ? crc32(replaced) : entry.crc32;
    const size = replaced ? replaced.byteLength : entry.size;
    const flags = (entry.flags & ~0x8) | 0x800; // 데이터 설명자 없음, 이름 UTF-8
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); lv.setUint16(4, 20, true); lv.setUint16(6, flags, true); lv.setUint16(8, method, true);
    lv.setUint16(10, entry.modTime, true); lv.setUint16(12, entry.modDate, true); lv.setUint32(14, crc, true);
    lv.setUint32(18, raw.byteLength, true); lv.setUint32(22, size, true); lv.setUint16(26, name.length, true); lv.setUint16(28, 0, true);
    local.set(name, 30);
    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true); cv.setUint16(4, 20, true); cv.setUint16(6, 20, true); cv.setUint16(8, flags, true);
    cv.setUint16(10, method, true); cv.setUint16(12, entry.modTime, true); cv.setUint16(14, entry.modDate, true); cv.setUint32(16, crc, true);
    cv.setUint32(20, raw.byteLength, true); cv.setUint32(24, size, true); cv.setUint16(28, name.length, true);
    cv.setUint32(42, offset, true);
    central.set(name, 46);
    locals.push(local, raw);
    centrals.push(central);
    offset += local.byteLength + raw.byteLength;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.byteLength, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, entries.length, true); ev.setUint16(10, entries.length, true);
  ev.setUint32(12, centralSize, true); ev.setUint32(16, offset, true);
  const out = new Uint8Array(offset + centralSize + 22);
  let cursor = 0;
  for (const part of [...locals, ...centrals, end]) { out.set(part, cursor); cursor += part.byteLength; }
  return out;
}
