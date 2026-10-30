"use client";

// The model and effort chips of the One composer for one conversation, with the One composer's own popover
// (OneComposerControls) and chip style (OneShell.module.css composerChip, data-one-composer-trigger).
// The chip reads and writes the conversation's durable pin; it is what every turn of that conversation runs
// (renderer/lib/one-runtime-chip.ts, electron/runtime/room-chip-runtime.ts).
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { IconAlertTriangle, IconChevronDown, IconRoute, IconSparkles } from "@/components/Icon";
import { runtimeModelDisplayLabel, runtimeModelFallbackLabel } from "@/components/dashboard/RuntimeModelPicker";
import { ipc, ipcEvents } from "@/lib/ipc";
import { llmLogoSrc } from "@/lib/llm-logo";
import { beginChatSelection, useChatSelectionIntent, readChatSelectionIntent, reconcileChatSelectionIntent } from "@/lib/chat-selection-intent";
import { readChatForRuntime } from "@/lib/chat-runtime-read";
import { goalRuntimeRefusalNotice, isOvertakenSelectionCode } from "@/lib/goal-runtime-refusal";
import { assertOneExplicitEffort, chipRuntimeFor, composerModelLabel, useRunningComposerModel, withOneRuntimeSelection } from "@/lib/one-runtime-chip";
import { runtimeSelectionReceiptMatches } from "@shared/runtime-selection-receipt";
import { ipcErrorCode } from "@shared/ipc-error-code";
import { sameRuntimeIdentity, selectionForRuntime } from "@shared/runtime-selection";
import type { Chat, RuntimeSelection, RuntimeStatus } from "@shared/types";
import { OneComposerControls, type OneComposerMenuKey, type OneComposerModelOption } from "./OneComposerControls";
import styles from "./OneShell.module.css";

const NO_ALWAYS_APPROVAL = { enabled: false, available: false, pending: false, failed: false, toggle: async () => undefined };
const noop = () => undefined;

