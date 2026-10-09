import { createHash } from "node:crypto";
import type { ImageAttachment } from "../../shared/types";
import { ONE_ATTACHMENT_LIMITS } from "../../shared/one-attachments";

export const NATIVE_ONE_INLINE_IMAGE_VERSION = "agentlas.native.one-inline-image.v1" as const;
export const NATIVE_ONE_INLINE_IMAGE_CHUNK_CHARS = 131_072;
export interface NativeOneInlineImageDescriptor {
  readonly version: typeof NATIVE_ONE_INLINE_IMAGE_VERSION;
  readonly imageIndex: number;
  readonly byteLength: number;
  readonly base64Length: number;
  readonly digest: string;
  readonly rawBase64Digest: string;
}
export interface NativeOneInlineImageChunk extends NativeOneInlineImageDescriptor {
  readonly offset: number;
  readonly nextOffset: number;
  readonly done: boolean;
  readonly data: string;
}
export class NativeOneInlineImageError extends Error {
  constructor(readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new NativeOneInlineImageError(code); };
const hash = (value: string | Buffer) => "sha256:" + createHash("sha256").update(value).digest("hex");
const mediaTypes = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const descriptorKeys = ["version", "imageIndex", "byteLength", "base64Length", "digest", "rawBase64Digest"] as const;
function plain(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}
function exact(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!plain(value)) return false;
  const observed = Object.keys(value);
  return observed.length === keys.length && observed.every(key => keys.includes(key));
}
function decoded(image: ImageAttachment): Buffer {
  // Exact original common chat image policy, without narrowing public metadata.
  // Flat lexical check plus canonical roundtrip avoids nested-regex stack limits.
  if (!image || typeof image !== "object" || !mediaTypes.has(image.mediaType)
    || typeof image.data !== "string" || image.data.length < 4
    || image.data.length > 4 * Math.ceil(ONE_ATTACHMENT_LIMITS.maxImageBytes / 3)
    || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data)) return fail("native_one_inline_image_invalid");
  const bytes = Buffer.from(image.data, "base64");
  if (bytes.length < 1 || bytes.length > ONE_ATTACHMENT_LIMITS.maxImageBytes
    || bytes.toString("base64") !== image.data) return fail("native_one_inline_image_invalid");
  return bytes;
}
/** Data-only snapshot. Only the original private Main issuer selects this One
 * input branch; this helper/descriptor cannot issue an admission or capability. */
export function captureNativeOneInlineImages(images: readonly ImageAttachment[]) {
  if (!Array.isArray(images) || images.length > ONE_ATTACHMENT_LIMITS.maxCount) return fail("native_one_inline_image_count_invalid");
  let closed = false;
  let values = images.map((image, imageIndex) => {
    const bytes = decoded(image);
    return { data: image.data, descriptor: Object.freeze({ version: NATIVE_ONE_INLINE_IMAGE_VERSION,
      imageIndex, byteLength: bytes.length, base64Length: image.data.length,
      digest: hash(bytes), rawBase64Digest: hash(image.data) }) };
  });
  const descriptors = Object.freeze(values.map(value => value.descriptor));
  const offsets = new Map<number, number>(), last = new Map<number, NativeOneInlineImageChunk>();
  function read(request: { imageIndex: number; offset: number }): NativeOneInlineImageChunk {
    if (closed) return fail("native_one_inline_image_closed");
    if (!exact(request, ["imageIndex", "offset"]) || !Number.isSafeInteger(request.imageIndex) || request.imageIndex < 0
      || !Number.isSafeInteger(request.offset) || request.offset < 0) return fail("native_one_inline_image_offset_invalid");
    const value = values[request.imageIndex];
    if (!value) return fail("native_one_inline_image_offset_invalid");
    const cached = last.get(request.imageIndex);
    if (cached?.offset === request.offset) return cached;
    if (request.offset !== (offsets.get(request.imageIndex) ?? 0) || request.offset >= value.data.length) return fail("native_one_inline_image_offset_invalid");
    const data = value.data.slice(request.offset, request.offset + NATIVE_ONE_INLINE_IMAGE_CHUNK_CHARS), nextOffset = request.offset + data.length;
    const chunk = Object.freeze({ ...value.descriptor, offset: request.offset, nextOffset, done: nextOffset === value.data.length, data });
    offsets.set(request.imageIndex, nextOffset); last.set(request.imageIndex, chunk);
    return chunk;
  }
  function cancel(): void { closed = true; }
  function release(): void { closed = true; values = []; offsets.clear(); last.clear(); }
  return Object.freeze({ descriptors, read, cancel, release });
}
/** Metadata comes from the authenticated original request snapshot. Do not
 * normalize names or drop public keys (including original dataSha256). Native
 * host custody must retain this actual promise through Stop, not race it away. */
