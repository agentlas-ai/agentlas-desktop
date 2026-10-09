import { createHash } from "node:crypto";
import { ONE_ATTACHMENT_LIMITS } from "../../shared/one-attachments";
import type { ImageAttachment } from "../../shared/types";

export class NativeOneImageTransportError extends Error { constructor(readonly code: string) { super(code); } }
const fail = (code: string): never => { throw new NativeOneImageTransportError(code); };

export const NATIVE_ONE_IMAGE_CHUNK_CHARS = 128 * 1024;
export interface NativeOneImageDescriptor { imageIndex: number; name: string; mediaType: string; byteLength: number; base64Length: number; digest: string }
export interface NativeOneImageChunk extends NativeOneImageDescriptor { offset: number; nextOffset: number; done: boolean; data: string }
/** Pure daemon import of already-authenticated Main bytes. This function creates no grant,
 * retries no chunk/claim and starts no brain. Caller retains its actual native capsule binding. */
export async function importNativeOneAttachmentImages(descriptors: readonly NativeOneImageDescriptor[], read: (request: { imageIndex: number; offset: number }) => Promise<NativeOneImageChunk>, signal: AbortSignal): Promise<ImageAttachment[]> {
  if (!Array.isArray(descriptors) || descriptors.length > ONE_ATTACHMENT_LIMITS.maxCount) return fail("one_native_image_metadata_invalid");
  const images: ImageAttachment[] = [];
  for (const [imageIndex, descriptor] of descriptors.entries()) {
    if (!descriptor || Object.keys(descriptor).sort().join(",") !== "base64Length,byteLength,digest,imageIndex,mediaType,name" || descriptor.imageIndex !== imageIndex || typeof descriptor.name !== "string" || descriptor.name.length > 512
      || typeof descriptor.mediaType !== "string" || !/^image\/[A-Za-z0-9.+-]+$/.test(descriptor.mediaType)
      || !Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength <= 0 || descriptor.byteLength > ONE_ATTACHMENT_LIMITS.maxImageBytes
      || descriptor.base64Length !== 4 * Math.ceil(descriptor.byteLength / 3) || !/^sha256:[a-f0-9]{64}$/.test(descriptor.digest)) return fail("one_native_image_metadata_invalid");
    const parts: string[] = []; let offset = 0;
    while (offset < descriptor.base64Length) {
      if (signal.aborted) return fail("one_native_image_transfer_aborted");
      let chunk: NativeOneImageChunk; try { chunk = await read({ imageIndex, offset }); } catch { return fail("one_native_image_transfer_uncertain"); }
      if (signal.aborted) return fail("one_native_image_transfer_aborted");
      if (!chunk || Object.keys(chunk).sort().join(",") !== "base64Length,byteLength,data,digest,done,imageIndex,mediaType,name,nextOffset,offset" || Buffer.byteLength(JSON.stringify(chunk), "utf8") > 256 * 1024 || chunk.imageIndex !== imageIndex || chunk.offset !== offset || chunk.name !== descriptor.name || chunk.mediaType !== descriptor.mediaType
        || chunk.byteLength !== descriptor.byteLength || chunk.base64Length !== descriptor.base64Length || chunk.digest !== descriptor.digest
        || typeof chunk.data !== "string" || !chunk.data || !/^[A-Za-z0-9+/]*={0,2}$/.test(chunk.data)
        || chunk.data.length > NATIVE_ONE_IMAGE_CHUNK_CHARS || chunk.nextOffset !== offset + chunk.data.length || chunk.nextOffset > descriptor.base64Length
        || chunk.done !== (chunk.nextOffset === descriptor.base64Length)) return fail("one_native_image_chunk_invalid");
      parts.push(chunk.data); offset = chunk.nextOffset;
    }
    const data = parts.join(""), bytes = Buffer.from(data, "base64");
    if (bytes.length !== descriptor.byteLength || bytes.toString("base64") !== data
      || "sha256:" + createHash("sha256").update(bytes).digest("hex") !== descriptor.digest) return fail("one_native_image_digest_invalid");
    images.push({ name: descriptor.name, mediaType: descriptor.mediaType, data });
  }
  if (signal.aborted) return fail("one_native_image_transfer_aborted"); return images;
}

