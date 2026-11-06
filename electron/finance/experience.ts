import fs from 'node:fs';
import { financeBuiltinPlugin } from './builtin-plugin';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FINANCE_NOTICE_VERSION, type FinanceDataSourceOption, type FinanceExperienceRequest, type FinanceExperienceState } from '../../shared/finance-experience';
import { lockFinanceDirectory, tryLockFinanceDirectory, type FinanceScope } from './store';
import { canonicalFinanceSourceId } from '../../shared/finance';
import { financeHash, financePrivateDirectory, financeScopeHash } from './archive';
import { FINANCE_DATA_CATEGORIES, resolveFinanceDataSource, type FinanceDataSelection } from '../../shared/finance-data-routing';
import { readFinanceSourceRouting, writeFinanceSourceRouting } from './source-routing';
import { userDataPath } from '../runtime-paths';
import { managedOneAuthentication, wasManagedOneConfigured } from '../managed-one/auth';
import { prepareFinanceDailyCheckin,registerFinanceDailyCheckin,revokeFinanceDailyCheckin,observeFinanceDailyCheckin,type FinanceDailyBinding } from './daily-briefing';

const OVERLAP_CODES=new Set(['EBUSY','EPERM','EACCES']);
const pause=(ms:number):void=>{Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0,ms);};
/** Windows can refuse a file operation that lands on the instant of another process's rename (or a scanner's hold); the next try sees the settled file. */
function overlapping<T>(operation:()=>T):T{
  for(let attempt=0;;attempt++){
    try{return operation();}
    catch(error){if(attempt<3&&OVERLAP_CODES.has((error as NodeJS.ErrnoException).code??''))pause(5+attempt*5);else throw error;}
  }
}
const time=z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/),date=z.string().datetime({offset:true}),id=z.string().min(1).max(200);
const feedId=z.enum(['finance-news','finance-sec','finance-economy','finance-earnings']);
const defaultFeeds=feedId.options;
const requestSchema=z.discriminatedUnion('action',[
  z.object({action:z.literal('read'),includeUnconfirmedReview:z.literal(true).optional()}).strict(),
  z.object({action:z.literal('plugins.prepare')}).strict(),
  z.object({action:z.literal('accept'),version:z.literal(FINANCE_NOTICE_VERSION),dataNotice:z.literal(true),aiNotice:z.literal(true)}).strict(),
  z.object({action:z.literal('source'),sourceId:id}).strict(),
  z.object({action:z.literal('source.binding'),category:z.enum(FINANCE_DATA_CATEGORIES),sourceId:id.nullable()}).strict(),
  z.object({action:z.literal('feed'),feedId,enabled:z.boolean()}).strict(),
  z.object({action:z.literal('customize'),customized:z.boolean()}).strict(),
  z.object({action:z.literal('monitoring'),enabled:z.boolean(),localTime:time.optional()}).strict(),
]);
const storedSchema=z.object({schemaVersion:z.literal(1),ownerScope:z.string().regex(/^[a-f0-9]{64}$/),revision:z.number().int().nonnegative(),
  consent:z.object({version:id,acceptedAt:date}).strict().nullable(),sourceId:z.string().max(200),dashboardCustomized:z.boolean().default(false),
  enabledFeedIds:z.array(feedId).max(4).default(defaultFeeds),
  monitoring:z.object({enabled:z.boolean(),localTime:time,timezone:id,lastSentAt:date.nullable(),nextRunAt:date.nullable(),generation:z.number().int().nonnegative(),oneId:id.nullable(),checkinId:id.nullable(),commandId:id.nullable(),admissionDay:z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),admissionRunId:id.nullable().default(null)}).strict(),
}).strict();
type Preferences=z.infer<typeof storedSchema>;
type Access=FinanceExperienceState['access'];
/** The saved monitoring registration is the one `value` was read with (a restart of monitoring is a new generation and command). */
const sameRegistration=(fresh:Preferences,value:Preferences):boolean=>fresh.monitoring.generation===value.monitoring.generation&&fresh.monitoring.commandId===value.monitoring.commandId;
/** Monitoring is on but no daily briefing is registered yet (the supervisor did not answer, or billing was unreachable): the sweep registers it by itself. */
const isPending=(monitoring:Preferences['monitoring']):boolean=>monitoring.enabled&&monitoring.commandId===null;
const NOT_A_REGISTRATION_FAILURE=new Set(['finance_account_changed','finance_sign_in_required']);
const warned=new Set<string>();
const warnOnce=(code:string,reason?:unknown):void=>{if(warned.has(code))return;warned.add(code);console.warn('[finance-daily] registration pending',code,typeof reason==='string'?reason:'');};
const UNVERIFIED:Access={plan:null,monitoringAllowed:false,status:'unavailable'};
/** The billing answer a read waits for before showing "unavailable"; turning monitoring on, admission and the firing guard wait for the full check. */
const BILLING_READ_WAIT_MS=2_500;
/** A failed attempt waits twice as long each time (15 s, 30 s, ...) up to this long; the sweep ticks every 30 s. */
const RETRY_MAX_MS=600_000;
/** A registration waiting on something only the owner can change (plan, sign-in, consent) is asked again this rarely; a request that sees it lifted asks at once. */
const PAUSED_RETRY_MS=600_000;
const SETTLED_LIMIT=16;
/** Captured under the owner's settings lease; identity excludes unrelated UI changes. */
export interface FinanceMonitoringSnapshot {ownerScope:string;hostScope:string;identity:string;settingsRevision:number;selection:FinanceDataSelection}
interface Ports {
  sources():Promise<FinanceDataSourceOption[]>;access(scope:FinanceScope):Promise<Access>;
  prepare:typeof prepareFinanceDailyCheckin;register:typeof registerFinanceDailyCheckin;revoke:typeof revokeFinanceDailyCheckin;observe:typeof observeFinanceDailyCheckin;
  now():Date;timezone():string;
}
/** Exact server plan IDs in the public billing catalog; aliveAgent is a separate feature. */
export async function financeMonitoringAccess(scope:FinanceScope):Promise<Access>{
  scope.assertCurrent();const {wasManagedOneConfigured}=await import('../managed-one/auth');scope.assertCurrent();
  if(wasManagedOneConfigured()){
    const {managedFinanceMonitoringAccess}=await import('./managed-monitoring-access');scope.assertCurrent();
    return managedFinanceMonitoringAccess(scope);
  }
  const {getBillingCredits}=await import('../billing');scope.assertCurrent();
  let balance:Awaited<ReturnType<typeof getBillingCredits>>;
  try{balance=await getBillingCredits();}catch{scope.assertCurrent();return {plan:null,monitoringAllowed:false,status:'unavailable'};}scope.assertCurrent();
  if(!balance.authenticated)return {plan:null,monitoringAllowed:false,status:'signed-out'};
  if(balance.error||typeof balance.plan!=='string')return {plan:null,monitoringAllowed:false,status:'unavailable'};
  return {plan:balance.plan,monitoringAllowed:['pro','max','wow'].includes(balance.plan),status:'verified'};
}
/** Fresh server-backed admission for recurring Finance monitoring; terminal actions never call this. */
export async function requireFinanceMonitoringAccess(scope:FinanceScope):Promise<void>{
  scope.assertCurrent();const access=await financeMonitoringAccess(scope);scope.assertCurrent();
  if(access.status!=="verified"||!access.monitoringAllowed)throw new Error(access.status==="verified"?"finance_monitoring_pro_required":"finance_monitoring_access_unavailable");
}
const defaultPorts:Ports={
  sources:async()=>{const [{financeWorldDataSources},{financeToolchainSources}]=await Promise.all([import('./world-markets'),import('./source-adapters')]);return [...financeWorldDataSources(),...await financeToolchainSources()];},access:financeMonitoringAccess,
  prepare:prepareFinanceDailyCheckin,register:registerFinanceDailyCheckin,revoke:revokeFinanceDailyCheckin,observe:observeFinanceDailyCheckin,
  now:()=>new Date(),timezone:()=>Intl.DateTimeFormat().resolvedOptions().timeZone||'UTC',
};
/** Local settings only; no holdings, quotes, market data or credentials are persisted here. */
export class FinanceExperience {
  constructor(private readonly root:string,private readonly ports:Ports=defaultPorts){}
  /** Settings file identity last seen with no pending registration, per owner directory (a user without a Finance folder costs one failed stat per sweep). */
  private readonly settled=new Map<string,string>();
  private readonly reconciling=new Set<string>();
  private readonly retry=new Map<string,{at:number;fails:number;paused:boolean}>();
  private initial(scope:FinanceScope,sources:FinanceDataSourceOption[]):Preferences{return {schemaVersion:1,ownerScope:financeScopeHash(scope),revision:0,consent:null,sourceId:sources.find(source=>source.available)?.id??sources[0]?.id??'finance-yfinance',dashboardCustomized:false,enabledFeedIds:[...defaultFeeds],monitoring:{enabled:false,localTime:'09:00',timezone:this.ports.timezone(),lastSentAt:null,nextRunAt:null,generation:0,oneId:null,checkinId:null,commandId:null,admissionDay:null,admissionRunId:null}};}
  /** One settings file, read without any lock: a save replaces the file by rename, so a reader always sees a whole old or whole new file. */
  private parse(file:string):Preferences {
    return overlapping(()=>{const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw new Error('finance_settings_invalid');return storedSchema.parse(JSON.parse(fs.readFileSync(file,'utf8')));});
  }
  /** `repair` (only under the settings lock) sets aside a file this app cannot read; without it the unreadable file is left alone and the defaults are answered. */
  private read(scope:FinanceScope,directory:string,sources:FinanceDataSourceOption[],repair=false):Preferences {
    scope.assertCurrent();try{const value=this.parse(path.join(directory,'settings.json'));if(value.ownerScope!==financeScopeHash(scope))throw new Error('finance_owner_scope_mismatch');return value;
    }catch(error){
      if((error as NodeJS.ErrnoException).code==='ENOENT')return this.initial(scope,sources);
      // Settings this app cannot read (an older or damaged file) are set aside, not kept as a permanent failure: the owner starts from the defaults and consents again. A file that belongs to another owner is never touched.
      if(error instanceof Error&&error.message!=='finance_owner_scope_mismatch'&&error.message!=='finance_sign_in_required'&&(error.message==='finance_settings_invalid'||error instanceof SyntaxError||error.name==='ZodError')){
        if(!repair)return this.initial(scope,sources);
        try{fs.renameSync(path.join(directory,'settings.json'),path.join(directory,`settings.unreadable-${Date.now()}.json`));scope.assertCurrent();return this.initial(scope,sources);}
        catch(renameError){scope.assertCurrent();if((renameError as NodeJS.ErrnoException).code==='ENOENT')return this.initial(scope,sources);}
      }
      throw error;
    }
  }
  private write(scope:FinanceScope,directory:string,value:Preferences):void {
    scope.assertCurrent();const checked=storedSchema.parse({...value,revision:value.revision+1});if(checked.ownerScope!==financeScopeHash(scope))throw new Error('finance_owner_scope_mismatch');
    const temporary=path.join(directory,`.settings-${randomUUID()}.tmp`),fd=fs.openSync(temporary,'wx',0o600);
    try{fs.writeFileSync(fd,JSON.stringify(checked));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    scope.assertCurrent();overlapping(()=>fs.renameSync(temporary,path.join(directory,'settings.json')));if(process.platform!=='win32'){const directoryFd=fs.openSync(directory,'r');try{fs.fsyncSync(directoryFd);}finally{fs.closeSync(directoryFd);}}value.revision=checked.revision;
  }
  private async directory(scope:FinanceScope):Promise<string>{
    scope.assertCurrent();const directory=path.join(this.root,financeScopeHash(scope));await financePrivateDirectory(directory);scope.assertCurrent();return directory;
  }
  /** What the settings say now, without a lock and without waiting for anyone. */
  private async snapshot(scope:FinanceScope,sources:FinanceDataSourceOption[]=[]):Promise<{directory:string;value:Preferences}>{
    const directory=await this.directory(scope);return {directory,value:this.read(scope,directory,sources)};
  }
  /**
   * The only writer: lock, read the file again, change that fresh copy with `change` (synchronous, nothing slow), save, unlock. The hold is a few
   * milliseconds, so contenders just wait their turn. `change` returning false means nothing needs saving. Slow work (plugin checks, billing,
   * automation lookups, source discovery) happens before this, never inside it.
   */
  private async commit(scope:FinanceScope,directory:string,change:(value:Preferences)=>boolean|void,sources:FinanceDataSourceOption[]=[]):Promise<Preferences>{
    scope.assertCurrent();
    const release=await lockFinanceDirectory(directory);
    try{scope.assertCurrent();const value=this.read(scope,directory,sources,true);if(change(value)!==false)this.write(scope,directory,value);return value;}
    finally{await release();scope.assertCurrent();}
  }
  private selection(scope:FinanceScope,value:Preferences):FinanceDataSelection {
    // A saved selection (or per-category binding) that still names the retired 'alpha-vantage' source means the free engine.
    const saved=readFinanceSourceRouting(scope,path.join(this.root,financeScopeHash(scope)),value.sourceId);
    return {...saved,sourceId:canonicalFinanceSourceId(saved.sourceId),...(saved.sourceBindings?{sourceBindings:Object.fromEntries(Object.entries(saved.sourceBindings).map(([category,source])=>[category,canonicalFinanceSourceId(source)])) as FinanceDataSelection['sourceBindings']}:{}),enabledFeedIds:[...value.enabledFeedIds]};
  }
  private publishSelection(scope:FinanceScope,value:Preferences,selection:FinanceDataSelection):void {
    value.sourceId=writeFinanceSourceRouting(scope,path.join(this.root,financeScopeHash(scope)),selection);
  }
  private dailySourcesAvailable(scope:FinanceScope,value:Preferences,sources:FinanceDataSourceOption[]):boolean {
    let selection:FinanceDataSelection;try{selection=this.selection(scope,value);}catch{scope.assertCurrent();return false;}
    return (['news','filings','social'] as const).every(category=>sources.some(source=>source.id===resolveFinanceDataSource(selection,category)&&source.available));
  }
  private async projection(scope:FinanceScope,value:Preferences,sources:FinanceDataSourceOption[],access:Access,inspectBuiltins=true,unconfirmedReview=false):Promise<FinanceExperienceState> {
    let selection:FinanceDataSelection={sourceId:value.sourceId},sourceRoutingStatus:'ready'|'unavailable'='ready';
    try{selection=this.selection(scope,value);}catch{scope.assertCurrent();sourceRoutingStatus='unavailable';}
    const builtins=inspectBuiltins?await financeBuiltinPlugin().status(scope,FINANCE_NOTICE_VERSION):undefined;scope.assertCurrent();
    return {consent:value.consent,...(builtins?{builtins}:{}),...selection,sourceRoutingStatus,dashboardCustomized:value.dashboardCustomized,sources,enabledFeedIds:[...value.enabledFeedIds],
      monitoring:{enabled:value.monitoring.enabled,localTime:value.monitoring.localTime,timezone:value.monitoring.timezone,lastSentAt:value.monitoring.lastSentAt,nextRunAt:value.monitoring.enabled?value.monitoring.nextRunAt:null,...(unconfirmedReview?{unconfirmedReview:true}:{})},access};
  }
  /**
   * The built-in Finance tools are ready for an owner who accepted the current notice. After an app update the saved activation names the
   * previous release; that is this app's own change, not something the owner has to repeat, so the activation is renewed from the bundled
   * release (prepare is idempotent and only runs for an owner whose consent is current). A real failure of the bundle stays a failure.
   */
  /** One activation per owner at a time inside this process; a caller that shared another's failed attempt makes its own. (Other processes are serialised by the plugin's own lock, and the activation is idempotent.) */
  private readonly preparing=new Map<string,Promise<Awaited<ReturnType<ReturnType<typeof financeBuiltinPlugin>['prepare']>>>>();
  private async prepared(scope:FinanceScope){
    const key=financeScopeHash(scope),shared=this.preparing.get(key);
    if(shared){try{const result=await shared;scope.assertCurrent();return result;}catch{scope.assertCurrent();}}
    const run=financeBuiltinPlugin().prepare(scope,FINANCE_NOTICE_VERSION);this.preparing.set(key,run);
    try{const result=await run;scope.assertCurrent();return result;}finally{if(this.preparing.get(key)===run)this.preparing.delete(key);}
  }
  private async pluginReady(scope:FinanceScope):Promise<boolean>{
    const status=await financeBuiltinPlugin().status(scope,FINANCE_NOTICE_VERSION);scope.assertCurrent();
    if(status.ready)return true;
    if(!['finance_plugin_activation_required','finance_plugin_release_mismatch','finance_plugin_installed_release_invalid','finance_plugin_activation_invalid'].includes(status.errorCode??'finance_plugin_activation_required'))return false;
    const prepared=await this.prepared(scope);return prepared.ready;
  }
  /** Disable the registration named by `value` (only while it is still the saved one) and revoke it. The revoke runs whether or not the save did. */
  private async stopMonitoring(scope:FinanceScope,directory:string,value:Preferences):Promise<Preferences>{
    const stopped:Preferences={...value,monitoring:{...value.monitoring,enabled:false,nextRunAt:null}};
    try{await this.commit(scope,directory,fresh=>{if(!sameRegistration(fresh,value)||(!fresh.monitoring.enabled&&fresh.monitoring.nextRunAt===null))return false;fresh.monitoring.enabled=false;fresh.monitoring.nextRunAt=null;});}
    finally{await this.ports.revoke(scope,stopped.monitoring);}
    scope.assertCurrent();return stopped;
  }
  /** Release the registration named by `value` (only while it is still the saved one) and revoke it; monitoring stays on, waiting for the sweep to register it again. The revoke runs whether or not the save did. */
  private async unbind(scope:FinanceScope,directory:string,value:Preferences):Promise<Preferences>{
    const released:Preferences={...value,monitoring:{...value.monitoring,oneId:null,checkinId:null,commandId:null,nextRunAt:null}};
    try{await this.commit(scope,directory,fresh=>{if(!sameRegistration(fresh,value)||fresh.monitoring.commandId===null)return false;Object.assign(fresh.monitoring,{oneId:null,checkinId:null,commandId:null,nextRunAt:null});});}
    finally{await this.ports.revoke(scope,value.monitoring);}
    scope.assertCurrent();return released;
  }
  /**
   * Register the daily briefing for `localTime`. The caller holds the monitoring lock and has checked consent, the plugin and the data sources.
   * Every attempt is a new generation and a new command, so a late undo of an earlier attempt can never remove this one. When the supervisor
   * does not answer, nothing is rolled back to "off": monitoring stays on with no registration and the sweep finishes the job.
   */
  private async register(scope:FinanceScope,directory:string,start:Preferences,localTime:string,sources:FinanceDataSourceOption[]):Promise<{value:Preferences;registered:boolean}>{
    let value=start;
    if(value.monitoring.commandId)value=await this.unbind(scope,directory,value);
    value=await this.commit(scope,directory,fresh=>{const monitoring=fresh.monitoring;monitoring.generation++;monitoring.enabled=true;monitoring.localTime=localTime;monitoring.timezone=this.ports.timezone();monitoring.nextRunAt=null;},sources);
    const commandId=`finance-daily:${financeHash([value.ownerScope,value.monitoring.generation,randomUUID()].join(':')).slice(0,48)}`;
    try{
      const binding=await this.ports.prepare(scope,commandId);scope.assertCurrent();
      value=await this.commit(scope,directory,fresh=>{Object.assign(fresh.monitoring,binding);},sources);
      const registered=await this.ports.register(scope,binding,localTime);scope.assertCurrent();
      value=await this.commit(scope,directory,fresh=>{fresh.monitoring.nextRunAt=registered.nextRunAt;},sources);
      return {value,registered:true};
    }catch(error){
      const code=error instanceof Error?error.message:'finance_daily_registration_failed';
      // The undo must outlive an account change: it only touches this owner's own file and the exact registration made here.
      if(value.monitoring.commandId)value=await this.unbind({...scope,assertCurrent(){}},directory,value);
      if(NOT_A_REGISTRATION_FAILURE.has(code))throw error;
      scope.assertCurrent();warnOnce(code,(error as {cause?:unknown}).cause);
      return {value,registered:false};
    }
  }
  /** What this answer shows is `value` with `change`; the saved copy gets the same change, best effort and only while it is still the same registration. A save that fails only means the next request works the same thing out again. */
  private async adjust(scope:FinanceScope,directory:string,value:Preferences,change:(monitoring:Preferences['monitoring'])=>void):Promise<Preferences>{
    const shown:Preferences={...value,monitoring:{...value.monitoring}};change(shown.monitoring);
    try{await this.commit(scope,directory,fresh=>{if(!sameRegistration(fresh,value))return false;const before=JSON.stringify(fresh.monitoring);change(fresh.monitoring);if(JSON.stringify(fresh.monitoring)===before)return false;});}
    catch(error){scope.assertCurrent();console.warn('finance settings not saved:',(error as NodeJS.ErrnoException)?.code??'unknown',path.basename(directory));}
    return shown;
  }
  /**
   * Turn monitoring off because the automation was not found. Only the owner's on/off action (the monitoring lock) decides that: while it is
   * running, a registration that is not there yet is a registration still being made, not a lost one. If that action holds the lock, do nothing.
   * `holding` is true when the caller is that action.
   */
  private async disableInactive(scope:FinanceScope,directory:string,value:Preferences,holding=false):Promise<Preferences|null>{
    const release=holding?undefined:await tryLockFinanceDirectory(path.join(directory,'monitoring'),'long');
    if(!holding&&!release)return null;
    // A registration that was never confirmed (the app stopped between saving it and registering) is not one the owner revoked: it goes back to waiting.
    try{return value.monitoring.nextRunAt===null?await this.unbind(scope,directory,value):await this.adjust(scope,directory,value,monitoring=>{monitoring.enabled=false;monitoring.nextRunAt=null;});}
    finally{await release?.();scope.assertCurrent();}
  }
  /** Common end of a request: compare the settings with what the automation says now (slow lookup, no lock), then answer. */
  private async settle(scope:FinanceScope,directory:string,value:Preferences,sources:FinanceDataSourceOption[],access:Access,request:z.infer<typeof requestSchema>,holding=false):Promise<FinanceExperienceState>{
    const observed=await this.ports.observe(scope,value.monitoring);scope.assertCurrent();let current=value;
    if(current.monitoring.enabled&&current.monitoring.commandId&&!observed.active){
      const off=await this.disableInactive(scope,directory,current,holding);
      // The on/off action is running: it decides, and this answer shows the settings as they are.
      if(!off)return this.projection(scope,current,sources,access,true);
      current=off;
    }
    const next=current.monitoring.enabled?observed.nextRunAt:null,last=observed.lastSentAt??current.monitoring.lastSentAt;
    if(next!==current.monitoring.nextRunAt||last!==current.monitoring.lastSentAt)current=await this.adjust(scope,directory,current,monitoring=>{monitoring.nextRunAt=next;monitoring.lastSentAt=last;});
    return this.projection(scope,current,sources,access,true,request.action==='read'&&request.includeUnconfirmedReview===true&&observed.unconfirmedReview===true);
  }
  async request(scope:FinanceScope,raw:FinanceExperienceRequest):Promise<FinanceExperienceState>{
    const request=requestSchema.parse(raw);scope.assertCurrent();
    // Stop is independent of server/network access. It does not query billing first.
    const terminal=request.action==='monitoring'&&!request.enabled,local=request.action==='customize';
    let access:Access={...UNVERIFIED},sources:FinanceDataSourceOption[]=[],settledRead=false,sourcesKnown=true;
    // Turning monitoring on waits for the full billing check; every other request shows "unavailable" rather than wait for a slow server (a late answer is dropped, nothing is cached).
    if(!terminal&&!local){
      const billing=this.ports.access(scope).catch(()=>{scope.assertCurrent();return UNVERIFIED;});
      const answer=request.action==='monitoring'?billing.then(value=>{access=value;}):new Promise<void>(resolve=>{const timer=setTimeout(resolve,BILLING_READ_WAIT_MS);timer.unref?.();billing.then(value=>{clearTimeout(timer);if(!settledRead)access=value;resolve();},()=>{clearTimeout(timer);resolve();});});
      await Promise.all([answer,this.ports.sources().then(value=>{sources=value;},()=>{scope.assertCurrent();sourcesKnown=false;})]);
    }
    settledRead=true;
    scope.assertCurrent();
    if(request.action==='monitoring')return this.monitoring(scope,request,access,sources,sourcesKnown);
    // Reads never wait for a lock; only the short commit of a change does. Everything slow below runs before that commit.
    const {directory,value:first}=await this.snapshot(scope,sources);let value=first;
    // The plan or sign-in that paused a waiting registration is back: do not wait out the sweep's slow retry.
    if(!local&&isPending(value.monitoring)&&access.monitoringAllowed&&this.retry.get(directory)?.paused){this.retry.delete(directory);void this.reconcilePending(scope).catch(()=>undefined);}
    if(request.action==='accept'){const prepared=await this.prepared(scope);if(!prepared.ready)throw new Error('finance_plugin_activation_required');const now=this.ports.now().getTime();
      value=await this.commit(scope,directory,fresh=>{const previous=fresh.consent?Date.parse(fresh.consent.acceptedAt):-1;fresh.consent={version:FINANCE_NOTICE_VERSION,acceptedAt:new Date(Math.max(now,previous+1)).toISOString()};},sources);
      // A briefing that waited for this consent continues now.
      if(isPending(value.monitoring)){this.retry.delete(directory);void this.reconcilePending(scope).catch(()=>undefined);}}
    if(request.action==='plugins.prepare'){if(value.consent?.version!==FINANCE_NOTICE_VERSION)throw new Error('finance_consent_required');const prepared=await this.prepared(scope);if(!prepared.ready)throw new Error('finance_plugin_activation_required');}
    if(request.action==='customize')value=await this.commit(scope,directory,fresh=>{fresh.dashboardCustomized=request.customized;},sources);
    if(request.action==='feed')value=await this.commit(scope,directory,fresh=>{fresh.enabledFeedIds=request.enabled?[...new Set([...fresh.enabledFeedIds,request.feedId])]:fresh.enabledFeedIds.filter(id=>id!==request.feedId);},sources);
    if(request.action==='source'){
      if(!sources.some(source=>source.id===request.sourceId&&source.available)||request.sourceId.startsWith('finance-routes:'))throw new Error('finance_source_unavailable');
      value=await this.commit(scope,directory,fresh=>{
        if(fresh.sourceId.startsWith('finance-routes:')){
          let previous:FinanceDataSelection|undefined;try{previous=this.selection(scope,fresh);}catch{scope.assertCurrent();}
          // Explicit base-source selection repairs an unreadable routing edition; never infer lost bindings.
          if(previous)this.publishSelection(scope,fresh,{...previous,sourceId:request.sourceId});else fresh.sourceId=request.sourceId;
        }else fresh.sourceId=request.sourceId;
      },sources);
    }
    if(request.action==='source.binding'){
      if(request.sourceId!==null&&(!sources.some(source=>source.id===request.sourceId&&source.available)||request.sourceId.startsWith('finance-routes:')))throw new Error('finance_source_unavailable');
      value=await this.commit(scope,directory,fresh=>{
        const previous=this.selection(scope,fresh),sourceBindings={...previous.sourceBindings};
        if(request.sourceId===null)delete sourceBindings[request.category];else sourceBindings[request.category]=request.sourceId;
        this.publishSelection(scope,fresh,{...previous,sourceBindings});
      },sources);
    }
    // Billing that cannot be reached ("unavailable") is not a verdict. A verified non-subscription or a signed-out account only pauses: the owner can lift both, and the briefing registers again by itself.
    if(!local&&value.monitoring.enabled&&!access.monitoringAllowed&&access.status!=='unavailable')value=value.monitoring.commandId?await this.unbind(scope,directory,value):value;
    return this.settle(scope,directory,value,sources,access,request);
  }
  /** Turning monitoring on or off registers and revokes an automation, several steps one after another. Only that action waits on this lock, and nothing else (a phone read, a setting) ever does. */
  private async monitoring(scope:FinanceScope,request:Extract<z.infer<typeof requestSchema>,{action:'monitoring'}>,access:Access,sources:FinanceDataSourceOption[],sourcesKnown=true):Promise<FinanceExperienceState>{
    const directory=await this.directory(scope),release=await lockFinanceDirectory(path.join(directory,'monitoring'),'long');
    try{
      scope.assertCurrent();let value=this.read(scope,directory,sources);
      if(!request.enabled){value=await this.stopMonitoring(scope,directory,value);return this.projection(scope,value,sources,access,false);}
      if(value.consent?.version!==FINANCE_NOTICE_VERSION)throw new Error('finance_consent_required');
      if(!(await this.pluginReady(scope)))throw new Error('finance_plugin_activation_required');scope.assertCurrent();
      // Registering before billing is reachable is safe: admission and the firing guard check the plan again before anything is sent.
      if(!access.monitoringAllowed&&access.status==='verified')throw new Error('finance_monitoring_pro_required');
      const localTime=request.localTime??value.monitoring.localTime;
      if(!this.dailySourcesAvailable(scope,value,sources)){
        if(sourcesKnown)throw new Error('finance_source_unavailable');
        // The source list could not be read just now: stay on, and the sweep registers it once it can.
        if(value.monitoring.commandId)value=await this.unbind(scope,directory,value);
        value=await this.commit(scope,directory,fresh=>{Object.assign(fresh.monitoring,{enabled:true,localTime,timezone:this.ports.timezone(),nextRunAt:null});},sources);
        return this.projection(scope,value,sources,access,true);
      }
      const observed=await this.ports.observe(scope,value.monitoring);scope.assertCurrent();
      if(value.monitoring.enabled&&observed.active&&value.monitoring.localTime===localTime){value=await this.commit(scope,directory,fresh=>{fresh.monitoring.nextRunAt=observed.nextRunAt;},sources);return this.projection(scope,value,sources,access,true);}
      const result=await this.register(scope,directory,value,localTime,sources);
      if(!result.registered)return this.projection(scope,result.value,sources,access,true);
      value=result.value;
      return await this.settle(scope,directory,value,sources,access,request,true);
    }finally{await release();scope.assertCurrent();}
  }
  async admit(scope:FinanceScope,binding:FinanceDailyBinding,runId:string):Promise<void>{
    let sources:FinanceDataSourceOption[]=[];try{sources=await this.ports.sources();}catch{scope.assertCurrent();}scope.assertCurrent();
    const {directory,value}=await this.snapshot(scope,sources);
    const registered=(fresh:Preferences)=>{const current=fresh.monitoring;if(!current.enabled||current.oneId!==binding.oneId||current.checkinId!==binding.checkinId||current.commandId!==binding.commandId)throw new Error('finance_daily_registration_inactive');return current;};
    registered(value);
    if(value.consent?.version!==FINANCE_NOTICE_VERSION)throw new Error('finance_consent_required');
    if(!(await this.pluginReady(scope)))throw new Error('finance_plugin_activation_required');scope.assertCurrent();
    if(!this.dailySourcesAvailable(scope,value,sources))throw new Error('finance_source_unavailable');
    const access=await this.ports.access(scope);scope.assertCurrent();
    if(!access.monitoringAllowed){
      // A plan or sign-in the owner can lift pauses the briefing (it registers again by itself) instead of letting the revoked check-in switch it off.
      if(access.status!=='unavailable'){try{await this.unbind(scope,directory,value);}catch{scope.assertCurrent();}}
      throw new Error(access.status==='verified'?'finance_monitoring_pro_required':access.status==='signed-out'?'finance_monitoring_sign_in_required':'finance_monitoring_access_unavailable');
    }
    const now=this.ports.now(),day=new Intl.DateTimeFormat('en-CA',{timeZone:this.ports.timezone(),year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
    // The registration and the day are decided again on the fresh file: another process may have changed either since the checks above.
    await this.commit(scope,directory,fresh=>{const current=registered(fresh);if(current.admissionDay===day&&current.admissionRunId!==runId)throw new Error('finance_daily_already_admitted');current.admissionDay=day;current.admissionRunId=id.parse(runId);},sources);scope.assertCurrent();
  }
  /** Record a committed host layout edit without contacting billing or source discovery. */
  async markDashboardCustomized(scope:FinanceScope):Promise<void>{
    await this.commit(scope,await this.directory(scope),fresh=>{if(fresh.dashboardCustomized)return false;fresh.dashboardCustomized=true;});
  }
  async selectedSource(scope:FinanceScope):Promise<FinanceDataSelection>{
    const {value}=await this.snapshot(scope);return this.selection(scope,value);
  }
  async feeds(scope:FinanceScope):Promise<import('../../shared/finance-feeds').FinanceFeedId[]>{
    const {value}=await this.snapshot(scope);if(value.consent?.version!==FINANCE_NOTICE_VERSION)throw new Error('finance_consent_required');if(!(await this.pluginReady(scope)))throw new Error('finance_plugin_activation_required');scope.assertCurrent();return [...value.enabledFeedIds];
  }
  async consent(scope:FinanceScope):Promise<FinanceDataSelection>{
    const {value}=await this.snapshot(scope);if(value.consent?.version!==FINANCE_NOTICE_VERSION)throw new Error('finance_consent_required');if(!(await this.pluginReady(scope)))throw new Error('finance_plugin_activation_required');scope.assertCurrent();return this.selection(scope,value);
  }
  private monitorSnapshot(scope:FinanceScope,value:Preferences):FinanceMonitoringSnapshot {
    scope.assertCurrent();if(value.consent?.version!==FINANCE_NOTICE_VERSION)throw new Error('finance_consent_required');
    const managed=managedOneAuthentication();if(wasManagedOneConfigured()&&!managed)throw new Error('finance_sign_in_required');
    if(managed&&(managed.workspaceId!==scope.workspaceId||managed.userId!==scope.userId))throw new Error('finance_account_changed');
    const ownerScope=financeScopeHash(scope),hostScope=financeHash(JSON.stringify(managed?['managed',managed.hostId,managed.generation]:['local',path.resolve(this.root)])),selection=this.selection(scope,value);
    const routes=FINANCE_DATA_CATEGORIES.map(category=>[category,resolveFinanceDataSource(selection,category)]);
    const identity=financeHash(JSON.stringify([ownerScope,hostScope,value.consent.version,value.consent.acceptedAt,routes,[...(selection.enabledFeedIds??[])].sort()]));
    return {ownerScope,hostScope,identity,settingsRevision:value.revision,selection};
  }
  /** Both the routing selection and the actual consent edition are account-bound. */
  async monitoringSnapshot(scope:FinanceScope):Promise<FinanceMonitoringSnapshot>{
    const {value}=await this.snapshot(scope);if(value.consent?.version!==FINANCE_NOTICE_VERSION)throw new Error('finance_consent_required');if(!(await this.pluginReady(scope)))throw new Error('finance_plugin_activation_required');scope.assertCurrent();return this.monitorSnapshot(scope,value);
  }
  /** Synchronous fence runs immediately before the workspace's atomic rename. */
  assertMonitoringSnapshot(scope:FinanceScope,expected:FinanceMonitoringSnapshot):void {
    scope.assertCurrent();const directory=path.join(this.root,financeScopeHash(scope)),actual=this.monitorSnapshot(scope,this.read(scope,directory,[]));
    if(actual.ownerScope!==expected.ownerScope||actual.hostScope!==expected.hostScope||actual.identity!==expected.identity||actual.settingsRevision!==expected.settingsRevision)throw new Error('finance_monitor_source_changed');
    scope.assertCurrent();
  }
  /**
   * Settings and workspace share an ordering: a monitor report is saved only while the settings are still the ones its run started from. The
   * check runs synchronously right before the workspace's atomic rename (the saving scope's assertCurrent); no lock is held across the save.
   */
  async withMonitoringSnapshot<T>(scope:FinanceScope,expected:FinanceMonitoringSnapshot,work:()=>Promise<T>):Promise<T>{
    scope.assertCurrent();this.assertMonitoringSnapshot(scope,expected);return work();
  }
  /**
   * Finish a registration that could not be made when monitoring was turned on (supervisor not answering yet, billing unreachable) or that a
   * plan change paused. Called by the existing One check-in sweep. A settled owner costs one stat of the settings file; only a pending one is
   * read, and its attempts back off up to two minutes. Resolves when the attempt ends; the caller does not wait for it.
   */
  async reconcilePending(scope:FinanceScope):Promise<void>{
    scope.assertCurrent();
    const directory=path.join(this.root,financeScopeHash(scope));let identity:string;
    try{const info=fs.statSync(path.join(directory,'settings.json'));identity=`${info.ino}:${info.size}:${info.mtimeMs}`;}catch{return;}
    if(this.settled.get(directory)===identity||this.reconciling.has(directory))return;
    const wait=this.retry.get(directory);if(wait&&this.ports.now().getTime()<wait.at)return;
    let value:Preferences;try{value=this.read(scope,directory,[]);}catch{scope.assertCurrent();return;}
    if(!isPending(value.monitoring)){if(this.settled.size>=SETTLED_LIMIT)this.settled.clear();this.settled.set(directory,identity);this.retry.delete(directory);return;}
    this.reconciling.add(directory);
    try{
      const outcome=await this.registerPending(scope,directory,value);const now=this.ports.now().getTime();
      if(outcome==='registered')this.retry.delete(directory);
      else if(outcome==='paused')this.retry.set(directory,{fails:wait?.fails??0,at:now+PAUSED_RETRY_MS,paused:true});
      else if(outcome==='failed'){const fails=(wait?.fails??0)+1;this.retry.set(directory,{fails,at:now+Math.min(15_000*2**fails,RETRY_MAX_MS),paused:false});}
      // 'busy': the owner's own on/off action holds the lock; the next sweep asks again.
    }catch(error){
      // An account change ends this attempt only; the owner's next sweep starts over.
      const code=error instanceof Error?error.message:'finance_daily_registration_failed';
      if(!NOT_A_REGISTRATION_FAILURE.has(code)){warnOnce(code);const fails=(wait?.fails??0)+1;this.retry.set(directory,{fails,at:this.ports.now().getTime()+Math.min(15_000*2**fails,RETRY_MAX_MS),paused:false});}
    }finally{this.reconciling.delete(directory);}
  }
  private async registerPending(scope:FinanceScope,directory:string,seen:Preferences):Promise<'registered'|'paused'|'failed'|'busy'>{
    // Consent that is not the current notice's: the briefing stays on and waits for the owner to accept again (the scheduled instruction never runs without it).
    if(seen.consent?.version!==FINANCE_NOTICE_VERSION)return 'paused';
    let sources:FinanceDataSourceOption[]=[];try{sources=await this.ports.sources();}catch{scope.assertCurrent();}scope.assertCurrent();
    let access:Access=UNVERIFIED;try{access=await this.ports.access(scope);}catch{scope.assertCurrent();}scope.assertCurrent();
    // The owner's plan or sign-in is the owner's to change: stay on, register by itself once it allows monitoring. An unreachable server is not a verdict.
    if(access.status==='signed-out'||(access.status==='verified'&&!access.monitoringAllowed))return 'paused';
    const release=await tryLockFinanceDirectory(path.join(directory,'monitoring'),'long');
    if(!release)return 'busy';
    try{
      scope.assertCurrent();const value=this.read(scope,directory,sources,true);
      if(!isPending(value.monitoring))return 'registered';
      if(value.consent?.version!==FINANCE_NOTICE_VERSION)return 'paused';
      if(!(await this.pluginReady(scope))){warnOnce('finance_plugin_activation_required');return 'failed';}
      if(!this.dailySourcesAvailable(scope,value,sources)){warnOnce('finance_source_unavailable');return 'failed';}
      return (await this.register(scope,directory,value,value.monitoring.localTime,sources)).registered?'registered':'failed';
    }finally{await release();scope.assertCurrent();}
  }
  async guard(scope:FinanceScope):Promise<FinanceDailyBinding|null>{
    const {directory,value}=await this.snapshot(scope);
    // Waiting for its registration (see reconcilePending): nothing to guard yet, and no automation of this binding exists.
    if(!value.monitoring.commandId)return null;
    if(!value.monitoring.enabled){await this.ports.revoke(scope,value.monitoring);scope.assertCurrent();return null;}
    const observed=await this.ports.observe(scope,value.monitoring);scope.assertCurrent();
    if(!observed.active){await this.disableInactive(scope,directory,value);return null;}
    const due=observed.pending||observed.nextRunAt!==null&&Date.parse(observed.nextRunAt)<=this.ports.now().getTime();
    if(due){const access=await this.ports.access(scope);scope.assertCurrent();
      // Unreachable billing is "cannot tell": keep the schedule and let the next sweep ask again (wakeFinanceDailyBriefing holds it).
      if(access.status==='unavailable')throw new Error('finance_monitoring_access_unavailable');
      let sources:FinanceDataSourceOption[]=[];try{sources=await this.ports.sources();}catch{scope.assertCurrent();}scope.assertCurrent();
      // A plan or sign-in that does not allow it pauses (reconcilePending registers again once it does); everything else stops.
      if(!access.monitoringAllowed){await this.unbind(scope,directory,value);return null;}
      if(value.consent?.version!==FINANCE_NOTICE_VERSION||!this.dailySourcesAvailable(scope,value,sources)||!(await this.pluginReady(scope))){await this.stopMonitoring(scope,directory,value);return null;}}
    const last=observed.lastSentAt??value.monitoring.lastSentAt;
    if(observed.nextRunAt!==value.monitoring.nextRunAt||last!==value.monitoring.lastSentAt)await this.adjust(scope,directory,value,monitoring=>{monitoring.nextRunAt=observed.nextRunAt;monitoring.lastSentAt=last;});
    return {oneId:value.monitoring.oneId,checkinId:value.monitoring.checkinId,commandId:value.monitoring.commandId};
  }
}
let singleton:FinanceExperience|undefined;
function experience(){return singleton??=new FinanceExperience(userDataPath('finance','experience'));}
export function financeExperience(scope:FinanceScope,request:FinanceExperienceRequest):Promise<FinanceExperienceState>{return experience().request(scope,request);}
/** Start finishing a pending registration without waiting for it (the sweep must not block on the supervisor). */
export function reconcileFinanceDailyPending(scope:FinanceScope):void{void experience().reconcilePending(scope).catch(()=>undefined);}
export function guardFinanceDailyBriefing(scope:FinanceScope):Promise<FinanceDailyBinding|null>{return experience().guard(scope);}

export function requireFinanceConsent(scope:FinanceScope):Promise<FinanceDataSelection>{return experience().consent(scope);}
export function financeSelectedDataSource(scope:FinanceScope):Promise<FinanceDataSelection>{return experience().selectedSource(scope);}
export function admitFinanceDailyBriefing(scope:FinanceScope,binding:FinanceDailyBinding,runId:string):Promise<void>{return experience().admit(scope,binding,runId);}
