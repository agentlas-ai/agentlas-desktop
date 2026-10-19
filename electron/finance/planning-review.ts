import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { FinancePlanningRequestSchema, type FinancePlanningResult } from '../../shared/finance-planning';
import { userDataPath } from '../runtime-paths';
import type { FinanceScope } from './store';
import { runFinancePlanning } from './planning';

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
  /** Calculate only supplied hypothetical inputs; a saved native review is optional metadata. */
  calculate(scope:FinanceScope,raw:unknown,compute:typeof runFinancePlanning=runFinancePlanning):FinancePlanningResult{
    scope.assertCurrent();const request=FinancePlanningRequestSchema.parse(raw);scope.assertCurrent();
    const result=compute(request);scope.assertCurrent();return result;
  }
}
