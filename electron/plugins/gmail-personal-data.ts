import type Database from "better-sqlite3";
import type { InstalledMcpServer, McpServerStatus } from "../../shared/types";
import type { McpToolCallOptions, McpToolContentResult } from "../mcp-tools/client";
import type { PersonalDataSourceBinding, PersonalDataSourceBatch, PersonalDataSourceItem, PersonalDataTarget, PersonalDataCollectInput, PersonalDataCollectionReceipt } from "../../shared/one-personal-data";
import type { PersonalDataSourcePort } from "../one/personal-data-connector";
import { PersonalDataConnectorError, validatePersonalDataBatch } from "../one/personal-data-connector";
import { personalDataError, personalDataHash, personalDataId, personalDataTarget, personalDataText } from "../one/personal-data-store";

type Tool=McpServerStatus["tools"][number];
type RecordValue=Record<string,unknown>;
export interface GmailCurrentReadConsent {
  principalRef:string; sessionRevision:string; consentRevision:string; permissionRevision:string; credentialGeneration:string;
  purpose:string; query:string; labelIds:string[]; allowMessageBody:boolean; allowHistory:boolean;
  /** Exact scope/audience/source grant, supplied by native current Business/personal authority. */
  audienceGrantRevision:string;
}
export interface GmailProfile { stableIdentity:string; historyId:string|null }
export interface GmailMessage { id:string; historyId:string|null; labelIds:string[]; subject:string; body:string }
export interface GmailHistoryPage { historyId:string; nextPageToken:string|null; changes:Array<{id:string;deleted:boolean}> }
export interface GmailPersonalCodecs {
  profile(result:McpToolContentResult):GmailProfile;
  search(result:McpToolContentResult):{ids:string[];nextPageToken:string|null};
  message(result:McpToolContentResult):GmailMessage;
}
/** Only an explicitly supported installed-plugin semantic contract can claim history coverage. */
export interface GmailDiscoveredHistoryContract {
  toolName:string; expectedSchemaDigest:string;
  encode(input:{startHistoryId:string;pageToken:string|null;maxResults:number;labelIds:string[]}):RecordValue;
  decode(result:McpToolContentResult):GmailHistoryPage;
}
export interface GmailPersonalNativePorts {
  db:Database.Database;
  getServer(id:string):InstalledMcpServer|null;
  testServerById(id:string):Promise<McpServerStatus>;
  schemaDigest(tool:Tool):string;
  call(server:InstalledMcpServer,name:string,args:RecordValue,options:McpToolCallOptions):Promise<McpToolContentResult|null>;
  registerSource(id:string,registration:{label:string;port:PersonalDataSourcePort;assertConsent(target:PersonalDataTarget):string}):()=>void;
}
export interface GmailPersonalSourceOptions {
  serverId:string; target:PersonalDataTarget; connectorId?:string;
  consent:{current(target:PersonalDataTarget):GmailCurrentReadConsent;assertRead(input:{target:PersonalDataTarget;serverId:string;toolName:string;messageId?:string}):void;
    /** Native current grant must match the actual profile account, not merely an installed server/principal. */
    assertAccount(input:{target:PersonalDataTarget;serverId:string;accountRef:string}):void};
  codecs?:GmailPersonalCodecs; history?:GmailDiscoveredHistoryContract;
  native?:GmailPersonalNativePorts;
  /** Main owns prepared account/credential custody. Never accepts raw secrets. */
  callOptions?:()=>Pick<McpToolCallOptions,"prepared">;
}
type Cursor={v:1;mode:"search"|"history";accountRef:string;consentDigest:string;historyId:string|null;pageToken:string|null;pending:Array<{id:string;deleted:boolean}>;nextHistoryId:string|null;nextPageToken:string|null};
class GmailMissingMessageError extends Error {}