export async function importNativeOneInlineImages(
  metadata: readonly Readonly<Record<string, unknown>>[], descriptors: readonly NativeOneInlineImageDescriptor[],
  read: (request: { imageIndex: number; offset: number }) => Promise<NativeOneInlineImageChunk>, signal: AbortSignal,
): Promise<ImageAttachment[]> {
  if (!Array.isArray(metadata) || !Array.isArray(descriptors) || metadata.length !== descriptors.length
    || descriptors.length > ONE_ATTACHMENT_LIMITS.maxCount) return fail("native_one_inline_image_descriptor_invalid");
  const held = descriptors.map((descriptor, imageIndex) => {
    if (!exact(descriptor, descriptorKeys) || descriptor.version !== NATIVE_ONE_INLINE_IMAGE_VERSION
      || typeof descriptor.imageIndex !== "number" || descriptor.imageIndex !== imageIndex || typeof descriptor.byteLength !== "number" || !Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 1
      || descriptor.byteLength > ONE_ATTACHMENT_LIMITS.maxImageBytes || typeof descriptor.base64Length !== "number" || !Number.isSafeInteger(descriptor.base64Length)
      || descriptor.base64Length !== 4 * Math.ceil(descriptor.byteLength / 3)
      || typeof descriptor.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(descriptor.digest)
      || typeof descriptor.rawBase64Digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(descriptor.rawBase64Digest)
      || !plain(metadata[imageIndex]) || Object.hasOwn(metadata[imageIndex], "data")
      || !mediaTypes.has(metadata[imageIndex].mediaType as string)) return fail("native_one_inline_image_descriptor_invalid");
    return { descriptor: Object.freeze({ ...descriptor }) as unknown as NativeOneInlineImageDescriptor, metadata: Object.freeze({ ...metadata[imageIndex] }) };
  });
  const images: ImageAttachment[] = [];
  for (const { descriptor, metadata: original } of held) {
    const parts: string[] = [];
    let offset = 0;
    while (offset < descriptor.base64Length) {
      signal.throwIfAborted();
      let chunk: NativeOneInlineImageChunk;
      try { chunk = await read({ imageIndex: descriptor.imageIndex, offset }); }
      catch (error) { signal.throwIfAborted(); throw error; }
      signal.throwIfAborted();
      if (!exact(chunk, [...descriptorKeys, "offset", "nextOffset", "done", "data"])
        || descriptorKeys.some(key => chunk[key] !== descriptor[key]) || chunk.offset !== offset
        || typeof chunk.data !== "string" || chunk.data.length < 1 || chunk.data.length > NATIVE_ONE_INLINE_IMAGE_CHUNK_CHARS
        || chunk.nextOffset !== offset + chunk.data.length || chunk.nextOffset > descriptor.base64Length
        || chunk.done !== (chunk.nextOffset === descriptor.base64Length)) return fail("native_one_inline_image_chunk_invalid");
      parts.push(chunk.data); offset = chunk.nextOffset;
    }
    const data = parts.join("");
    const image = { ...original, data } as unknown as ImageAttachment;
    const bytes = decoded(image);
    if (bytes.length !== descriptor.byteLength || hash(bytes) !== descriptor.digest || hash(data) !== descriptor.rawBase64Digest) return fail("native_one_inline_image_digest_invalid");
    images.push(image);
  }
  signal.throwIfAborted();
  return images;
}
