import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { FINANCE_DATA_CATEGORIES, type FinanceDataSelection } from '../../shared/finance-data-routing';
import { financeHash, financeScopeHash } from './archive';
import type { FinanceScope } from './store';

const prefix='finance-routes:v1:';
const pointer=/^finance-routes:v1:([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/;
const source=z.string().min(1).max(200).refine(value=>!!value.trim()&&!value.startsWith('finance-routes:'));
const bindings=z.object(Object.fromEntries(FINANCE_DATA_CATEGORIES.map(category=>[category,source.optional()])) as Record<typeof FINANCE_DATA_CATEGORIES[number],z.ZodOptional<typeof source>>).strict();
const payloadSchema=z.object({schemaVersion:z.literal(1),id:z.string().uuid(),ownerScope:z.string().regex(/^[a-f0-9]{64}$/),baseSourceId:source,bindings}).strict();
const editionSchema=payloadSchema.extend({sha256:z.string().regex(/^[a-f0-9]{64}$/)}).strict();
function directory(root:string,create=false):string {
  const directory=path.join(root,'source-routes');
  if(create){try{fs.mkdirSync(directory,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}}
  const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink())throw new Error('finance_source_routing_unavailable');return directory;
}
function syncDirectory(directory:string):void {
  // Windows does not expose directory fsync through Node; file fsync+atomic rename still apply.
  if(process.platform==='win32')return;
  const fd=fs.openSync(directory,'r');try{fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
}
export function readFinanceSourceRouting(scope:FinanceScope,root:string,sourceId:string):FinanceDataSelection {
  scope.assertCurrent();if(!sourceId.startsWith('finance-routes:'))return {sourceId};
  const match=pointer.exec(sourceId);if(!match)throw new Error('finance_source_routing_unavailable');
  let selection:FinanceDataSelection;
  try {
    const file=path.join(directory(root),`${match[1]}.json`),fd=fs.openSync(file,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));
    try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.size>16384||fs.lstatSync(file).isSymbolicLink())throw new Error('invalid');
      const raw=fs.readFileSync(fd,'utf8');if(Buffer.byteLength(raw)>16384)throw new Error('invalid');
      const edition=editionSchema.parse(JSON.parse(raw)),{sha256,...payload}=edition;
      if(edition.id!==match[1]||edition.ownerScope!==financeScopeHash(scope)||financeHash(JSON.stringify(payload))!==sha256)throw new Error('invalid');
      selection={sourceId:edition.baseSourceId,sourceBindings:{...edition.bindings}};
    }finally{fs.closeSync(fd);}
  }catch{scope.assertCurrent();throw new Error('finance_source_routing_unavailable');}
  scope.assertCurrent();return selection;
}
/** Publish immutable edition first; caller publishes this pointer under its settings lease. Orphans are never discovered. */
export function writeFinanceSourceRouting(scope:FinanceScope,root:string,selection:FinanceDataSelection):string {
  scope.assertCurrent();const id=randomUUID(),payload=payloadSchema.parse({schemaVersion:1,id,ownerScope:financeScopeHash(scope),baseSourceId:selection.sourceId,bindings:selection.sourceBindings??{}});
  const folder=directory(root,true),file=path.join(folder,`${id}.json`),temporary=path.join(folder,`.${id}.tmp`);
  const fd=fs.openSync(temporary,'wx',0o600);
  try{fs.writeFileSync(fd,JSON.stringify({...payload,sha256:financeHash(JSON.stringify(payload))}));fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
  scope.assertCurrent();fs.renameSync(temporary,file);syncDirectory(folder);scope.assertCurrent();return prefix+id;
}
