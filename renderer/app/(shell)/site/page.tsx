"use client";
// 사이트 디자인 스튜디오 — 디자인 전용(백엔드/dev server/코드 실행 없음).
// 화면 = self-contained HTML 1문서. 렌더는 main의 site:prepareRender(태깅+CSP+오버레이 주입)를
// 거친 sandbox="allow-scripts" iframe(srcDoc)만 사용한다 — allow-same-origin 금지(opaque origin 격리),
// 통신은 nonce 봉투 postMessage 단일 채널. docs/DESIGN.md: 토큰만, 강조 1개, inline CSSProperties.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, KeyboardEvent } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { SITE_MESSAGE_KEY } from "@shared/site-studio";
import type {
  SiteGuestMessage,
  SiteHostMessage,
  SiteProjectMeta,
  SiteScreenMeta,
  SiteSelectionPayload,
} from "@shared/site-studio";

type DevicePreset = { id: string; label: string; labelEn: string; width: number };
const DEVICES: DevicePreset[] = [
  { id: "mobile", label: "모바일", labelEn: "Mobile", width: 375 },
  { id: "tablet", label: "태블릿", labelEn: "Tablet", width: 768 },
  { id: "desktop", label: "데스크탑", labelEn: "Desktop", width: 1280 },
];

type Diagnostic = { level: "error" | "warn"; message: string };

function isImeSubmit(e: KeyboardEvent): boolean {
  return e.nativeEvent.isComposing || e.keyCode === 229;
}

