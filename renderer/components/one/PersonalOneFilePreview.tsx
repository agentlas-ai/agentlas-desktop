"use client";
import { useEffect, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { LiveOutputViewer } from "@/components/LiveOutputViewer";
import { IconClose } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import type { PersonalOneFile } from "@/lib/personal-one-file-preview";
import styles from "./PersonalOneWorkspace.module.css";

export function PersonalOneFilePreview({file,locale,onClose}:{file:PersonalOneFile;locale:'ko'|'en';onClose:()=>void}) {
  const [text,setText]=useState<{key:string;content:string;truncated:boolean}|null>(null);
  const [unavailable,setUnavailable]=useState<string|null>(null);
  const key=`${file.chatId}:${file.path}`;
  const ko=locale==='ko';
  useEffect(()=>{
    let current=true;setUnavailable(null);setText(null);
    if(file.kind==='markdown'||file.kind==='text')void ipc()?.fs.readTextFile(file.path,{kind:'chat-assets',chatId:file.chatId}).then(value=>{
      if(!current)return;
      if(['missing','denied','error'].includes(value.reason ?? '')){setUnavailable(key);return;}
      setText({key,content:value.content,truncated:value.truncated});
    }).catch(()=>{if(current)setUnavailable(key);});
    return()=>{current=false;};
  },[key,file.kind,file.chatId,file.path]);
  return <aside className={styles.filePanel} aria-label={ko?'파일 미리보기':'File preview'} data-file-preview={file.path}>
    <header><span title={file.path}>{file.name}</span><button className={styles.iconButton} aria-label={ko?'미리보기 닫기':'Close preview'} onClick={onClose}><IconClose size={17}/></button></header>
    <div className={styles.fileStage}>
      {file.kind==='unsupported'?<p role="status">{ko?'이 형식의 미리보기는 아직 지원되지 않습니다.':'Preview is not available for this format.'}</p>
        :unavailable===key?<p role="status">{ko?'파일을 읽을 수 없습니다. 원래 작업의 파일과 접근 권한을 확인해 주세요.':'This file could not be read. Check the file and access in its originating work.'}</p>
        :file.kind==='markdown'||file.kind==='text'?text?.key===key?<>{text.truncated&&<p role="status">{ko?'큰 파일의 일부를 표시합니다.':'Showing part of a large file.'}</p>}{file.kind==='markdown'?<Markdown text={text.content} chatId={file.chatId} messageId={`preview:${key}`}/>:<pre>{text.content}</pre>}</>:<p role="status">{ko?'파일을 여는 중':'Opening file'}</p>
        :<LiveOutputViewer source={file.source} name={file.name} kind={file.kind} locale={locale} fill placement="sidebar"/>}
    </div>
  </aside>;
}
