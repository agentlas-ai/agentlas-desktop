import { wasManagedOneConfigured } from '../managed-one/auth';

/**
 * Managed (Cloud) hosts run Finance search and query on the same keyless free engine as every other host; there is no server-relayed
 * provider. This module keeps only the host-level policy latch: a Managed process must register search/query/asset.add/query.save with the
 * 60 second call timeout and without the effect-free-read shortcut for search/query (see tools.ts), exactly as before.
 */
// One process-wide, host-only latch. An ordinary tools import can never become a paid/replayable Managed lane.
let hostPolicy:'managed'|'ordinary'|undefined;
export function installManagedFinanceHostPolicy(ports:readonly {operationId:string;effectFreeRead?:boolean;callTimeoutMs?:number}[]):void {
  if(hostPolicy!==undefined)return;
  const safe=wasManagedOneConfigured()&&['finance.search','finance.query','finance.asset.add','finance.query.save'].every(id=>{const port=ports.find(port=>port.operationId===id);return !!port&&port.callTimeoutMs===60000&&(!['finance.search','finance.query'].includes(id)||port.effectFreeRead!==true);});
  hostPolicy=safe?'managed':'ordinary';
}
/** True once the latch above found the Managed quotas and timeouts in place. */
export function managedFinanceHostPolicyReady():boolean{return hostPolicy==='managed';}
