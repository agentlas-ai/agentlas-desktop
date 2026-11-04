import type { FinanceDataResult, FinanceWidget } from "./finance";

type Observation = { date: string; value: number };
export interface FinanceDataVisual {
  kind: "history" | "treasury" | "series" | "nav" | "table";
  reason?: "shape" | "mixed" | "duplicates" | "missing" | "limit";
  series: string[];
  points: Observation[];
  unit: string | null;
  label: string;
  missing: number;
  nav?: { value: number; date: string; currency: string | null; fund: string; basis: string };
}
function day(value: unknown): value is string {
  if(typeof value!=="string"||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const parsed=new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime())&&parsed.toISOString().slice(0,10)===value;
}
const finite=(value:unknown):value is number=>typeof value==="number"&&Number.isFinite(value);
/** Exact provider column contracts only. Multiple matches and duplicate names are ambiguous. */
export function financeMetricForColumns(columns:readonly string[]):"price_history"|"treasury_yields"|"nav"|undefined {
  // FRED series and ECB pairs (macro_series, fx_rates) are read by financeDatedSeries below; they are not one of the three provider contracts here.
  if(new Set(columns).size!==columns.length)return undefined;
  const contracts={price_history:["Observation date","Symbol","Close (raw)"],treasury_yields:["Observation date","Maturity","Par curve yield","Unit"],nav:["Fund","NAV per share","Currency","NAV date","Price basis"]} as const;
  const matches=(Object.keys(contracts) as (keyof typeof contracts)[]).filter(metric=>contracts[metric].every(name=>columns.includes(name)));
  return matches.length===1?matches[0]:undefined;
}
export function financeTenorLabel(tenor:string):string {
  const match=/^(\d+(?:[._]\d+)?)(MONTH|YEAR)$/.exec(tenor);
  return match?`${match[1].replace("_",".")}${match[2]==="MONTH"?"M":"Y"}`:tenor;
}
export function financeCompactTreasuryTitle(title:string,projection:{columns:string[];rows:(string|number|null)[][]},selected?:string):string {
  const match=/^(미국채|US Treasury)$/.exec(title);
  if(!match||financeMetricForColumns(projection.columns)!=="treasury_yields")return title;
  const at=projection.columns.indexOf("Maturity"),series=[...new Set(projection.rows.map(row=>row[at]).filter((value):value is string=>typeof value==="string"))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  const tenor=selected&&series.includes(selected)?selected:series[0];
  return tenor?`${match[1]} ${financeTenorLabel(tenor)}`:title;
}
/** One dated series from the keyless sources: columns Observation date, Series|Pair, Value|Rate, Unit; one label, one unit, unique valid days, finite values. Anything else is not a series. */
export function financeDatedSeries(result:Pick<FinanceDataResult,"columns"|"rows">):{label:string;unit:string;points:Observation[]}|null {
  const columns=result.columns;if(!result.rows.length||result.rows.length>5000||new Set(columns).size!==columns.length)return null;
  const at=(names:string[])=>names.map(name=>columns.indexOf(name)).find(index=>index>=0)??-1;
  const date=columns.indexOf("Observation date"),label=at(["Series","Pair"]),value=at(["Value","Rate"]),unit=columns.indexOf("Unit");
  if(date<0||label<0||value<0||unit<0)return null;
  const labels=new Set(result.rows.map(row=>row[label])),units=new Set(result.rows.map(row=>row[unit]));
  if(labels.size!==1||units.size!==1)return null;const name=[...labels][0],measure=[...units][0];
  if(typeof name!=="string"||!name.trim()||typeof measure!=="string"||!measure.trim())return null;
  const seen=new Set<string>(),points:Observation[]=[];
  for(const row of result.rows){const day=row[date],number=row[value];if(!(typeof day==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&Number.isFinite(Date.parse(`${day}T00:00:00Z`))&&new Date(`${day}T00:00:00Z`).toISOString().slice(0,10)===day)||!finite(number)||seen.has(day))return null;seen.add(day);points.push({date:day,value:number});}
  points.sort((a,b)=>a.date.localeCompare(b.date));
  return points.length>=2?{label:name,unit:measure,points}:null;
}
/** Charts use named provider columns and literal observations only; no FX, return or gap inference. */
export function financeDataVisual(result:FinanceDataResult, metric?:string, selectedSeries?:string):FinanceDataVisual {
  const fallback=(reason?:FinanceDataVisual["reason"]):FinanceDataVisual=>({kind:"table",reason,series:[],points:[],unit:null,label:"",missing:0});
  if(result.status==="error"||result.status==="unconnected"||!result.rows.length)return fallback("missing");
  if(result.rows.length>20000)return fallback("limit");
  if(new Set(result.columns).size!==result.columns.length)return fallback("shape");
  const index=(name:string)=>result.columns.indexOf(name);
  if(metric==="nav"){
    const [fund,value,currency,date,basis]=["Fund","NAV per share","Currency","NAV date","Price basis"].map(index);
    if([fund,value,currency,date,basis].some(i=>i<0)||result.rows.length!==1)return fallback("shape");
    const row=result.rows[0];if(!finite(row[value])||row[value]<0||!day(row[date]))return fallback("missing");
    const code=row[currency];return {kind:"nav",series:[],points:[],unit:null,label:String(row[fund]??""),missing:0,nav:{value:row[value],date:row[date],currency:typeof code==="string"&&/^[A-Z]{3}$/.test(code)&&code!=="XXX"?code:null,fund:String(row[fund]??""),basis:String(row[basis]??"")}};
  }
  if(metric==="macro_series"||metric==="fx_rates"){const dated=financeDatedSeries(result);return dated?{kind:"series",series:[dated.label],points:dated.points,unit:dated.unit,label:dated.label,missing:0}:fallback("shape");}
  if(metric!=="price_history"&&metric!=="treasury_yields")return fallback();
  const treasury=metric==="treasury_yields";
  const [date,value,seriesIndex]=["Observation date",treasury?"Par curve yield":"Close (raw)",treasury?"Maturity":"Symbol"].map(index);
  if([date,value,seriesIndex].some(i=>i<0))return fallback("shape");
  const series=[...new Set(result.rows.map(row=>row[seriesIndex]).filter((v):v is string=>typeof v==="string"&&v.trim().length>0))].sort((a,b)=>a.localeCompare(b,undefined,{numeric:true}));
  if(series.length>50)return fallback("limit");
  if(!series.length||(!treasury&&series.length!==1))return fallback("mixed");
  if(result.rows.some(row=>typeof row[seriesIndex]!=="string"||!String(row[seriesIndex]).trim()))return fallback("missing");
  const label=treasury&&selectedSeries&&series.includes(selectedSeries)?selectedSeries:series[0];
  const rows=result.rows.filter(row=>row[seriesIndex]===label);
  let unit:string|null=null;
  if(treasury){const unitIndex=index("Unit");if(unitIndex<0)return fallback("shape");const units=new Set(rows.map(row=>row[unitIndex]));if(units.size!==1||!units.has("% per annum"))return fallback("mixed");unit="% per annum";}
  else {const currency=index("Currency");if(currency>=0){const currencies=new Set(rows.map(row=>row[currency]));if(currencies.size>1)return fallback("mixed");const code=rows[0]?.[currency];if(typeof code==="string"&&/^[A-Z]{3}$/.test(code)&&code!=="XXX")unit=code;}}
  const dates=new Set<string>(),points:Observation[]=[];let missing=0;
  for(const row of rows){if(!day(row[date])||!finite(row[value])){missing++;continue;}if(dates.has(row[date]))return fallback("duplicates");dates.add(row[date]);points.push({date:row[date],value:row[value]});}
  points.sort((a,b)=>a.date.localeCompare(b.date));
  if(!points.length||points.length===1&&missing>0)return fallback("missing");
  return {kind:treasury?"treasury":"history",series,points,unit,label,missing};
}
/** The exact chart spec used by the Desktop query-result component. */
export function financeDataChartSpec(visual:FinanceDataVisual,chartType:FinanceWidget["chartType"]|undefined,ko:boolean):Record<string,unknown> {
  const t=(a:string,b:string)=>ko?a:b;
  const chartPoints=visual.points.slice(0,2000);
  const chartSpec={data:{values:chartPoints},mark:{type:chartType==="line"||chartType==="bar"?chartType:"point",filled:chartType!=="line",...(chartType==="line"?{interpolate:"linear"}:{})},encoding:{...(chartType==="line"?{order:{field:"date",type:"ordinal",sort:"ascending"}}:{}),tooltip:[{field:"date",type:"ordinal",title:t("날짜","Date")},{field:"value",type:"quantitative",title:visual.unit??t("값","Value"),format:chartPoints.some(point=>point.value!==0&&Math.abs(point.value)<.01)?".3~g":",.2f"}],x:{field:"date",type:"ordinal",sort:"ascending",title:t("관측일","Observation date"),axis:{labelOverlap:true}},y:{field:"value",type:"quantitative",scale:{zero:false},title:visual.kind==="series"?`${visual.label} · ${visual.unit??""}`:visual.kind==="treasury"?t("연율 수익률 (%)","Yield (% per annum)"):`${t("종가","Close")} · ${visual.unit??t("통화 미확인","currency unverified")}`}}};
  return chartSpec;
}
