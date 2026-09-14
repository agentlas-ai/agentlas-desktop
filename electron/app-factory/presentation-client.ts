import { currentUiLocale } from "../ui-locale";

/** Runs in the isolated artifact guest. It restores data only, never input/action events. */
export function artifactPresentationClient(config: { token: string; bundleDigest: string }): string {
  // 게스트 페이지의 안내 문구는 생성 시점의 화면 언어로 고른다 — 영어 화면에 한국어가 새지 않게(오너 2026-09-14).
  const ko = currentUiLocale() === "ko";
  const copy = {
    conflict: ko ? "다른 화면에서 저장된 입력이 있습니다. 현재 입력을 보존했어요. 다시 열어 최신 상태를 확인해 주세요." : "Input was saved from another view. Your current input was kept — reopen to see the latest state.",
    saveFailed: ko ? "입력 상태를 저장하지 못했어요. 현재 화면을 유지해 주세요." : "Could not save the input state. Keep this view open.",
    readFailed: ko ? "저장된 입력 상태를 읽지 못했어요. 현재 입력은 그대로 유지됩니다." : "Could not read the saved input state. Your current input stays as it is.",
    buildFailed: ko ? "새 버전을 준비하지 못했어요. 이전 정상 버전을 표시하고 있습니다." : "The new version could not be prepared. Showing the last working version.",
  };
  return `const __agentlasPresentationConfig=${JSON.stringify(config)};\nconst __agentlasPresentationCopy=${JSON.stringify(copy)};\n` + String.raw`(() => {
  if (window.__agentlasLiveReload) return;
  window.__agentlasLiveReload = true;
  const config=__agentlasPresentationConfig, endpoint='/__agentlas/presentation';
  const forbidden=/(password|secret|token|api[_-]?key|authorization|cookie|private[_-]?key)/i;
  const fieldKey=node=>node.getAttribute('data-agentlas-state-key')||node.id||null;
  const fields=()=>{const seen=new Set();return [...document.querySelectorAll('input,textarea,select')].filter(node=>{
    const key=fieldKey(node);if(!key||key.length>256||forbidden.test(key)||seen.has(key)||['password','file','hidden','submit','button','reset','image'].includes(node.type))return false;
    seen.add(key);return true;
  }).slice(0,200);};
  const snapshot=()=>{const nodes=fields();return {schemaVersion:1,fields:nodes.map(node=>({key:fieldKey(node),tag:node.tagName,type:node.type,value:node.value.slice(0,32768),
    ...(typeof node.checked==='boolean'?{checked:node.checked}:{}),selectionStart:node.selectionStart??null,selectionEnd:node.selectionEnd??null})),
    focus:nodes.includes(document.activeElement)?fieldKey(document.activeElement):null,scroll:{x:Math.max(0,scrollX),y:Math.max(0,scrollY)}};};
  let revision=0,ready=false,dirty=false,blocked=false,restoring=false,saving=null,timer=null,pendingReload=false,lastState=null;
  const notice=text=>{let node=document.getElementById('__agentlas_build_notice');if(!node){node=document.createElement('div');node.id='__agentlas_build_notice';node.setAttribute('role','status');
    node.style.cssText='position:fixed;bottom:12px;right:12px;max-width:min(360px,90vw);padding:12px 16px;background:#fff4df;color:#503717;border:1px solid #decba5;border-radius:12px;font:13px/1.5 system-ui;z-index:2147483647';document.body.appendChild(node);}node.textContent=text;};
  const request=()=>({token:config.token,bundleDigest:config.bundleDigest,expectedRevision:revision,requestId:crypto.randomUUID(),state:snapshot()});
  const save=async()=>{
    if(!ready||blocked)return;
    if(saving){await saving;if(dirty)return save();return;}
    const payload=request(),serialized=JSON.stringify(payload.state);
    if(serialized===lastState){dirty=false;return;}
    dirty=false;
    saving=(async()=>{
      try{
        const response=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','X-Agentlas-Presentation':config.token},body:JSON.stringify(payload),keepalive:true});
        const result=await response.json();
        if(result.status==='conflict'){blocked=true;notice(__agentlasPresentationCopy.conflict);return;}
        if(!response.ok||result.status!=='saved')throw Error('presentation_save_failed');
        revision=result.receipt.revision;lastState=serialized;
        window.dispatchEvent(new CustomEvent('agentlas:presentation-saved',{detail:{revision,originBundleDigest:config.bundleDigest}}));
      }catch{dirty=true;notice(__agentlasPresentationCopy.saveFailed);}
    })();
    await saving;saving=null;
  };
  const changed=()=>{if(restoring||blocked)return;dirty=true;clearTimeout(timer);timer=setTimeout(()=>void save(),180);};
  for(const event of ['input','change','focusin','selectionchange'])document.addEventListener(event,changed,true);
  window.addEventListener('scroll',changed,{passive:true});
  window.addEventListener('pagehide',()=>{if(!ready||blocked||!dirty||saving)return;const body=JSON.stringify(request());if(body.length<60000)navigator.sendBeacon(endpoint,new Blob([body],{type:'application/json'}));});
  const initial=fetch(endpoint,{headers:{'X-Agentlas-Presentation':config.token}}).then(async response=>{
    if(!response.ok)throw Error('presentation_read_failed');const result=await response.json(),receipt=result.receipt;
    revision=receipt?.revision??0;
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    if(receipt&&!dirty){
      restoring=true;const saved=receipt.state,nodes=fields();
      for(const value of saved.fields){const node=nodes.find(node=>fieldKey(node)===value.key&&node.tagName===value.tag&&node.type===value.type);if(!node)continue;
        node.value=value.value;if(typeof value.checked==='boolean')node.checked=value.checked;
        if(saved.focus===value.key){node.focus({preventScroll:true});if(typeof value.selectionStart==='number')try{node.setSelectionRange(value.selectionStart,value.selectionEnd);}catch{}}
      }
      scrollTo(saved.scroll.x,saved.scroll.y);restoring=false;lastState=JSON.stringify(snapshot());
      window.dispatchEvent(new CustomEvent('agentlas:presentation-restored',{detail:{schemaVersion:1,revision,state:saved,originBundleDigest:receipt.originBundleDigest}}));
    }
    ready=true;if(dirty)await save();
  }).catch(()=>{blocked=true;notice(__agentlasPresentationCopy.readFailed);});
  const source=new EventSource('/__agentlas/events');
  source.addEventListener('reload',async()=>{if(pendingReload)return;pendingReload=true;await initial;await save();if(blocked||dirty){pendingReload=false;return;}window.location.reload();});
  source.addEventListener('build-failed',()=>notice(__agentlasPresentationCopy.buildFailed));
})();`;
}