/** Work creator policy: work-start.ts27 allows32; ChatInput.ts649 allows5MiB each.
 * Metadata is chunked separately so optional/long names remain exact, not truncated. */
export const NATIVE_WORK_IMAGE_CONTRACT_VERSION = "agentlas.native-work-image.v1" as const;
export const NATIVE_WORK_IMAGE_LIMITS = Object.freeze({ maxCount: 32, maxImageBytes: ONE_ATTACHMENT_LIMITS.maxImageBytes, maxImagesJsonCodeUnits: 32_000_000, maxMetadataJsonBytes: 1024 * 1024 });
export interface NativeWorkImageDescriptor {
  contractVersion: typeof NATIVE_WORK_IMAGE_CONTRACT_VERSION; imageIndex: number;
  byteLength: number; base64Length: number; digest: string; rawBase64Digest: string;
  metadataJsonByteLength: number; metadataBase64Length: number; metadataDigest: string;
}
export type NativeWorkImageComponent = "metadata" | "image";
export interface NativeWorkImageChunk extends NativeWorkImageDescriptor { component: NativeWorkImageComponent; offset: number; nextOffset: number; done: boolean; data: string }
const WORK_DESCRIPTOR_KEYS = "base64Length,byteLength,contractVersion,digest,imageIndex,metadataBase64Length,metadataDigest,metadataJsonByteLength,rawBase64Digest";
const workSha = (data: string | Buffer) => "sha256:" + createHash("sha256").update(data).digest("hex");
/** Explicit native Work32 policy. The read closure retains authenticated channel/capsule
 * binding; JSON labels are not authority. One's existing default8 remains unchanged. */
