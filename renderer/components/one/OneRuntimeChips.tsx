"use client";

// The model and effort chips of the One composer for one conversation, with the One composer's own popover
// (OneComposerControls) and chip style (OneShell.module.css composerChip, data-one-composer-trigger).
// The chip reads and writes the conversation's durable pin; it is what every turn of that conversation runs
// (renderer/lib/one-runtime-chip.ts, electron/runtime/room-chip-runtime.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconAlertTriangle, IconChevronDown, IconRoute, IconSparkles } from "@/components/Icon";
import { runtimeModelFallbackLabel } from "@/components/dashboard/RuntimeModelPicker";
import { ipc, ipcEvents } from "@/lib/ipc";
import { llmLogoSrc } from "@/lib/llm-logo";
import { adoptStoredOneRuntimeOnce, chipRuntimeFor, withOneRuntimeSelection } from "@/lib/one-runtime-chip";
import { selectionForRuntime } from "@shared/runtime-selection";
import { runtimeSelectionReceiptMatches } from "@shared/runtime-selection-receipt";
import type { RuntimeSelection, RuntimeStatus } from "@shared/types";
import { OneComposerControls, type OneComposerMenuKey, type OneComposerModelOption } from "./OneComposerControls";
import styles from "./OneShell.module.css";

const NO_ALWAYS_APPROVAL = { enabled: false, available: false, pending: false, failed: false, toggle: async () => undefined };
const noop = () => undefined;

