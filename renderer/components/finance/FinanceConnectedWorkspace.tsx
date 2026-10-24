"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { financeStore } from "@/lib/finance-store";
import { useT } from "@/lib/i18n";
import { FinanceWorkspace, type FinanceAIContext } from "./FinanceWorkspace";
import { WorkChatDraftContext, type WorkChatDraftRequest } from "@/lib/work-chat-draft";
import type { FinanceAPI } from "@shared/finance";
import type { FinanceAnalystRequest } from "@shared/finance-analysts";
import type { FinanceExperienceRequest } from "@shared/finance-experience";

function FinanceChatLoading() {
  const { locale } = useT();
  return <p role="status" style={{ padding: 24 }}>{locale === "ko" ? "Finance 대화를 여는 중…" : "Opening Finance conversations…"}</p>;
}
const FinanceWorkChat = dynamic(() => import("./FinanceWorkChat").then(module => module.FinanceWorkChat), {
  ssr: false,
  loading: FinanceChatLoading,
});

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
}
export function financeScreenContext(context:FinanceAIContext):string {
  const selection={dashboardId:context.dashboardId,selectedWidgetId:context.selectedWidgetId,
    reportId:context.reportId??null,selectedSectionId:context.selectedSectionId??null,
    ...(context.selectedSeries!==undefined?{selectedSeries:context.selectedSeries}:{}),
    history:context.history?.slice(-6).map(item=>({role:item.role,content:item.content.slice(0,180)}))??[]};
  // Bound the serialized packet, including JSON escapes, to the host's exact IPC limit.
  while(JSON.stringify(selection).length>2000&&selection.history.length)selection.history.shift();
  const serialized=JSON.stringify(selection);
  if(serialized.length>2000)throw new Error('finance_screen_context_too_large');
  return serialized;
}

