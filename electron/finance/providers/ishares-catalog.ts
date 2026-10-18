import type { FinanceAsset } from '../../../shared/finance';

export interface IsharesFundDefinition {
  readonly asset: Readonly<FinanceAsset>;
  readonly pageUrl: string;
  readonly holdingsUrl: string | null;
  readonly holdingsSchema: 'equity' | 'bond' | null;
  readonly structure: 'registered_etf' | 'gold_trust';
  readonly verifiedAt: string;
}
/** Finite issuer catalog, verified from issuer JSON-LD and explicitly linked CSV bytes on 2026-10-18.
 * These are discovery identities and capabilities, never prices or a complete ETF directory. */
export const ISHARES_FUNDS: readonly IsharesFundDefinition[] = Object.freeze([
  {asset:{id:'ishares:IVV',symbol:'IVV',name:'iShares Core S&P 500 ETF',exchange:'NYSE Arca',currency:'USD',kind:'etf'},pageUrl:'https://www.ishares.com/us/products/239726/ishares-core-sp-500-etf',holdingsUrl:'https://www.ishares.com/us/products/239726/ishares-core-s-p-500-etf/latest-holdings.csv',holdingsSchema:'equity',structure:'registered_etf',verifiedAt:'2026-10-18'},
  {asset:{id:'ishares:IEF',symbol:'IEF',name:'iShares 7-10 Year Treasury Bond ETF',exchange:'NASDAQ',currency:'USD',kind:'etf'},pageUrl:'https://www.ishares.com/us/products/239456/ishares-7-10-year-treasury-bond-etf',holdingsUrl:'https://www.ishares.com/us/products/239456/ishares-7-10-year-treasury-bond-etf/latest-holdings.csv',holdingsSchema:'bond',structure:'registered_etf',verifiedAt:'2026-10-18'},
  {asset:{id:'ishares:TLT',symbol:'TLT',name:'iShares 20+ Year Treasury Bond ETF',exchange:'NASDAQ',currency:'USD',kind:'etf'},pageUrl:'https://www.ishares.com/us/products/239454/ishares-20-year-treasury-bond-etf',holdingsUrl:'https://www.ishares.com/us/products/239454/ishares-20%20-year-treasury-bond-etf/latest-holdings.csv',holdingsSchema:'bond',structure:'registered_etf',verifiedAt:'2026-10-18'},
  {asset:{id:'ishares:IWM',symbol:'IWM',name:'iShares Russell 2000 ETF',exchange:'NYSE Arca',currency:'USD',kind:'etf'},pageUrl:'https://www.ishares.com/us/products/239710/ishares-russell-2000-etf',holdingsUrl:'https://www.ishares.com/us/products/239710/ishares-russell-2000-etf/latest-holdings.csv',holdingsSchema:'equity',structure:'registered_etf',verifiedAt:'2026-10-18'},
  {asset:{id:'ishares:IAU',symbol:'IAU',name:'iShares Gold Trust',exchange:'NYSE Arca',currency:'USD',kind:'fund'},pageUrl:'https://www.ishares.com/us/products/239561/ishares-gold-trust',holdingsUrl:null,holdingsSchema:null,structure:'gold_trust',verifiedAt:'2026-10-18'},
].map(fund=>Object.freeze({...fund,asset:Object.freeze(fund.asset)})) as IsharesFundDefinition[]);
export function findIsharesFund(assetId:string):IsharesFundDefinition|undefined{return ISHARES_FUNDS.find(fund=>fund.asset.id===assetId);}
export function searchIsharesCatalog(query:string):FinanceAsset[]{const q=query.trim().toLowerCase();if(!q)return [];return ISHARES_FUNDS.filter(fund=>fund.asset.symbol.toLowerCase().includes(q)||fund.asset.name.toLowerCase().includes(q)).map(fund=>({...fund.asset}));}
const paths=new Set(ISHARES_FUNDS.flatMap(fund=>[fund.pageUrl,...(fund.holdingsUrl?[fund.holdingsUrl]:[])]).map(value=>new URL(value).pathname));
export function isVerifiedIsharesUrl(url:URL):boolean{return url.protocol==='https:'&&url.hostname==='www.ishares.com'&&!url.port&&!url.username&&!url.password&&!url.search&&!url.hash&&paths.has(url.pathname);}
