// 입력창 — Claude Desktop / Codex 스타일 풀 기능:
//   - 텍스트 + 이미지/파일 첨부
//   - + 메뉴 (파일 / 플러그인 / Plan 모드 / Goal 모드)
//   - / 슬래시 커맨드 (자동완성)
//   - @ 멘션 (에이전트 · 프로젝트 · 회사 · 환경변수)
//   - 하단 툴바: 에이전트 칩 · 권한 칩 · 모드 토글 · 보내기
//
// 모드 토글은 V0 UI만 (실제 동작은 V1): plan/goal/permission이 invocation payload로 전달.
"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type {
  ImageAttachment,
  AppFactoryAppRecord,
  InstalledAgent,
  InstalledFirm,
  Project,
  RuntimeCommand,
  RuntimeStatus,
} from "@/lib/types";
import { CONTEXT_MANAGED_BY } from "@shared/models";
import type { AgentlasAppDefinition } from "@/lib/apps";
import { appDisplayName, appSlashCommands, appTagline } from "@/lib/apps";
import { pickLocalized, useT } from "@/lib/i18n";

type ModelOption = { id: string; label: string; tag?: string };

const CLI_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini",
};

/** 모델 칩에 보일 라벨 — 현재 모델 라벨(opts에서) 또는 런타임 기본명. */
function modelChipLabel(s: RuntimeStatus, opts: ModelOption[]): string {
  const label = opts.find((o) => o.id === s.model)?.label ?? (s.model || null);
  if (s.kind === "ollama") return label ? `Ollama · ${label}` : "Ollama";
  if (s.kind === "byok") return label ?? "API";
  const base = CLI_LABEL[s.kind] ?? s.kind;
  return label ? `${base} · ${label}` : base;
}
import {
  IconApps,
  IconArrowUp,
  IconAtSign,
  IconBuilding,
  IconChevronDown,
  IconChevronRight,
  IconClose,
  IconFileUp,
  IconFolder,
  IconKey,
  IconLayers,
  IconPaperclip,
  IconPlus,
  IconRoute,
  IconShield,
  IconSparkles,
  IconTarget,
} from "@/components/Icon";

type TFunction = ReturnType<typeof useT>["t"];

interface PreviewedImage extends ImageAttachment {
  dataUrl: string;
  name: string;
}

interface MentionContext {
  agents: InstalledAgent[];
  projects: Project[];
  firms: InstalledFirm[];
  apps: AgentlasAppDefinition[];
  generatedApps?: AppFactoryAppRecord[];
  envKeys: string[]; // 등록된 env 키 (Library > Environment에서 add한)
  /** CLI(Claude/Codex/Gemini)에서 스캔한 슬래시 명령 — / 자동완성에 노출 */
  commands?: RuntimeCommand[];
}

interface SendOptions {
  images?: ImageAttachment[];
  /** 사용자가 활성화한 모드 — 백엔드 invocation에 전달 (V1) */
  planMode?: boolean;
  goalMode?: boolean;
  permissions?: PermissionLevel;
  appsGenerateMode?: boolean;
}

/** popover에 그릴 한 행 + 평탄화 인덱스용 메타. group은 같은 헤더 아래로 그룹핑되지만 인덱스는 flat. */
interface AutocompleteOption {
  /** 안정적 key */
  key: string;
  /** 노출 그룹 헤더 — 같은 group끼리 헤더 한 번만 노출 */
  group?: string;
  title: string;
  subtitle?: string;
  /** 아이콘은 popover에서 일괄 매핑 (group으로 결정) */
  kind: "cmd" | "app" | "agent" | "firm" | "project" | "env";
  /** 선택 시 입력창에 치환할 토큰 */
  replacement: string;
  /** true면 앱 액션 실행(/new·/clear·/help). false/undefined면 텍스트 삽입(멘션·CLI 슬래시). */
  appAction?: boolean;
  /** 멘션(@agent/@firm) 선택 시 이 에이전트로 활성 에이전트를 전환(=에이전트 콜). 있으면 텍스트 삽입 대신 전환. */
  switchAgentId?: string;
}

type PermissionLevel = "read" | "write" | "full";
type AppGenerateChoice = "dedicated" | "chat";
interface BottomQuestionOption {
  id: AppGenerateChoice;
  title: string;
  description: string;
  shortcut: string;
}