export default function SiteStudioPage() {
  const { locale } = useT();
  const ko = locale !== "en";

  // ── 데이터 상태 ─────────────────────────────────────────
  const [projects, setProjects] = useState<SiteProjectMeta[]>([]);
  const [projectId, setProjectId] = useState<string | null>(null);
  const [activeScreenId, setActiveScreenId] = useState<string | null>(null);
  const [avail, setAvail] = useState<{ ready: boolean; agent: string } | null>(null);

  // ── 홈(브리프) 상태 ─────────────────────────────────────
  const [view, setView] = useState<"home" | "studio">("home");
  const [brief, setBrief] = useState("");
  const [variants, setVariants] = useState(1);
  const [generating, setGenerating] = useState(false);

  // ── 캔버스/렌더 상태 ────────────────────────────────────
  const [srcDoc, setSrcDoc] = useState<string | null>(null);
  const [renderKey, setRenderKey] = useState(0);
  const [device, setDevice] = useState<DevicePreset>(DEVICES[2]);
  const [selectMode, setSelectMode] = useState(false);
  const [selection, setSelection] = useState<SiteSelectionPayload | null>(null);
  const [selectionThumb, setSelectionThumb] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<Diagnostic[]>([]);
  const [instruction, setInstruction] = useState("");
  const [editing, setEditing] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // ── 새 화면 인라인 폼 ───────────────────────────────────
  const [addOpen, setAddOpen] = useState(false);
  const [addBrief, setAddBrief] = useState("");
  const [addSameStyle, setAddSameStyle] = useState(true);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");

  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const nonceRef = useRef<string | null>(null);
  const selectModeRef = useRef(false);
  const activeScreenRef = useRef<string | null>(null);
  const scrollMapRef = useRef(new Map<string, { x: number; y: number }>());
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const project = useMemo(() => projects.find((p) => p.id === projectId) ?? null, [projects, projectId]);
  const screens = project?.screens ?? [];
  const activeScreen = screens.find((s) => s.id === activeScreenId) ?? null;

  const showToast = useCallback((message: string) => {
    setToast(message);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 3500);
  }, []);

  const refreshProjects = useCallback(async (): Promise<SiteProjectMeta[]> => {
    const list = (await ipc()?.site?.listProjects?.()) ?? [];
    setProjects(list);
    return list;
  }, []);

  useEffect(() => {
    void refreshProjects();
    ipc()
      ?.site?.contentAvailable?.()
      .then((a) => setAvail(a ?? { ready: false, agent: "web-master" }))
      .catch(() => setAvail({ ready: false, agent: "web-master" }));
  }, [refreshProjects]);

  // ── 게스트(iframe) 통신 ─────────────────────────────────
  const postToGuest = useCallback((message: SiteHostMessage) => {
    const win = iframeRef.current?.contentWindow;
    const nonce = nonceRef.current;
    if (!win || !nonce) return;
    win.postMessage({ [SITE_MESSAGE_KEY]: nonce, message }, "*");
  }, []);

  const captureSelectionThumb = useCallback(async (payload: SiteSelectionPayload) => {
    setSelectionThumb(null);
    const iframe = iframeRef.current;
    if (!iframe) return;
    const box = iframe.getBoundingClientRect();
    const x = Math.max(box.left, box.left + payload.rect.x);
    const y = Math.max(box.top, box.top + payload.rect.y);
    const right = Math.min(box.right, box.left + payload.rect.x + payload.rect.width);
    const bottom = Math.min(box.bottom, box.top + payload.rect.y + payload.rect.height);
    if (right - x < 4 || bottom - y < 4) return;
    // 오버레이 하이라이트를 잠깐 숨기고 캡처(Orca 방식) — 복원은 finally에서.
    postToGuest({ type: "setOverlayVisible", visible: false });
    try {
      await new Promise((r) => setTimeout(r, 60));
      const res = await ipc()?.site?.captureRect?.({ x, y, width: right - x, height: bottom - y });
      if (res?.ok && res.dataUrl) setSelectionThumb(res.dataUrl);
    } finally {
      postToGuest({ type: "setOverlayVisible", visible: true });
    }
  }, [postToGuest]);

  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const iframe = iframeRef.current;
      if (!iframe || event.source !== iframe.contentWindow) return;
      const data = event.data as { [SITE_MESSAGE_KEY]?: string; message?: SiteGuestMessage } | null;
      if (!data || data[SITE_MESSAGE_KEY] !== nonceRef.current || !data.message) return;
      const m = data.message;
      if (m.type === "ready") {
        const screenId = activeScreenRef.current;
        const pos = screenId ? scrollMapRef.current.get(screenId) : null;
        if (pos) postToGuest({ type: "restoreScroll", x: pos.x, y: pos.y });
        postToGuest({ type: "setMode", mode: selectModeRef.current ? "select" : "browse" });
      } else if (m.type === "select") {
        setSelection(m.payload);
        void captureSelectionThumb(m.payload);
      } else if (m.type === "scroll") {
        const screenId = activeScreenRef.current;
        if (screenId) scrollMapRef.current.set(screenId, { x: m.x, y: m.y });
      } else if (m.type === "console" || m.type === "pageError") {
        const message = m.type === "console" ? m.message : m.message;
        const level: Diagnostic["level"] = m.type === "pageError" || m.level === "error" ? "error" : "warn";
        setDiagnostics((prev) => [...prev.slice(-4), { level, message }]);
      }
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [captureSelectionThumb, postToGuest]);

  // ── 렌더 로드 ───────────────────────────────────────────
  const loadRender = useCallback(async (pid: string, screenId: string) => {
    const res = await ipc()?.site?.prepareRender?.({ projectId: pid, screenId });
    if (!res?.ok || !res.renderHtml || !res.nonce) {
      setSrcDoc(null);
      nonceRef.current = null;
      return false;
    }
    // nonce를 srcDoc보다 먼저 갱신 — ready 메시지가 새 nonce로 검증되도록.
    nonceRef.current = res.nonce;
    activeScreenRef.current = screenId;
    setSelection(null);
    setSelectionThumb(null);
    setDiagnostics([]);
    setSrcDoc(res.renderHtml);
    setRenderKey((k) => k + 1);
    return true;
  }, []);

  const openScreen = useCallback(
    async (pid: string, screenId: string) => {
      setProjectId(pid);
      setActiveScreenId(screenId);
      activeScreenRef.current = screenId;
      setView("studio");
      await loadRender(pid, screenId);
    },
    [loadRender],
  );

  // ── 생성/수정 흐름 ──────────────────────────────────────
  const runGenerate = useCallback(
    async (opts: { pid: string | null; briefText: string; variantCount: number; baseScreenId?: string }) => {
      const text = opts.briefText.trim();
      if (!text || generating) return;
      setGenerating(true);
      try {
        let pid = opts.pid;
        if (!pid) {
          const created = await ipc()?.site?.createProject?.({ name: text.slice(0, 30) });
          if (!created) {
            showToast(ko ? "Electron 브리지를 사용할 수 없습니다" : "Electron bridge unavailable");
            return;
          }
          pid = created.id;
        }
        const res = await ipc()?.site?.generateScreen?.({
          projectId: pid,
          brief: text,
          variants: opts.variantCount,
          baseScreenId: opts.baseScreenId,
          locale: ko ? "ko" : "en",
        });
        if (!res?.ok || !res.screens?.length) {
          showToast((ko ? "생성 실패: " : "Generation failed: ") + (res?.reason ?? "unknown"));
          return;
        }
        await refreshProjects();
        await openScreen(pid, res.screens[0].id);
        showToast(
          res.screens.length > 1
            ? ko
              ? `시안 ${res.screens.length}개 생성 완료 (${res.engine})`
              : `${res.screens.length} variants ready (${res.engine})`
            : ko
              ? `화면 생성 완료 (${res.engine})`
              : `Screen ready (${res.engine})`,
        );
      } finally {
        setGenerating(false);
      }
    },
    [generating, ko, openScreen, refreshProjects, showToast],
  );

  const runEdit = useCallback(async () => {
    const text = instruction.trim();
    if (!text || editing || !projectId || !activeScreenId) return;
    setEditing(true);
    try {
      const res = await ipc()?.site?.editScreen?.({
        projectId,
        screenId: activeScreenId,
        instruction: text,
        selectionId: selection?.id,
        locale: ko ? "ko" : "en",
      });
      if (!res?.ok) {
        showToast((ko ? "수정 실패: " : "Edit failed: ") + (res?.reason ?? "unknown"));
        return;
      }
      setInstruction("");
      await refreshProjects();
      await loadRender(projectId, activeScreenId);
      showToast(
        res.mode === "patch"
          ? ko
            ? "선택 요소만 반영했습니다"
            : "Patched the selected element"
          : ko
            ? "화면 전체를 갱신했습니다"
            : "Regenerated the full screen",
      );
    } finally {
      setEditing(false);
    }
  }, [activeScreenId, editing, instruction, ko, loadRender, projectId, refreshProjects, selection, showToast]);

  const fixWithAi = useCallback(
    (diag: Diagnostic) => {
      setSelection(null);
      setSelectionThumb(null);
      setInstruction((ko ? "이 화면에서 다음 오류를 고쳐줘: " : "Fix this error in the screen: ") + diag.message);
    },
    [ko],
  );

  const toggleSelectMode = useCallback(() => {
    setSelectMode((prev) => {
      const next = !prev;
      selectModeRef.current = next;
      postToGuest({ type: "setMode", mode: next ? "select" : "browse" });
      if (!next) {
        setSelection(null);
        setSelectionThumb(null);
        postToGuest({ type: "clearSelection" });
      }
      return next;
    });
  }, [postToGuest]);

  const clearSelection = useCallback(() => {
    setSelection(null);
    setSelectionThumb(null);
    postToGuest({ type: "clearSelection" });
  }, [postToGuest]);

  const deleteScreen = useCallback(
    async (screenId: string) => {
      if (!projectId) return;
      if (!window.confirm(ko ? "이 화면을 삭제할까요?" : "Delete this screen?")) return;
      await ipc()?.site?.deleteScreen?.({ projectId, screenId });
      const list = await refreshProjects();
      const meta = list.find((p) => p.id === projectId);
      if (activeScreenId === screenId) {
        const nextScreen = meta?.screens[0];
        if (nextScreen) await openScreen(projectId, nextScreen.id);
        else {
          setActiveScreenId(null);
          setSrcDoc(null);
          setView("home");
        }
      }
    },
    [activeScreenId, ko, openScreen, projectId, refreshProjects],
  );

  const commitRename = useCallback(async () => {
    if (!projectId || !renamingId) return;
    const name = renameDraft.trim();
    setRenamingId(null);
    if (!name) return;
    await ipc()?.site?.renameScreen?.({ projectId, screenId: renamingId, name });
    await refreshProjects();
  }, [projectId, renameDraft, renamingId, refreshProjects]);

  const exportScreen = useCallback(async () => {
    if (!projectId || !activeScreenId) return;
    const res = await ipc()?.site?.exportScreen?.({ projectId, screenId: activeScreenId });
    if (res?.ok && res.path) showToast((ko ? "저장됨: " : "Saved: ") + res.path);
  }, [activeScreenId, ko, projectId, showToast]);

  const exportZip = useCallback(async () => {
    if (!projectId) return;
    const res = await ipc()?.site?.exportProjectZip?.({ projectId });
    if (res?.ok && res.path) showToast((ko ? "ZIP 저장됨: " : "ZIP saved: ") + res.path);
    else if (res?.reason) showToast((ko ? "내보내기 실패: " : "Export failed: ") + res.reason);
  }, [ko, projectId, showToast]);

  const deleteProject = useCallback(
    async (pid: string) => {
      if (!window.confirm(ko ? "프로젝트와 모든 화면을 삭제할까요?" : "Delete this project and all screens?")) return;
      await ipc()?.site?.deleteProject?.({ projectId: pid });
      if (projectId === pid) {
        setProjectId(null);
        setActiveScreenId(null);
        setSrcDoc(null);
      }
      await refreshProjects();
    },
    [ko, projectId, refreshProjects],
  );

  const noEngine = avail !== null && !avail.ready;

  // ── 홈 뷰 ───────────────────────────────────────────────
  if (view === "home") {
    return (
      <div style={shell}>
        <div style={homeWrap}>
          <div style={eyebrow}>SITE · DESIGN STUDIO</div>
          <h1 style={homeTitle}>
            <span style={{ color: "var(--accent)" }}>{ko ? "사이트" : "Site"}</span>{" "}
            {ko ? "디자인 스튜디오" : "Design Studio"}
          </h1>
          <p style={homeSub}>
            {ko
              ? "웹앱디자인마스터에게 화면을 맡기세요. 만들어진 디자인은 우측 캔버스에서 요소를 클릭해 바로 고칠 수 있습니다. 디자인 전용 — 서버도 빌드도 없습니다."
              : "Brief the design master, then click any element on the canvas to refine it. Design-only — no servers, no builds."}
          </p>

          <div style={promptBox}>
            <textarea
              value={brief}
              onChange={(e) => setBrief(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  if (isImeSubmit(e)) return;
                  e.preventDefault();
                  void runGenerate({ pid: null, briefText: brief, variantCount: variants });
                }
              }}
              placeholder={
                ko
                  ? "예: 1인 창업자를 위한 회계 SaaS 랜딩 페이지 — 신뢰감 있는 딥그린, 요금제 3단"
                  : "e.g. A landing page for an accounting SaaS — deep green, 3 pricing tiers"
              }
              rows={3}
              style={briefInput}
              disabled={generating}
            />
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 14, flexWrap: "wrap" }}>
            <span style={metaLabel}>{ko ? "시안" : "Variants"}</span>
            <div style={{ display: "inline-flex", gap: 4 }}>
              {[1, 2, 3].map((n) => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setVariants(n)}
                  style={{ ...segBtn, ...(variants === n ? segBtnOn : null) }}
                >
                  {n}
                </button>
              ))}
            </div>
            <div style={{ flex: 1 }} />
            <button
              type="button"
              style={{ ...primaryBtn, opacity: generating || !brief.trim() || noEngine ? 0.5 : 1 }}
              disabled={generating || !brief.trim() || noEngine}
              onClick={() => void runGenerate({ pid: null, briefText: brief, variantCount: variants })}
            >
              {generating ? (ko ? "디자인 중…" : "Designing…") : ko ? "화면 만들기" : "Create screen"}
            </button>
          </div>

          {noEngine && (
            <p style={warnNote}>
              {ko
                ? "활성 AI 런타임이 없습니다. 설정에서 런타임(Claude Code/Codex 등)을 연결하세요."
                : "No active AI runtime. Connect one (Claude Code/Codex …) in Settings."}
            </p>
          )}
          {generating && (
            <p style={{ ...metaLabel, marginTop: 14 }}>
              {ko
                ? "웹앱 디자인 마스터(Hub)를 빌려 화면을 설계하고 있습니다 — 1~4분 정도 걸립니다."
                : "Borrowing the Web App Design Master (Hub) to compose your screen — 1–4 minutes."}
            </p>
          )}

          {projects.length > 0 && (
            <div style={{ marginTop: 34 }}>
              <div style={metaLabel}>{ko ? "내 사이트" : "My sites"}</div>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }}>
                {projects.map((p) => (
                  <div key={p.id} style={projectRow}>
                    <button
                      type="button"
                      style={projectRowMain}
                      onClick={() => {
                        if (p.screens.length) void openScreen(p.id, p.screens[0].id);
                        else {
                          setProjectId(p.id);
                          setView("studio");
                        }
                      }}
                    >
                      <strong style={{ fontSize: 13, color: "var(--ink)" }}>{p.name}</strong>
                      <span style={{ fontSize: 11.5, color: "var(--muted-deep)" }}>
                        {ko ? `화면 ${p.screens.length}개` : `${p.screens.length} screens`} ·{" "}
                        {new Date(p.updatedAt).toLocaleDateString()}
                      </span>
                    </button>
                    <button
                      type="button"
                      style={ghostIconBtn}
                      title={ko ? "프로젝트 삭제" : "Delete project"}
                      onClick={() => void deleteProject(p.id)}
                    >
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        {toast && <div style={toastStyle}>{toast}</div>}
      </div>
    );
  }

  // ── 스튜디오 뷰 ─────────────────────────────────────────
  return (
    <div style={shell}>
      <div style={topbar}>
        <button
          type="button"
          style={backLink}
          onClick={() => {
            setView("home");
            void refreshProjects();
          }}
        >
          ← {ko ? "홈" : "Home"}
        </button>
        <span style={wordmark}>{project?.name ?? (ko ? "사이트" : "Site")}</span>
        {activeScreen && <span style={{ fontSize: 12, color: "var(--muted-deep)" }}>/ {activeScreen.name}</span>}
        <div style={{ flex: 1 }} />
        <div style={{ display: "inline-flex", gap: 4 }}>
          {DEVICES.map((d) => (
            <button
              key={d.id}
              type="button"
              onClick={() => setDevice(d)}
              style={{ ...segBtn, ...(device.id === d.id ? segBtnOn : null) }}
              title={`${d.width}px`}
            >
              {ko ? d.label : d.labelEn}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={toggleSelectMode}
          style={{ ...ghostBtn, ...(selectMode ? { borderColor: "var(--accent)", color: "var(--accent)" } : null) }}
          aria-pressed={selectMode}
        >
          {ko ? "요소 선택" : "Select"}
        </button>
        <button type="button" style={ghostBtn} onClick={() => void exportScreen()} disabled={!activeScreenId}>
          HTML
        </button>
        <button type="button" style={ghostBtn} onClick={() => void exportZip()}>
          ZIP
        </button>
      </div>

      <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
        {/* 좌: 화면 갤러리 */}
        <div style={railStyle}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px 6px" }}>
            <span style={metaLabel}>{ko ? "화면" : "Screens"}</span>
            <button type="button" style={ghostIconBtn} title={ko ? "새 화면" : "New screen"} onClick={() => setAddOpen((v) => !v)}>
              ＋
            </button>
          </div>
          {addOpen && (
            <div style={{ padding: "0 12px 10px", display: "flex", flexDirection: "column", gap: 6 }}>
              <textarea
                value={addBrief}
                onChange={(e) => setAddBrief(e.target.value)}
                rows={2}
                placeholder={ko ? "예: 같은 제품의 로그인 화면" : "e.g. a login screen for the same product"}
                style={{ ...briefInput, fontSize: 12, padding: 8 }}
                disabled={generating}
              />
              <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11.5, color: "var(--ink-soft)" }}>
                <input type="checkbox" checked={addSameStyle} onChange={(e) => setAddSameStyle(e.target.checked)} />
                {ko ? "현재 화면과 같은 스타일" : "Match current screen style"}
              </label>
              <button
                type="button"
                style={{ ...primaryBtn, height: 28, justifyContent: "center", opacity: generating || !addBrief.trim() ? 0.5 : 1 }}
                disabled={generating || !addBrief.trim()}
                onClick={() => {
                  const text = addBrief;
                  setAddBrief("");
                  setAddOpen(false);
                  void runGenerate({
                    pid: projectId,
                    briefText: text,
                    variantCount: 1,
                    baseScreenId: addSameStyle && activeScreenId ? activeScreenId : undefined,
                  });
                }}
              >
                {generating ? (ko ? "디자인 중…" : "Designing…") : ko ? "추가" : "Add"}
              </button>
            </div>
          )}
          <div style={{ flex: 1, overflowY: "auto", padding: "0 8px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
            {screens.map((s) => {
              const active = s.id === activeScreenId;
              return (
                <div key={s.id} style={{ ...screenCard, ...(active ? screenCardOn : null) }}>
                  {renamingId === s.id ? (
                    <input
                      autoFocus
                      value={renameDraft}
                      onChange={(e) => setRenameDraft(e.target.value)}
                      onBlur={() => void commitRename()}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          if (isImeSubmit(e)) return;
                          e.preventDefault();
                          void commitRename();
                        }
                        if (e.key === "Escape") setRenamingId(null);
                      }}
                      style={{ ...briefInput, fontSize: 12, padding: "4px 6px" }}
                    />
                  ) : (
                    <button
                      type="button"
                      style={screenCardMain}
                      onClick={() => projectId && void openScreen(projectId, s.id)}
                      onDoubleClick={() => {
                        setRenamingId(s.id);
                        setRenameDraft(s.name);
                      }}
                      title={ko ? "더블클릭: 이름 변경" : "Double-click to rename"}
                    >
                      <span style={{ fontSize: 12.5, fontWeight: 700, color: active ? "var(--accent)" : "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {s.name}
                      </span>
                      <span style={{ fontSize: 10.5, color: "var(--muted-deep)" }}>
                        {s.variantLabel ? `${ko ? "시안" : "Variant"} ${s.variantLabel} · ` : ""}
                        {new Date(s.updatedAt).toLocaleTimeString()}
                      </span>
                    </button>
                  )}
                  <button type="button" style={ghostIconBtn} title={ko ? "삭제" : "Delete"} onClick={() => void deleteScreen(s.id)}>
                    ✕
                  </button>
                </div>
              );
            })}
            {!screens.length && (
              <p style={{ fontSize: 12, color: "var(--muted-deep)", padding: "8px 6px" }}>
                {ko ? "아직 화면이 없습니다. ＋로 첫 화면을 만드세요." : "No screens yet — hit ＋ to create one."}
              </p>
            )}
          </div>
        </div>

        {/* 우: 캔버스 */}
        <div style={canvasWrap}>
          {generating && (
            <div style={busyOverlay}>
              <div style={busyCard}>
                {ko ? "웹앱디자인마스터가 작업 중… (1~3분)" : "Design master at work… (1–3 min)"}
              </div>
            </div>
          )}
          {srcDoc ? (
            <div style={{ ...frameHolder, width: device.width }}>
              <iframe
                key={renderKey}
                ref={iframeRef}
                title="site-preview"
                sandbox="allow-scripts"
                srcDoc={srcDoc}
                style={{ ...frameStyle, cursor: selectMode ? "crosshair" : "auto" }}
              />
            </div>
          ) : (
            <div style={{ margin: "auto", fontSize: 13, color: "var(--muted-deep)" }}>
              {ko ? "왼쪽에서 화면을 선택하거나 새로 만드세요." : "Pick or create a screen on the left."}
            </div>
          )}
        </div>
      </div>

      {/* 하단: 수정 지시 바 */}
      <div style={bottomBar}>
        {selection && (
          <span style={selectionChip}>
            {selectionThumb && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={selectionThumb} alt="" style={{ height: 22, borderRadius: 4, display: "block" }} />
            )}
            <span style={{ maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
              {selection.selector || selection.tagName}
            </span>
            <button type="button" onClick={clearSelection} style={chipX} aria-label={ko ? "선택 해제" : "Clear selection"}>
              ✕
            </button>
          </span>
        )}
        <input
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              if (isImeSubmit(e)) return;
              e.preventDefault();
              void runEdit();
            }
          }}
          placeholder={
            selection
              ? ko
                ? "선택한 요소를 어떻게 바꿀까요? 예: 더 크게, 주황색으로"
                : "How should the selected element change?"
              : ko
                ? "화면 전체에 대한 수정 지시 — 요소를 집으려면 위의 ‘요소 선택’을 켜세요"
                : "Instruction for the whole screen — toggle Select to pick an element"
          }
          style={instructionInput}
          disabled={editing || !activeScreenId}
        />
        <button
          type="button"
          style={{ ...primaryBtn, opacity: editing || !instruction.trim() || !activeScreenId ? 0.5 : 1 }}
          disabled={editing || !instruction.trim() || !activeScreenId}
          onClick={() => void runEdit()}
        >
          {editing ? (ko ? "반영 중…" : "Applying…") : ko ? "반영" : "Apply"}
        </button>
      </div>

      {diagnostics.length > 0 && (
        <div style={diagBar}>
          <span style={{ fontWeight: 800, color: diagnostics[diagnostics.length - 1].level === "error" ? "#c0392b" : "#96690d" }}>
            {diagnostics[diagnostics.length - 1].level === "error" ? (ko ? "오류" : "Error") : (ko ? "경고" : "Warning")}
          </span>
          <span style={{ flex: 1, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {diagnostics[diagnostics.length - 1].message}
          </span>
          <button type="button" style={ghostBtn} onClick={() => fixWithAi(diagnostics[diagnostics.length - 1])}>
            {ko ? "AI로 고치기" : "Fix with AI"}
          </button>
          <button type="button" style={ghostIconBtn} onClick={() => setDiagnostics([])} aria-label={ko ? "닫기" : "Dismiss"}>
            ✕
          </button>
        </div>
      )}

      {toast && <div style={toastStyle}>{toast}</div>}
    </div>
  );
}

// ── 스타일 (docs/DESIGN.md: 토큰만, 인라인 CSSProperties) ──────────
const shell: CSSProperties = { flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--paper)", color: "var(--ink)", position: "relative" };
const topbar: CSSProperties = { minHeight: 44, borderBottom: "1px solid var(--paper-edge)", background: "var(--paper)", display: "flex", alignItems: "center", gap: 8, padding: "6px 16px 6px 90px", flexShrink: 0 };
const backLink: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 6, color: "var(--accent)", fontWeight: 800, fontSize: 12, background: "none", border: "none", cursor: "pointer", padding: 0 };
const wordmark: CSSProperties = { fontSize: 13, fontWeight: 800, color: "var(--ink)" };
const ghostBtn: CSSProperties = { height: 30, border: "1px solid var(--paper-edge)", borderRadius: 7, background: "var(--paper)", color: "var(--ink-soft)", display: "inline-flex", alignItems: "center", gap: 6, padding: "0 11px", fontSize: 12, fontWeight: 800, cursor: "pointer" };
const primaryBtn: CSSProperties = { height: 30, border: "none", borderRadius: 7, background: "var(--accent)", color: "#fff", display: "inline-flex", alignItems: "center", gap: 6, padding: "0 13px", fontSize: 12, fontWeight: 900, cursor: "pointer" };
const ghostIconBtn: CSSProperties = { width: 24, height: 24, border: "none", borderRadius: 6, background: "transparent", color: "var(--muted-deep)", cursor: "pointer", fontSize: 12, lineHeight: "24px", flexShrink: 0 };
const segBtn: CSSProperties = { height: 28, border: "1px solid var(--paper-edge)", borderRadius: 7, background: "var(--paper)", color: "var(--ink-soft)", padding: "0 10px", fontSize: 11.5, fontWeight: 800, cursor: "pointer" };
const segBtnOn: CSSProperties = { borderColor: "var(--accent)", color: "var(--accent)", background: "var(--fill-1, rgba(0,0,0,.03))" };
const metaLabel: CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: ".14em", color: "var(--muted-deep)", textTransform: "uppercase" };