export async function importNativeWorkImages(descriptors: readonly NativeWorkImageDescriptor[], read: (request: { imageIndex: number; component: NativeWorkImageComponent; offset: number }) => Promise<NativeWorkImageChunk>, signal: AbortSignal): Promise<ImageAttachment[]> {
  if (!Array.isArray(descriptors) || descriptors.length > NATIVE_WORK_IMAGE_LIMITS.maxCount) return fail("native_work_image_metadata_invalid");
  const result: ImageAttachment[] = []; let totalBase64 = 0, totalMetadataBytes = 0;
  for (const [imageIndex, descriptor] of descriptors.entries()) {
    if (!descriptor || Object.keys(descriptor).sort().join(",") !== WORK_DESCRIPTOR_KEYS || descriptor.contractVersion !== NATIVE_WORK_IMAGE_CONTRACT_VERSION || descriptor.imageIndex !== imageIndex
      || !Number.isSafeInteger(descriptor.byteLength) || descriptor.byteLength < 1 || descriptor.byteLength > NATIVE_WORK_IMAGE_LIMITS.maxImageBytes
      || descriptor.base64Length !== 4 * Math.ceil(descriptor.byteLength / 3) || !/^sha256:[a-f0-9]{64}$/.test(descriptor.digest) || !/^sha256:[a-f0-9]{64}$/.test(descriptor.rawBase64Digest)
      || !Number.isSafeInteger(descriptor.metadataJsonByteLength) || descriptor.metadataJsonByteLength < 2 || descriptor.metadataJsonByteLength > NATIVE_WORK_IMAGE_LIMITS.maxMetadataJsonBytes
      || descriptor.metadataBase64Length !== 4 * Math.ceil(descriptor.metadataJsonByteLength / 3) || !/^sha256:[a-f0-9]{64}$/.test(descriptor.metadataDigest)) return fail("native_work_image_metadata_invalid");
    totalMetadataBytes += descriptor.metadataJsonByteLength; if (totalMetadataBytes > NATIVE_WORK_IMAGE_LIMITS.maxMetadataJsonBytes) return fail("native_work_image_metadata_invalid");
    totalBase64 += descriptor.base64Length; if (totalBase64 > NATIVE_WORK_IMAGE_LIMITS.maxImagesJsonCodeUnits) return fail("native_work_image_metadata_invalid");
    async function chunk(component: NativeWorkImageComponent, offset: number) {
      if (signal.aborted) return fail("native_work_image_transfer_aborted");
      let value: NativeWorkImageChunk; try { value = await read({ imageIndex, component, offset }); } catch { return fail("native_work_image_transfer_uncertain"); }
      if (signal.aborted) return fail("native_work_image_transfer_aborted");
      const length = component === "metadata" ? descriptor.metadataBase64Length : descriptor.base64Length;
      if (!value || Object.keys(value).sort().join(",") !== [...WORK_DESCRIPTOR_KEYS.split(","),"component","data","done","nextOffset","offset"].sort().join(",")) return fail("native_work_image_chunk_invalid");
      if (WORK_DESCRIPTOR_KEYS.split(",").some(key => value[key as keyof NativeWorkImageDescriptor] !== descriptor[key as keyof NativeWorkImageDescriptor])
        || value.component !== component || value.offset !== offset || typeof value.data !== "string" || !value.data || value.data.length > NATIVE_ONE_IMAGE_CHUNK_CHARS
        || !/^[A-Za-z0-9+/]*={0,2}$/.test(value.data) || value.nextOffset !== offset + value.data.length || value.nextOffset > length
        || value.done !== (value.nextOffset === length) || Buffer.byteLength(JSON.stringify(value),"utf8") > 256*1024) return fail("native_work_image_chunk_invalid");
      return value;
    }
    const metadataParts: string[] = []; let offset = 0;
    while (offset < descriptor.metadataBase64Length) { const value = await chunk("metadata",offset);metadataParts.push(value.data);offset=value.nextOffset; }
    const metadataBase64=metadataParts.join(""),metadataBytes=Buffer.from(metadataBase64,"base64"),metadataText=metadataBytes.toString("utf8");
    if (metadataBytes.length !== descriptor.metadataJsonByteLength || metadataBytes.toString("base64") !== metadataBase64 || workSha(metadataBytes) !== descriptor.metadataDigest || Buffer.from(metadataText,"utf8").compare(metadataBytes) !== 0) return fail("native_work_image_metadata_invalid");
    let metadata: { mediaType: string; name?: string };try { metadata=JSON.parse(metadataText); } catch { return fail("native_work_image_metadata_invalid"); }
    if (!metadata || typeof metadata !== "object" || Array.isArray(metadata) || Object.keys(metadata).some(key => !["mediaType","name"].includes(key)) || typeof metadata.mediaType !== "string" || !/^image\/[A-Za-z0-9.+-]+$/.test(metadata.mediaType)
      || (Object.hasOwn(metadata,"name") && typeof metadata.name !== "string") || JSON.stringify(metadata) !== metadataText) return fail("native_work_image_metadata_invalid");
    const imageParts:string[]=[];offset=0;
    while(offset<descriptor.base64Length){const value=await chunk("image",offset);imageParts.push(value.data);offset=value.nextOffset;}
    const data=imageParts.join(""),bytes=Buffer.from(data,"base64");
    if(bytes.length!==descriptor.byteLength || bytes.toString("base64")!==data || workSha(bytes)!==descriptor.digest) return fail("native_work_image_digest_invalid");
    if(workSha(data)!==descriptor.rawBase64Digest) return fail("native_work_image_raw_digest_invalid");
    result.push({mediaType:metadata.mediaType,data,...(Object.hasOwn(metadata,"name")?{name:metadata.name}:{})});
  }
  if (JSON.stringify(result).length > NATIVE_WORK_IMAGE_LIMITS.maxImagesJsonCodeUnits) return fail("native_work_image_metadata_invalid");
  if (signal.aborted) return fail("native_work_image_transfer_aborted"); return result;
}
