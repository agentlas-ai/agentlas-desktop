import { createHash } from "node:crypto";
import { companionHandoffProofBytes, companionWorkFullChunkBytes, COMPANION_HANDOFF_PROOF_FIELDS } from "./companion-handoff-proof";
export const COMPANION_FRONT_RESULT_MAX_BYTES=1_048_576;
const id=(x:unknown):x is string=>typeof x==="string" && /^[A-Za-z0-9_.:@-]{1,128}$/.test(x);
/** Front results have their own transcript and cannot become a Work receipt. */
export function companionFrontReceiptBytes(value:unknown):Buffer {
  if(!value || typeof value!=="object" || Array.isArray(value))throw new TypeError("companion_front_receipt_invalid");
  const v=value as Record<string,unknown>,long=Object.hasOwn(v,"fullResultPending"),keys=["binding","runId","state","result","resultDigest","executionModel","executionHost",...(long?["fullResultPending","fullDigest","fullBytes","fullCount"]:[])].sort();
  if(Object.keys(v).sort().join(",")!==keys.join(",") || !v.binding || typeof v.binding!=="object" || Array.isArray(v.binding))throw new TypeError("companion_front_receipt_invalid");
  const b=v.binding as Record<string,unknown>;companionHandoffProofBytes({...b,method:"one.work-handoff.send.v1"});
  if(b.method!=="one.front-turn.send.v1" || typeof b.deviceId!=="string" || !/^[A-Za-z0-9_-]{8,96}$/.test(b.deviceId) ||
    typeof b.turnId!=="string" || !/^trn_[A-Za-z0-9_-]{16}$/.test(b.turnId) || Number(b.contextRevision)<1 || !id(v.runId) ||
    (typeof v.state!=="string" || !["completed","failed","cancelled","interrupted"].includes(v.state)) || typeof v.result!=="string" ||
    Buffer.byteLength(v.result,"utf8")>COMPANION_FRONT_RESULT_MAX_BYTES || Array.from(v.result).length>4_000 || v.result.length>8_000 || /[\p{Cs}]/u.test(v.result) ||
    (v.state==="completed" ? !v.result.trim() : v.result!=="") ||
    typeof v.resultDigest!=="string" || !/^[a-f0-9]{64}$/.test(v.resultDigest) || createHash("sha256").update(v.result,"utf8").digest("hex")!==v.resultDigest ||
    !(v.executionModel===null || (typeof v.executionModel==="string" && v.executionModel.length<=160 && !!v.executionModel.trim() && !/[\p{Cs}\u0000-\u001f\u007f]/u.test(v.executionModel))) ||
    !(v.executionHost===null || (typeof v.executionHost==="string" && ["desktop","daemon","terminal"].includes(v.executionHost))) ||
    (long && (v.fullResultPending!==true || v.state!=="completed" || Array.from(v.result).length>3800 || typeof v.fullDigest!=="string" || !/^[a-f0-9]{64}$/.test(v.fullDigest) ||
      !Number.isSafeInteger(v.fullBytes) || Number(v.fullBytes)<=Buffer.byteLength(v.result,"utf8") || Number(v.fullBytes)>6*1024*1024 ||
      !Number.isSafeInteger(v.fullCount) || Number(v.fullCount)!==Math.ceil(Number(v.fullBytes)/8192))))throw new TypeError("companion_front_receipt_invalid");
  if(Buffer.byteLength(JSON.stringify({receipt:value,signature:"A".repeat(86)}),"utf8")>16*1024)throw new TypeError("companion_front_receipt_invalid");
  return Buffer.from(JSON.stringify([long?"agentlas.companion.front-receipt.v2":"agentlas.companion.front-receipt.v1",...COMPANION_HANDOFF_PROOF_FIELDS.map(field=>b[field]),
    v.runId,v.state,v.result,v.resultDigest,v.executionModel,v.executionHost,...(long?[true,v.fullDigest,v.fullBytes,v.fullCount]:[])]),"utf8");
}

/** Front full-result chunks use the Work shape but a separate signature domain. */
export function companionFrontFullChunkBytes(value:unknown):Buffer {
  const array:unknown=JSON.parse(companionWorkFullChunkBytes(value).toString("utf8"));
  if(!Array.isArray(array))throw new TypeError("companion_front_chunk_invalid");
  array[0]="agentlas.companion.front-full-chunk.v1";return Buffer.from(JSON.stringify(array),"utf8");
}
