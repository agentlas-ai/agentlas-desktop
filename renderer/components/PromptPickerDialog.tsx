// 프롬프트 불러오기 팝업 — 사이드바 "새 채팅" 바로 아래 버튼에서 연다.
// 내 북마크·소장(unlocked) 프롬프트를 우선 정렬 + 검색(promptHub.list + bookmarks).
// 수익화 정책(2026-07): 유료 구독=무제한 열람(unlock, 과금 0), 무료=프롬프트당 맛보기 1회 —
// 맛보기 body는 taste 응답 그 자리에서만 제공되며 재열람 불가("맛보기는 1회만 제공돼요" + 구독 CTA).
// 스타일은 Sidebar의 NewChatScopeDialog 오버레이 패턴을 따른다.
"use client";
import { useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import {
  clearPromptTasteIntent,
  exactPromptUnlockBody,
  getOrCreatePromptStartIntent,
  getOrCreatePromptTasteIntent,
  getOrCreatePromptUnlockIntent,
  storedPromptTasteIntent,
} from "@/lib/prompt-actions";
import { useT } from "@/lib/i18n";
import type { Chat, HubPromptSummary, HubPromptViewer } from "@shared/types";
import { UpgradeCta } from "./UpgradeCta";
import { IconClose, IconLock, IconSearch, IconSparkles } from "./Icon";
import { LoadingEstimate } from "./LoadingEstimate";

/** 다국어 필드에서 현재 언어 텍스트를 뽑는다(영어 사용자에게 한국어 누수 방지). */
function pickText(ko: boolean, koText?: string, enText?: string): string {
  return ((ko ? koText?.trim() || enText : enText?.trim() || koText) ?? "").trim();
}

/**
 * 프롬프트 body로 새 채팅을 시작한다.
 * 기본은 ?prompt= 시드(첫 메시지 자동 전송). seedOnly=true면 자동 전송 대신 입력창에만
 * 채운다 — 입력물(사진/문서)이 필요한 프롬프트는 사용자가 첨부를 붙인 뒤 직접 전송해야
 * 결과가 이상하게 나오지 않는다.
 */
export type PromptChatStartResult =
  | { ok: true; chatId: string }
  | { ok: false; chatId?: string; code: "bridge_unavailable" | "intent_persistence_failed" | "create_failed" | "receipt_mismatch" | "readback_failed" };

export function isExactPromptChat(value: Chat | null | undefined, expectedId?: string): value is Chat {
  if (!value || typeof value.id !== "string" || !value.id.trim()) return false;
  if (expectedId && value.id !== expectedId) return false;
  return value.originSurface === "one"
    && value.kind === "user"
    && value.projectId === null
    && value.firmId === null
    && value.archivedAt === null
    && typeof value.agentId === "string"
    && Boolean(value.agentId.trim())
    && (value.taskId === undefined || value.taskId === null);
}

export async function startChatWithPrompt(
  body: string,
  opts: { promptSlug: string; seedOnly?: boolean },
): Promise<PromptChatStartResult> {
  const api = ipc();
  if (!api) return { ok: false, code: "bridge_unavailable" };
  const seedOnly = opts.seedOnly === true;
  const intent = await getOrCreatePromptStartIntent({
    slug: opts.promptSlug,
    body,
    seedOnly,
  });
  if (!intent) return { ok: false, code: "intent_persistence_failed" };
  let chatId = "";
  try {
    const receipt = await api.promptHub.startChat({
      intentId: intent.intentId,
      body,
      seedOnly,
    });
    const receivedChat = receipt?.chat;
    if (receipt?.ok !== true
      || receipt.receiptVersion !== 1
      || (receipt.status !== "created" && receipt.status !== "replayed")
      || receipt.intentId !== intent.intentId
      || receipt.promptDigest !== intent.promptDigest
      || receipt.seedOnly !== seedOnly
      || !isExactPromptChat(receivedChat)) {
      const receivedId = typeof receivedChat?.id === "string" && receivedChat.id.trim() ? receivedChat.id : undefined;
      return { ok: false, ...(receivedId ? { chatId: receivedId } : {}), code: "receipt_mismatch" };
    }
    chatId = receivedChat.id;

    let projected: Chat | null;
    try {
      projected = await api.chats.get(chatId);
    } catch {
      return { ok: false, chatId, code: "readback_failed" };
    }
    if (!isExactPromptChat(projected, chatId)) {
      return { ok: false, chatId, code: "receipt_mismatch" };
    }

    const seedFlag = seedOnly ? "&seedOnly=1" : "";
    navigate(
      `/workspace/task?id=${encodeURIComponent(chatId)}`
      + `&prompt=${encodeURIComponent(body)}${seedFlag}`
      + `&promptStartIntent=${encodeURIComponent(intent.intentId)}`,
    );
    return { ok: true, chatId };
  } catch {
    return { ok: false, ...(chatId ? { chatId } : {}), code: chatId ? "readback_failed" : "create_failed" };
  }
}

/**
 * 입력물 안내 다이얼로그 — 프롬프트에 필요 입력물(inputsKo/En)이 있으면
 * 새 채팅 시작 전에 반드시 이 확인을 거친다. [그래도 시작] / [취소].
 */
export function PromptInputsConfirmDialog({
  inputs,
  ko,
  onConfirm,
  onCancel,
  busy = false,
  error = null,
  retry = false,
}: {
  inputs: string;
  ko: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  busy?: boolean;
  error?: string | null;
  retry?: boolean;
}) {
  return (
    <div
      className="titlebar-nodrag"
      role="dialog"
      aria-modal="true"
      aria-label={ko ? "필요 입력물 안내" : "Required inputs notice"}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 95,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0, 21, 25, 0.24)",
      }}
      onMouseDown={(e) => {
        if (!busy && e.currentTarget === e.target) onCancel();
      }}
    >
      <div
        style={{
          width: "var(--popup-3-width)",
          border: "1px solid var(--paper-edge)",
          borderRadius: 12,
          background: "var(--paper)",
          boxShadow: "0 18px 60px rgba(0, 21, 25, 0.20)",
          padding: 16,
          display: "grid",
          gap: 10,
        }}
      >
        <strong style={{ fontSize: 15, color: "var(--ink)" }}>
          {ko ? "이 프롬프트는 입력물이 필요해요" : "This prompt needs inputs"}
        </strong>
        <div
          style={{
            padding: "9px 11px",
            borderRadius: 10,
            border: "1px dashed var(--paper-edge)",
            background: "var(--fill-1)",
            fontSize: 12.5,
            color: "var(--ink)",
            lineHeight: 1.55,
            whiteSpace: "pre-wrap",
          }}
        >
          {"\u{1F4CE} "}
          {inputs}
        </div>
        <p style={{ margin: 0, fontSize: 12.5, color: "var(--muted-deep)", lineHeight: 1.5 }}>
          {ko
            ? "첨부 없이 시작하면 결과가 이상할 수 있어요."
            : "Starting without these attachments may produce odd results."}
        </p>
        {error && (
          <div
            role="alert"
            data-testid="prompt-start-error"
            style={{
              padding: "8px 10px",
              borderRadius: 9,
              border: "1px solid color-mix(in srgb, var(--red-deep) 28%, var(--paper-edge))",
              background: "color-mix(in srgb, var(--red-deep) 7%, var(--paper))",
              color: "var(--red-deep)",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            {error}
          </div>
        )}
        <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            style={{
              padding: "7px 12px",
              borderRadius: 9,
              border: "1px solid var(--paper-edge)",
              background: "var(--paper)",
              color: "var(--ink-soft)",
              fontSize: 12.5,
              cursor: "pointer",
            }}
          >
            {ko ? "취소" : "Cancel"}
          </button>
          <button
            type="button"
            className="neu-btn-primary"
            onClick={onConfirm}
            disabled={busy}
            style={{ padding: "7px 12px", borderRadius: 9, fontSize: 12.5 }}
          >
            {busy
              ? ko ? "채팅 만드는 중…" : "Creating chat…"
              : retry
                ? ko ? "다시 시도" : "Retry"
                : ko ? "그래도 시작" : "Start anyway"}
          </button>
        </div>
      </div>
    </div>
  );
}

