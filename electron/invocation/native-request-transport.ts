import {createHash} from "node:crypto";
import type {McpInvocationRequest} from "../../shared/types";
export const NATIVE_REQUEST_CHUNK_CHARS=65_536;
export interface NativeRequestBodyDescriptor {version:"agentlas.native.request-body.v1";length:number;byteLength:number;sha256:string}
export interface NativeRequestBodyChunk {offset:number;data:string;done:boolean}
function fail(code:string):never{throw Object.assign(new Error(code),{code});}
const sha=(value:string)=>createHash("sha256").update(value,"utf8").digest("hex");
function exact(value:unknown,keys:readonly string[]):boolean{if(!value||typeof value!=="object"||Array.isArray(value))return false;const prototype=Object.getPrototypeOf(value);if(prototype!==Object.prototype&&prototype!==null)return false;const observed=Object.keys(value);return observed.length===keys.length&&observed.every(key=>keys.includes(key));}
/** Called only on a sanitized Main private issuer, not a renderer/native authority gate. */
export function snapshotNativeRequestBody(request:McpInvocationRequest){
  const {images:_images,...body}=request;const json=JSON.stringify(body);
  if(Buffer.byteLength(json,"utf8")>1_048_576)fail("native_request_body_exceeds_original_admission_limit");
  const descriptor:Readonly<NativeRequestBodyDescriptor>=Object.freeze({version:"agentlas.native.request-body.v1",length:json.length,byteLength:Buffer.byteLength(json),sha256:sha(json)});
  let offset=0;
  return{descriptor,read(expectedOffset:number):NativeRequestBodyChunk{if(expectedOffset!==offset||offset>=json.length)fail("native_request_body_offset_invalid");const data=json.slice(offset,offset+NATIVE_REQUEST_CHUNK_CHARS),chunk=Object.freeze({offset,data,done:offset+data.length===json.length});offset+=data.length;return chunk;}};
}
/** No retry/race: host custody must retain this original promise through Stop. */
export async function importNativeRequestBody(descriptor:Readonly<NativeRequestBodyDescriptor>,read:(offset:number)=>Promise<NativeRequestBodyChunk>,signal:AbortSignal):Promise<Omit<McpInvocationRequest,"images">>{
  if(!exact(descriptor,["version","length","byteLength","sha256"])||descriptor.version!=="agentlas.native.request-body.v1"||!Number.isSafeInteger(descriptor.length)||descriptor.length<2||descriptor.length>1_048_576||!Number.isSafeInteger(descriptor.byteLength)||descriptor.byteLength<2||descriptor.byteLength>1_048_576||!/^[a-f0-9]{64}$/.test(descriptor.sha256))fail("native_request_body_descriptor_invalid");
  const parts:string[]=[];let offset=0;
  while(offset<descriptor.length){signal.throwIfAborted();const chunk=await read(offset);signal.throwIfAborted();if(!exact(chunk,["offset","data","done"])||chunk.offset!==offset||typeof chunk.data!=="string"||chunk.data.length===0||chunk.data.length>NATIVE_REQUEST_CHUNK_CHARS||typeof chunk.done!=="boolean"||offset+chunk.data.length>descriptor.length||chunk.done!==(offset+chunk.data.length===descriptor.length))fail("native_request_body_chunk_invalid");parts.push(chunk.data);offset+=chunk.data.length;}
  const json=parts.join("");if(Buffer.byteLength(json)!==descriptor.byteLength||sha(json)!==descriptor.sha256)fail("native_request_body_digest_mismatch");
  let parsed:unknown;try{parsed=JSON.parse(json);}catch{fail("native_request_body_json_invalid");}
  if(!parsed||typeof parsed!=="object"||Array.isArray(parsed)||Object.hasOwn(parsed,"images"))fail("native_request_body_images_forbidden");
  return parsed as Omit<McpInvocationRequest,"images">;
}
