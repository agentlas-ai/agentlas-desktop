import type { PersonalDataSourceBinding, PersonalDataSourceBatch, PersonalDataTarget } from "../../shared/one-personal-data";
import { personalDataError, personalDataId, personalDataText } from "./personal-data-store";

/** Implemented by an installed connector's permitted read capability. OAuth presence is insufficient. */
export interface PersonalDataSourcePort {
  readonly schema: "agentlas.personal-source-port.v1";
  /** Must resolve the current account and grants; no model-provided account identity. */
  binding(target: PersonalDataTarget): PersonalDataSourceBinding;
  read(input: { target: PersonalDataTarget; cursor: string | null; maxItems: number; signal: AbortSignal }): Promise<PersonalDataSourceBatch>;
}
export type PersonalDataConnectorFailure = "invalid_cursor" | "disconnected" | "permission_changed" | "partial_failure" | "unavailable";
export class PersonalDataConnectorError extends Error {
  constructor(readonly code: PersonalDataConnectorFailure) { super(code); }
}
export function validatePersonalDataBinding(b: PersonalDataSourceBinding): PersonalDataSourceBinding {
  if (!b || !["history","bounded-search"].includes(b.coverage)) throw personalDataError("personal_data_binding_invalid");
  return {sourceId:personalDataId(b.sourceId),connectorId:personalDataId(b.connectorId),accountRef:personalDataId(b.accountRef),
    permissionRevision:personalDataId(b.permissionRevision),credentialGeneration:personalDataId(b.credentialGeneration),purpose:personalDataText(b.purpose,500),coverage:b.coverage};
}
export function validatePersonalDataBatch(batch: PersonalDataSourceBatch, maxItems: number, now = Date.now()): PersonalDataSourceBatch {
  if (!batch || !Array.isArray(batch.items) || batch.items.length > maxItems || typeof batch.complete !== "boolean"
    || !Number.isFinite(Date.parse(batch.observedAt)) || Date.parse(batch.observedAt) > now + 30_000
    || now - Date.parse(batch.observedAt) > 300_000) throw personalDataError("personal_data_batch_invalid");
  const seen = new Set<string>();
  return {sourceRevision:personalDataId(batch.sourceRevision),cursor:batch.cursor === null ? null : personalDataText(batch.cursor,2000),
    nextCursor:batch.nextCursor === null ? null : personalDataText(batch.nextCursor,2000),permissionRevision:personalDataId(batch.permissionRevision),
    credentialGeneration:personalDataId(batch.credentialGeneration),observedAt:batch.observedAt,complete:batch.complete,
    items:batch.items.map(i=>{const id=personalDataId(i.id);if(seen.has(id)||typeof i.deleted!=="boolean")throw personalDataError("personal_data_batch_invalid");seen.add(id);
      return {id,revision:personalDataId(i.revision),sourceRef:personalDataId(i.sourceRef),text:i.deleted?"":personalDataText(i.text),deleted:i.deleted};})};
}
/** Registry owns no collection scheduler, queue, account/token storage or provider-specific wiring. */
export class OnePersonalDataConnectorRegistry {
  private readonly ports = new Map<string,PersonalDataSourcePort>();
  register(connectorId: string, port: PersonalDataSourcePort): () => void {
    personalDataId(connectorId);
    if (port.schema !== "agentlas.personal-source-port.v1" || this.ports.has(connectorId)) throw personalDataError("personal_data_connector_conflict");
    this.ports.set(connectorId,port);
    return ()=>{if(this.ports.get(connectorId)===port)this.ports.delete(connectorId);};
  }
  get(connectorId: string): PersonalDataSourcePort {
    const port=this.ports.get(connectorId);if(!port)throw new PersonalDataConnectorError("unavailable");return port;
  }
}
