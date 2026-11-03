import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";
import type Database from "better-sqlite3";
import { VideoCancelFence } from "./video-cancel-fence";
import { repairMobileBridgeUtf16, sanitizeMobileBridgeText, stripMobileBridgeControlFences, truncateMobileBridgeUtf8 } from "./sanitize";
import { isHousekeepingHostNotice, parseChatHostNotice } from "../../shared/chat-host-notice";

const MAX_BYTES = 192 * 1024 * 1024, MAX_MESSAGE_BYTES = 4 * 1024 * 1024, TTL = 10 * 60_000;
const CHAT_VIDEO_CHUNK_BYTES = 1024 * 1024;
type ChatVideoPrincipal = { deviceId:string; connectionId:string };
const MIME: Record<string,string> = {".mp4":"video/mp4", ".mov":"video/quicktime", ".m4v":"video/x-m4v", ".webm":"video/webm", ".ogv":"video/ogg"};
const sha = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
type Identity = { dev: string; ino: string; size: string; mtime: string; ctime: string; links: string };
export type LegacyDispatchScope = { parentChatId:string; dispatchId:string; runId:string };
/** A folder a listed video was found in: the chat's own folder, or one the desktop shows this chat's files from (chatAssetRoots). */
type Root = { input:string; real:string; dev:string; ino:string; own:boolean };
type Candidate = { principal: ChatVideoPrincipal; listId:string; chatId:string; messageId:string; dispatch?:LegacyDispatchScope; messageHash:string; workspaceInput:string|null; root:Root;
  filename:string; relative:string; mime:string; identity:Identity; expires:number; assertChat:()=>void };
type Transfer = { id:string; candidate:Candidate; closed:boolean; preparing:boolean; reader:fs.promises.FileHandle|null; abort:AbortController;
  timer:NodeJS.Timeout; digest?:string; reading:boolean };

function identity(stat:fs.BigIntStats):Identity { return {dev:String(stat.dev),ino:String(stat.ino),size:String(stat.size),mtime:String(stat.mtimeNs),ctime:String(stat.ctimeNs),links:String(stat.nlink)}; }
function same(a:Identity,b:Identity):boolean { return Object.keys(a).every(key => a[key as keyof Identity] === b[key as keyof Identity]); }
function samePrincipal(a:ChatVideoPrincipal,b:ChatVideoPrincipal):boolean { return a.deviceId===b.deviceId && a.connectionId===b.connectionId; }
/** A markdown link target: `<…>` (how agents write a path with spaces) is unwrapped. */
function linkTarget(raw:string):string { const angle=/^<([^<>\r\n]+)>$/.exec(raw.trim()); return angle ? angle[1]! : raw; }

/** Only explicit owner selection of a displayed message link can open this old workspace file. */
export class LegacyChatVideoTransfers {
  private candidates=new Map<string,Candidate>();
  private transfers=new Map<string,Transfer>();
  private readonly fence:VideoCancelFence;
  private disposed=false;
  constructor(private readonly db:Database.Database | (()=>Database.Database),private readonly assertCurrent:(p:ChatVideoPrincipal)=>void,private readonly now:()=>number=Date.now,
    private readonly assertDispatch?:(scope:LegacyDispatchScope,chatId:string,messageId:string)=>void,
    private readonly captureChat?:(chatId:string)=>(()=>void),
    // The folders the desktop shows this chat's files from (fs/access chat-assets). observed in use: of 43 owner
    // answers naming a video, 39 named files that existed and the phone was offered none — teammate chats have no folder of
    // their own and their results sit in agent-cwd, outside Hope's folder; the desktop showed the same files.
    private readonly assetRoots?:(chatId:string)=>string[]){this.fence=new VideoCancelFence(now)}
  private get database():Database.Database { return typeof this.db==='function' ? this.db() : this.db; }

  private roots(chatId:string,workspaceInput:string|null):Root[] {
    const out:Root[]=[],seen=new Set<string>();
    const add=(input:string,own:boolean)=>{
      try{const real=fs.realpathSync.native(input);if(seen.has(real))return;const stat=fs.statSync(real,{bigint:true});if(!stat.isDirectory())return;
        seen.add(real);out.push({input,real,dev:String(stat.dev),ino:String(stat.ino),own})}catch{/* missing: not a root */}
    };
    if(workspaceInput)add(workspaceInput,true);
    for(const root of this.assetRoots?.(chatId) ?? [])if(typeof root==='string' && path.isAbsolute(root))add(root,false);
    return out;
  }

