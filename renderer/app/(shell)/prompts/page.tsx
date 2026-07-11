"use client";
// 프롬프트 저장소 — Hub(마켓) 메뉴와 동형 구조: 검색창 + 카테고리 탭 + 카드 그리드 + 상세 모달.
// marketplace/page.tsx의 시각 언어(카드/칩/버튼/오버레이)를 그대로 따른다.
//
// 수익화 정책(2026-07 개편, electron/prompts-hub.ts와 동일):
//   · 유료 구독(viewer.paidAccess): 모든 프롬프트 무제한 열람(unlock, 과금 0) + 북마크 저장.
//   · 무료: 프롬프트당 1회 맛보기(taste) — body는 taste 응답 그 자리에서만 제공, 재시도는
//     already_tasted. 저장(북마크)은 402 subscription_required.
//   · CTA: unlock 402 → 맛보기 옵션(미사용 시) 또는 구독 안내 / tastes.count>=3 → 적극 배너 /
//     버튼은 웹 결제 페이지(agentlas.cloud/pricing)를 외부 브라우저로 연다.
import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { HubPromptSummary, HubPromptViewer } from "@shared/types";
import { UpgradeCta, openPricing } from "@/components/UpgradeCta";
import { PromptInputsConfirmDialog, startChatWithPrompt } from "@/components/PromptPickerDialog";
import { IconClose, IconLock } from "@/components/Icon";

const C = {
  purple: "color-mix(in oklch, var(--rd-accent) 18%, var(--rd-surface))",
  green: "color-mix(in oklch, var(--rd-ok) 24%, var(--rd-surface))",
};

/** 무료 맛보기 몇 회부터 적극적 구독 CTA를 띄울지. */
const TASTE_CTA_THRESHOLD = 3;

/** 다국어 필드에서 현재 언어 텍스트를 뽑는다(영어 사용자에게 한국어 누수 방지). */
function pickText(ko: boolean, koText?: string, enText?: string): string {
  return ((ko ? koText?.trim() || enText : enText?.trim() || koText) ?? "").trim();
}

type PromptDetail = HubPromptSummary & { body?: string; tipsKo?: string; tipsEn?: string };

