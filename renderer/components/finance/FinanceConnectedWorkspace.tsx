"use client";

import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import { financeStore } from "@/lib/finance-store";
import { useT } from "@/lib/i18n";
import { FinanceWorkspace } from "./FinanceWorkspace";
import type { FinanceAPI } from "@shared/finance";

function assertNotCancelled(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException("Cancelled", "AbortError");
}

/** Native account custody is re-established before any saved financial state is displayed. */
export function FinanceConnectedWorkspace() {
  const { locale } = useT();
  const [api, setApi] = useState<FinanceAPI | null>(null);
  const [ready, setReady] = useState(false);
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
  if (!ready) return <main role="status" style={{ padding: 32 }}>{locale === "ko" ? "Finance 작업 공간을 여는 중…" : "Opening Finance…"}</main>;

  return <FinanceWorkspace
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
    onAIRequest={api?.ask ? async (request, context) => {
      assertNotCancelled(context.signal);
      const cancel = () => { void api.cancelAsk?.({ requestId: context.requestId }).catch(() => undefined); };
      context.signal.addEventListener("abort", cancel, { once: true });
      try {
        const response = await api.ask!({ request, baseRevision: context.revision, requestId: context.requestId,
          screenContext: JSON.stringify({ dashboardId: context.dashboardId, selectedWidgetId: context.selectedWidgetId,
            reportId: context.reportId ?? null, selectedSectionId: context.selectedSectionId ?? null }) });
        assertNotCancelled(context.signal);
        return response;
      } finally { context.signal.removeEventListener("abort", cancel); }
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
  />;
}