const homeWrap: CSSProperties = { maxWidth: 640, width: "100%", margin: "0 auto", padding: "72px 24px 48px", overflowY: "auto" };
const eyebrow: CSSProperties = { fontSize: 11, fontWeight: 800, letterSpacing: ".18em", color: "var(--muted-deep)", marginBottom: 14 };
const homeTitle: CSSProperties = { margin: 0, fontSize: 26, fontWeight: 800, lineHeight: 1.14, color: "var(--ink)", fontFamily: "var(--font-display, inherit)" };
const homeSub: CSSProperties = { margin: "10px 0 26px", fontSize: 14, lineHeight: 1.6, color: "var(--muted-deep)" };
const promptBox: CSSProperties = { width: "100%", display: "flex", alignItems: "flex-start", gap: 10, padding: 6, border: "1px solid var(--paper-edge)", borderRadius: 14, background: "var(--paper)", boxShadow: "var(--rd-shadow-1, 0 4px 16px rgba(0,0,0,.05))" };
const briefInput: CSSProperties = { width: "100%", border: "none", outline: "none", resize: "none", background: "transparent", color: "var(--ink)", fontSize: 13.5, lineHeight: 1.6, padding: 10, fontFamily: "inherit" };
const warnNote: CSSProperties = { marginTop: 14, fontSize: 12.5, color: "#96690d", fontWeight: 700 };
const projectRow: CSSProperties = { display: "flex", alignItems: "center", gap: 6, border: "1px solid var(--paper-edge)", borderRadius: 10, background: "var(--paper)", padding: "4px 8px 4px 4px" };
const projectRowMain: CSSProperties = { flex: 1, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 2, background: "none", border: "none", cursor: "pointer", padding: "8px 10px", textAlign: "left" };

