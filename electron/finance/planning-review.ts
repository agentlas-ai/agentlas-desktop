import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FinancePlanningRequestSchema, type FinancePlanningRequest, type FinancePlanningResult } from '../../shared/finance-planning';
import { userDataPath } from '../runtime-paths';
import type { FinanceScope } from './store';
import { runFinancePlanning } from './planning';

function policy(request:Extract<FinancePlanningRequest,{kind:'rebalance'}>):string {
  return JSON.stringify({planType:request.planType,currency:request.currency,reserve:request.reserve,feeReserve:request.feeReserve,planMenu:[...request.planMenu].sort((a,b)=>a.id.localeCompare(b.id)),constraints:{...request.constraints,lockedIds:[...request.constraints.lockedIds].sort(),excludedIds:[...request.constraints.excludedIds].sort(),bounds:[...request.constraints.bounds].sort((a,b)=>a.instrumentId.localeCompare(b.instrumentId))},fees:request.fees});
}
const reviewSchema=z.object({schemaVersion:z.literal(1),ownerScope:z.string().regex(/^[a-f0-9]{64}$/),reviewedAt:z.string().datetime(),request:FinancePlanningRequestSchema}).strict();
/** Only the native reviewed form writes this policy; model arguments cannot mint a review. */
export class FinancePlanningReviews {
  constructor(private readonly root=userDataPath('finance','planning-reviews')){}
  private file(scope:FinanceScope):string{scope.assertCurrent();return path.join(this.root,createHash('sha256').update(JSON.stringify([scope.workspaceId,scope.userId])).digest('hex')+'.json');}
  record(scope:FinanceScope,raw:unknown):void{
    const request=FinancePlanningRequestSchema.parse(raw);if(request.kind!=='rebalance'||!request.menuConfirmed)return;
    const file=this.file(scope);fs.mkdirSync(this.root,{recursive:true,mode:0o700});
    if(fs.lstatSync(this.root).isSymbolicLink())throw new Error('finance_plan_review_store_invalid');
    const tmp=path.join(this.root,`.review-${randomUUID()}.tmp`);
    try{fs.writeFileSync(tmp,JSON.stringify({schemaVersion:1,ownerScope:path.basename(file,'.json'),reviewedAt:new Date().toISOString(),request}),{flag:'wx',mode:0o600});scope.assertCurrent();fs.renameSync(tmp,file);}finally{if(fs.existsSync(tmp))fs.unlinkSync(tmp);}
  }
  calculate(scope:FinanceScope,raw:unknown,compute:typeof runFinancePlanning=runFinancePlanning):FinancePlanningResult{
    const request=FinancePlanningRequestSchema.parse(raw),result=compute(request);scope.assertCurrent();
    if(request.kind!=='rebalance'||request.planType==='brokerage')return result;
    let approved=false;
    try{const file=this.file(scope),stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.size>200000)throw new Error('invalid');
      const review=reviewSchema.parse(JSON.parse(fs.readFileSync(file,'utf8')));approved=review.ownerScope===path.basename(file,'.json')&&review.request.kind==='rebalance'&&review.request.menuConfirmed&&policy(review.request)===policy(request);
    }catch{/* A missing or stale review is a required owner step, never an inferred confirmation. */}
    scope.assertCurrent();if(approved)return result;
    return{...result,status:'infeasible',summary:'Review the actual account menu and restrictions in Portfolio before using this pension scenario in chat.',errors:[...result.errors,{code:'finance_planning_owner_plan_review_required'}],charts:[],trades:[]};
  }
}