  private message(chatId:string,messageId:string,dispatch?:LegacyDispatchScope):{text:Buffer;workspaceInput:string|null}|null {
    if(!chatId || chatId.length>256 || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/.test(messageId))return null;
    if(dispatch){if(!this.assertDispatch)return null;this.assertDispatch(dispatch,chatId,messageId)}
    // Child conversations are intentionally absent from the normal chat sidebar. Their results require the
    // separate parent/dispatch/run ownership check; a guessed child chat ID is not that authorization.
    for(const table of ['one_team_dispatches','one_team_dispatch_results']) {
      const exists=this.database.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table);
      if(!dispatch && exists && this.database.prepare(`SELECT 1 FROM ${table} WHERE child_chat_id=? AND parent_chat_id<>? LIMIT 1`).get(chatId,chatId))return null;
    }
    const row=this.database.prepare(`SELECT CAST(m.text AS BLOB) AS text,c.working_folder AS workspaceInput,m.host_notice_json AS notice
      FROM chat_messages m JOIN chats c ON c.id=m.chat_id
      WHERE m.id=? AND m.chat_id=? AND m.role='assistant' AND m.row_scope IS NOT 'view'
        AND c.archived_at IS NULL AND length(CAST(m.text AS BLOB))<=?`)
      .get(messageId,chatId,MAX_MESSAGE_BYTES) as {text:Buffer;workspaceInput:unknown;notice:unknown}|undefined;
    if(!row || isHousekeepingHostNotice(parseChatHostNotice('assistant',row.notice)) || !Buffer.isBuffer(row.text))return null;
    return {text:row.text,workspaceInput:typeof row.workspaceInput==='string' && path.isAbsolute(row.workspaceInput) ? row.workspaceInput : null};
  }

  list(principal:ChatVideoPrincipal,chatId:string,messageId:string,listId:string,offset=0,dispatch?:LegacyDispatchScope):{items:Array<{candidateId:string;relativePath:string}>;tooLarge:boolean;nextOffset:number|null} {
    this.assertCurrent(principal);this.fence.assertOpen(principal,listId);if(this.disposed)throw Error('legacy_video_unavailable');
    if(!Number.isSafeInteger(offset)||offset<0||offset>10000)throw Error('legacy_video_cursor_invalid');
    for(const [id,c] of this.candidates)if(c.expires<=this.now() || (samePrincipal(c.principal,principal)&&c.listId===listId))this.candidates.delete(id);
    const assertChat=this.captureChat?.(chatId) ?? (()=>{});assertChat();
    const row=this.message(chatId,messageId,dispatch);if(!row)return {items:[],tooLarge:false,nextOffset:null};
    let text:string;
    try{text=new TextDecoder('utf-8',{fatal:true}).decode(row.text)}catch{return {items:[],tooLarge:false,nextOffset:null}}
    const roots=this.roots(chatId,row.workspaceInput),own=roots.find(root=>root.own) ?? null;
    if(!roots.length)return {items:[],tooLarge:false,nextOffset:null};
    // Never inspect fenced control/code blocks. Outside them, only exact local-looking video references in the shown
    // message are candidates; the phone must still show the relative path and the owner must choose one explicitly.
    // Paths are read before the bridge masks them as [local-path]: masked first, an absolute path could never be found,
    // and every owner answer names its video by absolute path. Only the folder-relative path below reaches the phone.
    text=truncateMobileBridgeUtf8(repairMobileBridgeUtf16(stripMobileBridgeControlFences(text)),64*1024).replace(/```[\s\S]*?(?:```|$)/g,'');
    const refs:string[]=[];
    for(const match of text.matchAll(/!?\[([^\]\r\n]{1,160})\]\(([^)\r\n]{1,1024})\)/g))refs.push(linkTarget(match[2]!));
    for(const match of text.matchAll(/`([^`\r\n]{1,1024})`/g))if(/^(?:file:\/\/\/|\/|\.\/)[^\r\n]+\.(?:mp4|mov|m4v|webm|ogv)$/i.test(match[1]!))refs.push(match[1]!);
    const prose=text.replace(/`[^`]*`/g,'').replace(/!?\[([^\]\r\n]{1,160})\]\(([^)\r\n]{1,1024})\)/g,'');
    for(const match of prose.matchAll(/(?:^|[\s(])((?:file:\/\/\/|\/|\.\/)[^\s`'"<>)]{1,1024}?\.(?:mp4|mov|m4v|webm|ogv))(?=$|[\s).,;:!?])/gi))refs.push(match[1]!);
    // A folder may contain spaces (for example macOS Application Support). Anchor at each exact root
    // so a suffix of an absolute path is never reinterpreted as a different relative file.
    for(const anchor of new Set(roots.flatMap(root=>[root.real,root.input]))){
      if(anchor===path.parse(anchor).root)continue;
      const escaped=anchor.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
      const scoped=new RegExp('(?:^|[\\s("\x27])('+escaped+'[\\\\/][^\\r\\n"\x27<>|()]{1,1024}?\\.(?:mp4|mov|m4v|webm|ogv))(?=$|[\\s).,;:!?])','gi');
      for(const match of prose.matchAll(scoped))refs.push(match[1]!);
    }
    const inside=(root:Root,filename:string)=>{const rel=path.relative(root.real,filename);return rel && rel!=='..' && !rel.startsWith('..'+path.sep) && !path.isAbsolute(rel) ? rel : null};
    const items:Array<{candidateId:string;relativePath:string}>=[],seen=new Set<string>();let tooLarge=false,index=0,nextOffset:number|null=null;
    for(const ref of refs){
      let filename:string,relative=false;try{const href=decodeURIComponent(ref);if(/[\u0000-\u001f]/.test(href))continue;
        if(/^file:/i.test(href)){const url=new URL(href);if(url.hostname && url.hostname!=='localhost')continue;filename=path.resolve(fileURLToPath(url))}
        // On Windows `C:\…` is a path, not a URL scheme.
        else {if(!(path.sep==='\\' && /^[A-Za-z]:[\\/]/.test(href)) && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(href))continue;relative=!path.isAbsolute(href);if(relative && !own)continue;filename=path.resolve(own?.real ?? '/',href)}
      }catch{continue}
      // A relative reference belongs to the chat's own folder; an absolute one to the first folder that holds it.
      const root=relative ? (own && inside(own,filename) ? own : undefined) : roots.find(candidate=>inside(candidate,filename));
      const within=root ? inside(root,filename) : null;
      const rel=root && within ? (root.own ? within : path.join(path.basename(root.real),within)) : '',mime=MIME[path.extname(filename).toLowerCase()];
      if(!mime || !root || !rel || seen.has(filename)
        || /[\u0000-\u001f\u007f-\u009f\u200b\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/u.test(rel)
        || Buffer.byteLength(rel,'utf8')>4096 || sanitizeMobileBridgeText(rel,4096)!==rel)continue;
      try{const stat=fs.lstatSync(filename,{bigint:true});if(!stat.isFile() || stat.isSymbolicLink() || stat.nlink!==1n || stat.size<1n || fs.realpathSync.native(filename)!==filename)continue;
        if(stat.size>BigInt(MAX_BYTES)){tooLarge=true;continue}
        seen.add(filename);if(index++<offset)continue;
        if(items.length>=16){nextOffset=index-1;break}
        if(this.candidates.size>=256 || [...this.candidates.values()].filter(value=>samePrincipal(value.principal,principal)).length>=64)throw Error('legacy_video_capacity');
        const id=randomBytes(32).toString('hex'),candidate:Candidate={principal:{...principal},listId,chatId,messageId,...(dispatch?{dispatch:{...dispatch}}:{}),messageHash:sha(row.text),workspaceInput:row.workspaceInput,root:{...root},filename,relative:rel,mime,identity:identity(stat),expires:this.now()+TTL,assertChat};
        this.candidates.set(id,candidate);items.push({candidateId:id,relativePath:rel});
      }catch(error){if(error instanceof Error && error.message==='legacy_video_capacity'){for(const item of items)this.candidates.delete(item.candidateId);throw error}/* missing or unreadable: never mint a candidate */}
    }
    try { this.assertCurrent(principal); assertChat(); this.fence.assertOpen(principal,listId); }
    catch (error) { for (const item of items) this.candidates.delete(item.candidateId); throw error; }
    return {items,tooLarge,nextOffset};
  }

  private current(c:Candidate):void {
    this.assertCurrent(c.principal);if(this.disposed || this.now()>=c.expires)throw Error('legacy_video_unavailable');
    c.assertChat();
    const row=this.message(c.chatId,c.messageId,c.dispatch);if(!row || row.workspaceInput!==c.workspaceInput || sha(row.text)!==c.messageHash)throw Error('legacy_video_changed');
    // A folder the desktop no longer shows this chat's files from closes the transfer, as a changed folder does.
    if(!c.root.own && !(this.assetRoots?.(c.chatId) ?? []).some(root=>{try{return fs.realpathSync.native(root)===c.root.real}catch{return false}}))throw Error('legacy_video_changed');
    const root=fs.statSync(c.root.real,{bigint:true});if(!root.isDirectory() || String(root.dev)!==c.root.dev || String(root.ino)!==c.root.ino || fs.realpathSync.native(c.root.input)!==c.root.real)throw Error('legacy_video_changed');
    const stat=fs.lstatSync(c.filename,{bigint:true});if(!stat.isFile() || stat.isSymbolicLink() || !same(identity(stat),c.identity) || fs.realpathSync.native(c.filename)!==c.filename)throw Error('legacy_video_changed');
  }
  open(principal:ChatVideoPrincipal,candidateId:string,id:string):{transferId:string;expiresAt:number} {
    this.assertCurrent(principal);this.fence.assertOpen(principal,id);const c=this.candidates.get(candidateId);
    if(!c || !samePrincipal(c.principal,principal) || this.transfers.has(id) || this.transfers.size>=4 || [...this.transfers.values()].some(t=>t.candidate.principal.deviceId===principal.deviceId))throw Error('legacy_video_unavailable');
    this.current(c);this.candidates.delete(candidateId);
    const transfer:Transfer={id,candidate:c,closed:false,preparing:false,reader:null,abort:new AbortController(),reading:false,timer:setTimeout(()=>{void this.closeOwned(transfer)},TTL)};
    transfer.timer.unref();this.transfers.set(id,transfer);return {transferId:id,expiresAt:c.expires};
  }
  private owned(principal:ChatVideoPrincipal,id:string):Transfer {const t=this.transfers.get(id);if(!t||t.closed||!samePrincipal(t.candidate.principal,principal))throw Error('legacy_video_unavailable');return t}
  private async check(t:Transfer):Promise<void>{if(t.closed||t.abort.signal.aborted||this.transfers.get(t.id)!==t)throw Error('legacy_video_closed');this.current(t.candidate);
    if(t.reader){const stat=await t.reader.stat({bigint:true});if(!stat.isFile()||!same(identity(stat),t.candidate.identity))throw Error('legacy_video_changed')}
    if(t.closed||t.abort.signal.aborted)throw Error('legacy_video_closed')}
  async prepare(principal:ChatVideoPrincipal,id:string):Promise<{size:number;mediaType:string;sha256:string;chunkBytes:number}> {
    const t=this.owned(principal,id);if(t.preparing||t.reader)throw Error('legacy_video_prepare_invalid');t.preparing=true;let reader:fs.promises.FileHandle|null=null;
    try{await this.check(t);reader=await fs.promises.open(t.candidate.filename,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));if(t.closed||t.abort.signal.aborted)throw Error('legacy_video_closed');t.reader=reader;await this.check(t);
      const size=Number(t.candidate.identity.size),hash=createHash('sha256'),buffer=Buffer.allocUnsafe(CHAT_VIDEO_CHUNK_BYTES);
      for(let offset=0;offset<size;){await this.check(t);const n=Math.min(buffer.length,size-offset),part=await reader.read(buffer,0,n,offset);if(part.bytesRead!==n)throw Error('legacy_video_changed');hash.update(buffer.subarray(0,n));offset+=n}
      await this.check(t);t.digest=hash.digest('hex');return {size,mediaType:t.candidate.mime,sha256:t.digest,chunkBytes:CHAT_VIDEO_CHUNK_BYTES};
    }catch(error){if(reader&&t.reader!==reader)await reader.close().catch(()=>undefined);await this.closeOwned(t);throw error}finally{t.preparing=false}
  }
  async read(principal:ChatVideoPrincipal,id:string,offset:number):Promise<{offset:number;base64:string;sha256:string}>{const t=this.owned(principal,id);try{await this.check(t);if(!t.reader||!t.digest||t.reading)throw Error('legacy_video_unavailable');const size=Number(t.candidate.identity.size);if(!Number.isSafeInteger(offset)||offset<0||offset>=size||offset%CHAT_VIDEO_CHUNK_BYTES!==0)throw Error('legacy_video_range_invalid');t.reading=true;const buf=Buffer.allocUnsafe(Math.min(CHAT_VIDEO_CHUNK_BYTES,size-offset));const part=await t.reader.read(buf,0,buf.length,offset);if(part.bytesRead!==buf.length)throw Error('legacy_video_changed');await this.check(t);return {offset,base64:buf.toString('base64'),sha256:sha(buf)}}catch(error){await this.closeOwned(t);throw error}finally{t.reading=false}}
  async close(principal:ChatVideoPrincipal,id:string):Promise<void>{this.fence.cancel(principal,id);const t=this.transfers.get(id);if(t&&samePrincipal(t.candidate.principal,principal))await this.closeOwned(t)}
  releaseList(principal:ChatVideoPrincipal,listId:string):void {this.fence.cancel(principal,listId);for(const [id,c] of this.candidates)if(samePrincipal(c.principal,principal)&&c.listId===listId)this.candidates.delete(id)}
  closeConnection(p:ChatVideoPrincipal):void{this.fence.cancelConnection(p);for(const [id,c] of this.candidates)if(samePrincipal(c.principal,p))this.candidates.delete(id);for(const t of this.transfers.values())if(samePrincipal(t.candidate.principal,p))void this.closeOwned(t)}
  dispose():void{this.disposed=true;this.candidates.clear();for(const t of this.transfers.values())void this.closeOwned(t)}
  private async closeOwned(t:Transfer):Promise<void>{if(t.closed)return;t.closed=true;this.transfers.delete(t.id);clearTimeout(t.timer);t.abort.abort();await t.reader?.close().catch(()=>undefined)}
}
