#!/usr/bin/env node
"use strict";
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
async function buildFinancePlugin(output){
 const root=path.resolve(__dirname,'..'),target=path.resolve(output),webpackModule=require('next/dist/compiled/webpack/webpack');webpackModule.init();fs.mkdirSync(path.dirname(target),{recursive:true});
 const config={mode:'production',context:root,target:'node18',entry:path.join(__dirname,'finance-plugin-entry.cjs'),devtool:false,output:{path:path.dirname(target),filename:path.basename(target),library:{type:'commonjs2'}},resolve:{extensions:['.ts','.cjs','.js','.json'],symlinks:false},module:{rules:[{test:/\.ts$/,use:[{loader:path.join(__dirname,'finance-plugin-typescript-loader.cjs')}]}]},optimization:{minimize:false,moduleIds:'deterministic',chunkIds:'deterministic'},performance:{hints:false}};
 await new Promise((resolve,reject)=>{const compiler=webpackModule.webpack(config);compiler.run((error,stats)=>{compiler.close(closeError=>{if(error||closeError)return reject(error||closeError);if(stats.hasErrors())return reject(new Error(stats.toString({all:false,errors:true})));resolve();});});});
 const bytes=fs.readFileSync(target);return{bytes:bytes.length,sha256:crypto.createHash('sha256').update(bytes).digest('hex')};
}
module.exports={buildFinancePlugin};
if(require.main===module){const args=process.argv.slice(2);if(args.length!==2||args[0]!=='--out'){console.error('Usage: build-finance-plugin.cjs --out <runtime/index.cjs>');process.exitCode=2;}else buildFinancePlugin(args[1]).then(result=>console.log(JSON.stringify(result))).catch(error=>{console.error(error.message);process.exitCode=1;});}