function record(v:unknown):RecordValue {if(!v||typeof v!=="object"||Array.isArray(v))throw new PersonalDataConnectorError("unavailable");return v as RecordValue;}
function providerId(v:unknown):string {if(typeof v!=="string"||!/^[A-Za-z0-9_-]{1,64}$/.test(v))throw new PersonalDataConnectorError("unavailable");return v;}
function token(v:unknown):string|null {if(v===undefined||v===null)return null;return personalDataText(v,1000);}
function payload(result:McpToolContentResult,context:"generic"|"message"|"history"="generic"):RecordValue {
  let value:RecordValue;try{value=record(JSON.parse(result.text));}catch{throw new PersonalDataConnectorError("unavailable");}
  const error=value.error&&typeof value.error==="object"?record(value.error):null;
  if(error?.code===404){if(context==="message")throw new GmailMissingMessageError();throw new PersonalDataConnectorError(context==="history"?"invalid_cursor":"unavailable");}
  if(error?.code===401)throw new PersonalDataConnectorError("disconnected");
  if(error?.code===403)throw new PersonalDataConnectorError("permission_changed");
  if(result.isError||error)throw new PersonalDataConnectorError("unavailable");return value;
}
function mimeText(raw:unknown,depth=0):string {
  if(!raw||depth>8)return "";const p=record(raw),body=p.body&&typeof p.body==="object"?record(p.body):null;
  const own=p.mimeType==="text/plain"&&typeof body?.data==="string"?Buffer.from(body.data,"base64url").toString("utf8"):"";
  const nested=Array.isArray(p.parts)?p.parts.slice(0,32).map(i=>mimeText(i,depth+1)).join("\n"):"";
  return personalDataText(`${own}\n${nested}`.trim(),100_000);
}
/** Direct Gmail API JSON representation only. Other plugin wrappers must supply explicit codecs. */
export const gmailApiJsonCodecs:GmailPersonalCodecs={
  profile(result){const p=payload(result);if(typeof p.emailAddress!=="string"||!p.emailAddress.includes("@"))throw new PersonalDataConnectorError("unavailable");return {stableIdentity:p.emailAddress.trim().toLowerCase(),historyId:p.historyId===undefined?null:providerId(String(p.historyId))};},
  search(result){const p=payload(result);if(!Array.isArray(p.messages)&&!(p.messages===undefined&&p.resultSizeEstimate===0))throw new PersonalDataConnectorError("unavailable");return {ids:((p.messages??[]) as unknown[]).map(v=>providerId(record(v).id)),nextPageToken:token(p.nextPageToken)};},
  message(result){const p=payload(result,"message"),part=p.payload?record(p.payload):{};const headers=Array.isArray(part.headers)?part.headers.map(record):[];
    if(!Array.isArray(p.labelIds))throw new PersonalDataConnectorError("unavailable");
    return {id:providerId(p.id),historyId:p.historyId===undefined?null:providerId(String(p.historyId)),labelIds:p.labelIds.map(providerId),subject:personalDataText(headers.find(h=>String(h.name).toLowerCase()==="subject")?.value??"",1000),body:mimeText(part)};}
};
export function decodeGmailApiHistory(result:McpToolContentResult):GmailHistoryPage {
  const p=payload(result,"history");if(!Array.isArray(p.history)&&p.history!==undefined)throw new PersonalDataConnectorError("unavailable");
  const changes=new Map<string,{id:string;deleted:boolean}>();
  for(const h of (p.history??[]) as unknown[]){const row=record(h);
    for(const field of ["messagesAdded","labelsAdded","labelsRemoved","messagesDeleted"]){const events=row[field];if(events===undefined)continue;if(!Array.isArray(events))throw new PersonalDataConnectorError("unavailable");
      for(const e of events){const id=providerId(record(record(e).message).id);changes.set(id,{id,deleted:field==="messagesDeleted"});}}
  }
  return {historyId:providerId(String(p.historyId)),nextPageToken:token(p.nextPageToken),changes:[...changes.values()]};
}
function descriptor(tools:Tool[],name:string,properties:string[]):Tool {
  const found=tools.filter(t=>t.name===name);if(found.length!==1)throw new PersonalDataConnectorError("unavailable");
  const schema=record(found[0].inputSchema),props=schema.properties?record(schema.properties):{};
  if(schema.type!=="object"||properties.some(p=>!(p in props)))throw new PersonalDataConnectorError("unavailable");return found[0];
}
function consent(options:GmailPersonalSourceOptions,target:PersonalDataTarget):GmailCurrentReadConsent {
  personalDataTarget(target);const c=options.consent.current(target);
  if(!c.principalRef||!c.sessionRevision||!c.consentRevision||!c.permissionRevision||!c.credentialGeneration||!c.audienceGrantRevision
    ||typeof c.purpose!=="string"||typeof c.query!=="string"||!c.purpose.trim()||!c.query.trim()||c.query.length>500||!Array.isArray(c.labelIds)||c.labelIds.length>16
    ||typeof c.allowHistory!=="boolean"||typeof c.allowMessageBody!=="boolean")throw new PersonalDataConnectorError("permission_changed");
  c.labelIds.forEach(providerId);return c;
}
async function defaultNative():Promise<GmailPersonalNativePorts> {
  const [store,registry,client,schema,runtime]=await Promise.all([import("../store/db"),import("../mcp-tools/registry"),import("../mcp-tools/client"),import("../mcp-tools/tool-schema"),import("../one/personal-data-runtime")]);
  return {db:store.getDb(),getServer:registry.getServer,testServerById:client.testServerById,schemaDigest:schema.mcpToolSchemaDigest,call:client.callServerToolContent,registerSource:runtime.registerOnePersonalSource};
}
/** Calls only after explicit current native consent. No OAuth creation, API grant, connector install or ready status is inferred. */
export async function createInstalledGmailPersonalSource(options:GmailPersonalSourceOptions):Promise<{port:PersonalDataSourcePort;assertConsent(target:PersonalDataTarget):string;native:GmailPersonalNativePorts}> {
  const target=personalDataTarget(options.target),connectorId=options.connectorId??"gmail",before=JSON.parse(JSON.stringify(consent(options,target))) as GmailCurrentReadConsent;
  options.consent.assertRead({target,serverId:options.serverId,toolName:"inventory"});
  const native=options.native??await defaultNative(),server=native.getServer(options.serverId);
  if(!server?.enabled||server.configurationValid===false)throw new PersonalDataConnectorError("disconnected");
  const consentDigest=personalDataHash(before),configDigest=personalDataHash(server),inventory=await native.testServerById(server.id);
  options.consent.assertRead({target,serverId:server.id,toolName:"inventory"});
  if(personalDataHash(consent(options,target))!==personalDataHash(before)||inventory.id!==server.id||configDigest!==personalDataHash(native.getServer(server.id)))throw new PersonalDataConnectorError("permission_changed");
  if(!inventory.connected)throw new PersonalDataConnectorError(inventory.failureCode==="authentication_required"?"disconnected":"unavailable");
  const tools={profile:descriptor(inventory.tools,"gmail_get_profile",[]),search:descriptor(inventory.tools,"gmail_search_email_ids",["query","max_results","next_page_token",...(before.labelIds.length?["label_ids"]:[])]),read:descriptor(inventory.tools,"gmail_read_email",["message_id","format"])};
  const historyMatches=before.allowHistory&&options.history?inventory.tools.filter(t=>t.name===options.history!.toolName&&native.schemaDigest(t)===options.history!.expectedSchemaDigest):[];
  const historyTool=historyMatches.length===1?historyMatches[0]:undefined;
  if(before.allowHistory&&options.history&&!historyTool)throw new PersonalDataConnectorError("unavailable");
  const codecs=options.codecs??gmailApiJsonCodecs,observedAt=()=>new Date().toISOString();
  let accountRef:string|null=null;
  const check=(scopeTarget:PersonalDataTarget,tool:Tool,messageId?:string)=>{
    if(personalDataHash(scopeTarget)!==personalDataHash(target))throw new PersonalDataConnectorError("permission_changed");
    options.consent.assertRead({target:scopeTarget,serverId:server.id,toolName:tool.name,...(messageId?{messageId}:{})});
    if(accountRef!==null)options.consent.assertAccount({target:scopeTarget,serverId:server.id,accountRef});
    const current=consent(options,scopeTarget);
    if(personalDataHash(current)!==personalDataHash(before)||configDigest!==personalDataHash(native.getServer(server.id)))throw new PersonalDataConnectorError("permission_changed");return current;
  };
  const call=async(tool:Tool,args:RecordValue,signal:AbortSignal,messageId?:string):Promise<McpToolContentResult>=>{
    check(target,tool,messageId);signal.throwIfAborted();let result:McpToolContentResult|null;
    try{result=await native.call(server,tool.name,args,{...options.callOptions?.(),signal,expectedToolSchemaDigest:native.schemaDigest(tool),maxTextChars:1_000_000});}
    catch(e){const status=(e as {status?:unknown;statusCode?:unknown;code?:unknown});if(status.status===404||status.statusCode===404||status.code===404){if(tool.name===tools.read.name)throw new GmailMissingMessageError();throw new PersonalDataConnectorError(tool.name===historyTool?.name?"invalid_cursor":"unavailable");}
      if(status.status===401||status.statusCode===401)throw new PersonalDataConnectorError("disconnected");if(status.status===403||status.statusCode===403)throw new PersonalDataConnectorError("permission_changed");throw new PersonalDataConnectorError("unavailable");}
    signal.throwIfAborted();check(target,tool,messageId);if(!result)throw new PersonalDataConnectorError("unavailable");return result;
  };
  const resolveProfile=async(signal:AbortSignal)=>{const p=codecs.profile(await call(tools.profile,{},signal));
    const ref=`gmail-account:${personalDataHash([before.principalRef,server.id,p.stableIdentity])}`;
    if(accountRef!==null&&accountRef!==ref)throw new PersonalDataConnectorError("permission_changed");
    options.consent.assertAccount({target,serverId:server.id,accountRef:ref});accountRef=ref;return p;};
  const profile=await resolveProfile(new AbortController().signal);
  if(historyTool&&!profile.historyId)throw new PersonalDataConnectorError("unavailable");
  native.db.exec("CREATE TABLE IF NOT EXISTS one_gmail_personal_connections(binding_key TEXT PRIMARY KEY,value_json TEXT NOT NULL)");
  const metadata={schema:"agentlas.gmail-personal-connection.v1",target,serverId:server.id,accountRef,consentDigest:personalDataHash(before),
    toolDigests:Object.fromEntries(Object.values(tools).map(t=>[t.name,native.schemaDigest(t)])),historyTool:historyTool?{name:historyTool.name,digest:native.schemaDigest(historyTool)}:null,verifiedProfileAt:observedAt(),coverage:historyTool?"history":"bounded-search",
    baselineCoverage:"approved-bounded-query",incrementalCoverage:historyTool?"provider-history-after-bootstrap-checkpoint":"bounded-search-incomplete"};
  check(target,tools.profile);
  native.db.prepare("INSERT INTO one_gmail_personal_connections VALUES(?,?) ON CONFLICT(binding_key) DO UPDATE SET value_json=excluded.value_json").run(personalDataHash([target,server.id,accountRef,connectorId,consentDigest]),JSON.stringify(metadata));
  const binding=(scopeTarget:PersonalDataTarget):PersonalDataSourceBinding=>{check(scopeTarget,tools.profile);return {sourceId:`gmail:${personalDataHash([target,server.id,accountRef,connectorId,consentDigest]).slice(0,32)}`,connectorId,accountRef:accountRef!,permissionRevision:personalDataHash([before.permissionRevision,before.consentRevision,before.audienceGrantRevision]),credentialGeneration:before.credentialGeneration,purpose:before.purpose,coverage:historyTool?"history":"bounded-search"};};
  const encode=(c:Cursor)=>{const value=JSON.stringify(c);if(value.length>2000)throw new PersonalDataConnectorError("partial_failure");return value;};
  const item=(id:string,message:GmailMessage|null):PersonalDataSourceItem=>{const ref=`gmail-message:${personalDataHash([accountRef,id])}`;
    return {id:ref,sourceRef:ref,deleted:message===null,revision:`gmail-revision:${personalDataHash(message??[id,"deleted"])}`,text:message?personalDataText(JSON.stringify({subject:message.subject,labels:message.labelIds,body:before.allowMessageBody?message.body:undefined}),100_000):""};};
  const port:PersonalDataSourcePort={schema:"agentlas.personal-source-port.v1",binding,async read(input){
    binding(input.target);const p=await resolveProfile(input.signal);let cursor:Cursor;
    if(input.cursor===null)cursor={v:1,mode:"search",accountRef:accountRef!,consentDigest,historyId:historyTool?p.historyId??profile.historyId:null,pageToken:null,pending:[],nextHistoryId:null,nextPageToken:null};
    else {try{cursor=record(JSON.parse(input.cursor)) as unknown as Cursor;}catch{throw new PersonalDataConnectorError("invalid_cursor");}
      if(cursor.v!==1||cursor.accountRef!==accountRef||cursor.consentDigest!==consentDigest||!["search","history"].includes(cursor.mode)||!Array.isArray(cursor.pending)||cursor.pending.length>100)throw new PersonalDataConnectorError("invalid_cursor");}
    let changes=cursor.pending,nextPage=cursor.nextPageToken,nextHistory=cursor.nextHistoryId;
    if(!changes.length){
      if(cursor.mode==="search"){const search=codecs.search(await call(tools.search,{query:before.query,max_results:Math.min(25,input.maxItems),...(before.labelIds.length?{label_ids:before.labelIds}:{}),...(cursor.pageToken?{next_page_token:cursor.pageToken}:{})},input.signal));
        if(search.ids.length>Math.min(25,input.maxItems))throw new PersonalDataConnectorError("partial_failure");changes=search.ids.map(id=>({id:providerId(id),deleted:false}));nextPage=search.nextPageToken;nextHistory=cursor.historyId;}
      else {if(!historyTool||!options.history||!cursor.historyId)throw new PersonalDataConnectorError("invalid_cursor");
        const history=options.history.decode(await call(historyTool,options.history.encode({startHistoryId:cursor.historyId,pageToken:cursor.pageToken,maxResults:Math.min(25,input.maxItems),labelIds:before.labelIds}),input.signal));
        if(history.changes.length>100)throw new PersonalDataConnectorError("partial_failure");changes=history.changes.map(c=>({id:providerId(c.id),deleted:c.deleted}));nextPage=history.nextPageToken;nextHistory=providerId(history.historyId);}
    }
    const items:PersonalDataSourceItem[]=[];let failedAt=-1;
    for(let i=0;i<changes.length;i++){
      const change=changes[i];if(items.length>=input.maxItems){failedAt=i;break;}
      if(change.deleted){check(target,tools.read,change.id);items.push(item(change.id,null));continue;}
      try{const message=codecs.message(await call(tools.read,{message_id:change.id,format:before.allowMessageBody?"full":"metadata"},input.signal,change.id));
        if(message.id!==change.id)throw new PersonalDataConnectorError("unavailable");
        items.push(item(change.id,before.labelIds.every(l=>message.labelIds.includes(l))?message:null));}
      catch(error){if(input.signal.aborted)throw error;if(error instanceof GmailMissingMessageError){items.push(item(change.id,null));continue;}if(error instanceof PersonalDataConnectorError&&["permission_changed","disconnected","invalid_cursor"].includes(error.code))throw error;failedAt=i;break;}
    }
    const pending=failedAt<0?[]:changes.slice(failedAt),finishedPage=pending.length===0;
    const next:Cursor={...cursor,pending,nextPageToken:finishedPage?null:nextPage,nextHistoryId:finishedPage?null:nextHistory,
      pageToken:finishedPage?nextPage:cursor.pageToken,historyId:finishedPage&&nextPage===null&&historyTool?nextHistory:cursor.historyId,
      mode:finishedPage&&nextPage===null&&historyTool?"history":cursor.mode};
    if(finishedPage&&nextPage===null&&next.mode==="search")next.pageToken=null;
    const currentBinding=binding(input.target);
    const persisted=native.db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_personal_data_sources'").get()?native.db.prepare("SELECT value_json FROM one_personal_data_sources WHERE target_key=? AND source_id=?").get(personalDataHash(target),currentBinding.sourceId) as {value_json:string}|undefined:undefined;
    const previousRevision=persisted?(JSON.parse(persisted.value_json) as {sourceRevision:string|null}).sourceRevision:null;
    const batch:PersonalDataSourceBatch={sourceRevision:items.length===0&&previousRevision?previousRevision:`gmail-snapshot:${personalDataHash([cursor.mode,nextHistory,nextPage,items.map(i=>[i.id,i.revision,i.deleted])])}`,
      cursor:input.cursor,nextCursor:encode(next),permissionRevision:currentBinding.permissionRevision,credentialGeneration:currentBinding.credentialGeneration,observedAt:observedAt(),complete:finishedPage&&nextPage===null,items};
    if(!finishedPage&&items.length===0)throw new PersonalDataConnectorError("partial_failure");return validatePersonalDataBatch(batch,input.maxItems);
  }};
  return {port,assertConsent(scopeTarget){binding(scopeTarget);return consentDigest;},native};
}
export async function registerInstalledGmailPersonalSource(options:GmailPersonalSourceOptions):Promise<()=>void> {
  const source=await createInstalledGmailPersonalSource(options);
  return source.native.registerSource(options.connectorId??"gmail",{label:"Gmail · permitted installed read connector",port:source.port,assertConsent:source.assertConsent});
}

