import {companionHandoffProofBytes,COMPANION_HANDOFF_PROOF_FIELDS} from "./companion-handoff-proof";
/** Only the active front turn and a fresh nonce may be signed. */
export function companionFrontTurnAuthorityRequestBytes(binding:Record<string,unknown>,runId:string,requestNonce:string):Buffer {
  if(!binding||binding.method!=="one.front-turn.send.v1"||typeof runId!=="string"||!/^[A-Za-z0-9_.:@-]{1,128}$/.test(runId)||
    typeof requestNonce!=="string"||!/^ftr_[A-Za-z0-9_-]{22}$/.test(requestNonce))throw new Error("front_turn_authority_request_invalid");
  companionHandoffProofBytes({...binding,method:"one.work-handoff.send.v1"});
  return Buffer.from(JSON.stringify(["agentlas.companion.front-turn-context.request.v1",...COMPANION_HANDOFF_PROOF_FIELDS.map(k=>binding[k]),runId,requestNonce]),"utf8");
}
