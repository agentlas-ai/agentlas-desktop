import type { FinanceDataResult, FinanceReportSection, FinanceWidget, FinanceWidgetProjection } from './finance';
import { CHART_SPEC_LIMITS, sanitizeChartSpec } from './chart-spec';
import { financeReportCompositionSpec } from './finance-report-presentation';
import { financeComputeKind, financeComputeSpec } from './finance-compute-presentation';
import { financeDataChartSpec, financeDataVisual, financeMetricForColumns } from './finance-data-visual';

/** Desktop's dashboard projection chart selection. The renderer and mobile bridge share this logic. */
export function financeDashboardChartPresentation(widget:FinanceWidget,projection:FinanceWidgetProjection,locale:'ko'|'en') {
  const composition=widget.chartType!=='table'?financeReportCompositionSpec({id:widget.id,title:widget.title,kind:'widget',narrative:'',widget,projection},locale):null;
  const numeric=projection.columns.indexOf(widget.type==='allocation'?'Market value':'Price');
  const timeIndex=projection.columns.indexOf('Observed at');
  const symbolIndex=Math.max(0,projection.columns.indexOf('Symbol'));
  const currencyIndex=projection.columns.indexOf('Currency');
  const currencyCount=new Set(projection.rows.map(row=>row[currencyIndex]).filter(Boolean)).size;
  const temporal=widget.type==='chart'&&timeIndex===0&&projection.rows.length>1;
  const chartable=widget.chartType!=='table'&&['chart','comparison','allocation'].includes(widget.type)&&numeric>=0&&currencyCount===1&&!projection.rows.some(row=>row[currencyIndex]==='XXX')&&(temporal||widget.chartType==='bar');
  const spec={
    data:{values:projection.rows.slice(0,5000).filter(row=>typeof row[numeric]==='number').map(row=>({x:row[temporal?timeIndex:symbolIndex],y:row[numeric],series:row[symbolIndex]}))},
    mark:{type:widget.chartType==='bar'||!temporal?'bar':'line',tooltip:true},
    encoding:{x:{field:'x',type:temporal?'temporal':'nominal',title:projection.columns[temporal?timeIndex:symbolIndex]},y:{field:'y',type:'quantitative',title:projection.columns[numeric]},color:{field:'series',type:'nominal',title:projection.columns[symbolIndex]}},
  };
  return {composition,chartable,spec};
}

export type FinanceMobileDashboardChart = {status:'ready'|'unavailable'|'too_large';spec:Record<string,unknown>|null;series:string[];selectedSeries:string|null};
/** The exact Desktop figure, checked before crossing the mobile bridge. No partial figure is passed off as complete. */
export function financeMobileDashboardChart(widget:FinanceWidget,projection:FinanceWidgetProjection,locale:'ko'|'en',evidenceSection?:FinanceReportSection,requestedSeries?:string):FinanceMobileDashboardChart {
  let series:string[]=[],selectedSeries:string|null=null;
  const unavailable=():FinanceMobileDashboardChart=>({status:'unavailable',spec:null,series,selectedSeries});
  const tooLarge=():FinanceMobileDashboardChart=>({status:'too_large',spec:null,series,selectedSeries});
  if(widget.chartType==='table'||projection.status==='empty'||projection.status==='unsupported'){
    if(requestedSeries!==undefined)throw new Error('finance_arguments_invalid');
    return unavailable();
  }
  let raw:Record<string,unknown>|null=null;
  if(evidenceSection){
    const section={...evidenceSection,projection};
    raw=financeReportCompositionSpec(section,locale);
    const compute=financeComputeKind(section);
    if(!raw&&compute)raw=financeComputeSpec(section,locale==='ko');
    else if(!raw){
      const result:FinanceDataResult={status:projection.status==='ready'?'ok':'partial',columns:projection.columns,rows:projection.rows,warnings:projection.warnings,asOf:projection.asOf,retrievedAt:'',sourceUrls:[]};
      const metric=financeMetricForColumns(result.columns);
      let visual=financeDataVisual(result,metric);
      // Desktop offers a selector only for a valid Treasury visual. The caller may select only its literal maturities.
      if(visual.kind==='treasury'){
        if(visual.series.length>100||visual.series.some(value=>value.length>200))throw new Error('finance_mobile_payload_too_large');
        series=visual.series;
        if(requestedSeries!==undefined&&!series.includes(requestedSeries))throw new Error('finance_arguments_invalid');
        selectedSeries=requestedSeries??visual.label;
        if(requestedSeries!==undefined)visual=financeDataVisual(result,metric,requestedSeries);
      } else if(requestedSeries!==undefined)throw new Error('finance_arguments_invalid');
      if((visual.kind==='history'||visual.kind==='treasury')&&visual.points.length>1){
        if(visual.points.length>2000)return tooLarge();
        raw=financeDataChartSpec(visual,widget.chartType,locale==='ko');
      }
    }
    if(requestedSeries!==undefined&&!series.length)throw new Error('finance_arguments_invalid');
  } else {
    if(requestedSeries!==undefined)throw new Error('finance_arguments_invalid');
    const selected=financeDashboardChartPresentation(widget,projection,locale);
    raw=selected.composition;
    if(!raw&&widget.type!=='allocation'&&selected.chartable){
      if(projection.rows.length>CHART_SPEC_LIMITS.maxRows)return tooLarge();
      raw=selected.spec;
    }
  }
  if(!raw)return unavailable();
  const checked=sanitizeChartSpec(raw);
  if(!checked.ok)return ['too-large','too-many-rows'].includes(checked.code)?tooLarge():unavailable();
  return {status:'ready',spec:checked.spec,series,selectedSeries};
}