const railStyle: CSSProperties = { width: 232, borderRight: "1px solid var(--paper-edge)", display: "flex", flexDirection: "column", minHeight: 0, flexShrink: 0, background: "var(--paper)" };
const screenCard: CSSProperties = { display: "flex", alignItems: "center", gap: 4, border: "1px solid var(--paper-edge)", borderRadius: 9, padding: "2px 6px 2px 2px", background: "var(--paper)" };
const screenCardOn: CSSProperties = { borderColor: "var(--accent)" };
const screenCardMain: CSSProperties = { flex: 1, minWidth: 0, display: "flex", flexDirection: "column", alignItems: "flex-start", gap: 1, background: "none", border: "none", cursor: "pointer", padding: "7px 8px", textAlign: "left" };

const canvasWrap: CSSProperties = { flex: 1, minWidth: 0, overflow: "auto", display: "flex", justifyContent: "center", alignItems: "stretch", padding: 18, background: "var(--fill-1, rgba(0,0,0,.035))", position: "relative" };
const frameHolder: CSSProperties = { maxWidth: "100%", minHeight: 0, display: "flex", flexShrink: 0, margin: "0 auto" };
const frameStyle: CSSProperties = { width: "100%", height: "100%", minHeight: 480, border: "1px solid var(--paper-edge)", borderRadius: 10, background: "#fff", boxShadow: "var(--rd-shadow-1, 0 6px 24px rgba(0,0,0,.08))" };
const busyOverlay: CSSProperties = { position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: "color-mix(in srgb, var(--paper) 55%, transparent)", zIndex: 5 };
const busyCard: CSSProperties = { padding: "10px 18px", borderRadius: 10, background: "var(--paper)", border: "1px solid var(--paper-edge)", fontSize: 13, fontWeight: 800, color: "var(--ink)" };

