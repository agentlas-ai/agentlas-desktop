import { companionHandoffProofBytes, COMPANION_HANDOFF_PROOF_FIELDS } from "./companion-handoff-proof";
export type FrontRetirementProof="not_started"|"interrupted";
/** No result or model text is accepted on the retirement lane. */
export function companionFrontRetirementBytes(binding:unknown,runId:unknown,proof:unknown):Buffer {
  if(!binding||typeof binding!=="object"||Array.isArray(binding)||(binding as Record<string,unknown>).method!=="one.front-turn.send.v1" ||
     typeof runId!=="string"||!/^[A-Za-z0-9_.:@-]{1,128}$/.test(runId)||(proof!=="not_started"&&proof!=="interrupted"))throw new TypeError("front_retirement_invalid");
  const b=binding as Record<string,unknown>;
  companionHandoffProofBytes({...b,method:"one.work-handoff.send.v1"});
  return Buffer.from(JSON.stringify(["agentlas.companion.front-retirement.v1",...COMPANION_HANDOFF_PROOF_FIELDS.map(field=>b[field]),runId,proof]),"utf8");
}