export default function PromptStorePage() {
  const { t, locale } = useT();
  const ko = locale === "ko";

  const [prompts, setPrompts] = useState<HubPromptSummary[]>([]);
  const [viewer, setViewer] = useState<HubPromptViewer | null>(null);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const [q, setQ] = useState("");
  const [category, setCategory] = useState<string>("all");
  const [allCategories, setAllCategories] = useState<string[]>([]);
  const [tasteCount, setTasteCount] = useState(0);
  const [active, setActive] = useState<HubPromptSummary | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "error"; text: string; action?: "pricing" | "signin" } | null>(null);
  const [pendingStart, setPendingStart] = useState<{ body: string; inputs: string; failed: boolean } | null>(null);
  const [pendingStartBusy, setPendingStartBusy] = useState(false);
  const [bookmarkBusy, setBookmarkBusy] = useState<string | null>(null);
  const seqRef = useRef(0);

  const refresh = useCallback(
    async (params: { q?: string; category?: string }) => {
      const api = ipc();
      if (!api?.promptHub) {
        // 구버전 preload/브라우저 dev — 무한 로딩 대신 연결 실패 안내.
        setLoadState("error");
        return;
      }
      const seq = ++seqRef.current;
      const res = await api.promptHub.list(params);
      if (seqRef.current !== seq) return;
      if (!res.ok) {
        setLoadState("error");
        return;
      }
      setPrompts(res.prompts);
      setViewer(res.viewer);
      setLoadState("ready");
      // 카테고리 탭 — 카탈로그에서 본 카테고리의 누적 합집합(필터 중에도 탭 유지).
      setAllCategories((prev) => {
        const next = new Set(prev);
        for (const p of res.prompts) if (p.category?.trim()) next.add(p.category.trim());
        return [...next].sort();
      });
    },
    [],
  );

  const refreshTastes = useCallback(async () => {
    const api = ipc();
    if (!api?.promptHub) return;
    try {
      const tr = await api.promptHub.tastes();
      if (tr.ok) setTasteCount(tr.count);
    } catch {
      // 비로그인/네트워크 — 카운트 없이도 페이지는 동작
    }
  }, []);

  // 검색·카테고리 디바운스 로드(첫 로드 포함).
  useEffect(() => {
    const timer = setTimeout(() => {
      void refresh({ q: q.trim() || undefined, category: category === "all" ? undefined : category });
    }, 200);
    return () => clearTimeout(timer);
  }, [q, category, refresh]);

  useEffect(() => {
    void refreshTastes();
  }, [refreshTastes]);

  const signedIn = viewer?.signedIn === true;
  const paid = viewer?.paidAccess === true;

  async function ensureSignedIn(): Promise<boolean> {
    const api = ipc();
    if (!api) return false;
    const current = await api.auth.getSession();
    if (!current.signedIn) {
      const next = await api.auth.signInWithGoogle();
      if (!next.signedIn) return false;
    }
    // 로그인 반영된 unlocked/tasted/bookmarked/viewer 재로드.
    await refresh({ q: q.trim() || undefined, category: category === "all" ? undefined : category });
    void refreshTastes();
    return true;
  }

  /** 목록과 상세 모달 양쪽의 프롬프트 상태 플래그를 패치. */
  function patchPrompt(slug: string, patch: Partial<HubPromptSummary>) {
    setPrompts((prev) => prev.map((p) => (p.slug === slug ? { ...p, ...patch } : p)));
    setActive((prev) => (prev && prev.slug === slug ? { ...prev, ...patch } : prev));
  }

  // 북마크 토글 — 유료만. 무료는 402 subscription_required → 구독 CTA.
  async function toggleBookmark(p: HubPromptSummary) {
    const api = ipc();
    if (!api?.promptHub || bookmarkBusy) return;
    if (!paid) {
      setNotice({
        tone: "error",
        action: "pricing",
        text: ko
          ? "프롬프트 저장(북마크)은 구독 회원 전용이에요. 구독하면 무제한 열람과 저장이 열립니다."
          : "Saving prompts is for subscribers. Subscribe to unlock unlimited opens and bookmarks.",
      });
      return;
    }
    setBookmarkBusy(p.slug);
    try {
      const res = p.bookmarked
        ? await api.promptHub.bookmarkRemove(p.slug)
        : await api.promptHub.bookmarkAdd(p.slug);
      if (res.ok) {
        patchPrompt(p.slug, { bookmarked: res.bookmarked ?? !p.bookmarked });
        setNotice(null);
        return;
      }
      if (res.code === "subscription_required") {
        setNotice({
          tone: "error",
          action: "pricing",
          text: ko ? "프롬프트 저장은 구독 회원 전용이에요." : "Saving prompts requires a subscription.",
        });
        return;
      }
      if (res.code === "unauthenticated") {
        setNotice({
          tone: "error",
          action: "signin",
          text: ko ? "저장하려면 먼저 로그인하세요." : "Sign in to save prompts.",
        });
        return;
      }
      setNotice({ tone: "error", text: ko ? "저장에 실패했습니다." : "Could not save the prompt." });
    } finally {
      setBookmarkBusy(null);
    }
  }

  // 써보기 — body 확보 후: 입력물 안내(있으면) → 새 채팅 시작(?prompt= 시드).
  async function handleStart(body: string, inputs: string): Promise<boolean> {
    if (inputs.trim()) {
      setPendingStart({ body, inputs: inputs.trim(), failed: false });
      return true;
    }
    return startChatWithPrompt(body);
  }

  async function confirmPendingStart() {
    const request = pendingStart;
    if (!request || pendingStartBusy) return;
    setPendingStartBusy(true);
    setPendingStart((current) => current ? { ...current, failed: false } : current);
    try {
      // Keep the exact one-time prompt body and required-input note mounted
      // until chat creation succeeds. A failed create can therefore retry
      // without re-unlocking or consuming another taste.
      const ok = await startChatWithPrompt(request.body, { seedOnly: true });
      if (ok) {
        setPendingStart(null);
      } else {
        setPendingStart((current) =>
          current && current.body === request.body ? { ...current, failed: true } : current,
        );
      }
    } finally {
      setPendingStartBusy(false);
    }
  }

  const normalizedQuery = q.trim().toLowerCase();
  const visible = prompts.filter((p) => {
    if (category !== "all" && (p.category ?? "") !== category) return false;
    if (!normalizedQuery) return true;
    return [p.slug, p.titleKo, p.titleEn, p.summaryKo, p.summaryEn, p.category, p.authorName, ...(p.tags ?? [])]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(normalizedQuery);
  });

  const accountLabel = !signedIn
    ? ko ? "로그인 필요" : "Signed out"
    : paid
      ? ko ? "구독 중 · 무제한 열람" : "Subscribed · unlimited"
      : ko ? "무료 · 프롬프트당 맛보기 1회" : "Free · one taste per prompt";

  return (
    <div className="rd hub-desktop-root">
      <div className="titlebar-nodrag hub-desktop-scroll">
        <div className="hub-web-frame">
          <div className="hub-web-main">
            <div className="hub-web-topbar">
              <div className="hub-web-topbar-title">{ko ? "프롬프트 저장소" : "Prompt Store"}</div>
              <div className="hub-web-topbar-actions" aria-label={ko ? "프롬프트 계정 상태" : "Prompt account state"}>
                <span
                  style={{
                    border: "1px solid var(--rd-hair)",
                    borderRadius: 999,
                    padding: "3px 8px",
                    color: paid ? "var(--rd-ok)" : "var(--rd-ink-2)",
                    background: "var(--rd-surface)",
                    fontSize: 12,
                    fontWeight: 650,
                    whiteSpace: "nowrap",
                  }}
                >
                  {accountLabel}
                </span>
              </div>
            </div>
            <main className="rd-page hub-web-content">
              <div className="hub-page-root">
                <div className="card portal-search-panel rd-card-cream">
                  <input
                    className="portal-input"
                    value={q}
                    onChange={(e) => setQ(e.target.value)}
                    placeholder={ko ? "프롬프트 검색..." : "Search prompts..."}
                    aria-label={ko ? "프롬프트 검색" : "Search prompts"}
                  />
                  {/* 카테고리 탭 */}
                  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 10 }}>
                    <button
                      type="button"
                      className={"btn sm" + (category === "all" ? " primary" : "")}
                      onClick={() => setCategory("all")}
                    >
                      {ko ? "전체" : "All"}
                    </button>
                    {allCategories.map((c) => (
                      <button
                        type="button"
                        key={c}
                        className={"btn sm" + (category === c ? " primary" : "")}
                        onClick={() => setCategory(c)}
                      >
                        {c}
                      </button>
                    ))}
                  </div>
                </div>

                {/* 무료 맛보기 3회+ — 적극적 구독 CTA */}
                {signedIn && !paid && tasteCount >= TASTE_CTA_THRESHOLD && (
                  <UpgradeCta
                    variant="banner"
                    message={
                      ko
                        ? `맛보기를 벌써 ${tasteCount}회 사용하셨어요. 구독하면 모든 프롬프트를 무제한 열람하고 저장할 수 있어요.`
                        : `You have used ${tasteCount} tastes already. Subscribe for unlimited opens and saving.`
                    }
                  />
                )}

                {/* 비로그인 안내 — 카탈로그는 공개, 열람/맛보기/저장엔 로그인 필요 */}
                {loadState === "ready" && !signedIn && (
                  <div className="hub-signin-notice" role="status">
                    <span>
                      <strong style={{ color: "var(--rd-ink)", fontWeight: 600 }}>{t("account.required.title")}</strong>
                      <span style={{ marginLeft: 8 }}>
                        {ko
                          ? "프롬프트를 열람·맛보기·저장하려면 먼저 로그인하세요."
                          : "Sign in first to open, taste, or save prompts."}
                      </span>
                    </span>
                    <button type="button" className="btn sm" onClick={() => void ensureSignedIn()}>
                      {t("account.sign_in")}
                    </button>
                  </div>
                )}

                {notice && (
                  <div className="hub-import-notice" data-tone={notice.tone} role="status">
                    <span>{notice.text}</span>
                    {notice.action === "pricing" && (
                      <button type="button" className="btn sm" onClick={openPricing}>
                        {ko ? "구독 알아보기" : "See plans"}
                      </button>
                    )}
                    {notice.action === "signin" && (
                      <button type="button" className="btn sm" onClick={() => void ensureSignedIn().then((ok) => ok && setNotice(null))}>
                        {t("account.sign_in")}
                      </button>
                    )}
                  </div>
                )}

                <section className="portal-panel" id="prompt-store">
                  {loadState === "loading" ? (
                    <div className="card portal-empty-panel" style={{ padding: 18 }}>
                      <div style={{ fontSize: 13, color: "var(--rd-ink-3)" }}>
                        {ko ? "프롬프트 불러오는 중..." : "Loading prompts..."}
                      </div>
                    </div>
                  ) : loadState === "error" ? (
                    <div className="card portal-empty-panel" style={{ padding: 18 }}>
                      <div style={{ fontFamily: "var(--rd-f-display)", fontSize: 20, fontWeight: 400 }}>
                        {ko ? "프롬프트 저장소에 연결하지 못했습니다" : "Could not reach the Prompt Store"}
                      </div>
                      <div style={{ fontSize: 13, color: "var(--rd-ink-3)", lineHeight: 1.55, marginTop: 6 }}>
                        {ko ? "네트워크 상태를 확인한 뒤 다시 시도하세요." : "Check your network and try again."}
                      </div>
                    </div>
                  ) : visible.length > 0 ? (
                    <div className="market-card-grid">
                      {visible.map((p) => (
                        <PromptCard
                          key={p.slug}
                          p={p}
                          ko={ko}
                          paid={paid}
                          bookmarkBusy={bookmarkBusy === p.slug}
                          onOpen={() => setActive(p)}
                          onToggleBookmark={() => void toggleBookmark(p)}
                        />
                      ))}
                    </div>
                  ) : (
                    <div className="card portal-empty-panel" style={{ padding: 18 }}>
                      <div style={{ fontFamily: "var(--rd-f-display)", fontSize: 20, fontWeight: 400 }}>
                        {ko ? "표시할 프롬프트가 없습니다" : "No prompts to show"}
                      </div>
                      <div style={{ fontSize: 13, color: "var(--rd-ink-3)", lineHeight: 1.55, marginTop: 6 }}>
                        {ko ? "검색어나 카테고리를 바꿔보세요." : "Try a different search or category."}
                      </div>
                    </div>
                  )}
                </section>

                {active && (
                  <PromptDetailDialog
                    prompt={active}
                    ko={ko}
                    signedIn={signedIn}
                    paid={paid}
                    onClose={() => setActive(null)}
                    onPatched={patchPrompt}
                    onTasted={() => void refreshTastes()}
                    onSignIn={ensureSignedIn}
                    onStart={handleStart}
                  />
                )}

                {pendingStart && (
                  <PromptInputsConfirmDialog
                    inputs={pendingStart.inputs}
                    ko={ko}
                    onConfirm={() => void confirmPendingStart()}
                    onCancel={() => setPendingStart(null)}
                    busy={pendingStartBusy}
                    retry={pendingStart.failed}
                    error={
                      pendingStart.failed
                        ? ko
                          ? "새 채팅을 만들지 못했습니다. 프롬프트와 입력물 안내는 그대로 보존됐습니다."
                          : "Could not create the chat. Your prompt and required-input note were preserved."
                        : null
                    }
                  />
                )}
              </div>
            </main>
          </div>
        </div>
      </div>
    </div>
  );
}