type PickerNotice =
  | { kind: "tasted-gone"; slug: string }
  | { kind: "offer-taste"; slug: string }
  | { kind: "taste-pending"; slug: string }
  | { kind: "unlock-pending"; slug: string }
  | { kind: "intent-error"; slug: string }
  | { kind: "unlock-intent-error"; slug: string }
  | { kind: "unauthenticated"; slug: string }
  | { kind: "error"; slug: string };

export function PromptPickerDialog({
  onClose,
  onStarted,
}: {
  onClose: () => void;
  /** 새 채팅 생성에 성공해 이동까지 마친 뒤(사이드바 목록 갱신용). */
  onStarted?: () => void;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [prompts, setPrompts] = useState<HubPromptSummary[]>([]);
  const [viewer, setViewer] = useState<HubPromptViewer | null>(null);
  const [bookmarkSlugs, setBookmarkSlugs] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);
  const [q, setQ] = useState("");
  const [reloadGeneration, setReloadGeneration] = useState(0);
  const [busySlug, setBusySlug] = useState<string | null>(null);
  const [notice, setNotice] = useState<PickerNotice | null>(null);
  const [pendingStart, setPendingStart] = useState<{ body: string; inputs: string; slug: string } | null>(null);
  const [startFailure, setStartFailure] = useState<{
    body: string;
    seedOnly: boolean;
    slug: string;
  } | null>(null);
  const [startBusy, setStartBusy] = useState(false);
  const seqRef = useRef(0);

  // 목록 로드(검색 디바운스) — 서버 q 검색 + 내 북마크 slug 집합.
  useEffect(() => {
    const api = ipc();
    if (!api?.promptHub) {
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    const timer = setTimeout(() => {
      void (async () => {
        try {
          const [catalog, bm] = await Promise.all([
            api.promptHub.list({ q: q.trim() || undefined }),
            api.promptHub.bookmarks(),
          ]);
          if (seqRef.current !== seq) return;
          setPrompts(catalog.ok ? catalog.prompts : []);
          setViewer(catalog.viewer);
          if (bm.ok) setBookmarkSlugs(new Set(bm.slugs));
          setLoadError(!catalog.ok);
        } catch {
          if (seqRef.current === seq) setLoadError(true);
        } finally {
          if (seqRef.current === seq) setLoading(false);
        }
      })();
    }, q ? 200 : 0);
    return () => clearTimeout(timer);
  }, [q, reloadGeneration]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 내 북마크 + 소장(unlocked) 우선 정렬.
  const sorted = [...prompts].sort((a, b) => {
    const score = (p: HubPromptSummary) =>
      (p.bookmarked || bookmarkSlugs.has(p.slug) ? 2 : 0) + (p.unlocked ? 1 : 0);
    const d = score(b) - score(a);
    if (d !== 0) return d;
    return (pickText(ko, a.titleKo, a.titleEn) || a.slug).localeCompare(pickText(ko, b.titleKo, b.titleEn) || b.slug);
  });

  function maybeStart(p: HubPromptSummary, body: string) {
    const inputs = pickText(ko, p.inputsKo, p.inputsEn);
    if (inputs) {
      setPendingStart({ body, inputs, slug: p.slug });
      setStartFailure(null);
      return;
    }
    void startNow(body, false, p.slug);
  }

  function exactTasteBody(
    res: Awaited<ReturnType<NonNullable<ReturnType<typeof ipc>>["promptHub"]["taste"]>>,
    p: HubPromptSummary,
    intent: string,
  ): string | null {
    return res.ok === true
      && res.receiptVersion === 1
      && res.status === "completed"
      && res.slug === p.slug
      && res.tasteIntentId === intent
      && res.tasted === true
      && typeof res.replayed === "boolean"
      && typeof res.body === "string"
      && typeof res.completedAt === "string"
      && Number.isFinite(Date.parse(res.completedAt))
      ? res.body
      : null;
  }

  async function startNow(body: string, seedOnly = false, slug = "") {
    if (startBusy) return;
    setStartBusy(true);
    setStartFailure(null);
    try {
      // 입력물 필요 프롬프트는 자동 전송 대신 입력창 시드만 — 첨부를 붙일 기회를 준다.
      const result = await startChatWithPrompt(body, { seedOnly, promptSlug: slug });
      if (result.ok) {
        setPendingStart(null);
        onStarted?.();
        onClose();
      } else {
        // A taste body can be one-time-only. Retain the exact body and input
        // notice locally so chat creation can retry without another Hub read.
        setStartFailure({ body, seedOnly, slug });
      }
    } finally {
      setStartBusy(false);
    }
  }

  // 선택 → unlock 시도. 유료/소장자는 body 획득. 무료는 402 → 맛보기 제안 또는 구독 CTA.
  async function pick(p: HubPromptSummary) {
    const api = ipc();
    if (!api?.promptHub || busySlug) return;
    setNotice(null);
    setBusySlug(p.slug);
    try {
      if (p.tasted && !p.unlocked && !paid) {
        const intent = storedPromptTasteIntent(p.slug);
        if (!intent) {
          setNotice({ kind: "tasted-gone", slug: p.slug });
          return;
        }
        const status = await api.promptHub.tasteStatus({ slug: p.slug, tasteIntentId: intent });
        const recovered = exactTasteBody(status, p, intent);
        if (recovered != null) {
          setNotice(null);
          maybeStart(p, recovered);
          return;
        }
        if (status.slug !== p.slug || status.tasteIntentId !== intent || status.outcomeUnknown === true) {
          setNotice({ kind: "taste-pending", slug: p.slug });
          return;
        }
        if (status.status === "processing") {
          setNotice({ kind: "taste-pending", slug: p.slug });
          return;
        }
        if (status.status === "consumed") clearPromptTasteIntent(p.slug, intent);
        setNotice({ kind: "tasted-gone", slug: p.slug });
        return;
      }
      const unlockIntent = getOrCreatePromptUnlockIntent(p.slug);
      if (!unlockIntent) {
        setNotice({ kind: "unlock-intent-error", slug: p.slug });
        return;
      }
      const res = await api.promptHub.unlock({ slug: p.slug, unlockIntentId: unlockIntent });
      const unlockedBody = exactPromptUnlockBody(res, p.slug, unlockIntent);
      if (unlockedBody != null) {
        setPrompts((prev) => prev.map((row) => row.slug === p.slug ? { ...row, unlocked: true } : row));
        maybeStart(p, unlockedBody);
        return;
      }
      if (res.code === "subscription_required") {
        // 맛보기만 한 프롬프트는 body 재열람 불가 — 1회 제공 원칙.
        setNotice({ kind: p.tasted ? "tasted-gone" : "offer-taste", slug: p.slug });
        return;
      }
      if (res.code === "unauthenticated") {
        setNotice({ kind: "unauthenticated", slug: p.slug });
        return;
      }
      if (res.outcomeUnknown === true) {
        setNotice({ kind: "unlock-pending", slug: p.slug });
        return;
      }
      setNotice({ kind: "error", slug: p.slug });
    } catch {
      setNotice({ kind: "unlock-pending", slug: p.slug });
    } finally {
      setBusySlug(null);
    }
  }

  // 무료 유저의 프롬프트당 1회 맛보기 — body는 이 응답에서만 온다.
  async function tasteOnce(p: HubPromptSummary) {
    const api = ipc();
    if (!api?.promptHub || busySlug) return;
    const intent = getOrCreatePromptTasteIntent(p.slug);
    if (!intent) {
      setNotice({ kind: "intent-error", slug: p.slug });
      return;
    }
    setBusySlug(p.slug);
    try {
      const res = await api.promptHub.taste({ slug: p.slug, tasteIntentId: intent });
      const exactBody = exactTasteBody(res, p, intent);
      if (exactBody != null) {
        setNotice(null);
        setPrompts((prev) => prev.map((row) => row.slug === p.slug ? { ...row, tasted: true } : row));
        maybeStart(p, exactBody);
        return;
      }
      if (res.code === "already_tasted") {
        clearPromptTasteIntent(p.slug, intent);
        setNotice({ kind: "tasted-gone", slug: p.slug });
        return;
      }
      if (res.code === "unauthenticated") {
        setNotice({ kind: "unauthenticated", slug: p.slug });
        return;
      }
      if (res.code === "processing" || res.outcomeUnknown === true) {
        setNotice({ kind: "taste-pending", slug: p.slug });
        return;
      }
      setNotice({ kind: "error", slug: p.slug });
    } catch {
      setNotice({ kind: "taste-pending", slug: p.slug });
    } finally {
      setBusySlug(null);
    }
  }

  async function signIn() {
    const api = ipc();
    if (!api) return;
    try {
      const session = await api.auth.signInWithGoogle();
      if (!session.signedIn) {
        setNotice({ kind: "error", slug: notice?.slug ?? "" });
        return;
      }
      setNotice(null);
      // 로그인 직후 목록·북마크를 즉시 재로드(unlocked/tasted 플래그 반영).
      const catalog = await api.promptHub.list({ q: q.trim() || undefined });
      setPrompts(catalog.ok ? catalog.prompts : []);
      setViewer(catalog.viewer);
      const bm = await api.promptHub.bookmarks();
      if (bm.ok) setBookmarkSlugs(new Set(bm.slugs));
      setLoadError(!catalog.ok);
    } catch {
      setNotice({ kind: "error", slug: notice?.slug ?? "" });
    }
  }

  const paid = viewer?.paidAccess === true;

  return (
    <div
      className="titlebar-nodrag"
      role="dialog"
      aria-modal="true"
      aria-label={ko ? "프롬프트 불러오기" : "Load prompt"}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: 20,
        background: "rgba(0, 21, 25, 0.18)",
      }}
      onMouseDown={(e) => {
        if (e.currentTarget === e.target) onClose();
      }}
    >
      <div
        style={{
          width: "var(--popup-3-width)",
          maxHeight: "min(620px, 90vh)",
          border: "1px solid var(--paper-edge)",
          borderRadius: 12,
          background: "var(--paper)",
          boxShadow: "0 18px 60px rgba(0, 21, 25, 0.20)",
          padding: 14,
          display: "flex",
          flexDirection: "column",
          gap: 10,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <IconSparkles size={16} />
          <strong style={{ flex: 1, fontSize: 15, color: "var(--ink)" }}>
            {ko ? "프롬프트 불러오기" : "Load a prompt"}
          </strong>
          <button
            type="button"
            onClick={onClose}
            aria-label={ko ? "닫기" : "Close"}
            style={{
              display: "inline-flex",
              padding: 6,
              borderRadius: 8,
              border: "none",
              background: "transparent",
              color: "var(--muted-deep)",
              cursor: "pointer",
            }}
          >
            <IconClose size={14} />
          </button>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "7px 10px",
            borderRadius: 10,
            border: "1px solid var(--paper-edge)",
            background: "var(--fill-1)",
          }}
        >
          <IconSearch size={14} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={ko ? "북마크·소장 프롬프트 검색" : "Search saved and unlocked prompts"}
            aria-label={ko ? "프롬프트 검색" : "Search prompts"}
            style={{
              flex: 1,
              minWidth: 0,
              border: "none",
              outline: "none",
              background: "transparent",
              color: "var(--ink)",
              fontSize: 13,
            }}
          />
        </div>

        {startFailure && !pendingStart && (
          <div
            role="alert"
            data-testid="prompt-start-error"
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              padding: "9px 11px",
              borderRadius: 10,
              border: "1px solid color-mix(in srgb, var(--red-deep) 28%, var(--paper-edge))",
              background: "color-mix(in srgb, var(--red-deep) 7%, var(--paper))",
              color: "var(--red-deep)",
              fontSize: 12,
              lineHeight: 1.5,
            }}
          >
            <span style={{ flex: 1 }}>
              {ko
                ? "새 채팅을 만들지 못했습니다. 프롬프트는 그대로 유지됩니다."
                : "Could not create the chat. Your prompt is still here."}
            </span>
            <button
              type="button"
              className="neu-btn-primary"
              disabled={startBusy}
              onClick={() => void startNow(startFailure.body, startFailure.seedOnly, startFailure.slug)}
              style={{ padding: "6px 10px", borderRadius: 8, fontSize: 12, flexShrink: 0 }}
            >
              {startBusy ? (ko ? "재시도 중…" : "Retrying…") : ko ? "다시 시도" : "Retry"}
            </button>
          </div>
        )}

        <div style={{ flex: 1, minHeight: 0, overflowY: "auto", display: "grid", gap: 6, alignContent: "start" }}>
          {loading ? (
            <div style={{ padding: "10px 8px", color: "var(--muted-deep)", fontSize: 12.5, display: "grid", gap: 5 }}>
              <span>{ko ? "프롬프트 불러오는 중..." : "Loading prompts..."}</span>
              <LoadingEstimate locale={ko ? "ko" : "en"} operationKey="desktop-prompt-picker" expectedSeconds={[1, 15]} />
            </div>
          ) : loadError ? (
            <div role="alert" style={{ padding: "10px 8px", color: "var(--red-deep)", fontSize: 12.5, lineHeight: 1.5, display: "grid", gap: 8 }}>
              <span>{ko ? "프롬프트 목록을 불러오지 못했습니다." : "Could not load prompts."}</span>
              <button
                type="button"
                className="neu-btn-primary"
                style={{ justifySelf: "start", padding: "6px 10px", borderRadius: 8, fontSize: 12 }}
                onClick={() => setReloadGeneration((value) => value + 1)}
              >
                {ko ? "다시 불러오기" : "Retry"}
              </button>
            </div>
          ) : sorted.length === 0 ? (
            <div style={{ padding: "10px 8px", color: "var(--muted-deep)", fontSize: 12.5, lineHeight: 1.5 }}>
              {ko
                ? "표시할 프롬프트가 없습니다. 프롬프트 저장소에서 먼저 찾아보세요."
                : "No prompts to show. Browse the Prompt Store first."}
            </div>
          ) : (
            sorted.map((p) => {
              const title = pickText(ko, p.titleKo, p.titleEn) || p.slug;
              const summary = pickText(ko, p.summaryKo, p.summaryEn);
              const saved = p.bookmarked || bookmarkSlugs.has(p.slug);
              const reloadable = p.unlocked || paid;
              const busy = busySlug === p.slug;
              const rowNotice = notice && notice.slug === p.slug ? notice : null;
              return (
                <div key={p.slug} style={{ display: "grid", gap: 6 }}>
                  <button
                    type="button"
                    onClick={() => void pick(p)}
                    disabled={busy}
                    style={{
                      width: "100%",
                      minWidth: 0,
                      display: "grid",
                      gridTemplateColumns: "minmax(0, 1fr) auto",
                      alignItems: "center",
                      gap: 10,
                      padding: "9px 11px",
                      borderRadius: 10,
                      border: "1px solid var(--paper-edge)",
                      background: "var(--paper)",
                      color: "var(--ink)",
                      textAlign: "left",
                      cursor: busy ? "wait" : "pointer",
                      opacity: busy ? 0.7 : 1,
                    }}
                  >
                    <span style={{ minWidth: 0, display: "grid", gap: 2 }}>
                      <strong
                        style={{
                          fontSize: 13,
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                        }}
                      >
                        {title}
                      </strong>
                      {summary && (
                        <span
                          style={{
                            fontSize: 11.5,
                            color: "var(--muted-deep)",
                            whiteSpace: "nowrap",
                            overflow: "hidden",
                            textOverflow: "ellipsis",
                          }}
                        >
                          {summary}
                        </span>
                      )}
                    </span>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "var(--muted-deep)" }}>
                      {saved && <span title={ko ? "북마크됨" : "Bookmarked"}>{"★"}</span>}
                      {p.unlocked && (
                        <span
                          style={{ color: "var(--green-deep)", fontWeight: 700 }}
                          title={ko ? "소장중 — 언제든 다시 열람" : "Unlocked — reopen anytime"}
                        >
                          {ko ? "소장" : "Owned"}
                        </span>
                      )}
                      {!reloadable && p.tasted && (
                        <span
                          style={{ display: "inline-flex", alignItems: "center", gap: 3 }}
                          title={ko ? "맛보기는 1회만 제공돼요" : "Tastes are one-time only"}
                        >
                          <IconLock size={11} />
                          {ko ? "맛봄" : "Tasted"}
                        </span>
                      )}
                      {busy && <span>{ko ? "여는 중…" : "Opening…"}</span>}
                    </span>
                  </button>
                  {rowNotice && (
                    <div
                      role="status"
                      style={{
                        padding: "9px 11px",
                        borderRadius: 10,
                        border: "1px dashed var(--paper-edge)",
                        background: "var(--fill-1)",
                        display: "grid",
                        gap: 8,
                        fontSize: 12,
                        color: "var(--ink-soft)",
                        lineHeight: 1.5,
                      }}
                    >
                      {rowNotice.kind === "tasted-gone" && (
                        <>
                          <span>
                            {ko
                              ? "맛보기는 1회만 제공돼요. 이 프롬프트를 다시 열람하려면 구독이 필요해요."
                              : "Tastes are one-time only. Subscribe to reopen this prompt."}
                          </span>
                          <UpgradeCta />
                        </>
                      )}
                      {rowNotice.kind === "offer-taste" && (
                        <>
                          <span>
                            {ko
                              ? "무료 플랜은 프롬프트당 1회 맛보기로 열람할 수 있어요. 맛보기 내용은 이 자리에서만 제공됩니다."
                              : "On the free plan you can taste each prompt once. The taste body is shown only at that moment."}
                          </span>
                          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                            <button
                              type="button"
                              className="neu-btn-primary"
                              onClick={() => void tasteOnce(p)}
                              style={{ padding: "6px 12px", borderRadius: 9, fontSize: 12 }}
                            >
                              {ko ? "맛보기 1회 사용" : "Use my one taste"}
                            </button>
                          </div>
                          <UpgradeCta />
                        </>
                      )}
                      {rowNotice.kind === "taste-pending" && (
                        <>
                          <span>
                            {ko
                              ? "같은 맛보기 요청의 완료 본문을 아직 확인하지 못했습니다. 새 요청을 만들지 말고 이어서 확인하세요."
                              : "The completed body for this taste request is not confirmed yet. Resume the same request instead of creating another one."}
                          </span>
                          <button
                            type="button"
                            className="neu-btn-primary"
                            onClick={() => void tasteOnce(p)}
                            style={{ padding: "6px 12px", borderRadius: 9, fontSize: 12, justifySelf: "start" }}
                          >
                            {ko ? "같은 요청 이어가기" : "Resume same request"}
                          </button>
                        </>
                      )}
                      {rowNotice.kind === "unlock-pending" && (
                        <>
                          <span>
                            {ko
                              ? "같은 열람 요청의 소유권과 본문을 아직 확인하지 못했습니다. 새 요청을 만들지 말고 같은 요청을 이어서 확인하세요."
                              : "Ownership and the body for this open request are not confirmed yet. Resume the same request instead of creating another one."}
                          </span>
                          <button
                            type="button"
                            className="neu-btn-primary"
                            onClick={() => void pick(p)}
                            style={{ padding: "6px 12px", borderRadius: 9, fontSize: 12, justifySelf: "start" }}
                          >
                            {ko ? "같은 요청 이어가기" : "Resume same request"}
                          </button>
                        </>
                      )}
                      {rowNotice.kind === "intent-error" && (
                        <span>
                          {ko
                            ? "중복 방지 요청 키를 저장하지 못해 맛보기를 시작하지 않았습니다. 앱 저장소 권한을 확인하세요."
                            : "The taste did not start because its duplicate-safe request key could not be stored. Check app storage access."}
                        </span>
                      )}
                      {rowNotice.kind === "unlock-intent-error" && (
                        <span>
                          {ko
                            ? "중복 방지 요청 키를 저장하지 못해 유료 열람을 시작하지 않았습니다. 앱 저장소 권한을 확인하세요."
                            : "The paid open did not start because its duplicate-safe request key could not be stored. Check app storage access."}
                        </span>
                      )}
                      {rowNotice.kind === "unauthenticated" && (
                        <>
                          <span>
                            {ko ? "프롬프트를 열람하려면 먼저 로그인하세요." : "Sign in to open prompts."}
                          </span>
                          <button
                            type="button"
                            className="neu-btn-primary"
                            onClick={() => void signIn()}
                            style={{ padding: "6px 12px", borderRadius: 9, fontSize: 12, justifySelf: "start" }}
                          >
                            {ko ? "Google로 로그인" : "Sign in with Google"}
                          </button>
                        </>
                      )}
                      {rowNotice.kind === "error" && (
                        <span>
                          {ko
                            ? "프롬프트를 열지 못했습니다. 네트워크 상태를 확인하고 다시 시도하세요."
                            : "Could not open the prompt. Check your network and try again."}
                        </span>
                      )}
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>

      {pendingStart && (
        <PromptInputsConfirmDialog
          inputs={pendingStart.inputs}
          ko={ko}
          onConfirm={() => void startNow(pendingStart.body, true, pendingStart.slug)}
          onCancel={() => setPendingStart(null)}
          busy={startBusy}
          retry={startFailure?.body === pendingStart.body}
          error={
            startFailure?.body === pendingStart.body
              ? ko
                ? "새 채팅을 만들지 못했습니다. 프롬프트와 입력물 안내는 그대로 보존됐습니다."
                : "Could not create the chat. Your prompt and required-input note were preserved."
              : null
          }
        />
      )}
    </div>
  );
}
