import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { ONE_ATTACHMENT_LIMITS } from "../../shared/one-attachments";
import { CHAT_FILE_MEDIA_BY_EXTENSION, hasExpectedImageSignature, persistChatFileBytes } from "../store/chat-message-attachments";

const CHUNK_BYTES = 1024 * 1024;
type Upload = { deviceId: string; chatId?: string; groupId: string; finished: boolean; expiresAt: number; files: Array<{name:string;sourceName:string;size:number;received:number;chunks:Buffer[]}>; result?: ReturnType<typeof persistChatFileBytes> };
/** Process-local, device-bound uploads. Partial bytes never become a conversation attachment. */
export class MobileChatAttachmentUploads {
  private readonly uploads = new Map<string, Upload>();
  private sweep(): void { for (const [id, upload] of this.uploads) if (upload.expiresAt < Date.now()) this.uploads.delete(id); }
  begin(deviceId: string, chatId: string | undefined, files: Array<{name:string;size:number}>): {uploadId:string;chunkBytes:number} {
    this.sweep();
    if (!Array.isArray(files) || !files.length || files.length > ONE_ATTACHMENT_LIMITS.maxCount) throw new TypeError("attachment_count_invalid");
    const active = [...this.uploads.values()].filter(upload => !upload.result);
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (active.length >= 4 || !Number.isSafeInteger(total) || total > ONE_ATTACHMENT_LIMITS.maxTotalBytes || active.reduce((sum, upload) => sum + upload.files.reduce((n, file) => n + file.size, 0), 0) + total > ONE_ATTACHMENT_LIMITS.maxTotalBytes) throw new TypeError("attachment_total_limit");
    const names = new Set<string>();
    const prepared = files.map(file => {
      if (!file || typeof file.name !== "string" || !file.name || file.name.length > 180 || /[\\/:\u0000-\u001f\u007f]/u.test(file.name) || file.name.startsWith(".")) throw new TypeError("attachment_name_invalid");
      const name=file.name.normalize("NFKC").trim();
      if (!name || /[\\/:\u0000-\u001f\u007f]/u.test(name) || name.startsWith(".")) throw new TypeError("attachment_name_invalid");
      const key = name.toLocaleLowerCase("en-US");
      if (names.has(key)) throw new TypeError("attachment_name_collision"); names.add(key);
      const mediaType = CHAT_FILE_MEDIA_BY_EXTENSION[path.extname(name).toLowerCase()];
      if (!mediaType) throw new TypeError("attachment_type_unsupported");
      const limit = ["image/png","image/jpeg","image/gif","image/webp"].includes(mediaType) ? ONE_ATTACHMENT_LIMITS.maxImageBytes : ONE_ATTACHMENT_LIMITS.maxFileBytes;
      if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > limit) throw new TypeError("attachment_file_limit");
      return {...file,name,sourceName:file.name,received:0,chunks:[]};
    });
    const uploadId = randomUUID();
    this.uploads.set(uploadId,{deviceId,chatId,groupId:randomUUID(),finished:false,expiresAt:Date.now()+ONE_ATTACHMENT_LIMITS.capabilityTtlMs,files:prepared});
    return {uploadId,chunkBytes:CHUNK_BYTES};
  }
  private require(deviceId:string,uploadId:string):Upload {
    this.sweep(); const upload=this.uploads.get(uploadId);
    if (!upload || upload.deviceId !== deviceId) throw new Error("attachment_upload_unavailable");
    return upload;
  }
  chunk(deviceId:string,input:{uploadId:string;fileIndex:number;offset:number;data:string}):{receivedBytes:number} {
    const upload=this.require(deviceId,input.uploadId), file=upload.files[input.fileIndex];
    if (upload.finished || !Number.isSafeInteger(input.fileIndex) || !file || !Number.isSafeInteger(input.offset) || input.offset !== file.received) throw new TypeError("attachment_chunk_offset_invalid");
    if (typeof input.data !== "string" || input.data.length > Math.ceil(CHUNK_BYTES/3)*4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(input.data)) throw new TypeError("attachment_chunk_invalid");
    const bytes=Buffer.from(input.data,"base64");
    if (!bytes.length || bytes.length > CHUNK_BYTES || bytes.toString("base64")!==input.data || file.received+bytes.length>file.size) throw new TypeError("attachment_chunk_size_invalid");
    file.chunks.push(bytes);file.received+=bytes.length;
    return {receivedBytes:file.received};
  }
  finish(deviceId:string,uploadId:string):{fileGroupId:string;files:Array<Record<string,unknown>>} {
    const upload=this.require(deviceId,uploadId);
    if (!upload.finished) {
      if (upload.files.some(file=>file.received!==file.size)) throw new Error("attachment_upload_incomplete");
      for (const file of upload.files) {
        const mediaType=CHAT_FILE_MEDIA_BY_EXTENSION[path.extname(file.name).toLowerCase()];
        if (["image/png","image/jpeg","image/gif","image/webp"].includes(mediaType) && !hasExpectedImageSignature(Buffer.concat(file.chunks,file.size),mediaType)) throw new TypeError("attachment_image_signature_invalid");
      }
      upload.finished=true;

    }
    if (upload.chatId && !upload.result) this.bind(deviceId,upload.groupId,upload.chatId);
    return {fileGroupId:upload.groupId,files:upload.result
      ? upload.result.files.map((file,index)=>({sourceName:upload.files[index].sourceName,attachmentId:file.id,groupId:file.groupId,name:file.name,mediaType:file.mediaType,size:file.size,sha256:file.sha256,kind:file.kind}))
      : upload.files.map(file=>({sourceName:file.sourceName,groupId:upload.groupId,name:file.name,mediaType:CHAT_FILE_MEDIA_BY_EXTENSION[path.extname(file.name).toLowerCase()],size:file.size,sha256:createHash("sha256").update(Buffer.concat(file.chunks,file.size)).digest("hex"),kind:"file"}))};
  }
  /** The paired device may bind its freshly uploaded group to exactly one conversation. */
  bind(deviceId:string,groupId:string,chatId:string):void {
    this.sweep();
    const upload=[...this.uploads.values()].find(item=>item.groupId===groupId);
    if (!upload || upload.deviceId!==deviceId || !upload.finished || (upload.chatId && upload.chatId!==chatId)) throw new Error("attachment_upload_unavailable");
    if (!upload.result) {
      upload.result=persistChatFileBytes({chatId,groupId,files:upload.files.map(file=>({name:file.name,bytes:Buffer.concat(file.chunks,file.size)}))});
      upload.chatId=chatId;
      for (const file of upload.files) file.chunks=[];
    }
  }
}