export function ChatInput({
  onSend,
  onCallAgent,
  onCommand,
  onStop,
  busy,
  disabled,
  context,
  runtime,
  modelOptions,
  onSelectModel,
  onSelectEffort,
}: {
  onSend: (text: string, opts?: SendOptions) => void;
  /** 슬래시 커맨드(/new, /clear, /help …) 실행 — 텍스트 삽입이 아니라 액션 */
  onCommand?: (cmd: string) => void;
  /** @멘션으로 에이전트/회사를 고르면 그 에이전트를 호출(활성 에이전트 전환). */
  onCallAgent?: (agentId: string) => void;
  /** 진행 중 실행 취소 — 제공되면 busy일 때 전송 버튼이 정지 버튼으로 변신(Esc도 정지). */
  onStop?: () => void;
  busy: boolean;
  disabled?: boolean;
  context?: MentionContext;
  /** 활성 런타임 — 모델/작업량 picker용. */
  runtime?: RuntimeStatus | null;
  /** 실시간 조회된 모델 목록 (runtime.listModels). */
  modelOptions?: ModelOption[];
  /** 모델 선택 — "" 이면 구독 기본(--model 미전달). */
  onSelectModel?: (id: string) => void;
  /** 작업량 선택 — "" 이면 기본. claude-code 전용. */
  onSelectEffort?: (id: string) => void;
}) {
  const { t, locale } = useT();
  const [input, setInput] = useState("");
  const [images, setImages] = useState<PreviewedImage[]>([]);
  const [plusOpen, setPlusOpen] = useState(false);
  const [plusSubmenu, setPlusSubmenu] = useState<"plugins" | null>(null);
  const [planMode, setPlanMode] = useState(false);
  const [goalMode, setGoalMode] = useState(false);
  const [appsGenerateMode, setAppsGenerateMode] = useState(false);
  const [appsGenerateQuestionOpen, setAppsGenerateQuestionOpen] = useState(false);
  const [appsGenerateChoice, setAppsGenerateChoice] = useState<AppGenerateChoice>("dedicated");
  // 기본값을 write로 — 바이브코딩 앱에서 read-only 기본은 첫 "만들어줘"가 파일을 못 써 조용히 실패한다.
  // write는 cwd 파일 편집만 허용(셸·외부 자동호출은 차단)이라 안전한 기본값.
  const [permissions, setPermissions] = useState<PermissionLevel>("write");
  const [permOpen, setPermOpen] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  // / 슬래시 + @ 멘션 인라인 자동완성
  const [trigger, setTrigger] = useState<null | {
    kind: "slash" | "mention";
    query: string;
    /** textarea 내부 trigger 문자 위치 (caret index) */
    startIndex: number;
  }>(null);
  /** 키보드 ↑↓로 선택 가능한 평탄화 인덱스 — Enter 시 이걸로 onPick */
  const [activeIndex, setActiveIndex] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const submitDisabled =
    busy || (!input.trim() && images.length === 0) || disabled;

  // ── 파일 첨부 ──────────────────────────────────────────
  async function addFiles(files: FileList | File[]) {
    const accepted: PreviewedImage[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) continue;
      if (file.size > 5 * 1024 * 1024) {
        alert(t("chatinput.image_too_large", { name: file.name }));
        continue;
      }
      const data = await fileToBase64(file);
      accepted.push({
        mediaType: file.type,
        data,
        dataUrl: `data:${file.type};base64,${data}`,
        name: file.name,
      });
    }
    if (accepted.length > 0) setImages((arr) => [...arr, ...accepted]);
  }

  function removeImage(i: number) {
    setImages((arr) => arr.filter((_, j) => j !== i));
  }

  // ── 입력 변경: / 또는 @ trigger 감지 ────────────────────
  function onInputChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    setInput(next);
    const caret = e.target.selectionStart ?? next.length;
    // 직전 단어 시작 위치 찾기 — 공백/개행으로 끊김
    const before = next.slice(0, caret);
    const lastSpace = Math.max(
      before.lastIndexOf(" "),
      before.lastIndexOf("\n"),
      before.lastIndexOf("\t"),
    );
    const tokenStart = lastSpace + 1;
    const token = before.slice(tokenStart);
    if (token.startsWith("/")) {
      setTrigger({ kind: "slash", query: token.slice(1), startIndex: tokenStart });
    } else if (token.startsWith("@")) {
      setTrigger({ kind: "mention", query: token.slice(1), startIndex: tokenStart });
    } else {
      setTrigger(null);
    }
  }

  // ── 자동완성 옵션 평탄화 — 키보드 네비용 ────────────────
  const autocompleteOptions = useMemo<AutocompleteOption[]>(() => {
    if (!trigger || !context) return [];
    return buildAutocompleteOptions(trigger, context, locale, t);
  }, [trigger, context, locale, t]);

  // trigger가 바뀌거나 query가 갱신되면 activeIndex를 0으로 리셋 — 빈 결과는 -1
  useEffect(() => {
    setActiveIndex(autocompleteOptions.length > 0 ? 0 : -1);
  }, [autocompleteOptions]);

  // fillOnly=true(Tab): 실행/전환 없이 텍스트만 자동완성해 넣는다(절대 전송 안 함).
  // fillOnly=false(Enter): 앱 명령은 실행, @agent/@firm은 에이전트 전환, 그 외는 텍스트 삽입.
  function applyAutocomplete(opt: AutocompleteOption, fillOnly = false) {
    if (!trigger) return;
    const before = input.slice(0, trigger.startIndex);
    const caret = textareaRef.current?.selectionStart ?? input.length;
    const after = input.slice(caret);

    if (!fillOnly) {
      // @agent / @firm 선택 = 그 에이전트 호출(활성 에이전트 전환) — 텍스트는 넣지 않고 토큰 제거.
      if (opt.switchAgentId && onCallAgent) {
        setInput(`${before}${after}`.trimStart());
        setTrigger(null);
        onCallAgent(opt.switchAgentId);
        setTimeout(() => textareaRef.current?.focus(), 0);
        return;
      }
      // 앱 슬래시 명령(/new·/folder·…)은 텍스트로 넣지 않고 액션 실행 — "/..." 토큰 제거.
      if (opt.appAction && onCommand) {
        setInput(`${before}${after}`.trimStart());
        setTrigger(null);
        onCommand(opt.replacement);
        setTimeout(() => textareaRef.current?.focus(), 0);
        return;
      }
    }
    // (fillOnly이거나) 멘션/CLI 슬래시 → 텍스트 삽입. fillOnly는 트레일링 공백 없이 채워 계속 편집 가능.
    const tail = fillOnly ? "" : " ";
    const next = `${before}${opt.replacement}${tail}${after}`;
    setInput(next);
    setTrigger(null);
    setTimeout(() => {
      const pos = `${before}${opt.replacement}${tail}`.length;
      textareaRef.current?.focus();
      textareaRef.current?.setSelectionRange(pos, pos);
    }, 0);
  }

  function submit() {
    if (submitDisabled) return;
    const text = input.trim();
    const attachments =
      images.length > 0 ? images.map(({ mediaType, data }) => ({ mediaType, data })) : undefined;
    onSend(text, {
      images: attachments,
      planMode: planMode || undefined,
      goalMode: goalMode || undefined,
      permissions,
      appsGenerateMode: appsGenerateMode || undefined,
    });
    setInput("");
    setImages([]);
    setTrigger(null);
  }

  function requestAppsGenerateMode(next: boolean) {
    if (!next) {
      setAppsGenerateQuestionOpen(false);
      setAppsGenerateMode(false);
      return;
    }
    setPlusOpen(false);
    setPlusSubmenu(null);
    setPermOpen(false);
    setModelOpen(false);
    setAppsGenerateChoice("dedicated");
    setAppsGenerateQuestionOpen(true);
  }

  function applyAppsGenerateQuestion() {
    setAppsGenerateMode(appsGenerateChoice === "dedicated");
    setAppsGenerateQuestionOpen(false);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  // 클릭 외부 — 메뉴 닫기
  useEffect(() => {
    if (!plusOpen && !permOpen && !modelOpen) return;
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-popover-root]")) {
        setPlusOpen(false);
        setPlusSubmenu(null);
        setPermOpen(false);
        setModelOpen(false);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [plusOpen, permOpen, modelOpen]);

  // ── 플러그인 목록 (설치된 에이전트의 MCP 서버 dedupe) ─────
  const plugins = useMemo(() => {
    const set = new Set<string>();
    for (const a of context?.agents ?? []) for (const m of a.mcpServers) set.add(m);
    return [...set];
  }, [context?.agents]);

  return (
    <footer
      data-popover-root
      className="titlebar-nodrag"
      style={{
        borderTop: "var(--hairline)",
        padding: "10px 16px 14px",
        background: "transparent",
        position: "relative",
      }}
      onDragOver={(e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDrop={(e) => {
        e.preventDefault();
        if (e.dataTransfer.files.length > 0) void addFiles(e.dataTransfer.files);
      }}
    >
      {/* 슬래시/멘션 자동완성 popover */}
      {trigger && context && (
        <AutocompletePopover
          trigger={trigger}
          options={autocompleteOptions}
          activeIndex={activeIndex}
          onHover={setActiveIndex}
          t={t}
          onPick={applyAutocomplete}
        />
      )}

      {/* + 메뉴 popover */}
      {plusOpen && (
        <PlusMenu
          submenu={plusSubmenu}
          setSubmenu={setPlusSubmenu}
          plugins={plugins}
          onAddFile={() => {
            setPlusOpen(false);
            setPlusSubmenu(null);
            fileInputRef.current?.click();
          }}
          planMode={planMode}
          setPlanMode={setPlanMode}
          goalMode={goalMode}
          setGoalMode={setGoalMode}
          appsGenerateMode={appsGenerateMode}
          setAppsGenerateMode={requestAppsGenerateMode}
          t={t}
        />
      )}

      {/* 권한 popover */}
      {permOpen && <PermissionMenu value={permissions} setValue={setPermissions} t={t} />}

      {/* 모델·작업량 popover */}
      {modelOpen && runtime && (
        <ModelMenu
          runtime={runtime}
          options={modelOptions ?? []}
          onSelectModel={(id) => {
            onSelectModel?.(id);
            setModelOpen(false);
          }}
          onSelectEffort={(id) => {
            onSelectEffort?.(id);
            setModelOpen(false);
          }}
          t={t}
        />
      )}

      {appsGenerateQuestionOpen && (
        <BottomQuestionSheet
          progress={t("chatinput.apps_generate_sheet_progress")}
          title={t("chatinput.apps_generate_confirm")}
          options={[
            {
              id: "dedicated",
              title: t("chatinput.apps_generate_sheet_dedicated_title"),
              description: t("chatinput.apps_generate_sheet_dedicated_desc"),
              shortcut: "1",
            },
            {
              id: "chat",
              title: t("chatinput.apps_generate_sheet_chat_title"),
              description: t("chatinput.apps_generate_sheet_chat_desc"),
              shortcut: "2",
            },
          ]}
          value={appsGenerateChoice}
          onChange={setAppsGenerateChoice}
          onClose={() => setAppsGenerateQuestionOpen(false)}
          onSkip={() => {
            setAppsGenerateQuestionOpen(false);
            setAppsGenerateMode(false);
          }}
          onNext={applyAppsGenerateQuestion}
          t={t}
        />
      )}

      <div
        className="glass-lift"
        style={{
          width: "min(100%, 980px)",
          margin: "0 auto",
          borderRadius: 18,
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
        }}
      >
        {/* 이미지 미리보기 */}
        {images.length > 0 && (
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {images.map((img, i) => (
              <div
                key={i}
                style={{
                  position: "relative",
                  width: 56,
                  height: 56,
                  borderRadius: 10,
                  overflow: "hidden",
                  border: "1px solid var(--paper-edge)",
                }}
                title={img.name}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={img.dataUrl}
                  alt={img.name}
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
                <button
                  onClick={() => removeImage(i)}
                  aria-label={t("chatinput.remove_image")}
                  style={{
                    position: "absolute",
                    top: 2,
                    right: 2,
                    width: 18,
                    height: 18,
                    borderRadius: "50%",
                    background: "rgba(0,0,0,0.7)",
                    color: "white",
                    border: "none",
                    fontSize: 10,
                    fontWeight: 700,
                  }}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          style={{ display: "none" }}
          onChange={(e) => {
            if (e.target.files) void addFiles(e.target.files);
            e.target.value = "";
          }}
        />

        {/* 텍스트 영역 */}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={onInputChange}
          onKeyDown={(e) => {
            // 한글 등 IME 조합 중에는 어떤 단축키도 가로채지 않는다 — 조합 중 Enter는 글자 확정,
            // Esc는 조합 취소다. 가로채면 한글 입력 중 조기 전송 / 실행 정지가 오발동한다.
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            // 자동완성 popover가 떠 있을 때 ↑↓/Enter/Tab/Esc 가로챔
            if (trigger && autocompleteOptions.length > 0) {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActiveIndex((i) =>
                  i < 0 ? 0 : (i + 1) % autocompleteOptions.length,
                );
                return;
              }
              if (e.key === "ArrowUp") {
                e.preventDefault();
                setActiveIndex((i) =>
                  i <= 0 ? autocompleteOptions.length - 1 : i - 1,
                );
                return;
              }
              // Tab = 텍스트만 자동완성(실행/전송 안 함). Enter = 선택(앱 명령 실행 / 에이전트 콜 / 텍스트 삽입).
              if (e.key === "Tab") {
                e.preventDefault();
                const opt = autocompleteOptions[activeIndex];
                if (opt) applyAutocomplete(opt, true);
                return;
              }
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                const opt = autocompleteOptions[activeIndex];
                if (opt) applyAutocomplete(opt);
                return;
              }
            }
            // 슬래시/멘션 토큰을 입력 중이면(매칭 0개라도) Enter/Tab으로 메시지를 전송하지 않는다.
            if (trigger && (e.key === "Enter" || e.key === "Tab") && !e.metaKey && !e.ctrlKey) {
              e.preventDefault();
              return;
            }
            if (trigger && e.key === "Escape") {
              setTrigger(null);
              e.preventDefault();
              return;
            }
            if (e.key === "Escape" && (plusOpen || permOpen || modelOpen)) {
              setPlusOpen(false);
              setPermOpen(false);
              setModelOpen(false);
              e.preventDefault();
              return;
            }
            // 실행 중 Cmd/Ctrl+Esc = 정지. 일반 Esc는 입력/IME 취소와 겹쳐 오발동하기 쉽다.
            if (busy && onStop && e.key === "Escape" && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              onStop();
              return;
            }
            // Enter = 즉시 전송, Shift+Enter = 줄바꿈. (자동완성 열림 시는 위에서 선택 처리)
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          onPaste={(e) => {
            const items = e.clipboardData?.items;
            if (!items) return;
            const files: File[] = [];
            for (const it of Array.from(items)) {
              if (it.type.startsWith("image/")) {
                const f = it.getAsFile();
                if (f) files.push(f);
              }
            }
            if (files.length > 0) {
              e.preventDefault();
              void addFiles(files);
            }
          }}
          placeholder={
            disabled
              ? t("chatinput.placeholder_disabled")
              : t("chatinput.placeholder_rich")
          }
          rows={2}
          disabled={disabled}
          style={{
            width: "100%",
            border: "none",
            outline: "none",
            fontSize: 14,
            lineHeight: 1.5,
            background: "transparent",
            color: "var(--ink)",
            resize: "none",
            padding: "4px 6px",
            fontFamily: "var(--font-body)",
          }}
        />

        {/* 하단 툴바 */}
        <div className="chat-input-toolbar">
          <div className="chat-input-tools-left">
            {/* + 메뉴 */}
            <button
              onClick={() => {
                setPlusOpen((v) => !v);
                setPlusSubmenu(null);
              }}
              aria-label={t("chatinput.plus")}
              title={t("chatinput.plus")}
              disabled={disabled}
              style={toolBtnStyle(plusOpen)}
            >
              <IconPlus size={15} />
            </button>

            {/* 슬래시 힌트 */}
            <button
              onClick={() => {
                setInput((s) => `${s}${s.endsWith(" ") || s === "" ? "" : " "}/`);
                setTimeout(() => textareaRef.current?.focus(), 0);
              }}
              aria-label={t("chatinput.slash")}
              title={t("chatinput.slash")}
              disabled={disabled}
              style={toolBtnStyle(false)}
            >
              <span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700 }}>/</span>
            </button>

            {/* @ 멘션 힌트 */}
            <button
              onClick={() => {
                setInput((s) => `${s}${s.endsWith(" ") || s === "" ? "" : " "}@`);
                setTimeout(() => textareaRef.current?.focus(), 0);
              }}
              aria-label={t("chatinput.mention")}
              title={t("chatinput.mention")}
              disabled={disabled}
              style={toolBtnStyle(false)}
            >
              <IconAtSign size={14} />
            </button>

            {/* 권한 칩 */}
            <button
              className="chat-input-chip"
              onClick={() => setPermOpen((v) => !v)}
              disabled={disabled}
              style={{
                ...toolBtnStyle(permOpen),
                width: "auto",
                padding: "0 10px",
                gap: 6,
                fontSize: 11,
                fontWeight: 600,
                color:
                  permissions === "full"
                    ? "var(--red-deep)"
                    : permissions === "write"
                      ? "var(--amber-deep)"
                      : "var(--green-deep)",
              }}
            >
              <IconShield size={13} />
              <span className="chat-input-chip-label">
                {t(`chatinput.perm.${permissions}` as `chatinput.perm.${PermissionLevel}`)}
              </span>
              <IconChevronDown size={11} style={{ opacity: 0.6, flexShrink: 0 }} />
            </button>

            {/* 모델·작업량 칩 — 활성 런타임이 모델 선택 또는 작업량을 지원할 때만 */}
            {runtime &&
              ((modelOptions?.length ?? 0) > 0 || (runtime.efforts?.length ?? 0) > 0) && (
                <button
                  className="chat-input-chip chat-input-model-chip"
                  onClick={() => setModelOpen((v) => !v)}
                  disabled={disabled}
                  title={t("chatinput.model")}
                  style={{
                    ...toolBtnStyle(modelOpen),
                    width: "auto",
                    padding: "0 10px",
                    gap: 6,
                    fontSize: 11,
                    fontWeight: 600,
                    color: "var(--ink-soft)",
                  }}
                >
                  <IconSparkles size={13} style={{ color: "var(--accent)", flexShrink: 0 }} />
                  <span className="chat-input-chip-label">
                    {modelChipLabel(runtime, modelOptions ?? [])}
                  </span>
                  <IconChevronDown size={11} style={{ opacity: 0.6, flexShrink: 0 }} />
                </button>
              )}
          </div>

          <div className="chat-input-tools-right">
            {/* 모드 칩 — Plan */}
            <button
              className="chat-input-chip chat-input-mode-chip"
              onClick={() => setPlanMode((v) => !v)}
              disabled={disabled}
              title={t("chatinput.plan_mode")}
              style={{
                ...toolBtnStyle(planMode),
                width: "auto",
                padding: "0 10px",
                gap: 6,
                fontSize: 11,
                fontWeight: 600,
                color: planMode ? "var(--accent)" : "var(--muted-deep)",
              }}
            >
              <IconRoute size={13} />
              <span className="chat-input-chip-label chat-input-action-label">
                {t("chatinput.plan_mode")}
              </span>
            </button>

            {/* 모드 칩 — Goal */}
            <button
              className="chat-input-chip chat-input-mode-chip"
              onClick={() => setGoalMode((v) => !v)}
              disabled={disabled}
              title={t("chatinput.goal_mode")}
              style={{
                ...toolBtnStyle(goalMode),
                width: "auto",
                padding: "0 10px",
                gap: 6,
                fontSize: 11,
                fontWeight: 600,
                color: goalMode ? "var(--accent)" : "var(--muted-deep)",
              }}
            >
              <IconTarget size={13} />
              <span className="chat-input-chip-label chat-input-action-label">
                {t("chatinput.goal_mode")}
              </span>
            </button>

            {/* 모드 칩 — 전용 App 생성 */}
            <button
              className="chat-input-chip chat-input-mode-chip"
              onClick={() => requestAppsGenerateMode(!appsGenerateMode)}
              disabled={disabled}
              title={t("chatinput.apps_generate_hint")}
              style={{
                ...toolBtnStyle(appsGenerateMode),
                width: "auto",
                padding: "0 10px",
                gap: 6,
                fontSize: 11,
                fontWeight: 600,
                color: appsGenerateMode ? "var(--accent)" : "var(--muted-deep)",
              }}
            >
              <IconApps size={13} />
              <span className="chat-input-chip-label chat-input-action-label">
                {t("chatinput.apps_generate_mode")}
              </span>
            </button>

            {/* 보내기 / 정지 — 실행 중(busy)이고 onStop이 있으면 정지 버튼으로 변신 */}
            {(() => {
              const showStop = busy && !!onStop;
              return (
                <button
                  className="chat-input-send-button"
                  onClick={showStop ? onStop : submit}
                  disabled={showStop ? false : submitDisabled}
                  aria-label={showStop ? t("chat.stop") : t("chatinput.send")}
                  title={showStop ? t("chat.stop") : undefined}
                  style={{
                    width: 32,
                    height: 32,
                    flexShrink: 0,
                    borderRadius: "50%",
                    background: showStop || !submitDisabled ? "var(--paper)" : "var(--paper-2)",
                    color: showStop
                      ? "var(--red-deep)"
                      : submitDisabled
                        ? "var(--muted-deep)"
                        : "var(--ink)",
                    border: "1px solid var(--paper-edge)",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: showStop || !submitDisabled ? "var(--neu-raised)" : "none",
                    cursor: showStop ? "pointer" : undefined,
                  }}
                >
                  {showStop ? (
                    <span
                      style={{
                        width: 10,
                        height: 10,
                        background: "currentColor",
                        borderRadius: 2,
                        display: "inline-block",
                      }}
                      aria-hidden
                    />
                  ) : busy ? (
                    <span className="agentlas-spinner" aria-hidden />
                  ) : (
                    <IconArrowUp size={15} />
                  )}
                </button>
              );
            })()}
          </div>
        </div>
      </div>
    </footer>
  );
}

function BottomQuestionSheet({
  progress,
  title,
  options,
  value,
  onChange,
  onClose,
  onSkip,
  onNext,
  t,
}: {
  progress: string;
  title: string;
  options: BottomQuestionOption[];
  value: AppGenerateChoice;
  onChange: (value: AppGenerateChoice) => void;
  onClose: () => void;
  onSkip: () => void;
  onNext: () => void;
  t: TFunction;
}) {
  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-label={title}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "calc(100% + 8px)",
        width: "calc(100% - 32px)",
        maxWidth: 980,
        margin: "0 auto",
        zIndex: 40,
        borderRadius: 0,
        border: "1px solid var(--paper-edge)",
        background: "#fff",
        boxShadow: "none",
        padding: 12,
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        if (e.key === "Enter") {
          e.preventDefault();
          onNext();
        }
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <span
          style={{
            flexShrink: 0,
            borderRadius: 999,
            background: "var(--fill-1)",
            color: "var(--amber-deep)",
            fontSize: 11,
            fontWeight: 700,
            padding: "2px 7px",
          }}
        >
          {progress}
        </span>
        <h2
          style={{
            margin: 0,
            minWidth: 0,
            flex: 1,
            fontSize: 14,
            lineHeight: 1.35,
            color: "var(--ink)",
            fontWeight: 750,
          }}
        >
          {title}
        </h2>
        <button
          onClick={onClose}
          aria-label={t("workspace.close_panel")}
          title={t("workspace.close_panel")}
          style={{
            width: 24,
            height: 24,
            borderRadius: 6,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            color: "var(--muted-deep)",
            background: "transparent",
            border: "none",
            flexShrink: 0,
          }}
        >
          <IconClose size={13} />
        </button>
      </div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {options.map((option) => {
          const picked = value === option.id;
          return (
            <button
              key={option.id}
              onClick={() => onChange(option.id)}
              style={{
                width: "100%",
                minHeight: 50,
                display: "flex",
                alignItems: "center",
                gap: 10,
                textAlign: "left",
                padding: "9px 10px",
                borderRadius: 8,
                background: picked ? "var(--fill-1)" : "var(--paper-2)",
                border: picked ? "1px solid color-mix(in srgb, var(--accent) 34%, var(--paper-edge))" : "1px solid transparent",
                color: "var(--ink)",
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <strong
                  style={{
                    display: "block",
                    fontSize: 12.5,
                    lineHeight: 1.25,
                    fontWeight: 750,
                    color: "var(--ink)",
                  }}
                >
                  {option.title}
                </strong>
                <span
                  style={{
                    display: "block",
                    marginTop: 2,
                    fontSize: 11.5,
                    lineHeight: 1.35,
                    color: "var(--muted-deep)",
                    overflowWrap: "anywhere",
                  }}
                >
                  {option.description}
                </span>
              </span>
              <span
                aria-hidden
                style={{
                  flexShrink: 0,
                  minWidth: 22,
                  height: 22,
                  borderRadius: 6,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  fontSize: 11,
                  fontWeight: 700,
                  color: picked ? "var(--accent)" : "var(--muted-deep)",
                  background: "var(--paper)",
                  border: "1px solid var(--paper-edge)",
                }}
              >
                {option.shortcut}
              </span>
            </button>
          );
        })}
      </div>

      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 10 }}>
        <button
          onClick={onSkip}
          style={{
            borderRadius: 8,
            border: "1px solid var(--paper-edge)",
            background: "var(--paper)",
            color: "var(--muted-deep)",
            padding: "6px 11px",
            fontSize: 12,
            fontWeight: 650,
          }}
        >
          {t("chatinput.question_skip")}
        </button>
        <button
          onClick={onNext}
          style={{
            borderRadius: 8,
            border: "1px solid color-mix(in srgb, var(--accent) 28%, var(--paper-edge))",
            background: "var(--fill-1)",
            color: "var(--accent)",
            padding: "6px 11px",
            fontSize: 12,
            fontWeight: 750,
          }}
        >
          {t("chatinput.question_next")}
        </button>
      </div>
    </section>
  );
}

// ── 평탄화된 자동완성 옵션 빌더 ──────────────────────────
// 키보드 ↑↓ 인덱스가 그룹 헤더를 건너뛰도록 옵션만 flat list로 모으고,
// 표시 시 group이 바뀔 때만 그룹 헤더를 그린다.
function buildAutocompleteOptions(
  trigger: { kind: "slash" | "mention"; query: string; startIndex: number },
  context: MentionContext,
  locale: "ko" | "en",
  t: TFunction,
): AutocompleteOption[] {
  const q = trigger.query.toLowerCase();
  const out: AutocompleteOption[] = [];

  if (trigger.kind === "slash") {
    // 앱 명령 — 실행(appAction)
    const cmds = [
      { key: "/goal", desc: t("chatinput.cmd.goal"), appAction: false },
      { key: "/new", desc: t("chatinput.cmd.new") },
      { key: "/apps", desc: t("chatinput.cmd.apps") },
      { key: "/folder", desc: t("chatinput.cmd.folder") },
      { key: "/global", desc: t("chatinput.cmd.global") },
      { key: "/rename", desc: t("chatinput.cmd.rename") },
      { key: "/clear", desc: t("chatinput.cmd.clear") },
      { key: "/help", desc: t("chatinput.cmd.help") },
    ].filter((c) => !q || c.key.includes(q) || c.desc.toLowerCase().includes(q));
    for (const c of cmds) {
      out.push({
        key: `cmd-${c.key}`,
        group: t("chatinput.slash.app"),
        kind: "cmd",
        title: c.key,
        subtitle: c.desc,
        replacement: c.key,
        appAction: c.appAction ?? true,
      });
    }
    for (const app of context.apps) {
      const name = appDisplayName(app, locale);
      const tagline = appTagline(app, locale);
      for (const command of appSlashCommands(app)) {
        const haystack = `${command} ${name} ${tagline}`.toLowerCase();
        if (q && !haystack.includes(q)) continue;
        out.push({
          key: `app-${app.id}-${command}`,
          group: t("chatinput.slash.apps"),
          kind: "app",
          title: command,
          subtitle: t("chatinput.app_cmd_hint", { name }),
          replacement: command,
          appAction: false,
        });
      }
    }
    // CLI 슬래시 명령 — 텍스트 삽입(전송 시 CLI가 확장). source별 그룹.
    const srcLabel: Record<RuntimeCommand["source"], string> = {
      "claude-code": "Claude",
      codex: "Codex",
      gemini: "Gemini",
    };
    const cli = (context.commands ?? [])
      .filter((c) => !q || c.name.toLowerCase().includes(q) || c.description.toLowerCase().includes(q))
      .slice(0, 40);
    for (const c of cli) {
      out.push({
        key: `cli-${c.source}-${c.name}`,
        group: srcLabel[c.source],
        kind: "cmd",
        title: c.name,
        subtitle: c.description || undefined,
        replacement: c.name,
        appAction: false,
      });
    }
    return out;
  }

  // mention — 그룹: generated apps → agents → firms → projects → env, 각 최대 5개
  const generatedApps = (context.generatedApps ?? [])
    .filter((app) => {
      const name = generatedAppMentionName(app).toLowerCase();
      return app.status !== "archived" && (!q || name.includes(q) || app.id.toLowerCase().includes(q));
    })
    .slice(0, 5);
  const agents = context.agents
    .filter((a) => {
      const loc = pickLocalized(a, locale);
      return !q || loc.name.toLowerCase().includes(q) || a.slug.includes(q);
    })
    .slice(0, 5);
  const firms = context.firms
    .filter((f) => {
      const loc = pickLocalized(f, locale);
      return !q || loc.name.toLowerCase().includes(q) || f.slug.includes(q);
    })
    .slice(0, 5);
  const projects = context.projects
    .filter((p) => !q || p.name.toLowerCase().includes(q))
    .slice(0, 5);
  const envs = context.envKeys
    .filter((k) => !q || k.toLowerCase().includes(q))
    .slice(0, 5);

  for (const app of generatedApps) {
    const name = generatedAppMentionName(app);
    out.push({
      key: `ga-${app.id}`,
      group: locale === "en" ? "Generated Apps" : "생성된 Apps",
      kind: "app",
      title: name,
      subtitle: locale === "en" ? "Edit or delete with a chat request" : "수정/삭제 요청으로 연결",
      replacement: `@${name}`,
    });
  }
  for (const a of agents) {
    const loc = pickLocalized(a, locale);
    out.push({
      key: `a-${a.id}`,
      group: t("sidebar.agents"),
      kind: "agent",
      title: loc.name,
      subtitle: loc.tagline,
      replacement: `@${loc.name}`,
      switchAgentId: a.id, // @agent = 그 에이전트 호출(활성 에이전트 전환)
    });
  }
  for (const f of firms) {
    const loc = pickLocalized(f, locale);
    out.push({
      key: `f-${f.id}`,
      group: t("sidebar.firms"),
      kind: "firm",
      title: loc.name,
      subtitle: loc.tagline,
      replacement: `@${loc.name}`,
      switchAgentId: f.ceoAgentId, // @firm = 그 회사 CEO 호출
    });
  }
  for (const p of projects) {
    out.push({
      key: `p-${p.id}`,
      group: t("sidebar.projects"),
      kind: "project",
      title: p.name,
      replacement: `@${p.name}`,
    });
  }
  for (const k of envs) {
    out.push({
      key: `e-${k}`,
      group: t("env.title"),
      kind: "env",
      title: k,
      replacement: `@${k}`,
    });
  }
  return out;
}

function generatedAppMentionName(app: AppFactoryAppRecord): string {
  return app.appName || app.manifest.app?.name || app.manifest.title || "Generated App";
}

// ── 자동완성 popover (/ 또는 @) ──────────────────────────
function AutocompletePopover({
  trigger,
  options,
  activeIndex,
  onHover,
  t,
  onPick,
}: {
  trigger: { kind: "slash" | "mention"; query: string; startIndex: number };
  options: AutocompleteOption[];
  activeIndex: number;
  onHover: (i: number) => void;
  t: TFunction;
  onPick: (opt: AutocompleteOption) => void;
}) {
  const title =
    trigger.kind === "slash" ? t("chatinput.slash_title") : t("chatinput.mention_title");
  if (options.length === 0) {
    return (
      <Popover title={title}>
        <EmptyHint>{t("chatinput.no_match")}</EmptyHint>
      </Popover>
    );
  }
  // 그룹 헤더는 같은 group이 처음 등장할 때만 그린다.
  const seenGroups = new Set<string>();
  return (
    <Popover title={title}>
      {options.map((opt, i) => {
        const showHeader = opt.group && !seenGroups.has(opt.group);
        if (opt.group) seenGroups.add(opt.group);
        return (
          <div key={opt.key}>
            {showHeader && <GroupLabel>{opt.group}</GroupLabel>}
            <Row
              onClick={() => onPick(opt)}
              onHover={() => onHover(i)}
              active={i === activeIndex}
              icon={kindIcon(opt.kind)}
              title={opt.title}
              subtitle={opt.subtitle}
            />
          </div>
        );
      })}
    </Popover>
  );
}

function kindIcon(kind: AutocompleteOption["kind"]) {
  switch (kind) {
    case "cmd":
      return (
        <span style={{ fontFamily: "var(--font-mono)", fontWeight: 700, fontSize: 11 }}>/</span>
      );
    case "app":
      return <IconApps size={13} style={{ color: "var(--accent)" }} />;
    case "agent":
      return <IconSparkles size={13} style={{ color: "var(--accent)" }} />;
    case "firm":
      return <IconBuilding size={13} style={{ color: "var(--accent)" }} />;
    case "project":
      return <IconFolder size={13} style={{ color: "var(--muted-deep)" }} />;
    case "env":
      return <IconKey size={13} style={{ color: "var(--peach-ink)" }} />;
  }
}

// ── + 메뉴 ───────────────────────────────────────────────
function PlusMenu({
  submenu,
  setSubmenu,
  plugins,
  onAddFile,
  planMode,
  setPlanMode,
  goalMode,
  setGoalMode,
  appsGenerateMode,
  setAppsGenerateMode,
  t,
}: {
  submenu: "plugins" | null;
  setSubmenu: (s: "plugins" | null) => void;
  plugins: string[];
  onAddFile: () => void;
  planMode: boolean;
  setPlanMode: (v: boolean) => void;
  goalMode: boolean;
  setGoalMode: (v: boolean) => void;
  appsGenerateMode: boolean;
  setAppsGenerateMode: (v: boolean) => void;
  t: TFunction;
}) {
  if (submenu === "plugins") {
    return (
      <Popover>
        <button
          onClick={() => setSubmenu(null)}
          style={{
            display: "flex",
            width: "100%",
            alignItems: "center",
            gap: 6,
            padding: "6px 10px",
            fontSize: 11,
            color: "var(--muted-deep)",
            background: "transparent",
            border: "none",
          }}
        >
          <IconChevronRight size={11} style={{ transform: "rotate(180deg)" }} />
          {t("chatinput.plus.plugins")}
        </button>
        {plugins.length === 0 ? (
          <EmptyHint>{t("chatinput.no_plugins")}</EmptyHint>
        ) : (
          plugins.map((p) => (
            <Row
              key={p}
              icon={<IconLayers size={13} style={{ color: "var(--accent)" }} />}
              title={p}
            />
          ))
        )}
      </Popover>
    );
  }
  return (
    <Popover>
      <Row
        onClick={onAddFile}
        icon={<IconFileUp size={14} />}
        title={t("chatinput.plus.attach")}
      />
      <Row
        onClick={() => setSubmenu("plugins")}
        icon={<IconLayers size={14} style={{ color: "var(--accent)" }} />}
        title={t("chatinput.plus.plugins")}
        right={<IconChevronRight size={11} style={{ color: "var(--muted)" }} />}
      />
      <Divider />
      <ToggleRow
        icon={<IconRoute size={14} />}
        title={t("chatinput.plan_mode")}
        on={planMode}
        onChange={setPlanMode}
      />
      <ToggleRow
        icon={<IconTarget size={14} />}
        title={t("chatinput.goal_mode")}
        on={goalMode}
        onChange={setGoalMode}
      />
      <ToggleRow
        icon={<IconApps size={14} />}
        title={t("chatinput.apps_generate_mode")}
        subtitle={t("chatinput.apps_generate_hint")}
        on={appsGenerateMode}
        onChange={setAppsGenerateMode}
      />
    </Popover>
  );
}

// ── 권한 메뉴 ─────────────────────────────────────────────
function PermissionMenu({
  value,
  setValue,
  t,
}: {
  value: PermissionLevel;
  setValue: (v: PermissionLevel) => void;
  t: TFunction;
}) {
  const opts: Array<{ id: PermissionLevel; color: string }> = [
    { id: "read", color: "var(--green-deep)" },
    { id: "write", color: "var(--amber-deep)" },
    { id: "full", color: "var(--red-deep)" },
  ];
  return (
    <Popover title={t("chatinput.perm.title")}>
      {opts.map((o) => (
        <Row
          key={o.id}
          onClick={() => setValue(o.id)}
          icon={<IconShield size={13} style={{ color: o.color }} />}
          title={t(`chatinput.perm.${o.id}` as `chatinput.perm.${PermissionLevel}`)}
          subtitle={t(`chatinput.perm.${o.id}.desc` as `chatinput.perm.${PermissionLevel}.desc`)}
          right={value === o.id ? <span style={{ color: "var(--accent)", fontWeight: 700 }}>•</span> : undefined}
        />
      ))}
    </Popover>
  );
}

// ── 모델·작업량 메뉴 ──────────────────────────────────────
// Image #2의 Claude Code 모델 메뉴를 입력창 안에 재현: 모델 목록 + 작업량.
// 목록은 실시간(runtime.listModels / runtime.efforts)이라 CLI가 업데이트되면 자동 반영.
function ModelMenu({
  runtime,
  options,
  onSelectModel,
  onSelectEffort,
  t,
}: {
  runtime: RuntimeStatus;
  options: ModelOption[];
  onSelectModel: (id: string) => void;
  onSelectEffort: (id: string) => void;
  t: TFunction;
}) {
  const efforts = runtime.efforts ?? [];
  // CLI(claude-code/codex/gemini)는 "구독 기본" 선택 가능. BYOK/Ollama는 항상 구체 모델.
  const allowDefaultModel = runtime.kind !== "byok" && runtime.kind !== "ollama";
  const managedByRuntime = CONTEXT_MANAGED_BY[runtime.kind] === "runtime";
  const check = <span style={{ color: "var(--accent)", fontWeight: 700 }}>•</span>;
  const modelIcon = <IconSparkles size={13} style={{ color: "var(--accent)" }} />;
  const effortIcon = <IconRoute size={13} style={{ color: "var(--muted-deep)" }} />;

  return (
    <Popover title={t("chatinput.model")}>
      {allowDefaultModel && (
        <Row
          onClick={() => onSelectModel("")}
          icon={modelIcon}
          title={t("chat.model.cli_default")}
          right={!runtime.model ? check : undefined}
        />
      )}
      {options.map((o) => (
        <Row
          key={o.id}
          onClick={() => onSelectModel(o.id)}
          icon={modelIcon}
          title={o.label}
          subtitle={o.tag}
          right={runtime.model === o.id ? check : undefined}
        />
      ))}
      {efforts.length > 0 && (
        <>
          <Divider />
          <GroupLabel>{t("chatinput.effort")}</GroupLabel>
          <Row
            onClick={() => onSelectEffort("")}
            icon={effortIcon}
            title={t("chat.model.cli_default")}
            right={!runtime.effort ? check : undefined}
          />
          {efforts.map((e) => (
            <Row
              key={e.id}
              onClick={() => onSelectEffort(e.id)}
              icon={effortIcon}
              title={e.label}
              right={runtime.effort === e.id ? check : undefined}
            />
          ))}
        </>
      )}
      <Divider />
      <div style={{ padding: "6px 10px", fontSize: 10.5, color: "var(--muted-deep)", lineHeight: 1.5 }}>
        {managedByRuntime
          ? t("settings.runtime.managed_runtime")
          : t("settings.runtime.managed_agentlas")}
      </div>
    </Popover>
  );
}

// ── popover primitives ──────────────────────────────────
function Popover({
  title,
  children,
}: {
  title?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      data-popover-root
      className="glass-lift"
      style={{
        position: "absolute",
        bottom: "calc(100% - 4px)",
        left: 16,
        minWidth: 240,
        maxWidth: 320,
        maxHeight: 360,
        overflowY: "auto",
        borderRadius: 14,
        padding: 6,
        zIndex: 100,
      }}
    >
      {title && (
        <div
          style={{
            padding: "6px 10px 4px",
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 0.6,
            color: "var(--muted-deep)",
          }}
        >
          {title}
        </div>
      )}
      {children}
    </div>
  );
}

function GroupLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        padding: "6px 10px 2px",
        fontSize: 10,
        fontFamily: "var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: 0.6,
        color: "var(--muted-deep)",
      }}
    >
      {children}
    </div>
  );
}

