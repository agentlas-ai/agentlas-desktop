import type { InstalledMcpServer } from "../../shared/types";
import type { McpToolCallOptions, McpToolContentResult } from "../mcp-tools/client";
import type { PersonalDataSourceBatch, PersonalDataSourceBinding, PersonalDataTarget } from "../../shared/one-personal-data";
import type { PersonalDataSourcePort } from "../one/personal-data-connector";
import { PersonalDataConnectorError, validatePersonalDataBinding, validatePersonalDataBatch } from "../one/personal-data-connector";
import { personalDataError, personalDataHash } from "../one/personal-data-store";

export interface PersonalDataMcpReadContract {
  toolName: string; schemaDigest: string;
  /** Adapter declares semantics from the discovered installed plugin schema, never guessed names. */
  encode(input: { target: PersonalDataTarget; cursor: string | null; maxItems: number }): Record<string,unknown>;
  decode(result: McpToolContentResult): PersonalDataSourceBatch;
}
export interface PersonalDataMcpSourceOptions {
  connectorId: string;
  /** Current native inventory and permitted account identity; does not establish a successful read. */
  current(target: PersonalDataTarget): {
    server: InstalledMcpServer; binding: Omit<PersonalDataSourceBinding,"coverage">;
    tools: Array<{name:string;schemaDigest:string;readPermitted:boolean}>;
  };
  history?: PersonalDataMcpReadContract;
  boundedSearch?: PersonalDataMcpReadContract;
  /** Trusted native tool grant checks before and after await. No automatic auth or permission expansion. */
  assertCurrentRead(input: {target:PersonalDataTarget;binding:PersonalDataSourceBinding;serverId:string;toolName:string;schemaDigest:string}): void;
  call?: (server:InstalledMcpServer,name:string,args:Record<string,unknown>,options:McpToolCallOptions)=>Promise<McpToolContentResult|null>;
}

/** Optional installed-plugin adapter. Provider OAuth, history decoding and vendor mappings stay outside OS Core. */
export function createPersonalDataMcpSourcePort(options: PersonalDataMcpSourceOptions): PersonalDataSourcePort {
  const resolve = (target:PersonalDataTarget) => {
    const current=options.current(target);
    if(!current.server.enabled || current.server.configurationValid===false)throw new PersonalDataConnectorError("disconnected");
    const matches=(contract:PersonalDataMcpReadContract|undefined)=>contract && current.tools.filter(t=>t.name===contract.toolName&&t.schemaDigest===contract.schemaDigest&&t.readPermitted).length===1;
    const contract=matches(options.history)?options.history:matches(options.boundedSearch)?options.boundedSearch:undefined;
    if(!contract)throw new PersonalDataConnectorError("unavailable");
    if(!/^[a-f0-9]{64}$/.test(contract.schemaDigest))throw personalDataError("personal_data_plugin_schema_invalid");
    const binding=validatePersonalDataBinding({...current.binding,connectorId:options.connectorId,coverage:contract===options.history?"history":"bounded-search"});
    return {current,contract,binding};
  };
  return {schema:"agentlas.personal-source-port.v1",binding(target){return resolve(target).binding;},async read(input){
    const before=resolve(input.target);
    const check=()=>options.assertCurrentRead({target:input.target,binding:before.binding,serverId:before.current.server.id,toolName:before.contract.toolName,schemaDigest:before.contract.schemaDigest});
    check();input.signal.throwIfAborted();
    const call=options.call ?? (await import("../mcp-tools/client")).callServerToolContent;
    let result:McpToolContentResult|null;
    try {result=await call(before.current.server,before.contract.toolName,before.contract.encode(input),{signal:input.signal,expectedToolSchemaDigest:before.contract.schemaDigest,maxTextChars:1_000_000});}
    catch(error){
      const code=(error as {code?:unknown})?.code;
      if(code==="invalid_cursor"||code==="disconnected"||code==="permission_changed"||code==="partial_failure")throw new PersonalDataConnectorError(code);
      throw new PersonalDataConnectorError("unavailable");
    }
    input.signal.throwIfAborted();check();
    const after=resolve(input.target);
    if(personalDataHash(before.binding)!==personalDataHash(after.binding)||after.current.server.id!==before.current.server.id||after.contract.schemaDigest!==before.contract.schemaDigest)throw new PersonalDataConnectorError("permission_changed");
    if(!result||result.isError)throw new PersonalDataConnectorError("unavailable");
    // Bounded search stays explicitly incomplete in binding.coverage even when its page is complete.
    return validatePersonalDataBatch(before.contract.decode(result),input.maxItems);
  }};
}