export function OneRuntimeChips({
  chatId,
  locale,
  disabled = false,
  draftSelection,
  onSelectionConfirmed,
}: {
  chatId: string | null;
  locale: "ko" | "en";
  disabled?: boolean;
  /** A Work draft chooses only its next request; it never reads or writes a conversation pin. */
  draftSelection?: { value: RuntimeSelection | null; onChange: (selection: RuntimeSelection | null) => void };
  onSelectionConfirmed?: (chat: Chat) => void;
}) {
  const draft = draftSelection !== undefined;
  const choice = useChatSelectionIntent(draft ? null : chatId);
  const runningModel = useRunningComposerModel(draft ? null : chatId);
  const [inventory, setInventory] = useState<RuntimeStatus[]>([]);
  const [models, setModels] = useState<OneComposerModelOption[]>([]);
  const [pin, setPin] = useState<{ chatId: string; selection: RuntimeSelection | null } | null>(null);
  const [revision, setRevision] = useState(0);
  const [menu, setMenu] = useState<"model" | "effort" | null>(null);
  const [failed, setFailed] = useState(false);
  // Set only for a refusal caused outside the app (signed out, not installed...): the one plain sentence that says which.
  const [refusal, setRefusal] = useState<string | null>(null);
  const modelTrigger = useRef<HTMLButtonElement>(null);
  const effortTrigger = useRef<HTMLButtonElement>(null);
  const chatRef = useRef(chatId);
  const pinReadGenerationRef = useRef(0);
  chatRef.current = chatId;
  const pickerViewRef = useRef({ chatId, generation: 0, mounted: true });
  if (pickerViewRef.current.chatId !== chatId) {
    pickerViewRef.current.chatId = chatId;
    pickerViewRef.current.generation += 1;
  }
  useEffect(() => {
    pickerViewRef.current.mounted = true;
    return () => { pickerViewRef.current.mounted = false; pickerViewRef.current.generation += 1; };
  }, []);

  useEffect(() => {
    const api = ipc();
    if (!api?.runtime?.detect) return;
    let cancelled = false;
    let generation = 0;
    const refresh = () => {
      const request = ++generation;
      void api.runtime.detect().then((runtimes) => { if (!cancelled && request === generation) setInventory(runtimes); }).catch(() => { if (!cancelled && request === generation) setInventory([]); });
    };
    const off = ipcEvents()?.onStoreChanged?.((change) => { if (change.entity === "runtime") refresh(); });
    refresh();
    return () => { cancelled = true; off?.(); };
  }, []);

  // Another window (a One chat showing this conversation, the phone) may change the pin: follow Main's change event.
  useEffect(() => {
    if (draft || !chatId) return;
    return ipcEvents()?.onStoreChanged?.((change) => {
      if (change.entity === "chat" && change.id === chatId) {
        const api = ipc();
        if (api) void reconcileChatSelectionIntent(api, chatId);
        pinReadGenerationRef.current += 1;
        setRevision((value) => value + 1);
      }
    });
  }, [chatId, draft]);

  useEffect(() => {
    if (draft) return;
    const api = ipc();
    setFailed(false);
    setRefusal(null);
    if (!chatId || !api?.chats?.get) { setPin(null); return; }
    let cancelled = false;
    const readGeneration = ++pinReadGenerationRef.current;
    const isCurrent = () => !cancelled && chatRef.current === chatId && pinReadGenerationRef.current === readGeneration;
    void (async () => {
      const chat = await readChatForRuntime(api.chats, chatId, isCurrent);
      if (!chat || chat.id !== chatId) throw new Error("chat_runtime_selection_unavailable");
      const selection = chat?.runtimeSelection ?? null;
      if (isCurrent()) setPin({ chatId, selection });
    })().catch(() => { if (isCurrent()) setPin(null); });
    return () => { cancelled = true; };
  }, [chatId, revision, draft]);

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

  const shownPin = draft ? draftSelection.value : choice?.selection ?? (pin && pin.chatId === chatId ? pin.selection : null);
  const runtime = useMemo(() => draft
    ? chipRuntimeFor(inventory, shownPin)
    : pin && pin.chatId === chatId ? chipRuntimeFor(inventory, shownPin) : null,
  [chatId, inventory, pin, shownPin, draft]);

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
    const generation = pickerViewRef.current.generation;
    const pickerIsCurrent = () => pickerViewRef.current.mounted && pickerViewRef.current.generation === generation
      && chatRef.current === chatId;
    if (!pickerIsCurrent()) return;
    const base = runtimeOverride ?? runtime;
    setMenu(current => pickerIsCurrent() ? null : current);
    if (!base || disabled) return;
    const nextModel = patch.model !== undefined ? patch.model || null : base.model ?? null;
    const requestedEffort = patch.effort !== undefined ? patch.effort || null : patch.model !== undefined ? undefined : base.effort;
    if (patch.effort !== undefined) {
      try { assertOneExplicitEffort(base, nextModel, requestedEffort ?? null); }
      catch { setFailed(true); return; }
    }
    const selection = selectionForRuntime(withOneRuntimeSelection(base, nextModel, requestedEffort), { role: "orchestrator", inherit: false, includeSource: false });
    if (draftSelection !== undefined) { draftSelection.onChange(selection); return; }
    const api = ipc();
    const target = chatId;
    if (!api?.chats || !target) return;
    const intent = beginChatSelection(target, selection);
    let writeStarted = false;
    let writeAcknowledged = false;
    const readSavedSelection = () => {
      // The saved selection is the answer: the chip shows it again.
      pinReadGenerationRef.current += 1;
      setRevision((value) => value + 1);
    };
    try {
      // One re-read: a Main busy for a moment is not a reason to refuse the person's choice.
      let goal: Awaited<ReturnType<typeof api.chats.getGoalContext>>;
      try { goal = await api.chats.getGoalContext(target); }
      catch { if (!intent.isCurrent()) return; goal = await api.chats.getGoalContext(target); }
      if (!intent.isCurrent()) return;
      // An ongoing Goal takes a model change at its next safe episode; the conversation pin is not rewritten under it.
      // A Goal still being created has no revision yet: the choice is the pin. One that moved on is bound by Main at its
      // current revision, and one that ended is the pin as well.
      const goalRevision = goal?.lifecycle === "ongoing" ? goal.goalRevision : undefined;
      if (goal && goalRevision) intent.bindGoalReceiptScope(goal.goalId, goalRevision);
      writeStarted = true;
      const handoff = goal && goalRevision
        ? await api.chats.requestGoalRuntimeSelection(target, { expectedGoalId: goal.goalId, expectedGoalRevision: goalRevision, selection })
        : null;
      const updated = handoff?.chat ?? await api.chats.setRuntimeSelection(target, selection);
      if (!updated || updated.id !== target || !runtimeSelectionReceiptMatches(selection, updated.runtimeSelection)
        || (handoff && handoff.chat.id !== updated.id)) {
        throw new Error("runtime_selection_unacknowledged");
      }
      writeAcknowledged = true;
      if (handoff && !intent.acceptGoalReceipt(handoff)) return;
      if (!intent.isCurrent()) return;
      const confirmation = await intent.confirm(api);
      if (confirmation === "overtaken" && pickerIsCurrent()) readSavedSelection();
      if (confirmation !== "confirmed") return;
      if (!intent.isCurrent()) return;
      if (pickerIsCurrent()) {
        // A read started before this acknowledged write cannot repaint it.
        pinReadGenerationRef.current += 1;
        onSelectionConfirmed?.(updated);
        setPin(current => pickerIsCurrent() ? { chatId: target, selection: updated.runtimeSelection ?? null } : current);
        setFailed(current => pickerIsCurrent() ? false : current);
        setRefusal(current => pickerIsCurrent() ? null : current);
      }
    } catch (cause) {
      if (!intent.isCurrent()) return;
      const code = ipcErrorCode(cause);
      // A newer choice overtook this one (or the chat is gone): the saved selection is the latest, the chip shows it,
      // and nothing is said.
      if (isOvertakenSelectionCode(code)) {
        intent.yieldToSaved();
        if (pickerIsCurrent()) readSavedSelection();
        return;
      }
      // Only a cause outside the app is refused; Main raises it before it writes, so the saved choice is unchanged.
      const plain = !writeAcknowledged ? goalRuntimeRefusalNotice(code, selection, locale) : null;
      if (plain) intent.yieldToSaved(); else intent.markUnknown(cause);
      if (pickerIsCurrent()) {
        // The refused choice wrote nothing and was dropped above, so the chip already shows the saved one.
        if (plain) setRefusal(plain);
        if (writeStarted || intent.isCurrent() || plain) setFailed(current => pickerIsCurrent() ? true : current);
      }
    } finally {
      intent.finish();
    }
  }, [chatId, runtime, draft, draftSelection, disabled, onSelectionConfirmed, locale]);

  // Nothing until this conversation's pin is read: a default label first would claim a model the turn may not run.
  if (!draft && (!chatId || pin?.chatId !== chatId)) return null;
  // 선택이 비어 있으면 실제로 돌 모델 이름을 보인다 — "기본값" 문구는 없다.
  const requestedModelLabel = runtime
    ? runtimeModelDisplayLabel(runtime, locale, models.filter((model) => sameRuntimeIdentity(model.runtime, runtime)))
    : draft
      ? shownPin?.model ?? (shownPin ? runtimeModelFallbackLabel(shownPin.kind, locale) : locale === "ko" ? "모델 확인 중…" : "Checking model…")
      : shownPin?.model ?? (shownPin ? runtimeModelFallbackLabel(shownPin.kind, locale) : locale === "ko" ? "모델 확인 중…" : "Checking model…");
  const modelLabel = composerModelLabel(requestedModelLabel, runningModel, locale);
  const effortLabel = runtime?.efforts?.find((effort) => effort.id === runtime.effort)?.label ?? (locale === "ko" ? "기본" : "Default");
  const waiting = choice?.status === "pending" || choice?.status === "unknown";
  const failedChoice = failed || choice?.status === "conflicted";
  const failure = refusal ?? (choice?.status === "conflicted"
    ? locale === "ko" ? "다른 곳에서 모델이 변경되었습니다. 선택을 확인해 주세요." : "The model changed elsewhere. Review your choice."
    : locale === "ko" ? "선택한 모델을 확인하지 못했습니다. 작성한 글은 보관됩니다." : "The selected model could not be confirmed. Your draft is kept.");
  const toggle = (next: "model" | "effort") => setMenu((current) => current === next ? null : next);
  return (
    <>
      <button
        type="button"
        className={styles.composerChip}
        data-one-composer-trigger="model"
        data-fit-chip="model"
        ref={modelTrigger}
        data-failed={failedChoice ? "true" : undefined}
        disabled={disabled}
        aria-expanded={menu === "model"}
        aria-haspopup="dialog"
        aria-controls={menu === "model" ? "one-composer-popover" : undefined}
        aria-label={`${locale === "ko" ? "모델" : "Model"}: ${modelLabel}`}
        aria-busy={waiting || undefined}
        title={failedChoice ? failure : modelLabel}
        onClick={() => toggle("model")}
      >
        {failedChoice ? <IconAlertTriangle size={14} /> : <IconSparkles size={15} />}
        <span data-fit-label>{modelLabel}{waiting ? locale === "ko" ? " · 확인 중" : " · Confirming" : ""}</span>
        <IconChevronDown size={12} />
      </button>
      {runtime && (runtime.efforts?.length ?? 0) > 0 && (
        <button
          type="button"
          className={styles.composerChip}
          data-one-composer-trigger="effort"
          data-fit-chip="effort"
          ref={effortTrigger}
          disabled={disabled}
          aria-expanded={menu === "effort"}
          aria-haspopup="dialog"
          aria-controls={menu === "effort" ? "one-composer-popover" : undefined}
          aria-label={`${locale === "ko" ? "추론 강도" : "Reasoning effort"}: ${effortLabel}`}
          title={effortLabel}
          onClick={() => toggle("effort")}
        >
          <IconRoute size={15} />
          <span data-fit-label>{effortLabel}</span>
          <IconChevronDown size={12} />
        </button>
      )}
      {draftSelection !== undefined && shownPin && <button type="button" className={styles.composerChip} disabled={disabled}
        aria-label={locale === "ko" ? "작업 모델 선택 해제" : "Clear Work model selection"}
        onClick={() => { setMenu(null); draftSelection.onChange(null); }}>{locale === "ko" ? "기존 Work 설정 사용" : "Use existing Work settings"}</button>}
      {failedChoice && <span role="alert" className="sr-only">{failure}</span>}
      {menu && (
        <OneComposerControls
          activeMenu={menu}
          locale={locale}
          contextChatId={chatId}
          anchor={menu === "effort" ? effortTrigger.current : modelTrigger.current}
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
          selectionIntentId={choice?.requestId}
          onSelectEffort={(effort, displayed, intentId) => {
            if (!displayed || !draft && readChatSelectionIntent(chatId)?.requestId !== intentId) return;
            void apply({ effort }, displayed);
          }}
          onSelectPermission={noop}
          onToggleTurnOption={noop}
        />
      )}
    </>
  );
}
