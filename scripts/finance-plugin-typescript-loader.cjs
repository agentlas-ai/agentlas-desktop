"use strict";
const ts=require('typescript'),path=require('node:path');
module.exports=function(source){
 // Expose the canonical private schemas only inside this generated package bundle.
 // The authoritative source file is not modified and no parallel workspace schema is maintained.
 if(path.normalize(this.resourcePath)===path.normalize(path.resolve(__dirname,'../shared/finance.ts'))){
  for(const name of ['WorkspaceSchema','SourceSchema','operationSchemas'])if(!new RegExp(`const ${name}(?:\\s|:)`).test(source))throw new Error(`finance build canonical schema missing: ${name}`);
  source+='\nexport { WorkspaceSchema as __financeWorkspaceSchema, SourceSchema as __financeSourceSchema, operationSchemas as __financeOperationSchemas };\n';
 }
 const compiled=ts.transpileModule(source,{fileName:this.resourcePath,compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,esModuleInterop:true},reportDiagnostics:true});
 const errors=compiled.diagnostics.filter(item=>item.category===ts.DiagnosticCategory.Error);if(errors.length)throw new Error(ts.formatDiagnosticsWithColorAndContext(errors,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>process.cwd(),getNewLine:()=> '\n'}));return compiled.outputText;
};