export interface GmailPersonalIntakeWakePorts {
  db:Database.Database;
  /** Existing native Supervisor/check-in timer owner calls the listener. This adapter creates no timer. */
  subscribeOwnerWake(listener:()=>void):()=>void;
  assertOwner():void;
  assertCurrent(input:PersonalDataCollectInput):void;
  assertBudget(input:PersonalDataCollectInput):void;
  collect(input:PersonalDataCollectInput):Promise<PersonalDataCollectionReceipt>;
  state(input:PersonalDataCollectInput):{revision:number;status:string};
  control(input:{target:PersonalDataTarget;sourceId:string;action:"pause";expectedRevision:number}):unknown;
}
/** Subscription metadata is persisted in the existing DB; every wake uses the same collect/cancel/budget path. */
export class GmailPersonalIntakeSubscriptions {
  private readonly inFlight=new Set<string>();private readonly unsubscribe:()=>void;
  constructor(private readonly ports:GmailPersonalIntakeWakePorts){ports.db.exec("CREATE TABLE IF NOT EXISTS one_gmail_personal_subscriptions(subscription_id TEXT PRIMARY KEY,revision INTEGER NOT NULL,enabled INTEGER NOT NULL,value_json TEXT NOT NULL)");this.unsubscribe=ports.subscribeOwnerWake(()=>{void this.wake();});}
  status(input:PersonalDataCollectInput):{revision:number;enabled:boolean}{
    this.ports.assertOwner();const target=personalDataTarget(input.target),id=`gmail-intake:${personalDataHash([target,input.sourceId])}`;
    const row=this.ports.db.prepare('SELECT revision,enabled,value_json FROM one_gmail_personal_subscriptions WHERE subscription_id=?').get(id) as {revision:number;enabled:number;value_json:string}|undefined;
    if(!row)return {revision:0,enabled:false};
    if(personalDataHash(JSON.parse(row.value_json))!==personalDataHash({...input,target}))throw personalDataError('gmail_personal_subscription_binding_changed');
    return {revision:row.revision,enabled:row.enabled===1};
  }
  configure(input:PersonalDataCollectInput,expectedRevision:number,enabled:boolean):{subscriptionId:string;revision:number;enabled:boolean} {
    this.ports.assertOwner();if(!Number.isSafeInteger(expectedRevision)||expectedRevision<0||typeof enabled!=="boolean")throw personalDataError("gmail_personal_subscription_input_invalid");
    personalDataId(input.sourceId);personalDataId(input.budgetId);
    const target=personalDataTarget(input.target),subscriptionId=`gmail-intake:${personalDataHash([target,input.sourceId])}`;
    if(enabled){this.ports.assertCurrent(input);this.ports.assertBudget(input);}
    const saved=this.ports.db.transaction(()=>{const prior=this.ports.db.prepare("SELECT revision FROM one_gmail_personal_subscriptions WHERE subscription_id=?").get(subscriptionId) as {revision:number}|undefined;
      if((prior?.revision??0)!==expectedRevision)throw personalDataError("gmail_personal_subscription_revision_conflict");
      this.ports.db.prepare("INSERT INTO one_gmail_personal_subscriptions VALUES(?,?,?,?) ON CONFLICT(subscription_id) DO UPDATE SET revision=excluded.revision,enabled=excluded.enabled,value_json=excluded.value_json")
        .run(subscriptionId,expectedRevision+1,enabled?1:0,JSON.stringify({...input,target}));
      return {subscriptionId,revision:expectedRevision+1,enabled};}).immediate();
    // A missing/revoked source or uncertain native Stop cannot roll back disabling the wake subscription.
    if(!enabled)try{const state=this.ports.state(input);this.ports.control({target,sourceId:input.sourceId,action:"pause",expectedRevision:state.revision});}catch{/* Re-read the source separately; disabling is not a claim that an external read was rolled back. */}
    return saved;
  }
  async wake():Promise<void> {
    try{this.ports.assertOwner();}catch{return;}
    const rows=this.ports.db.prepare("SELECT subscription_id,value_json FROM one_gmail_personal_subscriptions WHERE enabled=1 ORDER BY rowid LIMIT 20").all() as Array<{subscription_id:string;value_json:string}>;
    for(const row of rows){if(this.inFlight.has(row.subscription_id))continue;const input=JSON.parse(row.value_json) as PersonalDataCollectInput;
      try{this.ports.assertCurrent(input);this.ports.assertBudget(input);if(!["unread","ready","partial"].includes(this.ports.state(input).status))continue;this.inFlight.add(row.subscription_id);await this.ports.collect(input);}
      catch{/* Source/queue hold state already carries a safe typed blocker. Never auto-reset a cursor or expand grants. */}
      finally{this.inFlight.delete(row.subscription_id);}
    }
  }
  close():void{this.unsubscribe();for(const id of this.inFlight){
    const row=this.ports.db.prepare("SELECT value_json FROM one_gmail_personal_subscriptions WHERE subscription_id=?").get(id) as {value_json:string}|undefined;
    if(row)try{const input=JSON.parse(row.value_json) as PersonalDataCollectInput;this.ports.control({target:input.target,sourceId:input.sourceId,action:"pause",expectedRevision:this.ports.state(input).revision});}catch{/* Current native source controls preserve any uncertain state. */}
  }}
}
