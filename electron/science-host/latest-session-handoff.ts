/** Ordered latest-state handoff: an older in-flight request finishes before a
 * newer logout/account change is sent, and superseded queued requests are
 * dropped. Snapshot values stay inside the host process and native channel. */
export function createLatestSessionHandoff<T>(options: {snapshot():T;send(value:T):Promise<unknown>}) {
  let revision=0, closed=false, tail:Promise<void>=Promise.resolve();
  function request():void {
    const requested=++revision;
    tail=tail.catch(()=>undefined).then(async()=>{
      if(closed || requested!==revision)return;
      await options.send(options.snapshot());
    }).catch(()=>undefined);
  }
  function close():void {closed=true;revision++;}
  function settled():Promise<void> {return tail;}
  return Object.freeze({request,close,settled});
}