const bottomBar: CSSProperties = { display: "flex", alignItems: "center", gap: 8, padding: "8px 14px", borderTop: "1px solid var(--paper-edge)", background: "var(--paper)", flexShrink: 0 };
const selectionChip: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 7, padding: "4px 6px 4px 4px", borderRadius: 8, border: "1px solid var(--accent)", color: "var(--accent)", fontSize: 11.5, fontWeight: 800, background: "var(--fill-1, rgba(0,0,0,.03))", flexShrink: 0 };
const chipX: CSSProperties = { border: "none", background: "none", color: "inherit", cursor: "pointer", fontSize: 11, padding: 0 };
const instructionInput: CSSProperties = { flex: 1, height: 34, border: "1px solid var(--paper-edge)", borderRadius: 8, background: "var(--paper)", color: "var(--ink)", padding: "0 12px", fontSize: 13, outline: "none" };
const diagBar: CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "6px 14px", borderTop: "1px solid var(--paper-edge)", background: "var(--paper)", fontSize: 12, color: "var(--ink-soft)", flexShrink: 0 };
const toastStyle: CSSProperties = { position: "absolute", bottom: 64, right: 18, padding: "9px 14px", borderRadius: 9, background: "var(--ink)", color: "var(--paper)", fontSize: 12, fontWeight: 700, zIndex: 20, maxWidth: 420, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };
