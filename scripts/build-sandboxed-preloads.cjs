#!/usr/bin/env node
'use strict';
// Bundle canonical local modules for Electron's restricted sandbox preload require.
// Input is normal tsc output. Runtime permission and sandbox settings stay unchanged.
const fs=require('node:fs'),path=require('node:path');
const webpackPackage=require('next/dist/compiled/webpack/webpack');webpackPackage.init();
const args=process.argv.slice(2);if(args.length && (args.length!==2 || args[0]!=='--dist-root'))throw Error('sandbox-preload-build-arguments-invalid');
const dist=path.resolve(args[1]||path.join(__dirname,'../dist'));
const entry=path.join(dist,'electron/science-preload.js');
if(!fs.statSync(entry).isFile() || fs.lstatSync(entry).isSymbolicLink())throw Error('sandbox-preload-input-invalid');
const bundleMarker='/*! agentlas.sandbox-preload-bundle.v1 */';
const input=fs.readFileSync(entry,'utf8');
if(input.startsWith(bundleMarker) || input.startsWith('/******/ (() => { // webpackBootstrap')) {
 console.log('[sandbox-preloads] Science preload already bundled');process.exit(0);
}
const compiler=webpackPackage.webpack({mode:'none',target:'electron-preload',entry,
 output:{path:path.dirname(entry),filename:path.basename(entry)},devtool:false,
 plugins:[new webpackPackage.webpack.BannerPlugin({banner:'agentlas.sandbox-preload-bundle.v1'})],
 optimization:{minimize:false},externals:{electron:'commonjs electron'},
 resolve:{extensions:['.js']},performance:{hints:false}});
compiler.run((error,stats)=>compiler.close(closeError=>{
 if(error||closeError){console.error(error||closeError);process.exitCode=1;return;}
 if(stats.hasErrors()){console.error(stats.toString({all:false,errors:true}));process.exitCode=1;return;}
 console.log('[sandbox-preloads] Science canonical shared modules bundled');
}));
