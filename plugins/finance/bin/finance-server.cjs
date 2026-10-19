#!/usr/bin/env node
"use strict";
const runtime=require('../runtime/index.cjs');
const MAX=4*1024*1024;let buffered='',queue=Promise.resolve();
const error=(id,code,message)=>({jsonrpc:'2.0',id:id??null,error:{code,message}});
function plain(value){return !!value&&typeof value==='object'&&!Array.isArray(value);}
function keys(value,allowed){return plain(value)&&Object.keys(value).every(key=>allowed.includes(key));}
function receive(request){
 if(!keys(request,['jsonrpc','id','method','params'])||request.jsonrpc!=='2.0'||typeof request.method!=='string'||('id'in request&&typeof request.id!=='string'&&typeof request.id!=='number'&&request.id!==null))return error(null,-32600,'Invalid request');
 if(!('id'in request))return null;
 const id=request.id,params=request.params??{};
 if(request.method==='initialize'){if(!keys(params,['protocolVersion','capabilities','clientInfo']))return error(id,-32602,'Invalid parameters');return{jsonrpc:'2.0',id,result:{protocolVersion:['2024-11-05','2025-03-26','2025-06-18'].includes(params.protocolVersion)?params.protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'agentlas-finance',version:'0.2.0'}}};}
 if(request.method==='ping')return{jsonrpc:'2.0',id,result:{}};
 if(request.method==='tools/list'){if(!keys(params,[]))return error(id,-32602,'Invalid parameters');return{jsonrpc:'2.0',id,result:{tools:runtime.toolDefinitions}};}
 if(request.method!=='tools/call')return error(id,-32601,'Method not found');
 if(!keys(params,['name','arguments'])||typeof params.name!=='string'||!plain(params.arguments))return error(id,-32602,'Invalid parameters');
 const actions={finance_compute:'compute',finance_plan:'planning',finance_valuation:'valuation'};if(!Object.hasOwn(actions,params.name))return error(id,-32602,'Unknown tool');
 if(params.name==='finance_compute'&&params.arguments.input?.provenance?.kind!=='scenario')return error(id,-32602,'Declared scenario provenance required');
 try{const value=runtime.callPureTool(actions[params.name],params.arguments);return{jsonrpc:'2.0',id,result:{content:[{type:'text',text:JSON.stringify(value)}],structuredContent:value}};}
 catch(cause){const message=cause?.name==='ZodError'?'finance_plugin_arguments_invalid':typeof cause?.message==='string'&&/^finance_[a-z_]+$/.test(cause.message)?cause.message:'finance_plugin_calculation_failed';return{jsonrpc:'2.0',id,result:{isError:true,content:[{type:'text',text:message}]}};}
}
function emit(result){if(result){const text=JSON.stringify(result);process.stdout.write((Buffer.byteLength(text)>8*1024*1024?JSON.stringify(error(result.id,-32603,'Result too large')):text)+'\n');}}
process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buffered+=chunk;let index;while((index=buffered.indexOf('\n'))>=0){const line=buffered.slice(0,index);buffered=buffered.slice(index+1);if(!line.trim())continue;if(Buffer.byteLength(line)>MAX){emit(error(null,-32600,'Request too large'));continue;}queue=queue.then(()=>{try{emit(receive(JSON.parse(line)));}catch{emit(error(null,-32700,'Parse error'));}});}if(Buffer.byteLength(buffered)>MAX){buffered='';emit(error(null,-32600,'Request too large'));process.stdin.destroy();}});
process.stdin.on('end',()=>{if(buffered.trim())queue=queue.then(()=>emit(error(null,-32700,'Incomplete request')));});
