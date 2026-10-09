import { createHash, randomUUID } from "node:crypto";
import type { McpInvocationRequest, ImageAttachment } from "../../shared/types";
import { NATIVE_WORK_IMAGE_CONTRACT_VERSION, NATIVE_WORK_IMAGE_LIMITS, NATIVE_ONE_IMAGE_CHUNK_CHARS, type NativeWorkImageDescriptor, type NativeWorkImageChunk, type NativeWorkImageComponent } from "../daemon/native-image-transport";
export interface NativeWorkImageChannelIdentity {
    readonly peer: object;
    readonly generation: string;
    readonly serviceIdentity: string;
    readonly bootId: string;
    readonly ownerId: string;
    readonly storeIdentity: string;
}
export interface NativeWorkImageBinding {
    readonly chatId: string;
    readonly runId: string;
    readonly inputDigest: string;
}
export interface NativeWorkImageSnapshot {
    readonly snapshot: unique symbol;
}
export interface NativeWorkImageSnapshotPorts {
    /** Actual native top-frame/window guard PLUS explicit isAppControlEvent denial. */
    authorizeRenderer(event: object): object | null;
    nativeChannelIdentity(channel: object): Readonly<NativeWorkImageChannelIdentity> | null;
    /** Exact current Main canonicalInvocationRequestJson + admission digest version. */
    fingerprintRequest(request: McpInvocationRequest): {
        canonicalRequestJson: string;
        inputDigest: string;
    };
    /** Main's owned synchronous/prepared intake proof, not inferred from missing receipt. */
    assertBeforeStart(binding: NativeWorkImageBinding): void;
    maxPending?: number;
}
export class NativeWorkImageSnapshotError extends Error {
    constructor(readonly code: string) { super(code); }
}
const fail = (code: string): never => { throw new NativeWorkImageSnapshotError(code); };
const sha = (value: string | Buffer) => "sha256:" + createHash("sha256").update(value).digest("hex");
interface Record {
    handle: string;
    sender: object;
    channel: object;
    identity: Readonly<NativeWorkImageChannelIdentity>;
    binding: Readonly<NativeWorkImageBinding>;
    canonicalRequestJson: string;
    images: Array<{
        descriptor: Readonly<NativeWorkImageDescriptor>;
        image: string;
        metadata: string;
    }>;
    closed: boolean;
    offsets: Map<string, number>;
    last: Map<string, NativeWorkImageChunk>;
}
/** Work-only Main snapshot adapter; no registration, DB opening, grants, staging or brain. */
export function createNativeWorkImageSnapshots(ports: NativeWorkImageSnapshotPorts) {
    const privateRecords = new WeakMap<NativeWorkImageSnapshot, Record>(), handles = new Map<string, Record>(), runs = new Map<string, Record>();
    const sameIdentity = (a: Readonly<NativeWorkImageChannelIdentity>, b: Readonly<NativeWorkImageChannelIdentity>) => a.peer === b.peer && a.generation === b.generation && a.serviceIdentity === b.serviceIdentity && a.bootId === b.bootId && a.ownerId === b.ownerId && a.storeIdentity === b.storeIdentity;
    function identity(channel: object) { const value = ports.nativeChannelIdentity(channel); if (!value || !value.peer || typeof value.peer !== "object" || [value.generation, value.serviceIdentity, value.bootId, value.ownerId, value.storeIdentity].some(x => typeof x !== "string" || !x))
        return fail("native_work_image_channel_required"); return value; }
    function record(snapshot: NativeWorkImageSnapshot) { const value = privateRecords.get(snapshot); if (!value)
        return fail("native_work_image_capability_unavailable"); return value; }
    function live(value: Record, channel: object) { if (value.closed)
        return fail("native_work_image_capability_closed"); if (!sameIdentity(identity(channel), value.identity))
        return fail("native_work_image_channel_changed"); }
    function issue(event: object, channel: object, request: McpInvocationRequest): NativeWorkImageSnapshot {
        const sender = ports.authorizeRenderer(event);
        if (!sender || typeof sender !== "object")
            return fail("native_work_image_native_sender_required");
        const channelIdentity = identity(channel);
        if (!request || request.oneMode === true || typeof request.chatId !== "string" || !request.chatId || typeof request.runId !== "string" || !request.runId || !Array.isArray(request.images))
            return fail("native_work_image_request_invalid");
        if (request.images.length > NATIVE_WORK_IMAGE_LIMITS.maxCount)
            return fail("native_work_image_count_unsupported");
        if (handles.size >= (ports.maxPending ?? 32))
            return fail("native_work_image_capacity");
        const key = JSON.stringify([request.chatId, request.runId]);
        if (runs.has(key))
            return fail("native_work_image_already_issued");
        let imagesJson: string;
        try {
            imagesJson = JSON.stringify(request.images);
        }
        catch {
            return fail("native_work_image_request_invalid");
        }
        if (imagesJson.length > NATIVE_WORK_IMAGE_LIMITS.maxImagesJsonCodeUnits)
            return fail("native_work_image_request_too_large");
        const imageDetails: Array<{
            byteLength: number;
            digest: string;
            rawDigest: string;
        }> = [];
        const frozenImages: ImageAttachment[] = request.images.map(image => {
            if (!image || typeof image !== "object" || Array.isArray(image) || Object.keys(image).some(k => !["mediaType", "data", "name"].includes(k)) || typeof image.data !== "string" || typeof image.mediaType !== "string" || !/^image\/[A-Za-z0-9.+-]+$/.test(image.mediaType) || (image.name !== undefined && typeof image.name !== "string") || image.data.length < 4 || image.data.length > 4 * Math.ceil(NATIVE_WORK_IMAGE_LIMITS.maxImageBytes / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.data))
                return fail("native_work_image_request_invalid");
            const bytes = Buffer.from(image.data, "base64");
            if (bytes.length < 1 || bytes.length > NATIVE_WORK_IMAGE_LIMITS.maxImageBytes || bytes.toString("base64") !== image.data)
                return fail("native_work_image_request_invalid");
            imageDetails.push({ byteLength: bytes.length, digest: sha(bytes), rawDigest: sha(image.data) });
            return Object.freeze({ mediaType: image.mediaType, data: image.data, ...(image.name !== undefined ? { name: image.name } : {}) });
        });
        const fingerprint = ports.fingerprintRequest(request);
        if (!fingerprint || typeof fingerprint.canonicalRequestJson !== "string" || !/^[a-f0-9]{64}$/.test(fingerprint.inputDigest))
            return fail("native_work_image_request_binding_invalid");
        const canonical = JSON.parse(fingerprint.canonicalRequestJson) as {
            chatId: string;
            runId: string;
            images: Array<{
                dataSha256: string;
                mediaType: string;
                name?: string;
            }>;
        };
        if (canonical.chatId !== request.chatId || canonical.runId !== request.runId || !Array.isArray(canonical.images) || canonical.images.length !== frozenImages.length || canonical.images.some((image, index) => image.dataSha256 !== sha(frozenImages[index].data).slice(7) || image.mediaType !== frozenImages[index].mediaType || image.name !== frozenImages[index].name))
            return fail("native_work_image_request_binding_invalid");
        const binding = Object.freeze({ chatId: request.chatId, runId: request.runId, inputDigest: fingerprint.inputDigest });
        ports.assertBeforeStart(binding);
        const images = frozenImages.map((image, imageIndex) => { const detail = imageDetails[imageIndex], metadataBytes = Buffer.from(JSON.stringify({ mediaType: image.mediaType, ...(image.name !== undefined ? { name: image.name } : {}) }), "utf8"); if (metadataBytes.length > NATIVE_WORK_IMAGE_LIMITS.maxMetadataJsonBytes)
            return fail("native_work_image_request_too_large"); return { descriptor: Object.freeze({ contractVersion: NATIVE_WORK_IMAGE_CONTRACT_VERSION, imageIndex, byteLength: detail.byteLength, base64Length: image.data.length, digest: detail.digest, rawBase64Digest: detail.rawDigest, metadataJsonByteLength: metadataBytes.length, metadataBase64Length: 4 * Math.ceil(metadataBytes.length / 3), metadataDigest: sha(metadataBytes) }), image: image.data, metadata: metadataBytes.toString("base64") }; });
        const value: Record = { handle: randomUUID(), sender, channel, identity: Object.freeze({ ...channelIdentity }), binding, canonicalRequestJson: fingerprint.canonicalRequestJson, images, closed: false, offsets: new Map(), last: new Map() };
        const snapshot = Object.freeze({}) as NativeWorkImageSnapshot;
        privateRecords.set(snapshot, value);
        handles.set(value.handle, value);
        runs.set(key, value);
        return snapshot;
    }
    function projection(snapshot: NativeWorkImageSnapshot) { const value = record(snapshot); live(value, value.channel); return Object.freeze({ handle: value.handle, binding: value.binding, images: Object.freeze(value.images.map(x => x.descriptor)) }); }
    function readChunk(channel: object, handle: string, expected: NativeWorkImageBinding, request: {
        imageIndex: number;
        component: NativeWorkImageComponent;
        offset: number;
    }): NativeWorkImageChunk {
        const value = handles.get(handle);
        if (!value)
            return fail("native_work_image_capability_unavailable");
        live(value, channel);
        if (!expected || Object.keys(expected).sort().join(",") !== "chatId,inputDigest,runId" || expected.chatId !== value.binding.chatId || expected.runId !== value.binding.runId || expected.inputDigest !== value.binding.inputDigest)
            return fail("native_work_image_binding_changed");
        if (!request || Object.keys(request).sort().join(",") !== "component,imageIndex,offset" || !Number.isSafeInteger(request.imageIndex) || request.imageIndex < 0 || !Number.isSafeInteger(request.offset) || request.offset < 0 || !["metadata", "image"].includes(request.component))
            return fail("native_work_image_offset_invalid");
        const image = value.images[request.imageIndex];
        if (!image)
            return fail("native_work_image_offset_invalid");
        const key = request.imageIndex + ":" + request.component, cached = value.last.get(key);
        if (cached?.offset === request.offset)
            return cached;
        const source = request.component === "image" ? image.image : image.metadata;
        if (request.offset !== (value.offsets.get(key) ?? 0) || request.offset >= source.length)
            return fail("native_work_image_offset_invalid");
        const data = source.slice(request.offset, request.offset + NATIVE_ONE_IMAGE_CHUNK_CHARS), nextOffset = request.offset + data.length, chunk = Object.freeze({ ...image.descriptor, component: request.component, offset: request.offset, nextOffset, done: nextOffset === source.length, data });
        if (Buffer.byteLength(JSON.stringify(chunk), "utf8") > 256 * 1024)
            return fail("native_work_image_chunk_too_large");
        value.offsets.set(key, nextOffset);
        value.last.set(key, chunk);
        return chunk;
    }
    /** Private lifetime/Stop callback; no channel, receipt or state precondition. */
    function cancel(snapshot: NativeWorkImageSnapshot) { record(snapshot).closed = true; }
    function release(snapshot: NativeWorkImageSnapshot) { const value = record(snapshot); value.closed = true; value.images = []; value.last.clear(); value.offsets.clear(); handles.delete(value.handle); runs.delete(JSON.stringify([value.binding.chatId, value.binding.runId])); }
    return { issue, projection, readChunk, cancel, release };
}
