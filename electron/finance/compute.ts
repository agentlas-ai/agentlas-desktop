import { createHash } from 'node:crypto';
import { FinanceComputeInputSchema, FinanceComputeRequestSchema, type FinanceComputeInput, type FinanceComputeRequest, type FinanceComputeArtifact, type FinanceComputeMetric } from '../../shared/finance-compute';

const citations={
  markowitz:{title:'Markowitz (1952), Portfolio Selection',url:'https://traders.berkeley.edu/papers/Markowitz.pdf'},
  riskParity:{title:'Griveau-Billion, Richard & Roncalli (2013), Cyclical coordinate descent for risk parity',url:'https://arxiv.org/abs/1311.4057'},
  shrinkage:{title:'Ledoit & Wolf (2004), Covariance shrinkage background',url:'https://www.ledoit.net/honey.pdf'},
  bootstrap:{title:'Efron (1979), Bootstrap Methods: Another Look at the Jackknife',url:'https://doi.org/10.1214/aos/1176344552'},
  merton:{title:'Merton, Theory of Rational Option Pricing (MIT working paper)',url:'https://dspace.mit.edu/entities/publication/6e05a2fa-478f-41e6-9e69-a06532002236'},
  option:{title:'Black & Scholes (1973), The Pricing of Options and Corporate Liabilities',url:'https://doi.org/10.1086/260062'},
};
function fail(code:string):never{throw new Error(`finance_compute_${code}`);}
const dot=(a:number[],b:number[])=>a.reduce((sum,value,i)=>sum+value*b[i],0);
const product=(a:number[][],x:number[])=>a.map(row=>dot(row,x));
const metric=(id:string,label:string,value:number,unit:string):FinanceComputeMetric=>({id,label,value,unit});
function canonical(value:unknown):unknown {if(Array.isArray(value))return value.map(canonical);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,val])=>[key,canonical(val)]));return value;}
/** A content identifier only, not proof that a provider or model actually ran. */
function digest(value:unknown){return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');}
function base(request:FinanceComputeRequest,input:FinanceComputeInput):FinanceComputeArtifact{
  return {schemaVersion:1,engineVersion:'finance-compute-v1',kind:request.kind,method:'',title:'',provenance:input.provenance,
    input:{symbols:[],assetIds:[],currency:'',startDate:null,endDate:null,observations:0,inputSha256:digest({request,input})},metrics:[],series:[],tables:[],assumptions:[],warnings:input.provenance.kind==='scenario'?['가정 시나리오 · 관측된 시장자료가 아닙니다.']:[],citations:[],diagnostics:{iterations:0,converged:true,residual:0}};
}
function aligned(request:Extract<FinanceComputeRequest,{kind:'allocation'|'forecast'}>,input:FinanceComputeInput){
  if(new Set(input.histories.map(history=>history.assetId)).size!==input.histories.length)fail('duplicate_history');
  const histories=request.assetIds.map(id=>input.histories.find(history=>history.assetId===id)??fail('history_missing'));
  const dates=histories[0].prices.map(point=>point.date),currency=histories[0].currency,basis=histories[0].priceBasis;
  for(const history of histories){
    if(history.currency!==currency)fail('currency_mismatch');
    if(history.priceBasis!==basis)fail('price_basis_mismatch');
    if(history.prices.length!==dates.length||history.prices.some((point,i)=>point.date!==dates[i]||(i>0&&point.date<=history.prices[i-1].date)))fail('history_not_aligned');
  }
  const returns=dates.slice(1).map((_,t)=>histories.map(history=>history.prices[t+1].close/history.prices[t].close-1));
  if(returns.some(row=>row.some(value=>!Number.isFinite(value)||value<=-1||Math.abs(value)>10)))fail('return_out_of_range');
  return {histories,dates,currency,returns};
}
/** Projection onto the bounded unit simplex, without silently relaxing the user's bounds. */
function project(values:number[],lower:number,upper:number):number[]{
  if(values.length*lower>1+1e-12||values.length*upper<1-1e-12||lower>upper)fail('bounds_infeasible');
  let lo=Math.min(...values)-upper,hi=Math.max(...values)-lower;
  for(let i=0;i<90;i++){const mid=(lo+hi)/2,total=values.reduce((sum,value)=>sum+Math.min(upper,Math.max(lower,value-mid)),0);if(total>1)lo=mid;else hi=mid;}
  return values.map(value=>Math.min(upper,Math.max(lower,value-(lo+hi)/2)));
}
function covariance(returns:number[][],shrinkage:number){
  const n=returns[0].length,means=Array.from({length:n},(_,j)=>returns.reduce((sum,row)=>sum+row[j],0)/returns.length);
  const sample=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>returns.reduce((sum,row)=>sum+(row[i]-means[i])*(row[j]-means[j]),0)/(returns.length-1)));
  if(sample.some((row,i)=>row[i]<1e-16))fail('constant_history');
  const scale=Math.max(...sample.map((row,i)=>row[i])),ridge=scale*1e-10;
  const regularized=sample.map((row,i)=>row.map((value,j)=>(i===j?value:(1-shrinkage)*value)+(i===j?ridge:0)));
  return {sample,regularized,means,ridge};
}
function minimumVariance(cov:number[][],lower:number,upper:number){
  const scale=Math.max(...cov.map((row,i)=>row[i])),a=cov.map(row=>row.map(value=>value/scale));
  const step=1/Math.max(...a.map(row=>row.reduce((sum,value)=>sum+Math.abs(value),0)));
  let weights=project(Array(cov.length).fill(1/cov.length),lower,upper),residual=Infinity;
  for(let iteration=1;iteration<=20000;iteration++){
    const grad=product(a,weights),next=project(weights.map((weight,i)=>weight-step*grad[i]),lower,upper);
    residual=Math.max(...next.map((weight,i)=>Math.abs(weight-weights[i])))/step;weights=next;
    if(residual<1e-9)return {weights,iterations:iteration,residual};
  }return fail('solver_not_converged');
}
function riskParity(cov:number[][],lower:number,upper:number){
  project(Array(cov.length).fill(1/cov.length),lower,upper);
  const n=cov.length,scale=Math.max(...cov.map((row,i)=>row[i])),a=cov.map(row=>row.map(value=>value/scale));
  const x=a.map((row,i)=>1/Math.sqrt(n*row[i]));
  for(let iteration=1;iteration<=10000;iteration++){
    for(let i=0;i<n;i++){
      const c=dot(a[i],x)-a[i][i]*x[i],root=Math.sqrt(c*c+4*a[i][i]/n);
      x[i]=c>=0?(2/n)/(root+c):(root-c)/(2*a[i][i]);
    }
    const total=x.reduce((sum,value)=>sum+value,0),weights=x.map(value=>value/total),marginal=product(a,weights),variance=dot(weights,marginal);
    const residual=Math.max(...weights.map((weight,i)=>Math.abs(weight*marginal[i]/variance-1/n)));
    if(!Number.isFinite(residual))fail('numeric_overflow');
    if(residual<1e-8){if(weights.some(weight=>weight<lower-1e-8||weight>upper+1e-8))fail('risk_parity_bounds_infeasible');return {weights,iterations:iteration,residual};}
  }return fail('solver_not_converged');
}
function allocation(request:Extract<FinanceComputeRequest,{kind:'allocation'}>,input:FinanceComputeInput):FinanceComputeArtifact{
  if(request.assetIds.length<2)fail('allocation_requires_two_assets');
  const data=aligned(request,input),cov=covariance(data.returns,request.shrinkage);
  const solved=request.method==='min_variance'?minimumVariance(cov.regularized,request.minWeight,request.maxWeight):riskParity(cov.regularized,request.minWeight,request.maxWeight);
  const {weights}=solved,result=base(request,input),marginal=product(cov.regularized,weights),variance=dot(weights,marginal),sampleVariance=dot(weights,product(cov.sample,weights));
  const violation=Math.max(Math.abs(weights.reduce((a,b)=>a+b,0)-1),...weights.map(weight=>Math.max(0,request.minWeight-weight,weight-request.maxWeight)));
  if(violation>1e-7)fail('bounds_infeasible');
  result.method=request.method;result.title=request.method==='min_variance'?'최소 분산 배분 · 과거자료 계산':'동일 위험 기여 배분 · 과거자료 계산';
  Object.assign(result.input,{symbols:data.histories.map(h=>h.symbol),assetIds:request.assetIds,currency:data.currency,startDate:data.dates[0],endDate:data.dates.at(-1)!,observations:data.returns.length});
  result.metrics=[metric('annualized_volatility','정규화 공분산 연율 변동성',Math.sqrt(variance*request.periodsPerYear),'fraction'),metric('sample_volatility','표본 공분산 연율 변동성',Math.sqrt(sampleVariance*request.periodsPerYear),'fraction'),metric('historical_mean','과거 일평균 수익률의 연율 환산',dot(weights,cov.means)*request.periodsPerYear,'fraction'),metric('constraint_violation','최대 제약 위반',violation,'weight')];
  result.series=[{id:'weights',label:'계산 비중',chart:'bar',xLabel:'자산',yLabel:'비중',points:weights.map((weight,i)=>({x:data.histories[i].symbol,y:weight}))}];
  result.tables=[{id:'allocation',title:'배분과 위험 기여',columns:['assetId','symbol','weight','riskShare','annualizedVolatility'],rows:weights.map((weight,i)=>[request.assetIds[i],data.histories[i].symbol,weight,weight*marginal[i]/variance,Math.sqrt(cov.regularized[i][i]*request.periodsPerYear)])},{id:'covariance',title:'계산에 사용한 일별 공분산',columns:['symbol',...data.histories.map(h=>h.symbol)],rows:cov.regularized.map((row,i)=>[data.histories[i].symbol,...row])}];
  result.assumptions=[`단순 일별 수익률; 표본 분모 n−1; 연율 환산 ${request.periodsPerYear}개 관측/년.`,`공분산: 비대각 항에 1−${request.shrinkage}를 곱하는 고정 대각 수축 + 대각 ridge ${cov.ridge}. Ledoit–Wolf 최적 수축 추정량은 아닙니다.`,`공매도·레버리지 없음; 합계 1; 각 자산 비중 ${request.minWeight}–${request.maxWeight}.`,'동일 통화, 환헤지·세금·거래비용 제외. 과거 평균은 미래 기대수익 추정의 보장이 아닙니다.','위험 기여는 정규화 공분산 기준이며, risk parity의 한도 충돌은 비중을 강제 조정하지 않고 거절합니다.'];
  if(data.histories.some(h=>h.adjustment==='unknown'))result.warnings.push('가격의 분할 조정 여부가 확인되지 않아 기업행사가 수익률과 위험을 왜곡할 수 있습니다.');
  if(data.histories[0].priceBasis==='price')result.warnings.push('가격 수익률 기준: 배당을 포함한 총수익률이 아닙니다.');
  if(data.returns.length<10*request.assetIds.length)result.warnings.push('관측 수가 자산 수의 10배 미만입니다. 표본 공분산과 비중이 추정 오차에 민감할 수 있습니다.');
  result.citations=[citations.markowitz,citations.shrinkage,...(request.method==='risk_parity'?[citations.riskParity]:[])];result.diagnostics={iterations:solved.iterations,converged:true,residual:solved.residual};return result;
}
function random(seed:number){let state=seed>>>0;return()=>{state=(state+0x6D2B79F5)>>>0;let value=state;value=Math.imul(value^(value>>>15),value|1);value^=value+Math.imul(value^(value>>>7),value|61);return((value^(value>>>14))>>>0)/4294967296;};}
function quantile(sorted:number[],p:number){const position=(sorted.length-1)*p,left=Math.floor(position),alpha=position-left;return sorted[left]*(1-alpha)+sorted[Math.min(left+1,sorted.length-1)]*alpha;}
function forecast(request:Extract<FinanceComputeRequest,{kind:'forecast'}>,input:FinanceComputeInput):FinanceComputeArtifact{
  const data=aligned(request,input),result=base(request,input),history=data.histories[0],spot=history.prices.at(-1)!.close,logReturns=data.returns.map(row=>Math.log1p(row[0])),rng=random(request.seed),values=Array(request.paths).fill(spot);
  const points:FinanceComputeArtifact['series'][number]['points']=[{x:0,y:spot,p05:spot,p25:spot,p50:spot,p75:spot,p95:spot}];
  for(let day=1;day<=request.horizon;day++){
    for(let p=0;p<values.length;p++){values[p]*=Math.exp(logReturns[Math.floor(rng()*logReturns.length)]);if(!Number.isFinite(values[p])||values[p]>1e15||values[p]<=0)fail('forecast_overflow');}
    const sorted=[...values].sort((a,b)=>a-b),p50=quantile(sorted,.5);points.push({x:day,y:p50,p05:quantile(sorted,.05),p25:quantile(sorted,.25),p50,p75:quantile(sorted,.75),p95:quantile(sorted,.95)});
  }
  const last=points.at(-1)!;result.method='historical_iid_bootstrap';result.title='과거 수익률 재표본 시나리오';
  Object.assign(result.input,{symbols:[history.symbol],assetIds:request.assetIds,currency:data.currency,startDate:data.dates[0],endDate:data.dates.at(-1)!,observations:data.returns.length});
  result.metrics=[metric('initial','시작값',spot,data.currency),metric('terminal_median','마지막 단계 중앙값',last.p50!,data.currency),metric('terminal_p05','마지막 단계 5분위',last.p05!,data.currency),metric('terminal_p95','마지막 단계 95분위',last.p95!,data.currency)];
  result.series=[{id:'forecast',label:'5·25·50·75·95 분위 경로',chart:'fan',xLabel:'앞으로의 관측 단계',yLabel:data.currency,points}];
  result.tables=[{id:'fan',title:'단계별 분위',columns:['step','p05','p25','p50','p75','p95'],rows:points.map(p=>[p.x,p.p05!,p.p25!,p.p50!,p.p75!,p.p95!])}];
  result.assumptions=[`과거 로그수익률을 독립·동일분포로 복원 추출합니다. ${request.paths}개 경로, ${request.horizon}개 관측 단계, seed ${request.seed}.`,'난수 알고리즘 mulberry32; 분위는 정렬 표본 사이 선형 보간. 시계열 순서·변동성 군집·구조 변화는 반영하지 않습니다.','밴드는 조건부 시나리오 분위이며 예측 정확도나 미래 가격의 보장·검증된 신뢰구간이 아닙니다.','주말·휴장일을 예측 날짜로 만들지 않고 단계 번호를 표시합니다. 거래비용·세금 제외.'];
  if(history.adjustment==='unknown')result.warnings.push('분할 조정 여부가 불명확하여 기업행사에 의한 가격 변화가 재표본될 수 있습니다.');
  if(history.priceBasis==='price')result.warnings.push('배당을 포함하지 않는 가격 기준 시나리오입니다.');
  result.citations=[citations.bootstrap];result.diagnostics={iterations:request.horizon,converged:true,residual:0,seed:request.seed,paths:request.paths};return result;
}
/** Normal CDF approximation, absolute error below about 8e-8 in the central region. */
function normal(x:number):number{if(x===0)return .5;const a=Math.abs(x),t=1/(1+.2316419*a),density=Math.exp(-a*a/2)/Math.sqrt(2*Math.PI),tail=density*t*(.319381530+t*(-.356563782+t*(1.781477937+t*(-1.821255978+t*1.330274429))));return x>0?1-tail:tail;}
function option(request:Extract<FinanceComputeRequest,{kind:'option'}>,input:FinanceComputeInput):FinanceComputeArtifact{
  if(input.provenance.kind!=='scenario'||input.histories.length)fail('option_requires_scenario');
  const {spot:s,strike:k,rate:r,dividendYield:q,volatility:v,years:t}=request,sqrt=Math.sqrt(t),d1=(Math.log(s/k)+(r-q+v*v/2)*t)/(v*sqrt),d2=d1-v*sqrt,discountR=Math.exp(-r*t),discountQ=Math.exp(-q*t),phi=Math.exp(-d1*d1/2)/Math.sqrt(2*Math.PI),call=request.optionType==='call';
  const price=call?s*discountQ*normal(d1)-k*discountR*normal(d2):k*discountR*normal(-d2)-s*discountQ*normal(-d1);
  const delta=call?discountQ*normal(d1):discountQ*(normal(d1)-1),gamma=discountQ*phi/(s*v*sqrt),vega=s*discountQ*phi*sqrt;
  const theta=-s*discountQ*phi*v/(2*sqrt)+(call?q*s*discountQ*normal(d1)-r*k*discountR*normal(d2):r*k*discountR*normal(-d2)-q*s*discountQ*normal(-d1));
  const rho=call?k*t*discountR*normal(d2):-k*t*discountR*normal(-d2),result=base(request,input);
  result.method='black_scholes_merton_european';result.title=`유럽형 ${call?'콜':'풋'} 옵션 · 가정 시나리오`;
  Object.assign(result.input,{symbols:[request.symbol],currency:request.currency,observations:0});
  result.metrics=[metric('price','이론 가격',Math.max(0,price),request.currency),metric('delta','Delta',delta,'per spot unit'),metric('gamma','Gamma',gamma,'per spot unit squared'),metric('vega','Vega · 변동성 1%p',vega/100,request.currency),metric('theta','Theta · 달력 1일',theta/365,request.currency),metric('rho','Rho · 금리 1%p',rho/100,request.currency)];
  const grid=[...new Set([0,s,k,...Array.from({length:81},(_,i)=>Math.max(s,k)*2*i/80)])].sort((a,b)=>a-b),points=grid.map(terminal=>{const payoff=Math.max(call?terminal-k:k-terminal,0);return {terminal,payoff,pnl:payoff-Math.max(0,price)};});
  result.series=[{id:'payoff',label:'만기 지급액',chart:'line',xLabel:'만기 기초자산 가격',yLabel:request.currency,points:points.map(p=>({x:p.terminal,y:p.payoff}))},{id:'pnl',label:'만기 지급액 − 현재 프리미엄',chart:'line',xLabel:'만기 기초자산 가격',yLabel:request.currency,points:points.map(p=>({x:p.terminal,y:p.pnl}))}];
  result.tables=[{id:'parameters',title:'가정 입력값',columns:['parameter','value','unit'],rows:[['spot',s,request.currency],['strike',k,request.currency],['rate',r,'annual continuously compounded fraction'],['dividendYield',q,'continuous annual fraction'],['volatility',v,'annual fraction'],['years',t,'years'],['origin',input.provenance.origin,'scenario']]},{id:'payoff',title:'만기 시나리오',columns:['terminalSpot','payoff','payoffLessPremium'],rows:points.map(p=>[p.terminal,p.payoff,p.pnl])}];
  result.assumptions=['유럽형·만기 행사; 일정 연율 변동성·연속복리 금리·연속 배당수익률의 Black–Scholes–Merton 모형.','기초자산 1단위 기준; 계약 승수는 적용하지 않습니다. 옵션 시장 호가·실현 가격이 아닌 가정 입력값의 이론 계산입니다. 미국형 조기 행사·변동성 스마일·거래비용 제외.','만기 순액은 지급액에서 현재 프리미엄만 차감합니다. 프리미엄 조달 이자와 세금은 제외합니다.','Vega/Rho는 각각 1%p 변화, Theta는 달력 1일 경과 단위. 만기 0/변동성 0의 미분 불능 경계는 허용하지 않습니다.'];
  result.citations=[citations.option,citations.merton];return result;
}
/** Deterministic host calculation. Never fetches, saves, places trades or invokes a model. */
export function calculateFinance(rawRequest:unknown,rawInput:unknown):FinanceComputeArtifact{
  const request=FinanceComputeRequestSchema.parse(rawRequest),input=FinanceComputeInputSchema.parse(rawInput);
  const result=request.kind==='allocation'?allocation(request,input):request.kind==='forecast'?forecast(request,input):option(request,input);
  const check=(value:unknown):void=>{if(typeof value==='number'&&(!Number.isFinite(value)||Math.abs(value)>1e15))fail('numeric_overflow');if(Array.isArray(value))value.forEach(check);else if(value&&typeof value==='object')Object.values(value).forEach(check);};check(result);return result;
}
