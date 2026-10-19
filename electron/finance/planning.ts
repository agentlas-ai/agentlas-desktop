import { createHash } from 'node:crypto';
import { FinancePlanningRequestSchema, type FinancePlanningRequest, type FinancePlanningResult, type FinancePlanningPoint, type FinancePlanningMetric } from '../../shared/finance-planning';

const SCALE=1000000n,RATE=1000000000000n,LIMIT=1000000000000000n*SCALE;
function fail(code:string):never{throw new Error(`finance_planning_${code}`);}
function roundDiv(value:bigint,denominator:bigint):bigint{if(denominator<=0n)fail('numeric_invalid');const negative=value<0n,n=negative?-value:value,q=n/denominator,r=n%denominator;const rounded=q+(r*2n>denominator||r*2n===denominator&&q%2n===1n?1n:0n);return negative?-rounded:rounded;}
const quantum=(precision:number)=>10n**BigInt(6-precision);
function money(value:string,precision:number):bigint{const [a,b='']=value.split('.');const result=BigInt(a)*SCALE+BigInt(b.padEnd(6,'0'));if(result%quantum(precision)!==0n)fail('money_precision_mismatch');return result;}
function rounded(value:bigint,precision:number):bigint{if(value<0n||value>LIMIT)fail('numeric_range');const q=quantum(precision);return roundDiv(value,q)*q;}
function multiply(value:bigint,factor:number,precision:number):bigint{if(!Number.isFinite(factor)||factor<0||factor>1e6)fail('numeric_range');return rounded(roundDiv(value*BigInt(Math.round(factor*Number(RATE))),RATE),precision);}
function text(value:bigint,precision:number):string{value=rounded(value,precision);const a=value/SCALE,b=(value%SCALE).toString().padStart(6,'0').slice(0,precision);return precision?`${a}.${b}`:`${a}`;}
const total=(values:bigint[])=>values.reduce((a,b)=>a+b,0n);
const metric=(id:string,label:string,value:string|number|null,unit:FinancePlanningMetric['unit']):FinancePlanningMetric=>({id,label,value,unit});
function base(request:FinancePlanningRequest):FinancePlanningResult{return{schemaVersion:1,engineVersion:'finance-planning-v1',kind:request.kind,status:'ok',currency:request.currency,precision:request.precision,asOf:request.asOf,inputSha256:createHash('sha256').update(JSON.stringify(request)).digest('hex'),summary:'',metrics:[],monthlyProjection:[],annualProjection:[],trades:[],charts:[],assumptions:[`Explicit ${request.assumptionOrigin} scenario; no market return, distribution, tax or plan rule is inferred.`,`All amounts are ${request.currency}; no implicit FX conversion. Monetary results use half-even rounding to ${request.precision} decimal places.`,...request.assumptionNotes],warnings:['Deterministic scenario, not a probability of success or a guaranteed outcome.'],errors:[],request};}
function cashflow(request:Extract<FinancePlanningRequest,{kind:'cashflow'}>,result:FinancePlanningResult):void{
 const p=request.precision,initial=money(request.initialCapital,p),contribution=money(request.monthlyContribution,p),income=money(request.monthlyIncome,p),withdrawal=money(request.monthlyWithdrawal,p),target=request.targetEndBalance===undefined?null:money(request.targetEndBalance,p),growth=(1+request.annualReturn)**(1/12),inflation=1+request.annualInflation;
 type Simulation={end:bigint;shortfall:bigint;points:FinancePlanningPoint[];depleted:number|null;fees:bigint};
 const simulate=(monthly:bigint,collect:boolean):Simulation=>{
  let balance=initial,shortfall=0n,feesTotal=0n,depleted:number|null=null;const points:FinancePlanningPoint[]=[];
  if(collect)points.push({month:0,balance:text(initial,p),realBalance:text(initial,p),contribution:text(0n,p),income:text(0n,p),withdrawalRequested:text(0n,p),withdrawalPaid:text(0n,p),fees:text(0n,p),shortfall:text(0n,p)});
  for(let month=1;month<=request.months;month++){
   const grown=multiply(balance,growth,p),fees=multiply(grown,request.annualFeeRate/12,p),requested=request.withdrawalInflationAdjusted?multiply(withdrawal,inflation**((month-1)/12),p):withdrawal;
   const available=rounded(grown-fees+monthly+income,p),paid=requested<available?requested:available,missing=requested-paid;balance=available-paid;shortfall+=missing;feesTotal+=fees;
   if(missing>0n&&depleted===null)depleted=month;
   if(collect)points.push({month,balance:text(balance,p),realBalance:text(multiply(balance,1/(inflation**(month/12)),p),p),contribution:text(monthly,p),income:text(income,p),withdrawalRequested:text(requested,p),withdrawalPaid:text(paid,p),fees:text(fees,p),shortfall:text(missing,p)});
  }
  return{end:balance,shortfall,points,depleted,fees:feesTotal};
 };
 const simulation=simulate(contribution,true);result.monthlyProjection=simulation.points;
 for(let start=1;start<=request.months;start+=12){const group=simulation.points.slice(start,Math.min(start+12,request.months+1)),last=group[group.length-1];const summed=(key:keyof FinancePlanningPoint)=>text(total(group.map(point=>money(String(point[key]),p))),p);result.annualProjection.push({...last,contribution:summed('contribution'),income:summed('income'),withdrawalRequested:summed('withdrawalRequested'),withdrawalPaid:summed('withdrawalPaid'),fees:summed('fees'),shortfall:summed('shortfall')});}
 result.metrics=[metric('ending_balance','Ending balance',text(simulation.end,p),'money'),metric('ending_real_balance','Ending balance in starting purchasing power',simulation.points.at(-1)!.realBalance,'money'),metric('unfunded_withdrawals','Unfunded withdrawals',text(simulation.shortfall,p),'money'),metric('depletion_month','First unfunded withdrawal month',simulation.depleted,'month'),metric('total_fees','Additional fees',text(simulation.fees,p),'money')];
 if(target!==null){
  const maximumMonthly=1000000000000n*SCALE-quantum(p);let lo=0n,hi=quantum(p);const succeeds=(amount:bigint)=>{const s=simulate(amount,false);return s.end>=target&&s.shortfall===0n;};
  while(!succeeds(hi)&&hi<maximumMonthly)hi=hi*2n>maximumMonthly?maximumMonthly:hi*2n;
  if(!succeeds(hi))result.warnings.push('Target cannot be reached within the supported monthly-contribution bound.');
  else{const q=quantum(p);while(hi-lo>q){const mid=((lo+hi)/2n/q)*q;if(succeeds(mid))hi=mid;else lo=mid+q;}const answer=succeeds(lo)?lo:hi;result.metrics.push(metric('required_monthly_contribution','Total monthly contribution required for target',text(answer,p),'money'));}
  result.metrics.push(metric('target_end_balance','Target ending balance',text(target,p),'money'));
 }
 if(simulation.shortfall>0n){result.status='infeasible';result.errors.push({code:'finance_planning_cashflow_shortfall',detail:'Requested withdrawals exceed available assets in at least one month.'});}
 const chart= request.months>120?[simulation.points[0],...result.annualProjection]:simulation.points;
 result.charts=[{id:'balance',label:'Projected balance',type:'line',points:chart.map(point=>({x:point.month,y:Number(point.balance)}))}];
 result.summary=simulation.shortfall>0n?'The stated withdrawals create a funding shortfall.':'The stated cash flows remain funded over the selected horizon.';
 result.assumptions.push('Annual return is an effective nominal total return. Its monthly factor is (1 + annualReturn)^(1/12). Additional fees are annualFeeRate/12 of the balance after growth.','Contributions and other income arrive at month end before the requested withdrawal; no borrowing is assumed. No separate dividend income is added to total return.','Real balances use the stated inflation assumption. Only withdrawals grow with inflation when explicitly enabled. The first month uses the stated initial withdrawal.');
}
function incomeGoal(request:Extract<FinancePlanningRequest,{kind:'income_goal'}>,result:FinancePlanningResult):void{
 const p=request.precision,capital=money(request.capital,p),target=money(request.monthlyIncomeTarget,p),other=money(request.otherMonthlyIncome,p),need=target>other?target-other:0n,netYield=request.annualCashYield*(1-request.withholdingRate)-request.annualFeeRate;
 const annualGross=multiply(capital,request.annualCashYield,p),withheld=multiply(annualGross,request.withholdingRate,p),fees=multiply(capital,request.annualFeeRate,p),netAnnual=annualGross-withheld-fees,netMonthly=roundDiv(netAnnual,12n*quantum(p))*quantum(p),covered=netMonthly+other,shortfall=target>covered?target-covered:0n;
 let required:string|null=need===0n?text(0n,p):null;
 if(need>0n&&netYield>0){const rate=BigInt(Math.round(netYield*Number(RATE)));if(rate<=0n)fail('net_yield_nonpositive');const q=quantum(p),n=need*12n*RATE;required=text(((n+rate*q-1n)/(rate*q))*q,p);}
 if(need>0n&&netYield<=0){result.status='infeasible';result.errors.push({code:'finance_planning_net_yield_nonpositive'});}
 if(shortfall>0n){result.status='infeasible';result.errors.push({code:'finance_planning_income_shortfall'});}
 result.metrics=[metric('net_yield','Assumed cash yield after stated withholding and additional fees',netYield,'fraction'),metric('monthly_investment_income','Estimated monthly investment cash income',(netMonthly<0n?'-'+text(-netMonthly,p):text(netMonthly,p)),'money'),metric('monthly_shortfall','Monthly income shortfall',text(shortfall,p),'money'),metric('required_capital','Capital required under stated yield',required,'money'),metric('annual_fee','Additional annual fees',text(fees,p),'money')];
 result.charts=[{id:'income',label:'Monthly income',type:'bar',points:[{x:'Investment income',y:Number((netMonthly<0n?'-'+text(-netMonthly,p):text(netMonthly,p)))},{x:'Other income',y:Number(text(other,p))},{x:'Income target',y:Number(text(target,p))}]}];
 result.summary=required===null?'The stated net cash yield cannot fund the income goal.':shortfall>0n?'The stated capital and cash yield leave an income shortfall.':'The stated income sources cover the goal under these assumptions.';
 result.assumptions.push('Cash yield is an explicit gross annual distribution assumption, not price appreciation or a guaranteed distribution. Withholding is a user/model rate assumption, not a legal tax determination.','Additional fees are deducted once from the stated cash yield. Required capital is rounded upward to the chosen monetary precision. Capital preservation and market-price changes are not modeled.');
 if(netAnnual<0n)result.warnings.push('Additional fees exceed the after-withholding distribution; the negative investment cash flow is retained; capital-price changes are not modeled.');
}
function rebalance(request:Extract<FinancePlanningRequest,{kind:'rebalance'}>,result:FinancePlanningResult):void{
 const p=request.precision,fmt=(x:bigint)=>text(x,p),q=quantum(p);const reject=(code:string,field?:string)=>result.errors.push({code:`finance_planning_${code}`,...(field?{field}:{})});
 const unique=(values:string[],field:string)=>{if(new Set(values).size!==values.length)reject('duplicate_id',field);};
 unique(request.planMenu.map(x=>x.id),'planMenu');if(new Set(request.planMenu.map(x=>x.label)).size!==request.planMenu.length)reject('ambiguous_instrument_labels','planMenu');unique(request.positions.map(x=>x.instrumentId),'positions');unique(request.targetWeights.map(x=>x.instrumentId),'targetWeights');unique(request.constraints.lockedIds,'lockedIds');unique(request.constraints.excludedIds,'excludedIds');unique(request.constraints.bounds.map(x=>x.instrumentId),'bounds');
 if(request.planType!=='brokerage'&&(!request.menuConfirmed||!request.planMenu.length))reject('confirmed_plan_menu_required');
 if((request.planType==='kr_dc'||request.planType==='kr_irp')&&request.constraints.maxRiskWeight===undefined)reject('pension_risk_rule_required');
 const menu=new Map(request.planMenu.map(x=>[x.id,x])),current=new Map(request.positions.map(x=>[x.instrumentId,money(x.currentValue,p)])),targets=new Map(request.targetWeights.map(x=>[x.instrumentId,x.weight]));
 for(const id of [...current.keys(),...targets.keys(),...request.constraints.lockedIds,...request.constraints.excludedIds,...request.constraints.bounds.map(x=>x.instrumentId)])if(!menu.has(id))reject('instrument_not_in_plan_menu',id);
 for(const id of current.keys())if(!targets.has(id))reject('target_missing_for_position',id);
 for(const id of [...request.constraints.lockedIds,...request.constraints.excludedIds,...request.constraints.bounds.map(x=>x.instrumentId)])if(!targets.has(id))reject('constraint_target_missing',id);
 if(Math.abs(totalWeight(request.targetWeights)-1)>1e-9)reject('target_weights_must_sum_one');
 const cash=money(request.cash,p),contribution=money(request.contribution,p),reserve=money(request.reserve,p),feeReserve=money(request.feeReserve,p),capital=total([...current.values()])+cash+contribution,investable=capital-reserve-feeReserve;
 if(investable<0n)reject('reserve_exceeds_capital');
 if(result.errors.length){result.status='infeasible';result.summary='The stated plan or allocation constraints cannot be applied.';return;}
 let feeTotal=0n,bought=0n,sold=0n,risky=0n,unknownRisk=false;const fixed=money(request.fees.fixedPerTrade,p);
 for(const target of request.targetWeights){
  const instrument=menu.get(target.instrumentId)!,old=current.get(target.instrumentId)??0n,value=investable*BigInt(Math.round(target.weight*Number(RATE)))/RATE/q*q,delta=value-old,amount=delta<0n?-delta:delta;
  const fee=amount===0n?0n:fixed+multiply(amount,request.fees.proportionalRate,p);feeTotal+=fee;
  if(delta>0n)bought+=delta;else sold-=delta;
  if(delta>0n&&!instrument.buyAllowed)reject('buy_not_allowed',target.instrumentId);if(delta<0n&&!instrument.sellAllowed)reject('sell_not_allowed',target.instrumentId);
  if(request.constraints.lockedIds.includes(target.instrumentId)&&delta!==0n)reject('locked_position_changed',target.instrumentId);
  if(request.constraints.excludedIds.includes(target.instrumentId)&&value!==0n)reject('excluded_instrument_target',target.instrumentId);
  const bound=request.constraints.bounds.find(x=>x.instrumentId===target.instrumentId);if(bound&&(bound.minWeight>bound.maxWeight||target.weight<bound.minWeight-1e-10||target.weight>bound.maxWeight+1e-10))reject('weight_bound_violated',target.instrumentId);
  if(instrument.riskClass==='risk')risky+=value;else if(instrument.riskClass==='unknown'&&value>0n){unknownRisk=true;if(request.constraints.maxRiskWeight!==undefined)reject('risk_classification_required',target.instrumentId);}
  result.trades.push({instrumentId:target.instrumentId,label:instrument.label,side:delta>0n?'buy':delta<0n?'sell':'hold',currentValue:fmt(old),targetValue:fmt(value),amount:fmt(amount),estimatedFee:fmt(fee),targetWeight:target.weight});
 }
 const cashAfter=cash+contribution+sold-bought-feeTotal,postFeeCapital=capital-feeTotal;
 if(feeTotal>feeReserve)reject('fee_reserve_insufficient');if(cashAfter<reserve)reject('cash_reserve_violated');
 const riskWeight=postFeeCapital>0n?Number(risky)/Number(postFeeCapital):0;
 if(request.constraints.maxRiskWeight!==undefined&&riskWeight>request.constraints.maxRiskWeight+1e-10)reject('risk_cap_violated');
 result.metrics=[metric('capital_before','Capital including contribution',fmt(capital),'money'),metric('estimated_fees','Estimated transaction fees',fmt(feeTotal),'money'),metric('cash_after','Cash after suggested trades',cashAfter<0n?null:fmt(cashAfter),'money'),metric('risk_weight','Post-fee risky allocation including cash reserve',unknownRisk?null:riskWeight,'fraction')];
 if(unknownRisk)result.warnings.push('Some target holdings have unknown risk classification; aggregate risky allocation is unavailable.');
 result.status=result.errors.length?'infeasible':'ok';result.summary=result.errors.length?'The suggested allocation violates the stated constraints.':'The target allocation satisfies the stated input constraints after fees and reserves.';
 if(!result.errors.length)result.charts=[{id:'targets',label:'Target holding values',type:'bar',points:result.trades.map(t=>({x:t.label,y:Number(t.targetValue)}))}];
 result.assumptions.push('One account and one declared currency per calculation. Plan menu and risk classifications are supplied inputs, not inferred regulatory facts.','Target weights sum to one across investable assets after deducting reserve and feeReserve. Target amounts are rounded down to the chosen monetary precision; the remainder stays in cash.','Bounds apply to the stated investable target weights. Risk cap applies to risk-classified target value divided by post-transaction-fee total account capital, including cash reserves.','Locked positions must retain their exact input value. Exclusions require zero target. Missing current-position targets are rejected instead of silently liquidated.','Trade amounts are value suggestions, not share quantities or executable orders; taxes, spreads and unavailable restrictions are not inferred.');
 result.warnings.push('Passing the supplied constraints is not a legal determination of pension or plan eligibility. No trade is executed.');
}
function totalWeight(weights:Array<{weight:number}>):number{return weights.reduce((a,b)=>a+b.weight,0);}
/** Pure bounded scenario calculation: no providers, storage, account access, model calls or order execution. */
export function runFinancePlanning(raw:unknown):FinancePlanningResult{
 const request=FinancePlanningRequestSchema.parse(raw),result=base(request);
 try{if(request.kind==='cashflow')cashflow(request,result);else if(request.kind==='income_goal')incomeGoal(request,result);else rebalance(request,result);}
 catch(error){if(!(error instanceof Error)||!/^finance_planning_[a-z_]+$/.test(error.message))throw error;result.status='infeasible';result.errors.push({code:error.message});result.summary='The scenario cannot be calculated with the stated inputs.';result.charts=[];result.trades=[];result.monthlyProjection=[];result.annualProjection=[];}
 return result;
}
