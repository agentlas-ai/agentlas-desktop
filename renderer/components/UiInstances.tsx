"use client";

import { useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { UiActionView, UiInstanceView } from "@shared/ui-instances";
import { mergeInlineUiTranscript } from "@shared/inline-ui-transcript";
import { validateInlineUiPresentationContent } from "@shared/inline-ui-presentation";
import { IntellectUiActions } from "@/lib/intellect-ui-actions";
import { readUiResult } from "@/lib/ui-result-read";
import { VisualChatScope } from "@/lib/visual-artifacts";
import {
  actionReply, admitMessage, createBridgeState, extractAppHtml, parseMcpAppViewId, reduceViewMessage, teardownMessage,
  wrapAppHtml, MCP_APP_SANDBOX, type BridgeEffect, type BridgeState,
} from "@/lib/mcp-app-bridge";
import { McpResultPreview } from "./McpResultPreview";
import { IntellectUI } from "./IntellectUI";
import { ChartBlock } from "./ChartBlock";
import { HtmlVisualBlock } from "./HtmlVisualBlock";
import { IconAlertTriangle, IconBolt, IconCheck, IconClose, IconEdit, IconExpand, IconSend } from "./Icon";
import styles from "./UiInstances.module.css";

type HarnessApi = {
  call: (operation: string, args?: Record<string, unknown>) => Promise<{ status: string; data?: unknown; reason?: string }>;
  uiList: (chatId: string) => Promise<UiInstanceView[]>;
  onUiChanged: (handler: (event: { chatId: string }) => void) => () => void;
};

const harnessApi = (): HarnessApi | null => (typeof window !== "undefined" ? ((window as unknown as { agentlas?: { harness?: HarnessApi } }).agentlas?.harness ?? null) : null);
const newCommandId = (): string => (globalThis.crypto?.randomUUID?.() ?? `c_${Date.now()}_${Math.random().toString(36).slice(2)}`);

async function runUiAction(instance: UiInstanceView, action: UiActionView, input: Record<string, unknown>) {
  const api = harnessApi();
  if (!api) return { status: "unavailable", reason: "harness_unavailable" };
  return api.call("ui.action", {
    chatId: instance.chatId, instanceId: instance.instanceId, actionId: action.actionId, actionRef: action.actionRef,
    expectedRevision: instance.revision, resultRef: instance.resultRef, commandId: newCommandId(), input,
  });
}

/** One source read per owning chat. Switches never display the previous chat's views. */
export function useInlineUiInstances(chatId?: string): UiInstanceView[] {
  const [instances, setInstances] = useState<UiInstanceView[]>([]);
  useEffect(() => {
    const api = harnessApi();
    if (!chatId || !api) { setInstances([]); return; }
    let alive = true;
    const load = () => { api.uiList(chatId).then(rows => { if (alive) setInstances(rows.filter(row => row.chatId === chatId)); }).catch(() => undefined); };
    load();
    const off = api.onUiChanged(event => { if (event.chatId === chatId) load(); });
    return () => { alive = false; off(); };
  }, [chatId]);
  return instances.filter(instance => instance.chatId === chatId && instance.state !== "closed");
}

/** Exact run ownership; an equivalent answer fence already owns its widget. */
export function inlineUiForReply(instances: readonly UiInstanceView[], turnId: string | undefined, text = ""): UiInstanceView[] {
  if (!turnId) return [];
  return instances.filter(instance => instance.turnId === turnId && instance.state !== "closed"
    && (!instance.content || mergeInlineUiTranscript(instance.chatId,
      [{ id: "reply", role: "assistant", text, createdAt: instance.createdAt }], [instance]).fallbackByMessageId.size > 0));
}

/** Cards render inside the caller's owning assistant bubble, never in an output tab. */
export function InlineUiInstances({ chatId, turnIds, locale, instances }: {
  chatId?: string; turnIds?: readonly string[]; locale: "ko" | "en"; instances?: readonly UiInstanceView[];
}) {
  const loaded = useInlineUiInstances(instances ? undefined : chatId);
  const visible = (instances ?? loaded).filter(instance => instance.chatId === chatId && instance.state !== "closed"
    && (!turnIds || turnIds.includes(instance.turnId)));
  if (visible.length === 0) return null;
  return <>{visible.map(instance => <UiInstanceCard key={instance.instanceId} instance={instance} locale={locale} />)}</>;
}

const INTENT_ICON = { "host-action": IconBolt, "open-artifact": IconExpand, "prepare-input": IconEdit, "model-followup": IconSend, "local-state": IconCheck } as const;

function UiInstanceCard({ instance, locale }: { instance: UiInstanceView; locale: "ko" | "en" }) {
  const composer = useContext(IntellectUiActions);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [structured, setStructured] = useState<string | null>(null);
  const mcpApp = instance.presentation.kind === "mcp-app" ? parseMcpAppViewId(instance.presentation.viewId) : null;
  const inline = useMemo(() => instance.content ? validateInlineUiPresentationContent(instance.content) : null, [instance.content]);

  useEffect(() => {
    const api = harnessApi();
    setStructured(null);
    if (!api || mcpApp || instance.content) return;
    let alive = true;
    readUiResult((operation, args) => api.call(operation, { ...args, chatId: instance.chatId }), instance.structuredResultRef ?? instance.resultRef, () => alive).then((original) => {
      if (!alive || original == null) return;
      setStructured(typeof original === "string" ? original : JSON.stringify(original));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [instance.structuredResultRef, instance.resultRef, instance.revision, mcpApp?.connectorId, mcpApp?.uri, instance.content]);

  const act = useCallback(async (action: UiActionView) => {
    if (busy) return;
    setBusy(action.actionId); setFailed(null);
    try {
      const outcome = await runUiAction(instance, action, {});
      if (outcome.status !== "ok") { setFailed(outcome.reason ?? outcome.status); return; }
      const data = (outcome.data ?? {}) as { draft?: { text?: string }; followup?: { text?: string }; openRequest?: { operationId?: string; args?: Record<string, unknown> } };
      const text = data.draft?.text || data.followup?.text;
      if (text && composer.prepareFollowup) await composer.prepareFollowup(text);
      const open = data.openRequest;
      if (open?.operationId) {
        const opened = await harnessApi()?.call(open.operationId, open.args ?? {});
        if (opened && opened.status !== "ok") setFailed(opened.reason ?? opened.status);
      }
    } finally { setBusy(null); }
  }, [busy, composer, instance]);

  const close = useCallback(() => { void harnessApi()?.call("ui.close", { chatId: instance.chatId, instanceId: instance.instanceId }); }, [instance.chatId, instance.instanceId]);
  const visibleActions = instance.actions.filter((action) => action.intent !== "local-state");
  const closeLabel = locale === "ko" ? "닫기" : "Close";
  const blockId = `ui-instance:${instance.instanceId}:${instance.revision}`;
  const content = inline?.ok ? inline.content : null;
  const displayTitle = instance.presentation.title && (!content || instance.presentation.title !== instance.presentation.viewId)
    ? instance.presentation.title : locale === "ko" ? "인터랙티브 응답" : "Interactive response";
  const fallback = <p className={styles.text}>{instance.presentation.fallbackText || displayTitle}</p>;

  return (
    <section className={styles.card} data-ui-instance={instance.instanceId} data-ui-revision={instance.revision} aria-label={displayTitle}>
      <div className={styles.head}>
        <span className={styles.title} title={displayTitle}>{displayTitle}</span>
        {failed && <span title={failed} aria-label={failed}><IconAlertTriangle size={14} /></span>}
        <button type="button" className={styles.icon} onClick={close} aria-label={closeLabel} title={closeLabel}><IconClose size={14} /></button>
      </div>
      <VisualChatScope.Provider value={instance.chatId}>
      {content?.kind === "native"
        ? <IntellectUI code={JSON.stringify(content.document)} blockId={blockId} complete />
        : content?.kind === "visual"
          ? <HtmlVisualBlock html={content.html} blockId={blockId} title={displayTitle} fallback={fallback} />
          : content?.kind === "chart"
            ? <ChartBlock code={JSON.stringify(content.spec)} blockId={blockId} fallback={fallback} />
            : mcpApp
        ? <McpAppFrame instance={instance} connectorId={mcpApp.connectorId} uri={mcpApp.uri} />
        : (structured
          ? <McpResultPreview result={structured} locale={locale} compact />
          : fallback)}
      </VisualChatScope.Provider>
      {!mcpApp && visibleActions.length > 0 && (
        <div className={styles.actions}>
          {visibleActions.map((action) => {
            const Icon = INTENT_ICON[action.intent];
            return (
              <button key={action.actionRef} type="button" className={styles.button} disabled={busy !== null || composer.disabled} onClick={() => void act(action)} title={action.label ?? action.actionId}>
                <Icon size={13} />{action.label ?? action.actionId}
              </button>
            );
          })}
        </div>
      )}
    </section>
  );
}

/** Sandboxed MCP Apps view. No credentials, no IPC and no direct tool calls reach the iframe. */
function McpAppFrame({ instance, connectorId, uri }: { instance: UiInstanceView; connectorId: string; uri: string }) {
  const frameRef = useRef<HTMLIFrameElement | null>(null);
  const bridge = useRef<BridgeState>(createBridgeState());
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [height, setHeight] = useState(160);
  const toolResult = useRef<unknown>(undefined);
  const instanceRef = useRef(instance);
  instanceRef.current = instance;

  useEffect(() => {
    const api = harnessApi();
    if (!api) { setError("harness_unavailable"); return; }
    let alive = true;
    bridge.current = createBridgeState();
    setHtml(null); setError(null);
    (async () => {
      // Another agent implements the backend of this port; unavailable answers become a quiet failure icon.
      const resource = await api.call("mcp.app.resource.read", { connectorId, uri });
      const text = resource.status === "ok" ? extractAppHtml(resource.data) : null;
      if (!alive) return;
      if (!text) { setError(resource.reason ?? resource.status); return; }
      const result = await readUiResult((operation, args) => api.call(operation, { ...args, chatId: instance.chatId }), instance.structuredResultRef ?? instance.resultRef, () => alive).catch(() => null);
      if (!alive) return;
      toolResult.current = result && typeof result === "object" ? result : undefined;
      setHtml(wrapAppHtml(text));
    })().catch((cause) => { if (alive) setError(cause instanceof Error ? cause.message : "failed"); });
    return () => { alive = false; };
  }, [connectorId, uri, instance.resultRef, instance.structuredResultRef]);

  useEffect(() => {
    if (!html) return;
    const post = (message: Record<string, unknown>) => frameRef.current?.contentWindow?.postMessage(message, "*");
    const apply = async (effect: BridgeEffect) => {
      if (effect.type === "reply" || effect.type === "notify") post(effect.message);
      else if (effect.type === "resize") setHeight(Math.max(40, effect.height));
      else if (effect.type === "ui-action") {
        const current = instanceRef.current;
        const action = current.actions.find((item) => item.actionRef === effect.actionRef);
        const outcome = action ? await runUiAction(current, action, effect.input) : { status: "refused", reason: "action_stale" };
        post(actionReply(effect.requestId, outcome));
      }
    };
    const onMessage = (event: MessageEvent) => {
      if (!admitMessage({ source: event.source, origin: event.origin, data: event.data }, frameRef.current?.contentWindow)) return;
      const current = instanceRef.current;
      const dark = typeof document !== "undefined" && document.documentElement.dataset.theme === "dark";
      const step = reduceViewMessage(bridge.current, event.data, {
        actions: current.actions, theme: dark ? "dark" : "light", locale: document.documentElement.lang || "en", toolResult: toolResult.current,
      });
      bridge.current = step.state;
      for (const effect of step.effects) void apply(effect);
    };
    window.addEventListener("message", onMessage);
    const frame = frameRef.current;
    return () => {
      window.removeEventListener("message", onMessage);
      try { frame?.contentWindow?.postMessage(teardownMessage(1), "*"); } catch { /* frame already gone */ }
    };
  }, [html]);

  if (error) return <p className={styles.text}>{instance.presentation.fallbackText}</p>;
  if (!html) return null;
  return (
    <iframe
      ref={frameRef}
      className={styles.frame}
      title={instance.presentation.title}
      sandbox={MCP_APP_SANDBOX}
      srcDoc={html}
      style={{ height }}
      referrerPolicy="no-referrer"
    />
  );
}

