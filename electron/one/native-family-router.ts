import type {OneVaultRuntime} from '../secrets/one-vault-runtime';
import {oneVaultDigest} from '../secrets/one-vault-crypto';
import type {OneNativeMainOwnerFactory,OneNativeMainOwners,OneNativeMainPersonalFamily,OneNativeMainOrganizationFamily,OneNativeReauthorizationScope,OneNativeReportGenerationScope} from './native-main-composition';
import type {BrowserWindow} from 'electron';
import type {OneNativeStartupOwners} from './native-startup-installer';

type ReportStartup=Omit<OneNativeStartupOwners,'signal'|'assertMainOwner'|'currentNativeInstallation'>;
/** Main's single inert factory. Registration only retains an original approved
 * owner; it never creates a session, source, credential, grant or Supervisor. */
export function createOneNativeMainFamilyRouter(input:{runtime():OneVaultRuntime|null}){
 const runtimeGetter=input.runtime;
 let runtime:OneVaultRuntime|null=null,ownerDigest:string|null=null;
 let personalFactory:OneNativeMainOwnerFactory|null=null,personal:OneNativeMainPersonalFamily|null=null;
 let organization:OneNativeMainOrganizationFamily|null=null,closed=false;
 const retiredStartups=new WeakSet<ReportStartup>();
 const reportGenerations=new WeakMap<object,{runtime:OneVaultRuntime;scopeDigest:string;organization:OneNativeMainOrganizationFamily|null}>();
 function reportGeneration(r:OneVaultRuntime,scope:Readonly<OneNativeReportGenerationScope>){
  if(closed||input.runtime!==runtimeGetter||runtimeGetter()!==r||runtime&&runtime!==r||personalFactory||personal||!r.currentNativeOwner()
   ||oneVaultDigest(r.currentNativeOwner())!==scope.nativeOwnerDigest||oneVaultDigest(r.trust.currentHostMetadata())!==scope.hostTrustDigest
   ||!r.trust.currentHostMetadata()||!r.service.authorityDrainState().confirmed||r.service.authorityDrainState().epoch!==scope.drainEpoch)throw Error('one_native_main_report_generation_unavailable');
 }
 function original(){
  if(closed||input.runtime!==runtimeGetter)throw Error('one_native_main_family_router_closed');
  const r=runtimeGetter(),owner=r?.currentNativeOwner();
  if(!r||!owner||runtime&&r!==runtime||ownerDigest!==null&&oneVaultDigest(owner)!==ownerDigest)throw Error('one_native_main_family_original_changed');
  return r;
 }
 function pin(){const r=original();runtime=r;ownerDigest=oneVaultDigest(r.currentNativeOwner());return r}
 const owners:OneNativeMainOwners=Object.freeze({scope:'combined' as const,mobile:null,providerReader:null,
  stillCurrent:()=>{try{return original()===runtime&&!!(personal||organization)}catch{return false}},
  families:()=>{original();return Object.freeze({personal,organization})}});
 const factory:OneNativeMainOwnerFactory=Object.freeze({
  prepareReportGeneration(r:OneVaultRuntime,scope:Readonly<OneNativeReportGenerationScope>){
   reportGeneration(r,scope);const ticket=Object.freeze({});reportGenerations.set(ticket,{runtime:r,scopeDigest:oneVaultDigest(scope),organization});return ticket;
  },
  consumeReportGeneration(ticket:object,scope:Readonly<OneNativeReportGenerationScope>){
   const held=reportGenerations.get(ticket);reportGenerations.delete(ticket);
   if(!held||held.scopeDigest!==oneVaultDigest(scope)||held.organization!==organization)throw Error('one_native_main_report_generation_ticket_denied');
   reportGeneration(held.runtime,scope);if(organization)retiredStartups.add(organization.startup);organization=null;runtime=held.runtime;ownerDigest=oneVaultDigest(runtime.currentNativeOwner());
  },
  current:(r:OneVaultRuntime)=>{try{return r===original()&&owners.stillCurrent()?owners:null}catch{return null}},
  async reviewReauthorization(window:BrowserWindow,r:OneVaultRuntime,scope:Readonly<OneNativeReauthorizationScope>){
   // The existing original personal factory owns native review and its durable
   // signed ticket. A combined router never manufactures a replacement ticket.
   if(closed||r!==runtime||!personalFactory?.reviewReauthorization)throw Error('one_native_main_reauthorization_owner_unbound');
   return personalFactory.reviewReauthorization(window,r,scope);
  },
  consumeReauthorization(receipt:object,scope:Readonly<OneNativeReauthorizationScope>){
   const r=runtime;if(closed||!r||!personalFactory?.consumeReauthorization)throw Error('one_native_main_reauthorization_owner_unbound');
   const fresh=personalFactory.consumeReauthorization(receipt,scope);
   if(!fresh||fresh.scope!=='personal'||fresh.personal.provider||fresh.stillCurrent()!==true||personalFactory.current(r)!==fresh||runtimeGetter()!==r||!r.currentNativeOwner())throw Error('one_native_main_reauthorization_denied');
   personal=fresh;ownerDigest=oneVaultDigest(r.currentNativeOwner());
   // The prior Business generation is terminal after session invalidation.
   // Its durable unknown attempts are retained by their original journal.
   // Personal reauthorization cannot resume/replay them or approve a new org.
   if(organization)retiredStartups.add(organization.startup);
   organization=null;return owners;
  },
 });
 function installPersonal(value:OneNativeMainOwnerFactory){
  const r=pin();if(personalFactory&&personalFactory!==value)throw Error('one_native_main_family_replacement_denied');
  const issued=value.current(r);if(!issued||issued.scope!=='personal'||issued.stillCurrent()!==true)throw Error('one_native_main_family_owner_required');
  if(personal&&personal!==issued)throw Error('one_native_main_family_replacement_denied');
  personalFactory=value;personal=issued;original();
 }
 function installReport(startup:ReportStartup){
  if(retiredStartups.has(startup))throw Error('one_native_main_retired_report_family');
  pin();if(organization){if(organization.startup!==startup)throw Error('one_native_main_family_replacement_denied');return}
  if(!startup?.nativeCustodyReports||startup.business||startup.employeeReports||startup.personalVault||startup.pendingConsent||startup.credentialConsumer||startup.provider||startup.toolchains)throw Error('one_native_main_report_family_required');
  // The original association/producer carries the Business current-state fence.
  // Its revocation does not replace or stop the independent personal family.
  organization=Object.freeze({scope:'organization' as const,startup,mobile:null,providerReader:null,stillCurrent:()=>{try{return original()===runtime}catch{return false}}});
 }
 function close(){closed=true}
 return Object.freeze({factory,installPersonal,installReport,close});
}
