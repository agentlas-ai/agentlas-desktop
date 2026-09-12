/** Runs in a dedicated isolated world; the page has no reference to this state. */
export const BROWSER_ANNOTATION_WORLD = 1047;
export const annotationInstallScript = String.raw`(() => {
  const key = '__agentlasBrowserAnnotation';
  const token = '__ANNOTATION_SESSION_ID__';
  if (globalThis.__agentlasAnnotationCancelled?.has(token)) return false;
  globalThis[key]?.stop();
  const host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;inset:0;pointer-events:auto;cursor:crosshair;z-index:2147483647';
  const shadow = host.attachShadow({mode:'closed'});
  const outline = document.createElement('div');
  outline.style.cssText = 'position:fixed;pointer-events:none;border:1.5px solid #7774ef;background:rgba(119,116,239,.07);border-radius:3px;box-sizing:border-box;display:none';
  shadow.append(outline); document.documentElement.append(host);
  let selected = null, selection = null, sequence = 0, error = null;
  const clean = (s, n) => String(s ?? '').replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,n);
  function selector(el) {
    const parts = []; let node = el;
    for (let depth=0; node && depth<6; depth++,node=node.parentElement) {
      if (node.id) { parts.unshift('#'+CSS.escape(node.id)); break; }
      let part = node.tagName.toLowerCase();
      if (node.parentElement) {
        const siblings = Array.from(node.parentElement.children).filter(other=>other.tagName===node.tagName);
        if(siblings.length>1)part += ':nth-of-type('+(siblings.indexOf(node)+1)+')';
      }
      parts.unshift(part);
    }
    return parts.join(' > ').slice(0,512);
  }
  function snapshot(el) {
    const r=el.getBoundingClientRect();
    return {tagName:el.tagName.toLowerCase(),selector:selector(el),textSnippet:clean(el.textContent,500),
      role:el.getAttribute('role') ? clean(el.getAttribute('role'),80):null,
      ariaLabel:el.getAttribute('aria-label') ? clean(el.getAttribute('aria-label'),200):null,
      rect:{x:r.x,y:r.y,width:r.width,height:r.height}};
  }
  function paint(el) {
    if(!el?.isConnected){outline.style.display='none';return;}
    const r=el.getBoundingClientRect();
    Object.assign(outline.style,{display:'block',left:r.left+'px',top:r.top+'px',width:r.width+'px',height:r.height+'px'});
  }
  function validTarget(event) {
    const el=document.elementsFromPoint(event.clientX,event.clientY).find(node=>node instanceof Element && node!==host);
    if(!el || el===host || el.getRootNode()!==document || el.shadowRoot || el.tagName.includes('-')) return {error:'annotation_shadow_frame_unsupported'};
    if(['IFRAME','FRAME','OBJECT','EMBED'].includes(el.tagName))return {error:'annotation_cross_frame_unsupported'};
    return {el};
  }
  const move=event=>{if(event.isTrusted && !selected){const target=validTarget(event);paint(target.el);}};
  const click=event=>{
    if(!event.isTrusted)return;
    event.preventDefault();event.stopImmediatePropagation();
    const target=validTarget(event);sequence++;error=target.error??null;
    if(!target.el){selected=null;selection=null;paint(null);return;}
    selected=target.el;selection=snapshot(selected);paint(selected);
  };
  const keydown=event=>{if(event.isTrusted&&event.key==='Escape'){error='annotation_cancelled';selected=null;selection=null;paint(null);}};
  document.addEventListener('mousemove',move,true);document.addEventListener('click',click,true);document.addEventListener('keydown',keydown,true);
  globalThis[key]={
    sessionId:token,
    read(){
      if(!host.isConnected)return {sequence,error:'annotation_overlay_removed'};
      if(error)return {sequence,error};
      if(!selected)return {sequence,element:null};
      if(!selected.isConnected)return {sequence,error:'annotation_element_detached'};
      const current=snapshot(selected);
      const material=value=>JSON.stringify([value.tagName,value.selector,value.textSnippet,value.role,value.ariaLabel]);
      if(material(current)!==material(selection))return {sequence,error:'annotation_element_changed'};
      paint(selected);return {sequence,element:current};
    },
    stop(){document.removeEventListener('mousemove',move,true);document.removeEventListener('click',click,true);document.removeEventListener('keydown',keydown,true);host.remove();delete globalThis[key];}
  };
  return true;
})()`;
export const annotationReadScript = (sessionId: string): string => `globalThis.__agentlasBrowserAnnotation?.sessionId === ${JSON.stringify(sessionId)} ? globalThis.__agentlasBrowserAnnotation.read() : {error:'annotation_session_missing'}`;
export const annotationStopScript = (sessionId: string): string => `(() => {
  const cancelled = globalThis.__agentlasAnnotationCancelled ??= new Set();
  if (cancelled.size >= 128) cancelled.delete(cancelled.values().next().value);
  cancelled.add(${JSON.stringify(sessionId)});
  if (globalThis.__agentlasBrowserAnnotation?.sessionId === ${JSON.stringify(sessionId)}) globalThis.__agentlasBrowserAnnotation.stop();
  return true;
})()`;