function Divider() {
  return (
    <div
      style={{
        height: 1,
        background: "var(--paper-edge)",
        margin: "4px 6px",
      }}
    />
  );
}

function EmptyHint({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "10px 12px", fontSize: 11, color: "var(--muted-deep)" }}>
      {children}
    </div>
  );
}

function Row({
  onClick,
  onHover,
  active,
  icon,
  title,
  subtitle,
  right,
}: {
  onClick?: () => void;
  /** 마우스가 위로 올라오면 호출 — 키보드 activeIndex와 마우스 활성을 동기화 */
  onHover?: () => void;
  /** 키보드 ↑↓로 선택된 행이면 true */
  active?: boolean;
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  right?: React.ReactNode;
}) {
  // active일 때는 hover 색을 항상 표시 — inline 토글이라 ref로 보존하지 않음
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      style={{
        display: "flex",
        width: "100%",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: 8,
        background: active ? "var(--fill-1)" : "transparent",
        border: "none",
        textAlign: "left",
        cursor: onClick ? "pointer" : "default",
      }}
      onMouseEnter={(e) => {
        if (onClick) e.currentTarget.style.background = "var(--fill-1)";
        onHover?.();
      }}
      onMouseLeave={(e) => {
        // active면 hover 색을 유지
        e.currentTarget.style.background = active ? "var(--fill-1)" : "transparent";
      }}
    >
      <span style={{ flexShrink: 0, color: "var(--ink-soft)" }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 12.5,
            fontWeight: 600,
            color: "var(--ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
        >
          {title}
        </span>
        {subtitle && (
          <span
            style={{
              display: "block",
              fontSize: 10.5,
              color: "var(--muted-deep)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {subtitle}
          </span>
        )}
      </span>
      {right}
    </button>
  );
}

function ToggleRow({
  icon,
  title,
  subtitle,
  on,
  onChange,
}: {
  icon: React.ReactNode;
  title: string;
  subtitle?: string;
  on: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <button
      onClick={() => onChange(!on)}
      style={{
        display: "flex",
        width: "100%",
        alignItems: "center",
        gap: 10,
        padding: "8px 10px",
        borderRadius: 8,
        background: "transparent",
        border: "none",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--fill-1)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      <span style={{ flexShrink: 0, color: on ? "var(--accent)" : "var(--ink-soft)" }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0, textAlign: "left" }}>
        <span style={{ display: "block", fontSize: 12.5, fontWeight: 600, color: "var(--ink)" }}>
          {title}
        </span>
        {subtitle && (
          <span style={{ display: "block", marginTop: 2, fontSize: 11, lineHeight: 1.35, color: "var(--muted-deep)" }}>
            {subtitle}
          </span>
        )}
      </span>
      <span
        style={{
          width: 30,
          height: 17,
          borderRadius: 999,
          background: on ? "var(--accent)" : "var(--paper-edge)",
          position: "relative",
          transition: "background 0.12s",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 2,
            left: on ? 15 : 2,
            width: 13,
            height: 13,
            borderRadius: "50%",
            background: "white",
            transition: "left 0.12s",
            boxShadow: "0 1px 2px rgba(0,0,0,0.15)",
          }}
        />
      </span>
    </button>
  );
}

// 도구 버튼 공통 스타일
function toolBtnStyle(active: boolean): React.CSSProperties {
  return {
    width: 30,
    height: 30,
    flexShrink: 0,
    borderRadius: 8,
    background: active ? "var(--fill-1)" : "transparent",
    color: active ? "var(--accent)" : "var(--ink-soft)",
    border: "none",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    transition: "background 0.12s",
    cursor: "pointer",
  };
}

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      const comma = result.indexOf(",");
      resolve(comma >= 0 ? result.slice(comma + 1) : result);
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}