export function OneRuntimeChips({
  chatId,
  locale,
  disabled = false,
  adoptStoredSelection = false,
}: {
  chatId: string | null;
  locale: "ko" | "en";
  disabled?: boolean;
  /** The personal window: take over the renderer-global One pin once (adoptStoredOneRuntimeOnce). */
  adoptStoredSelection?: boolean;
}) {
  const [inventory, setInventory] = useState<RuntimeStatus[]>([]);
  const [models, setModels] = useState<OneComposerModelOption[]>([]);
  const [pin, setPin] = useState<{ chatId: string; selection: RuntimeSelection | null } | null>(null);
  const [revision, setRevision] = useState(0);
  const [menu, setMenu] = useState<"model" | "effort" | null>(null);
  const [failed, setFailed] = useState(false);
  const chatRef = useRef(chatId);
  chatRef.current = chatId;

  useEffect(() => {
    const api = ipc();
    if (!api?.runtime?.detect) return;
    let cancelled = false;
    void api.runtime.detect().then((runtimes) => { if (!cancelled) setInventory(runtimes); }).catch(() => { if (!cancelled) setInventory([]); });
    return () => { cancelled = true; };
  }, []);

  // Another window (a One chat showing this conversation, the phone) may change the pin: follow Main's change event.
  useEffect(() => {
    if (!chatId) return;
    return ipcEvents()?.onStoreChanged?.((change) => {
      if (change.entity === "chat" && change.id === chatId) setRevision((value) => value + 1);
    });
  }, [chatId]);

  useEffect(() => {
    const api = ipc();
    setFailed(false);
    if (!chatId || !api?.chats?.get) { setPin(null); return; }
    let cancelled = false;
    void (async () => {
      const chat = await api.chats.get(chatId);
      let selection = chat?.runtimeSelection ?? null;
      if (adoptStoredSelection && chat) {
        selection = await adoptStoredOneRuntimeOnce(api.chats, chatId, selection).catch(() => null) ?? selection;
      }
      if (!cancelled) setPin({ chatId, selection });
    })().catch(() => { if (!cancelled) setPin(null); });
    return () => { cancelled = true; };
  }, [adoptStoredSelection, chatId, revision]);

  useEffect(() => {
    const api = ipc();
    if (!api?.runtime?.listModels || inventory.length === 0) { setModels([]); return; }
    let cancelled = false;
    void Promise.all(inventory.map(async (runtime) => {
      const listed = await api.runtime.listModels({ kind: runtime.kind, backend: runtime.backend, availableModels: runtime.availableModels });
      const provider = runtime.kind === "claude-code" ? "Claude"
        : runtime.kind === "codex" ? "Codex"
          : runtime.kind === "antigravity" ? "Antigravity"
            : runtime.kind === "grok" ? "Grok"
              : runtime.kind === "kimi" ? "Kimi"
                : runtime.label ?? (runtime.backend || runtime.kind);
      return listed.map((model) => ({
        ...model,
        runtime,
        tag: model.tag ?? provider,
        logo: llmLogoSrc({ model: model.id, backend: runtime.backend, kind: runtime.kind }),
      }));
    })).then((groups) => { if (!cancelled) setModels(groups.flat()); }).catch(() => { if (!cancelled) setModels([]); });
    return () => { cancelled = true; };
  }, [inventory]);

  const shownPin = pin && pin.chatId === chatId ? pin.selection : null;
  const runtime = useMemo(() => (pin && pin.chatId === chatId ? chipRuntimeFor(inventory, shownPin) : null), [chatId, inventory, pin, shownPin]);

  useEffect(() => {
    if (!menu) return;
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const dismiss = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-one-composer-popover], [data-one-composer-trigger]")) return;
      setMenu(null);
    };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", dismiss);
      document.removeEventListener("keydown", escape);
      if (opener && opener.isConnected && !opener.contains(document.activeElement)) opener.focus({ preventScroll: true });
    };
  }, [menu]);

  const apply = useCallback(async (patch: { model?: string; effort?: string }, runtimeOverride?: RuntimeStatus) => {
    const base = runtimeOverride ?? runtime;
    const api = ipc();
    const target = chatRef.current;
    setMenu(null);
    if (!base || !api?.chats || !target) return;
    const nextModel = patch.model !== undefined ? patch.model || null : base.model ?? null;
    const requestedEffort = patch.effort !== undefined ? patch.effort || null : patch.model !== undefined ? undefined : base.effort;
    const selection = selectionForRuntime(withOneRuntimeSelection(base, nextModel, requestedEffort), { role: "orchestrator", inherit: false, includeSource: false });
    try {
      const goal = await api.chats.getGoalContext(target);
      if (goal?.lifecycle === "ongoing" && !goal.goalRevision) throw new Error("goal_runtime_selection_revision_changed");
      // An ongoing Goal takes a model change at its next safe episode; the conversation pin is not rewritten under it.
      const handoff = goal?.lifecycle === "ongoing" && goal.goalRevision
        ? await api.chats.requestGoalRuntimeSelection(target, { expectedGoalId: goal.goalId, expectedGoalRevision: goal.goalRevision, selection })
        : null;
      const updated = handoff?.chat ?? await api.chats.setRuntimeSelection(target, selection);
      if (!updated || updated.id !== target || !runtimeSelectionReceiptMatches(selection, updated.runtimeSelection)
        || (handoff && (handoff.goalId !== goal?.goalId || handoff.goalRevision !== goal?.goalRevision || handoff.state !== "pending"))) {
        throw new Error("runtime_selection_unacknowledged");
      }
      if (chatRef.current === target) { setPin({ chatId: target, selection: updated.runtimeSelection ?? null }); setFailed(false); }
    } catch {
      if (chatRef.current === target) setFailed(true);
    }
  }, [runtime]);

  // Nothing until this conversation's pin is read: a default label first would claim a model the turn may not run.
  if (!chatId || pin?.chatId !== chatId || (inventory.length === 0 && !runtime?.model)) return null;
  const modelLabel = models.find((model) => model.runtime.kind === runtime?.kind && model.runtime.backend === runtime?.backend && model.id === runtime?.model)?.label
    ?? runtime?.model ?? runtimeModelFallbackLabel(runtime?.kind ?? "agentlas", locale);
  const effortLabel = runtime?.efforts?.find((effort) => effort.id === runtime.effort)?.label ?? (locale === "ko" ? "기본" : "Default");
  const failure = locale === "ko" ? "모델을 바꾸지 못했습니다" : "Model not changed";
  const toggle = (next: "model" | "effort") => setMenu((current) => current === next ? null : next);
  return (
    <>
      <button
        type="button"
        className={styles.composerChip}
        data-one-composer-trigger="model"
        data-failed={failed ? "true" : undefined}
        disabled={disabled}
        aria-expanded={menu === "model"}
        aria-haspopup="dialog"
        aria-controls={menu === "model" ? "one-composer-popover" : undefined}
        aria-label={`${locale === "ko" ? "모델" : "Model"}: ${modelLabel}`}
        title={failed ? failure : modelLabel}
        onClick={() => toggle("model")}
      >
        {failed ? <IconAlertTriangle size={14} /> : <IconSparkles size={15} />}
        <span>{modelLabel}</span>
        <IconChevronDown size={12} />
      </button>
      {runtime && (runtime.efforts?.length ?? 0) > 0 && (
        <button
          type="button"
          className={styles.composerChip}
          data-one-composer-trigger="effort"
          disabled={disabled}
          aria-expanded={menu === "effort"}
          aria-haspopup="dialog"
          aria-controls={menu === "effort" ? "one-composer-popover" : undefined}
          aria-label={`${locale === "ko" ? "추론 강도" : "Reasoning effort"}: ${effortLabel}`}
          title={effortLabel}
          onClick={() => toggle("effort")}
        >
          <IconRoute size={15} />
          <span>{effortLabel}</span>
          <IconChevronDown size={12} />
        </button>
      )}
      {failed && <span role="alert" className="sr-only">{failure}</span>}
      {menu && (
        <OneComposerControls
          activeMenu={menu}
          locale={locale}
          contextChatId={chatId}
          runtime={runtime}
          models={models}
          agents={[]}
          plugins={[]}
          permission="full"
          alwaysApproval={NO_ALWAYS_APPROVAL}
          turnOptions={{}}
          localFilesConnected={false}
          onMenuChange={(next: OneComposerMenuKey | null) => setMenu(next === "model" || next === "effort" ? next : null)}
          onAttach={noop}
          onAddFolder={noop}
          onClearFolder={noop}
          onOpenPlugins={noop}
          onTogglePlugin={noop}
          onToggleAgent={noop}
          onSelectModel={(selected, model) => { void apply({ model }, selected); }}
          onSelectEffort={(effort) => { void apply({ effort }); }}
          onSelectPermission={noop}
          onToggleTurnOption={noop}
        />
      )}
    </>
  );
}
