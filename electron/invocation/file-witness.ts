import {createHash} from 'node:crypto';
import {constants,promises as fs} from 'node:fs';
import path from 'node:path';
import type {FileWitness} from './generated-video-receipts';
/** Exact Main media_operations result path only; callers must not pass renderer/model paths. */
export async function captureVideoWitness(file:string,expectedSha:string,signal:AbortSignal, nofollowFlag:number = constants.O_NOFOLLOW || 0):Promise<FileWitness> {
  if(!path.isAbsolute(file)||!/^[a-f0-9]{64}$/.test(expectedSha)||signal.aborted)throw Error('video_witness_invalid');
  const before=await fs.lstat(file,{bigint:true}),beforeReal=await fs.realpath(file);
  if(!before.isFile()||before.isSymbolicLink()||before.nlink!==1n||beforeReal!==file||signal.aborted)throw Error('video_file_changed');
  const h=await fs.open(file,constants.O_RDONLY|nofollowFlag);
  try {
    const a=await h.stat({bigint:true}),n=await fs.lstat(file,{bigint:true}),real=await fs.realpath(file);
    if(!a.isFile()||a.nlink!==1n||n.isSymbolicLink()||!n.isFile()||a.dev!==n.dev||a.ino!==n.ino||before.dev!==a.dev||before.ino!==a.ino||before.size!==a.size||before.mtimeNs!==a.mtimeNs||before.ctimeNs!==a.ctimeNs||real!==file||a.size<1n||a.size>BigInt(192*1024*1024))throw Error('video_file_changed');
    const digest=createHash('sha256'),buf=Buffer.allocUnsafe(1024*1024);let pos=0;
    while(BigInt(pos)<a.size){if(signal.aborted)throw Error('video_stopped');const read=await h.read(buf,0,Math.min(buf.length,Number(a.size)-pos),pos);if(!read.bytesRead)throw Error('video_file_changed');digest.update(buf.subarray(0,read.bytesRead));pos+=read.bytesRead;}
    const b=await h.stat({bigint:true}),n2=await fs.lstat(file,{bigint:true});
    if(signal.aborted||a.dev!==b.dev||a.ino!==b.ino||a.size!==b.size||a.mtimeNs!==b.mtimeNs||a.ctimeNs!==b.ctimeNs||b.dev!==n2.dev||b.ino!==n2.ino||b.size!==n2.size||b.mtimeNs!==n2.mtimeNs||b.ctimeNs!==n2.ctimeNs||digest.digest('hex')!==expectedSha)throw Error('video_file_changed');
    return {sha256:expectedSha,dev:String(b.dev),ino:String(b.ino),size:Number(b.size),mtimeNs:String(b.mtimeNs),ctimeNs:String(b.ctimeNs)};
  } finally {await h.close();}
}