// marketplace/page.tsx의 RdTag와 동일한 칩 — 시각 언어 통일.
function RdTag({
  dashed,
  bg,
  size,
  className,
  style,
  children,
}: {
  dashed?: boolean;
  bg?: string;
  size?: "s" | "m";
  className?: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  return (
    <span
      className={["chip", dashed ? "dashed" : "", className || ""].filter(Boolean).join(" ")}
      style={{
        background: bg,
        fontSize: size === "s" ? 10.5 : undefined,
        whiteSpace: "nowrap",
        ...style,
      }}
    >
      {children}
    </span>
  );
}

function PromptCard({
  p,
  ko,
  paid,
  bookmarkBusy,
  onOpen,
  onToggleBookmark,
}: {
  p: HubPromptSummary;
  ko: boolean;
  paid: boolean;
  bookmarkBusy: boolean;
  onOpen: () => void;
  onToggleBookmark: () => void;
}) {
  const title = pickText(ko, p.titleKo, p.titleEn) || p.slug;
  const summary = pickText(ko, p.summaryKo, p.summaryEn);
  const inputs = pickText(ko, p.inputsKo, p.inputsEn);
  const author = p.authorName ? (ko ? `${p.authorName} 제공` : `by ${p.authorName}`) : "Agentlas Hub";
  return (
    <div className="card portal-entity-card hub-entity-card">
      <div className="hub-card-head">
        <div className="hub-card-main">
          <div className="hub-card-kicker">
            {ko ? "프롬프트" : "PROMPT"}
            {p.category ? ` · ${p.category}` : ""}
          </div>
          <div className="portal-card-title hub-card-title">{title}</div>
          <div className="hub-card-author">{author}</div>
        </div>
        <RdTag className="hub-credit-tag" bg={p.unlocked ? C.green : C.purple}>
          {p.unlocked
            ? ko ? "소장중" : "Unlocked"
            : p.tasted
              ? ko ? "맛보기 사용" : "Tasted"
              : ko ? "프롬프트" : "Prompt"}
        </RdTag>
      </div>
      <div className="hub-card-copy">{summary}</div>
      <div className="portal-chip-row hub-card-meta">
        {inputs && <RdTag dashed>{"\u{1F4CE} "}{ko ? "입력물 필요" : "Inputs needed"}</RdTag>}
        {(p.models ?? []).slice(0, 3).map((m) => (
          <RdTag key={m} dashed>{m}</RdTag>
        ))}
        {p.bookmarked && <RdTag dashed>{"★ "}{ko ? "저장됨" : "Saved"}</RdTag>}
        {typeof p.unlockCount === "number" && p.unlockCount > 0 && (
          <RdTag dashed>{ko ? `열람 ${p.unlockCount}회` : `${p.unlockCount} opens`}</RdTag>
        )}
      </div>
      <div className="hub-card-actions">
        <button
          type="button"
          className="btn sm"
          onClick={onToggleBookmark}
          disabled={bookmarkBusy}
          title={
            paid
              ? p.bookmarked
                ? ko ? "저장 해제" : "Remove bookmark"
                : ko ? "내 프롬프트에 저장" : "Save to my prompts"
              : ko ? "구독하면 저장할 수 있어요" : "Subscribe to save prompts"
          }
          aria-label={ko ? "프롬프트 저장 토글" : "Toggle prompt bookmark"}
          style={{ display: "inline-flex", alignItems: "center", gap: 5 }}
        >
          {paid ? (p.bookmarked ? "★" : "☆") : <IconLock size={12} />}
          {p.bookmarked ? (ko ? "저장됨" : "Saved") : ko ? "저장" : "Save"}
        </button>
        <button type="button" className="btn sm primary" onClick={onOpen}>
          {ko ? "자세히" : "Details"}
        </button>
      </div>
    </div>
  );
}

// ── 상세 모달 — 열람(unlock)/맛보기(taste)/써보기 흐름의 본체 ──────────────────
function PromptDetailDialog({
  prompt,
  ko,
  signedIn,
  paid,
  onClose,
  onPatched,
  onTasted,
  onSignIn,
  onStart,
}: {
  prompt: HubPromptSummary;
  ko: boolean;
  signedIn: boolean;
  paid: boolean;
  onClose: () => void;
  onPatched: (slug: string, patch: Partial<HubPromptSummary>) => void;
  onTasted: () => void;
  onSignIn: () => Promise<boolean>;
  onStart: (body: string, inputs: string) => Promise<boolean>;
}) {
  const [detail, setDetail] = useState<PromptDetail | null>(null);
  const [body, setBody] = useState<string | null>(null);
  const [tips, setTips] = useState<string | null>(null);
  const [busy, setBusy] = useState<"unlock" | "taste" | null>(null);
  const [gate, setGate] = useState<"subscription" | "tasted-gone" | "unauthenticated" | "error" | null>(null);
  const [copied, setCopied] = useState(false);
  const [startBusy, setStartBusy] = useState(false);
  const [startFailed, setStartFailed] = useState(false);

  const merged: PromptDetail = { ...prompt, ...(detail ?? {}) };
  const title = pickText(ko, merged.titleKo, merged.titleEn) || merged.slug;
  const summary = pickText(ko, merged.summaryKo, merged.summaryEn);
  const inputs = pickText(ko, merged.inputsKo, merged.inputsEn);
  const exampleResult = pickText(ko, merged.exampleResultKo, merged.exampleResultEn);

  // 상세 GET — 소장/소유 시 body 포함(무료 맛보기 body는 절대 여기 오지 않는다).
  useEffect(() => {
    const api = ipc();
    if (!api?.promptHub) return;
    let cancelled = false;
    void api.promptHub.get(prompt.slug).then((res) => {
      if (cancelled || !res.ok || !res.prompt) return;
      setDetail(res.prompt);
      if (res.prompt.body) {
        setBody(res.prompt.body);
        setTips(pickText(ko, res.prompt.tipsKo, res.prompt.tipsEn) || null);
      }
    });
    return () => {
      cancelled = true;
    };
    // ko 변경은 tips 표시 언어만 바꾸므로 재조회하지 않는다.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt.slug]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 열람 — 유료 구독/소유자는 무제한(과금 0). 무료는 402 subscription_required.
  async function doUnlock() {
    const api = ipc();
    if (!api?.promptHub || busy) return;
    setBusy("unlock");
    setGate(null);
    try {
      const res = await api.promptHub.unlock(prompt.slug);
      if (res.ok && res.body) {
        setBody(res.body);
        setTips(pickText(ko, res.tipsKo, res.tipsEn) || null);
        onPatched(prompt.slug, { unlocked: true });
        return;
      }
      if (res.code === "subscription_required") {
        setGate("subscription");
        return;
      }
      if (res.code === "unauthenticated") {
        setGate("unauthenticated");
        return;
      }
      setGate("error");
    } catch {
      setGate("error");
    } finally {
      setBusy(null);
    }
  }

  // 맛보기 — 무료 유저 프롬프트당 1회. body는 이 응답에서만 제공된다.
  async function doTaste() {
    const api = ipc();
    if (!api?.promptHub || busy) return;
    setBusy("taste");
    setGate(null);
    try {
      const res = await api.promptHub.taste(prompt.slug);
      if (res.ok && res.body) {
        setBody(res.body);
        setTips(pickText(ko, res.tipsKo, res.tipsEn) || null);
        onPatched(prompt.slug, { tasted: true });
        onTasted();
        return;
      }
      if (res.code === "already_tasted") {
        onPatched(prompt.slug, { tasted: true });
        setGate("tasted-gone");
        return;
      }
      if (res.code === "subscription_required") {
        setGate("subscription");
        return;
      }
      if (res.code === "unauthenticated") {
        setGate("unauthenticated");
        return;
      }
      setGate("error");
    } catch {
      setGate("error");
    } finally {
      setBusy(null);
    }
  }

  async function copyBody() {
    if (!body) return;
    try {
      await navigator.clipboard.writeText(body);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // 클립보드 권한 실패 — 조용히 무시
    }
  }

  async function startFromDetail() {
    if (!body || startBusy) return;
    setStartBusy(true);
    setStartFailed(false);
    try {
      const accepted = await onStart(body, inputs);
      if (!accepted) setStartFailed(true);
    } finally {
      setStartBusy(false);
    }
  }

  const tastedGone = gate === "tasted-gone" || (!body && !paid && signedIn && merged.tasted === true);

  return (
    <div style={detailOverlay} role="dialog" aria-modal="true" aria-label={title}>
      <div style={detailDialog}>
        <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
          <div style={{ flex: 1, minWidth: 0, display: "grid", gap: 4 }}>
            <div className="hub-card-kicker">
              {ko ? "프롬프트" : "PROMPT"}
              {merged.category ? ` · ${merged.category}` : ""}
            </div>
            <div style={{ fontFamily: "var(--rd-f-display)", fontSize: 21, color: "var(--rd-ink)" }}>{title}</div>
            {merged.authorName && (
              <div style={{ fontSize: 12, color: "var(--rd-ink-3)" }}>
                {ko ? `${merged.authorName} 제공` : `by ${merged.authorName}`}
              </div>
            )}
          </div>
          <button
            type="button"
            className="btn sm"
            onClick={onClose}
            aria-label={ko ? "닫기" : "Close"}
            style={{ display: "inline-flex", alignItems: "center", gap: 4 }}
          >
            <IconClose size={13} />
          </button>
        </div>

        {summary && <div style={{ fontSize: 13, lineHeight: 1.6, color: "var(--rd-ink-2)" }}>{summary}</div>}

        <div className="portal-chip-row">
          {(merged.models ?? []).map((m) => (
            <RdTag key={m} dashed>{m}</RdTag>
          ))}
          {merged.unlocked && <RdTag bg={C.green}>{ko ? "소장중" : "Unlocked"}</RdTag>}
          {merged.tasted && !merged.unlocked && <RdTag dashed>{ko ? "맛보기 사용됨" : "Taste used"}</RdTag>}
          {merged.bookmarked && <RdTag dashed>{"★ "}{ko ? "저장됨" : "Saved"}</RdTag>}
        </div>

        {inputs && (
          <div style={detailBlock}>
            <div style={detailBlockTitle}>{"\u{1F4CE} "}{ko ? "필요 입력물" : "Required inputs"}</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{inputs}</div>
          </div>
        )}

        {(merged.exampleImages ?? []).length > 0 && (
          <div style={{ display: "flex", gap: 8, overflowX: "auto" }}>
            {(merged.exampleImages ?? []).map((src) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={src}
                src={src}
                alt={ko ? `${title} 예시 이미지` : `${title} example`}
                style={{ height: 150, borderRadius: 8, border: "1px solid var(--rd-hair)", objectFit: "cover" }}
              />
            ))}
          </div>
        )}

        {exampleResult && (
          <div style={detailBlock}>
            <div style={detailBlockTitle}>{ko ? "예시 결과" : "Example result"}</div>
            <div style={{ whiteSpace: "pre-wrap" }}>{exampleResult}</div>
          </div>
        )}

        {/* ── 열람/맛보기/써보기 액션 영역 ── */}
        {body ? (
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ ...detailBlock, maxHeight: 220, overflowY: "auto" }}>
              <div style={detailBlockTitle}>{ko ? "프롬프트 본문" : "Prompt body"}</div>
              <pre style={{ margin: 0, whiteSpace: "pre-wrap", fontFamily: "inherit", fontSize: 12.5, lineHeight: 1.6 }}>
                {body}
              </pre>
            </div>
            {tips && (
              <div style={detailBlock}>
                <div style={detailBlockTitle}>{ko ? "활용 팁" : "Tips"}</div>
                <div style={{ whiteSpace: "pre-wrap" }}>{tips}</div>
              </div>
            )}
            {!paid && !merged.unlocked && (
              <div style={{ fontSize: 12, color: "var(--rd-warn)", lineHeight: 1.5 }}>
                {ko
                  ? "맛보기 내용은 이 자리에서만 제공돼요. 화면을 닫으면 다시 볼 수 없습니다."
                  : "This taste is shown only here. Once you close it, it cannot be reopened."}
              </div>
            )}
            {startFailed && (
              <div
                role="alert"
                data-testid="prompt-start-error"
                style={{ ...detailBlock, color: "var(--rd-warn)" }}
              >
                {ko
                  ? "새 채팅을 만들지 못했습니다. 프롬프트는 그대로 유지됩니다."
                  : "Could not create the chat. Your prompt is still here."}
              </div>
            )}
            <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, flexWrap: "wrap" }}>
              <button type="button" className="btn sm" onClick={() => void copyBody()}>
                {copied ? (ko ? "복사됨" : "Copied") : ko ? "복사" : "Copy"}
              </button>
              <button
                type="button"
                className="btn sm primary"
                onClick={() => void startFromDetail()}
                disabled={startBusy}
              >
                {startBusy
                  ? ko ? "채팅 만드는 중…" : "Creating chat…"
                  : startFailed
                    ? ko ? "다시 시도" : "Retry"
                    : ko ? "이 프롬프트로 새 채팅 시작" : "Start a new chat with this prompt"}
              </button>
            </div>
          </div>
        ) : (
          <div style={{ display: "grid", gap: 10 }}>
            {gate === "unauthenticated" || !signedIn ? (
              <div style={{ display: "grid", gap: 8 }}>
                <span style={{ fontSize: 12.5, color: "var(--rd-ink-2)", lineHeight: 1.5 }}>
                  {ko ? "프롬프트를 열람하려면 먼저 로그인하세요." : "Sign in first to open this prompt."}
                </span>
                <button
                  type="button"
                  className="btn sm primary"
                  style={{ justifySelf: "start" }}
                  onClick={() => void onSignIn().then((ok) => ok && setGate(null))}
                >
                  {ko ? "Google로 로그인" : "Sign in with Google"}
                </button>
              </div>
            ) : tastedGone ? (
              // 무료 + 이미 맛봄 — 1회 제공 원칙, 재열람은 구독 필요.
              <div style={{ display: "grid", gap: 8 }}>
                <span style={{ fontSize: 12.5, color: "var(--rd-ink-2)", lineHeight: 1.5 }}>
                  {ko
                    ? "맛보기는 1회만 제공돼요. 이 프롬프트를 다시 열람하려면 구독이 필요해요."
                    : "Tastes are one-time only. Subscribe to reopen this prompt."}
                </span>
                <UpgradeCta variant="banner" />
              </div>
            ) : gate === "subscription" ? (
              // unlock 402 — 맛보기 옵션(미사용 시) 또는 구독 안내.
              <div style={{ display: "grid", gap: 8 }}>
                <span style={{ fontSize: 12.5, color: "var(--rd-ink-2)", lineHeight: 1.5 }}>
                  {ko
                    ? "무제한 열람은 구독 회원 전용이에요. 무료 플랜은 이 프롬프트를 1회 맛보기로 열람할 수 있어요."
                    : "Unlimited opens are for subscribers. On the free plan you can taste this prompt once."}
                </span>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  {!merged.tasted && (
                    <button type="button" className="btn sm primary" onClick={() => void doTaste()} disabled={busy != null}>
                      {busy === "taste" ? (ko ? "여는 중…" : "Opening…") : ko ? "맛보기 1회 사용" : "Use my one taste"}
                    </button>
                  )}
                  <button type="button" className="btn sm" onClick={openPricing}>
                    {ko ? "구독하고 무제한 열람" : "Subscribe for unlimited"}
                  </button>
                </div>
              </div>
            ) : gate === "error" ? (
              <div style={{ display: "grid", gap: 8 }}>
                <span style={{ fontSize: 12.5, color: "var(--rd-warn)", lineHeight: 1.5 }}>
                  {ko
                    ? "프롬프트를 열지 못했습니다. 네트워크 상태를 확인하고 다시 시도하세요."
                    : "Could not open the prompt. Check your network and try again."}
                </span>
                <button
                  type="button"
                  className="btn sm"
                  style={{ justifySelf: "start" }}
                  onClick={() => void (paid ? doUnlock() : doTaste())}
                >
                  {ko ? "다시 시도" : "Retry"}
                </button>
              </div>
            ) : paid ? (
              <div style={{ display: "flex", justifyContent: "flex-end" }}>
                <button type="button" className="btn sm primary" onClick={() => void doUnlock()} disabled={busy != null}>
                  {busy === "unlock" ? (ko ? "여는 중…" : "Opening…") : ko ? "열람하기 (무제한)" : "Open (unlimited)"}
                </button>
              </div>
            ) : (
              // 무료 + 아직 맛보기 전
              <div style={{ display: "grid", gap: 8 }}>
                <span style={{ fontSize: 12.5, color: "var(--rd-ink-2)", lineHeight: 1.5 }}>
                  {ko
                    ? "무료 플랜은 프롬프트당 1회 맛보기로 열람할 수 있어요. 맛보기 내용은 그 자리에서만 제공됩니다."
                    : "On the free plan you can taste each prompt once. The body is shown only at that moment."}
                </span>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" className="btn sm primary" onClick={() => void doTaste()} disabled={busy != null}>
                    {busy === "taste" ? (ko ? "여는 중…" : "Opening…") : ko ? "맛보기 1회" : "Taste once"}
                  </button>
                  <button type="button" className="btn sm" onClick={openPricing}>
                    {ko ? "구독하고 무제한 열람" : "Subscribe for unlimited"}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

const detailOverlay: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 90,
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  padding: 20,
  background: "rgba(20, 24, 32, 0.28)",
};

const detailDialog: CSSProperties = {
  width: "min(640px, 100%)",
  maxHeight: "min(760px, 90vh)",
  overflowY: "auto",
  borderRadius: 8,
  border: "1px solid var(--rd-hair)",
  background: "var(--rd-surface)",
  boxShadow: "0 18px 60px rgba(20, 24, 32, 0.24)",
  display: "grid",
  gap: 14,
  padding: 18,
};

const detailBlock: CSSProperties = {
  padding: "9px 11px",
  borderRadius: 8,
  background: "var(--rd-surface-2)",
  border: "1px solid var(--rd-hair)",
  color: "var(--rd-ink-2)",
  fontSize: 12.5,
  lineHeight: 1.55,
};

const detailBlockTitle: CSSProperties = {
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 0.4,
  textTransform: "uppercase",
  color: "var(--rd-ink-3)",
  marginBottom: 5,
};