/** Native account custody is re-established before any saved financial state is displayed. */
export function FinanceConnectedWorkspace() {
  const { locale } = useT();
  const [api, setApi] = useState<FinanceAPI | null>(null);
  const [ready, setReady] = useState(false);
  const [workDraft, setWorkDraft] = useState<{ ownerScope: string; draft: WorkChatDraftRequest } | null>(null);
  const [experienceRefreshVersion,setExperienceRefreshVersion]=useState(0);
  useEffect(() => {
    let mounted = true, generation = 0;
    const bridge = ipc();
    const reconnect = () => {
      const epoch = ++generation;
      setReady(false); setApi(null); financeStore.reset();
      void financeStore.load().catch(() => undefined).finally(() => {
        if (!mounted || generation !== epoch) return;
        setApi(ipc()?.finance ?? null); setReady(true);
      });
    };
    const unsubscribe = bridge?.auth?.onSessionChanged?.(reconnect);
    reconnect();
    return () => { mounted = false; generation += 1; unsubscribe?.(); };
  }, []);
  useEffect(() => {
    if (!api?.onChanged) return;
    let active=true;
    const unsubscribe=api.onChanged(event=>{
      if(!active)return;
      const current=financeStore.getSnapshot().workspace;
      if(event.ownerScope!==current.ownerScope || event.revision<=current.revision)return;
      void financeStore.reloadIfNewer(event.ownerScope,event.revision).then(()=>{
        if(!active)return;
        const latest=financeStore.getSnapshot().workspace;
        if(latest.ownerScope===event.ownerScope&&latest.revision>=event.revision)
          setExperienceRefreshVersion(version=>version+1);
      }).catch(()=>undefined);
    });
    return ()=>{active=false;unsubscribe();};
  },[api]);
  const monitorRuns = useCallback(async (monitorId:string,page?:{cursor?:string;limit?:number}) => {
    await financeStore.refreshHostState();
    if(!api?.monitorRuns)throw new Error("finance_monitor_ledger_unavailable");
    return api.monitorRuns({monitorId,...page});
  },[api]);
  const inspectData = useCallback(async (request: import('@shared/finance').FinanceDataConnectionRequest) => {
    if (!api?.dataConnection) throw new Error('finance_connection_unavailable');
    return api.dataConnection(request);
  }, [api]);
  const experience = useCallback(async (request: FinanceExperienceRequest) => {
    if (!api?.experience) throw new Error('finance_experience_unavailable');
    return api.experience(request);
  }, [api]);
  const worldMarkets = useCallback(async () => {
    if (!api?.worldMarkets) throw new Error('finance_world_source_unavailable');
    return api.worldMarkets();
  }, [api]);
  const dashboardFeeds = useCallback(async () => {
    if (!api?.dashboardFeeds) throw new Error('finance_dashboard_feeds_unavailable');
    return api.dashboardFeeds();
  }, [api]);
  const analysts = useCallback(async (request:FinanceAnalystRequest) => {
    if(!api?.analysts)throw new Error("finance_analysts_unavailable");
    return api.analysts(request);
  },[api]);
  const workProject = useCallback(async () => {
    if (!api?.workProject) throw new Error("finance_work_project_unavailable");
    return api.workProject();
  }, [api]);
  if (!ready) return <main role="status" style={{ padding: 32 }}>{locale === "ko" ? "Agentlas Finance를 여는 중…" : "Opening Agentlas Finance…"}</main>;

  const currentOwnerScope = financeStore.getSnapshot().workspace.ownerScope;
  return <WorkChatDraftContext.Provider value={workDraft?.ownerScope === currentOwnerScope ? workDraft.draft : null}><FinanceWorkspace
    onWorkDraft={text=>{
      const ownerScope = financeStore.getSnapshot().workspace.ownerScope;
      if (!ownerScope || !text.trim()) return;
      const id = crypto.randomUUID();
      setWorkDraft({ ownerScope, draft: { id, text, onConsumed: () => setWorkDraft(current => current?.draft.id === id ? null : current) } });
    }}
    workChat={<FinanceWorkChat key={financeStore.getSnapshot().workspace.ownerScope ?? "unbound"} ownerScope={financeStore.getSnapshot().workspace.ownerScope} provisionProject={workProject}/>}
    experienceRefreshVersion={experienceRefreshVersion}
    onPlanning={api?.planning?async(request,signal)=>{assertNotCancelled(signal);const result=await api.planning!(request);assertNotCancelled(signal);return result;}:undefined}
    onPortfolio={api?.portfolio?async(request,signal)=>{
      assertNotCancelled(signal);
      const cancel=()=>{if(request.action==="extract")void api.cancelAsk?.({requestId:request.requestId}).catch(()=>undefined);};
      signal.addEventListener("abort",cancel,{once:true});
      try{
        if(request.action==="save")return await financeStore.runHostMutation(()=>api.portfolio!(request));
        const result=await api.portfolio!(request);assertNotCancelled(signal);return result;
      }finally{signal.removeEventListener("abort",cancel);}
    }:undefined}
    onAnalysts={api?.analysts?analysts:undefined}
    onExperience={api?.experience ? experience : undefined}
    onWorldMarkets={api?.worldMarkets ? worldMarkets : undefined}
    onDashboardFeeds={api?.dashboardFeeds ? dashboardFeeds : undefined}
    onInspectData={api?.dataConnection ? inspectData : undefined}
    onRunMonitor={api?.runMonitor ? async monitor => {
      await financeStore.flush();
      const result = await api.runMonitor!({monitorId:monitor.id});
      await financeStore.reload();
      return result;
    } : undefined}
    onMonitorRuns={api?.monitorRuns ? monitorRuns : undefined}
    onArchives={api?.archives ? async request => {
      if(request.action==="create"||request.action==="restore")
        return financeStore.runHostMutation(()=>api.archives!(request));
      return api.archives!(request);
    } : undefined}
    onQueryAndSave={api?.queryAndSave ? async (request,signal) => {
      assertNotCancelled(signal);
      const result=await api.queryAndSave!(request);
      // A completed host save remains committed even if the view was closed meanwhile.
      await financeStore.reload();
      assertNotCancelled(signal);
      return result;
    } : undefined}
    onConnectData={api && ipc()?.env?.set ? async key => {
      const value = key.trim();
      if (!value || value.length > 512) throw new Error("finance_provider_key_invalid");
      await ipc()!.env.set("ALPHAVANTAGE_API_KEY", value);
    } : undefined}
    onSearch={api?.search ? async (query, signal) => {
      assertNotCancelled(signal);
      const result = await api.search!({ query });
      assertNotCancelled(signal);
      return result;
    } : undefined}
    onQueryData={api?.queryData ? async (request, signal) => {
      assertNotCancelled(signal);
      const result = await api.queryData!(request);
      assertNotCancelled(signal);
      return result;
    } : undefined}
    onRefreshData={api?.refreshQuotes ? async signal => {
      assertNotCancelled(signal);
      const result = await api.refreshQuotes!();
      assertNotCancelled(signal);
      return result;
    } : undefined}
    onExport={api?.exportFile ? async file => {
      const result = await api.exportFile!({ filename: file.name, content: file.content, mimeType: file.mime.split(";")[0], ownerScope: file.ownerScope });
      if (!result.ok && !result.cancelled) throw new Error(result.error ?? "finance_export_failed");
      return { saved: result.ok, path: result.path };
    } : undefined}
    onOpenResearch={api?.startResearch ? async asset => {
      const result = await api.startResearch!({ assetId: asset.id });
      if (result.status !== "queued" && result.status !== "accepted") throw new Error("finance_research_not_started");
      navigate(`/workspace/task?id=${encodeURIComponent(result.chatId)}&workStart=${encodeURIComponent(result.intentId)}`);
    } : undefined}
    onScheduleMonitor={api?.scheduleMonitor ? async (monitor, scheduleHuman) => {
      const receipt = await api.scheduleMonitor!({ monitorId: monitor.id, scheduleHuman });
      if (receipt.status !== "active") throw new Error("finance_monitor_schedule_unconfirmed");
      await financeStore.reload();
    } : undefined}
    onPauseMonitor={api?.pauseMonitor ? async monitor => {
      const receipt = await api.pauseMonitor!({ monitorId: monitor.id });
      if (receipt.status !== "paused") throw new Error("finance_monitor_pause_unconfirmed");
      await financeStore.reload();
    } : undefined}
  /></WorkChatDraftContext.Provider>;
}
