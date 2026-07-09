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
import type { Recommendation, RecExecChoice } from "@shared/types";
import type { AgentlasAppDefinition } from "@/lib/apps";
import { appDisplayName, appSlashCommands, appTagline } from "@/lib/apps";
import { pickLocalized, useT, type Locale } from "@/lib/i18n";

type ModelOption = { id: string; label: string; tag?: string };

const CLI_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Antigravity",
  grok: "Grok",
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
  IconUsers,
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
// 챗 입력바 모드 토글 — 에이전트 찾기(추천 미리보기) + Stormbreaker(견고-실행 루프).
// 단일선택이 아니라 다중선택이며, 전송해도 꺼지지 않고 계속 켜둘 수 있다.
// /hep-network 직접 입력은 여전히 허브 라우팅으로 동작하지만, 하단에서는 추천/네트워크 선택을 한 흐름으로 묶는다.
// recommend 는 프리픽스가 아니라 전송 동작을 바꾼다(실행 전에 추천 시트를 띄움). composeHepPrefix 는 무시한다.
type HepToggleId = "network" | "stormbreaker" | "recommend";

const HEP_TOGGLES: Array<{
  id: HepToggleId;
  labelKo: string;
  labelEn: string;
  titleKo: string;
  titleEn: string;
}> = [
  {
    id: "recommend",
    labelKo: "알아서 에이전트 부르기",
    labelEn: "Find agent",
    titleKo: "요청에 맞는 에이전트·네트워크 TF·예상 비용을 먼저 확인하고 호출",
    titleEn: "Find the right agent, network TF, and estimated credits first",
  },
  {
    id: "stormbreaker",
    labelKo: "Stormbreaker",
    labelEn: "Stormbreaker",
    titleKo: "Stormbreaker 견고-실행: 검증·복구 루프로 끝까지 (계속 켜둘 수 있음)",
    titleEn: "Stormbreaker robust run: verify/repair loop to completion (stays on)",
  },
];

// Stormbreaker 워닝 버블 — 토글을 OFF→ON 할 때 1회만. per-device 선호라 localStorage(설정 스토어 아님).
const STORM_WARNING_DISMISSED_KEY = "agentlas.stormbreaker.warning.dismissed";
function isStormWarningDismissed(): boolean {
  try {
    return typeof window !== "undefined" && window.localStorage.getItem(STORM_WARNING_DISMISSED_KEY) === "1";
  } catch {
    return false;
  }
}
function dismissStormWarning() {
  try {
    window.localStorage.setItem(STORM_WARNING_DISMISSED_KEY, "1");
  } catch {
    // ignore
  }
}

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
  onRecommendPreview,
  onRecommendExecute,
  onStop,
  busy,
  disabled,
  context,
  runtime,
  modelOptions,
  onSelectModel,
  onSelectEffort,
  tokensUsage,
  activeAgentId,
  stopRequested = false,
  showModeToggles = false,
  continuousMode = false,
  swarmMode = false,
  onToggleContinuous,
  onToggleSwarm,
  queuedCount = 0,
  prefillText = null,
  activeChatId = null,
}: {
  onSend: (text: string, opts?: SendOptions) => void;
  /** 슬래시 커맨드(/new, /clear, /help …) 실행 — 텍스트 삽입이 아니라 액션 */
  onCommand?: (cmd: string) => void;
  /** @멘션으로 에이전트/회사를 고르면 그 에이전트를 호출(활성 에이전트 전환). */
  onCallAgent?: (agentId: string) => void;
  /** 추천 토글 ON 시 보내기 전에 라우터 미리보기를 요청 — 정규화된 추천을 반환(없으면 null). */
  onRecommendPreview?: (text: string) => Promise<Recommendation | null>;
  /** 추천 시트에서 고른 실행 경로를 디스패치(에이전트 전환/네트워크/파이프라인/그냥보내기). */
  onRecommendExecute?: (choice: RecExecChoice, text: string, opts: SendOptions) => void;
  /** 진행 중 실행 취소 — 제공되면 busy일 때 전송 버튼이 정지 버튼으로 변신(Esc도 정지). */
  onStop?: () => void;
  /** 상단/멘션에서 명시적으로 선택된 현재 에이전트. 바뀌면 자동추천 라우팅을 끈다. */
  activeAgentId?: string | null;
  /** 정지 요청이 이미 눌린 상태 — 중복 클릭과 불확실한 UI를 막는다. */
  stopRequested?: boolean;
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
  /** 컨텍스트 사용량 표시용 */
  tokensUsage?: { current: number; limit: number };
  /** 실행 모드 토글 노출 여부(division 챗은 숨김). + 메뉴에 "계속 라이브로"·"스웜"을 넣는다. */
  showModeToggles?: boolean;
  /** 계속 라이브로(continuousMode) 현재 상태 + 토글. */
  continuousMode?: boolean;
  onToggleContinuous?: () => void;
  /** 스웜(swarmMode) 현재 상태 + 토글. */
  swarmMode?: boolean;
  onToggleSwarm?: () => void;
  /** 실행 중 steering 큐에 대기 중인 메시지 수 — 0보다 크면 "대기 중" 표시. */
  queuedCount?: number;
  /** 외부 프리필(프롬프트 저장소 seedOnly) — 입력창이 비었을 때 1회 주입, 전송은 사용자가. */
  prefillText?: string | null;
  /** 현재 채팅 id — 바뀌면 세션 전용 실행 상태(추천 시트·모드 토글)를 리셋해 세션 간 누수 방지. */
  activeChatId?: string | null;
}) {
  const { t, locale } = useT();
  const [input, setInput] = useState("");
  const [images, setImages] = useState<PreviewedImage[]>([]);
  const [plusOpen, setPlusOpen] = useState(false);

  // 외부 프리필 — 입력창이 비어있을 때만 채운다(입력 중 내용 덮어쓰기 금지).
  useEffect(() => {
    if (prefillText && prefillText.trim() && !input.trim()) {
      setInput(prefillText);
    }
    // input을 deps에 넣지 않는다 — 프리필 값이 바뀔 때만 1회 시도.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prefillText]);
  const [plusSubmenu, setPlusSubmenu] = useState<"plugins" | null>(null);
  const [planMode, setPlanMode] = useState(false);
  const [goalMode, setGoalMode] = useState(false);
  // 다중선택·지속 모드 토글(에이전트 찾기/Stormbreaker). 전송해도 유지된다.
  const [hepToggles, setHepToggles] = useState<Set<HepToggleId>>(() => new Set());
  // Stormbreaker를 처음 켤 때 뜨는 비용/시간 경고 버블. dismiss하면 다시 안 뜸.
  const [showStormWarning, setShowStormWarning] = useState(false);
  // 추천 토글 ON 시 보내기 전에 뜨는 추천 바텀시트. 픽 시 onRecommendExecute로 실제 실행.
  const [recSheet, setRecSheet] = useState<null | {
    loading: boolean;
    preview: Recommendation | null;
    text: string;
    opts: SendOptions;
  }>(null);
  const [appsGenerateMode, setAppsGenerateMode] = useState(false);
  const [appsGenerateQuestionOpen, setAppsGenerateQuestionOpen] = useState(false);
  const [agentPickerOpen, setAgentPickerOpen] = useState(false);
  const [selectedAgentIds, setSelectedAgentIds] = useState<Set<string>>(new Set());
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
  const lastActiveAgentIdRef = useRef<string | null | undefined>(undefined);
  const autocompleteSignatureRef = useRef<string>("");

  // 세션 격리 — 채팅을 바꾸면 이전 세션의 실행 의도 상태(추천 시트·모드 토글·선택)를 버린다.
  // ChatInput은 채팅별로 remount되지 않아서, 이게 없으면 A에서 연 추천 바텀시트가 B로 넘어가
  // "쓰기"를 누르면 B(지금 세션)로 엉뚱하게 에이전트가 콜된다. (드래프트 텍스트는 유지.)
  const lastChatIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (lastChatIdRef.current === null) {
      lastChatIdRef.current = activeChatId;
      return;
    }
    if (lastChatIdRef.current === activeChatId) return;
    lastChatIdRef.current = activeChatId;
    setRecSheet(null);
    setHepToggles(new Set());
    setPlanMode(false);
    setGoalMode(false);
    setAppsGenerateMode(false);
    setAppsGenerateQuestionOpen(false);
    setAgentPickerOpen(false);
    setSelectedAgentIds(new Set());
    setTrigger(null);
  }, [activeChatId]);

  // 입력 내용에 따라 textarea 높이를 늘린다(auto-grow) — 최대치까지 자라고 그 뒤엔 내부 스크롤.
  // 전송 후 비우기·자동완성 삽입 같은 프로그램적 변경도 input 값 변화로 함께 반영된다.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 150)}px`;
  }, [input]);

  // busy는 제외 — 실행 중에도 엔터로 메시지를 보낼 수 있게(steering). 부모가 busy면 큐에 쌓아
  // 현재 턴이 끝나면 순서대로 전송한다. (실행 중 전송 버튼 자체는 여전히 정지 버튼으로 변신.)
  const submitDisabled =
    (!input.trim() && images.length === 0) || disabled;
  // 활성 토글을 Hephaestus 지시 프리픽스로 합성. Network=허브 라우팅, Stormbreaker=견고-실행(--stormbreaker).
  // Network 칩은 하단에서 숨겼지만 /hep-network 직접 실행 및 내부 선택 경로를 위해 동작은 유지한다.
  function composeHepPrefix(text: string): string {
    const net = hepToggles.has("network");
    const storm = hepToggles.has("stormbreaker");
    const body = text ? ` ${text}` : "";
    if (net && storm) return `hep-network --stormbreaker${body}`;
    if (net) return `hep-network${body}`;
    if (storm) return `stormbreaker${body}`;
    return text;
  }
  const hepHint = [...hepToggles]
    .map((id) => {
      const toggle = HEP_TOGGLES.find((t) => t.id === id);
      return toggle ? (locale === "ko" ? toggle.labelKo : toggle.labelEn) : null;
    })
    .filter(Boolean)
    .join(" + ");
  const contextManagedByRuntime = runtime ? CONTEXT_MANAGED_BY[runtime.kind] === "runtime" : true;
  const contextPercent = tokensUsage
    ? Math.min(100, Math.max(0, Math.round((tokensUsage.current / Math.max(1, tokensUsage.limit)) * 100)))
    : 0;
  const contextOwnerLabel = contextManagedByRuntime
    ? t("chatinput.context.runtime_short")
    : t("chatinput.context.agentlas_short");
  const contextOwnerDescription = contextManagedByRuntime
    ? t("chatinput.context.runtime_desc")
    : t("chatinput.context.agentlas_desc");

  // ── 파일 첨부 ──────────────────────────────────────────
  async function addFiles(files: FileList | File[]) {
    const accepted: PreviewedImage[] = [];
    const rejected: string[] = [];
    for (const file of Array.from(files)) {
      if (!file.type.startsWith("image/")) {
        rejected.push(file.name);
        continue;
      }
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
    if (rejected.length > 0) {
      alert(
        locale === "ko"
          ? `이미지 파일만 첨부할 수 있습니다: ${rejected.join(", ")}`
          : `Only image files can be attached here: ${rejected.join(", ")}`,
      );
    }
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

  const autocompleteOptionKey = useMemo(
    () => autocompleteOptions.map((opt) => opt.key).join("\u001f"),
    [autocompleteOptions],
  );
  const autocompleteSignature = `${trigger?.kind ?? "none"}\u001f${trigger?.startIndex ?? -1}\u001f${trigger?.query ?? ""}\u001f${autocompleteOptionKey}`;

  // trigger/query/결과 목록이 실제로 바뀔 때만 activeIndex를 보정한다.
  // context 객체는 부모 렌더마다 새로 만들어질 수 있으므로 배열 identity에 의존하면
  // 키보드/마우스 선택이 매 렌더 0번으로 튀어 오른다.
  useEffect(() => {
    const changed = autocompleteSignatureRef.current !== autocompleteSignature;
    autocompleteSignatureRef.current = autocompleteSignature;
    setActiveIndex((current) => {
      if (autocompleteOptions.length === 0) return -1;
      if (changed) return 0;
      if (current < 0 || current >= autocompleteOptions.length) return 0;
      return current;
    });
  }, [autocompleteSignature, autocompleteOptions.length]);

  useEffect(() => {
    const previous = lastActiveAgentIdRef.current;
    lastActiveAgentIdRef.current = activeAgentId;
    if (!previous || !activeAgentId || previous === activeAgentId) return;
    setRecSheet(null);
    setHepToggles((prev) => {
      if (!prev.has("recommend")) return prev;
      const next = new Set(prev);
      next.delete("recommend");
      return next;
    });
  }, [activeAgentId]);

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
        setRecSheet(null);
        setHepToggles((prev) => {
          const next = new Set(prev);
          next.delete("recommend");
          return next;
        });
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

  function selectedAutocompleteOption(): AutocompleteOption | undefined {
    return autocompleteOptions[activeIndex] ?? autocompleteOptions[0];
  }

  /** 현재 첨부/모드 상태로 SendOptions 를 합성. */
  function currentSendOptions(): SendOptions {
    const attachments =
      images.length > 0 ? images.map(({ mediaType, data, name }) => ({ mediaType, data, name })) : undefined;
    return {
      images: attachments,
      planMode: planMode || undefined,
      goalMode: goalMode || undefined,
      permissions,
      appsGenerateMode: appsGenerateMode || undefined,
    };
  }

  function submit() {
    if (submitDisabled) return;
    const text = input.trim();
    // 추천 토글 ON → 즉시 전송 대신 추천 미리보기 시트. 텍스트/첨부는 시트가 들고 있다가 픽 시 실행한다.
    if (hepToggles.has("recommend") && text && onRecommendPreview) {
      void openRecSheet(text);
      return;
    }
    const outgoingText = composeHepPrefix(text);
    onSend(outgoingText, currentSendOptions());
    setInput("");
    setImages([]);
    // 모드 토글(에이전트 찾기/Stormbreaker)은 리셋하지 않는다 — 계속 켜둘 수 있음.
    setTrigger(null);
  }

  // ── 추천 바텀시트 흐름 ─────────────────────────────────
  async function openRecSheet(text: string) {
    if (!onRecommendPreview) return;
    const opts = currentSendOptions();
    setRecSheet({ loading: true, preview: null, text, opts });
    const preview = await onRecommendPreview(text).catch(() => null);
    // 사용자가 그새 취소했으면(또는 다른 텍스트로 다시 열었으면) 무시.
    setRecSheet((cur) => (cur && cur.text === text ? { ...cur, loading: false, preview } : cur));
  }

  function pickRec(choice: RecExecChoice) {
    const cur = recSheet;
    if (!cur) return;
    onRecommendExecute?.(choice, cur.text, cur.opts);
    setHepToggles((prev) => {
      const next = new Set(prev);
      next.delete("recommend");
      return next;
    });
    setRecSheet(null);
    setInput("");
    setImages([]);
    setTrigger(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function cancelRec() {
    // 텍스트는 입력창에 그대로 둔다 — 사용자가 다시 보내거나 추천 토글을 끌 수 있음.
    setRecSheet(null);
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function retryRec() {
    const cur = recSheet;
    if (!cur) return;
    void openRecSheet(cur.text);
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
    if (!plusOpen && !permOpen && !modelOpen && !agentPickerOpen) return;
    function onDown(e: MouseEvent) {
      const target = e.target as HTMLElement;
      if (!target.closest("[data-popover-root]")) {
        setPlusOpen(false);
        setPlusSubmenu(null);
        setPermOpen(false);
        setModelOpen(false);
        setAgentPickerOpen(false);
        setSelectedAgentIds(new Set());
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [plusOpen, permOpen, modelOpen, agentPickerOpen]);

  // ── 플러그인 목록 (설치된 에이전트의 MCP 서버 dedupe) ─────
  const plugins = useMemo(() => {
    const set = new Set<string>();
    for (const a of context?.agents ?? []) for (const m of a.mcpServers) set.add(m);
    return [...set];
  }, [context?.agents]);

  return (
    <footer
      data-popover-root
      className="titlebar-nodrag chat-input-footer"
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
          onToggleAppsGenerate={requestAppsGenerateMode}
          onInsertSlash={() => {
            setInput((s) => `${s}${s.endsWith(" ") || s === "" ? "" : " "}/`);
            setPlusOpen(false);
            setPlusSubmenu(null);
            setTimeout(() => textareaRef.current?.focus(), 0);
          }}
          onInsertMention={() => {
            setInput((s) => `${s}${s.endsWith(" ") || s === "" ? "" : " "}@`);
            setPlusOpen(false);
            setPlusSubmenu(null);
            setTimeout(() => textareaRef.current?.focus(), 0);
          }}
          hepToggles={hepToggles}
          onToggleHep={(id) => {
            // Stormbreaker OFF→ON 전환 감지 — 첫 활성화 시 비용/시간 경고 버블.
            const turningStormOn = id === "stormbreaker" && !hepToggles.has("stormbreaker");
            setHepToggles((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
            if (id === "stormbreaker") {
              setShowStormWarning(turningStormOn && !isStormWarningDismissed());
            }
            setTimeout(() => textareaRef.current?.focus(), 0);
          }}
          locale={locale}
          onOpenAgentPicker={() => {
            setPlusOpen(false);
            setPlusSubmenu(null);
            setAgentPickerOpen(true);
          }}
          showModeToggles={showModeToggles}
          continuousMode={continuousMode}
          swarmMode={swarmMode}
          onToggleContinuous={() => {
            onToggleContinuous?.();
            setTimeout(() => textareaRef.current?.focus(), 0);
          }}
          onToggleSwarm={() => {
            onToggleSwarm?.();
            setTimeout(() => textareaRef.current?.focus(), 0);
          }}
          t={t}
        />
      )}

      {/* 에이전트 선택 팝업 */}
      {agentPickerOpen && context && (
        <AgentPickerPopup
          agents={context.agents}
          firms={context.firms}
          selected={selectedAgentIds}
          onToggle={(id) => {
            setSelectedAgentIds((prev) => {
              const next = new Set(prev);
              if (next.has(id)) next.delete(id);
              else next.add(id);
              return next;
            });
          }}
          onConfirm={() => {
            // 선택된 에이전트들을 호출
            setHepToggles((prev) => {
              const next = new Set(prev);
              next.delete("recommend");
              return next;
            });
            for (const id of selectedAgentIds) {
              onCallAgent?.(id);
            }
            setAgentPickerOpen(false);
            setSelectedAgentIds(new Set());
          }}
          onClose={() => {
            setAgentPickerOpen(false);
            setSelectedAgentIds(new Set());
          }}
          t={t}
          locale={locale}
        />
      )}

      {/* 권한 popover */}
      {permOpen && (
        <PermissionMenu
          value={permissions}
          setValue={(value) => {
            setPermissions(value);
            setPermOpen(false);
            setTimeout(() => textareaRef.current?.focus(), 0);
          }}
          t={t}
        />
      )}

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

      {/* Stormbreaker 비용/시간 경고 버블 — 첫 활성화 시 1회 */}
      {showStormWarning && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: "absolute",
            left: 16,
            bottom: "calc(100% + 8px)",
            zIndex: 45,
            maxWidth: 360,
            display: "flex",
            flexDirection: "column",
            gap: 8,
            border: "1px solid var(--paper-edge)",
            background: "#fff",
            padding: 12,
          }}
        >
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ flexShrink: 0, color: "var(--amber-deep)", display: "inline-flex" }} aria-hidden>
              <IconSparkles size={14} />
            </span>
            <strong style={{ fontSize: 12.5, fontWeight: 700 }}>{t("chatinput.storm_warning.title")}</strong>
          </div>
          <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: "var(--ink-soft)" }}>
            {t("chatinput.storm_warning.body")}
          </p>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={() => {
                dismissStormWarning();
                setShowStormWarning(false);
                setTimeout(() => textareaRef.current?.focus(), 0);
              }}
              style={{
                fontSize: 12,
                fontWeight: 600,
                padding: "4px 12px",
                border: "1px solid var(--paper-edge)",
                background: "var(--fill-1)",
                color: "inherit",
                cursor: "pointer",
              }}
            >
              {t("chatinput.storm_warning.ok")}
            </button>
          </div>
        </div>
      )}

      {/* 추천 바텀시트 — 추천 토글 ON 으로 보낼 때 라우터 미리보기 결과 */}
      {recSheet && (
        <RecommendationSheet
          loading={recSheet.loading}
          preview={recSheet.preview}
          onPick={pickRec}
          onCancel={cancelRec}
          onRetry={retryRec}
          t={t}
          locale={locale}
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
        className="glass-lift chat-input-shell"
        style={{
          width: "min(100%, 980px)",
          margin: "0 auto",
          borderRadius: 18,
          padding: "10px 12px",
          display: "flex",
          flexDirection: "column",
          gap: 8,
          background: "var(--paper)",
          backdropFilter: "none",
          WebkitBackdropFilter: "none",
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
                const opt = selectedAutocompleteOption();
                if (opt) applyAutocomplete(opt, true);
                return;
              }
              if (e.key === "Enter" && !e.metaKey && !e.ctrlKey) {
                e.preventDefault();
                const opt = selectedAutocompleteOption();
                if (opt) applyAutocomplete(opt);
                return;
              }
            }
            // 매칭 후보가 없으면 Enter는 사용자가 쓴 텍스트 그대로 전송한다. Tab만 포커스 이탈 방지.
            if (trigger && e.key === "Tab" && !e.metaKey && !e.ctrlKey) {
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
              : hepHint
                ? `${hepHint} · ${locale === "ko" ? "요청을 입력하세요" : "describe the request"}`
              : t("chatinput.placeholder_rich")
          }
          rows={1}
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
            minHeight: 46,
            maxHeight: 150,
            overflowY: "auto",
            boxSizing: "border-box",
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

            {/* 켜진 모드 칩 — 평소엔 + 메뉴에 있고, 활성일 때만 바에 표시(가시성 + 눌러서 끄기). */}
            {HEP_TOGGLES.some((tg) => hepToggles.has(tg.id)) && (
              <div className="chat-input-hep-toggle-group" role="group" aria-label="Active modes">
                {HEP_TOGGLES.filter((tg) => hepToggles.has(tg.id)).map((tg) => (
                  <button
                    key={tg.id}
                    type="button"
                    className="chat-input-hep-chip active"
                    onClick={() => {
                      setHepToggles((prev) => {
                        const next = new Set(prev);
                        next.delete(tg.id);
                        return next;
                      });
                      setTimeout(() => textareaRef.current?.focus(), 0);
                    }}
                    disabled={disabled}
                    title={`${locale === "ko" ? tg.labelKo : tg.labelEn} — ${locale === "ko" ? "끄기" : "turn off"}`}
                    aria-pressed={true}
                  >
                    <span className="chat-input-hep-dot" aria-hidden />
                    <span className="chat-input-hep-label">{locale === "ko" ? tg.labelKo : tg.labelEn}</span>
                  </button>
                ))}
              </div>
            )}

            {/* 계속 라이브로 / 스웜 활성 칩 — 켜졌을 때만 바에 표시, 눌러서 끄기(평소엔 + 메뉴). */}
            {showModeToggles && continuousMode && (
              <div className="chat-input-hep-toggle-group" role="group" aria-label="Active modes">
                <button
                  type="button"
                  className="chat-input-hep-chip active"
                  onClick={() => onToggleContinuous?.()}
                  disabled={disabled}
                  title={`${locale === "ko" ? "계속 라이브로" : "Keep going live"} — ${locale === "ko" ? "끄기" : "turn off"}`}
                  aria-pressed={true}
                >
                  <span className="chat-input-hep-dot" aria-hidden />
                  <span className="chat-input-hep-label">{locale === "ko" ? "계속 라이브로" : "Keep going live"}</span>
                </button>
              </div>
            )}
            {showModeToggles && swarmMode && (
              <div className="chat-input-hep-toggle-group" role="group" aria-label="Active modes">
                <button
                  type="button"
                  className="chat-input-hep-chip active"
                  onClick={() => onToggleSwarm?.()}
                  disabled={disabled}
                  title={`${locale === "ko" ? "스웜" : "Swarm"} — ${locale === "ko" ? "끄기" : "turn off"}`}
                  aria-pressed={true}
                >
                  <span aria-hidden style={{ fontSize: 11, lineHeight: 1 }}>🐝</span>
                  <span className="chat-input-hep-label">{locale === "ko" ? "스웜" : "Swarm"}</span>
                </button>
              </div>
            )}

            {/* 실행 중 steering 대기 표시 — 큐에 쌓인 메시지가 있으면 개수를 보여준다. */}
            {queuedCount > 0 && (
              <span
                title={locale === "ko" ? "실행이 끝나면 순서대로 전송됩니다" : "Will send in order when the run finishes"}
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  height: 24,
                  padding: "0 9px",
                  borderRadius: 999,
                  fontSize: 11,
                  fontWeight: 600,
                  color: "var(--amber-deep)",
                  background: "color-mix(in srgb, var(--amber-deep) 10%, var(--paper))",
                  border: "1px solid color-mix(in srgb, var(--amber-deep) 24%, var(--paper-edge))",
                  whiteSpace: "nowrap",
                }}
              >
                <span aria-hidden>⏳</span>
                {locale === "ko" ? `${queuedCount}개 대기 중` : `${queuedCount} queued`}
              </span>
            )}

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

          <div className="chat-input-tools-right" style={{ display: "flex", alignItems: "center", gap: 8 }}>
            {/* Context volume indicator */}
            {tokensUsage && (
              <div 
                className="chat-input-context-pill"
                title={`${contextOwnerDescription} · ${Math.round(tokensUsage.current/1000)}k / ${Math.round(tokensUsage.limit/1000)}k`}
                style={{ 
                  display: "flex", alignItems: "center", gap: 6,
                  padding: "0 8px", height: 26, borderRadius: 13,
                  background: "var(--fill-1)", border: "1px solid var(--paper-edge)",
                  fontSize: 10, fontWeight: 600, color: "var(--muted-deep)",
                  minWidth: 0,
                  flex: "0 1 auto",
                }}
              >
                <span
                  className="chat-input-context-owner"
                  style={{ color: contextManagedByRuntime ? "var(--muted-deep)" : "var(--accent)" }}
                >
                  {contextOwnerLabel}
                </span>
                <div className="chat-input-context-meter" style={{ width: 40, height: 4, borderRadius: 2, background: "var(--fill-3)", overflow: "hidden" }}>
                  <div style={{ 
                    height: "100%", 
                    width: `${contextPercent}%`,
                    background: tokensUsage.current > tokensUsage.limit * 0.9 ? "var(--red)" : "var(--accent)",
                    transition: "width 0.3s"
                  }} />
                </div>
                <span className="chat-input-context-percent">{contextPercent}%</span>
              </div>
            )}
            
            {/* Plan/Goal 모드 토글은 툴바에서 숨김 — + 메뉴(PlusMenu)의 ToggleRow로만 노출.
                켜져 있으면 아래 활성 칩(chat-input-active-modes)이 상태를 보여준다. */}
            {(planMode || goalMode) && (
              <div style={{ display: "flex", gap: 4 }}>
                {planMode && (
                  <button
                    className="chat-input-chip"
                    onClick={() => setPlanMode(false)}
                    title={t("chatinput.plan_mode")}
                    style={{ ...toolBtnStyle(true), width: "auto", padding: "0 8px", gap: 4, fontSize: 10.5, fontWeight: 600, color: "var(--accent)" }}
                  >
                    <IconRoute size={12} />
                    <span className="chat-input-chip-label">{t("chatinput.plan_mode")}</span> ✕
                  </button>
                )}
                {goalMode && (
                  <button
                    className="chat-input-chip"
                    onClick={() => setGoalMode(false)}
                    title={t("chatinput.goal_mode")}
                    style={{ ...toolBtnStyle(true), width: "auto", padding: "0 8px", gap: 4, fontSize: 10.5, fontWeight: 600, color: "var(--accent)" }}
                  >
                    <IconTarget size={12} />
                    <span className="chat-input-chip-label">{t("chatinput.goal_mode")}</span> ✕
                  </button>
                )}
              </div>
            )}

            {/* 보내기 / 정지 — 실행 중(busy)이고 onStop이 있으면 정지 버튼으로 변신 */}
            {(() => {
              const showStop = busy && !!onStop;
              const stopLabel = stopRequested
                ? locale === "ko"
                  ? "중지 요청됨"
                  : "Stopping"
                : t("chat.stop");
              return (
                <>
                  {showStop && (
                    <button
                      type="button"
                      className="chat-input-stop-button"
                      data-chat-stop-button="true"
                      onPointerDown={(e) => {
                        e.preventDefault();
                        e.stopPropagation();
                        if (!stopRequested) onStop?.();
                      }}
                      onClick={stopRequested ? undefined : onStop}
                      disabled={stopRequested}
                      aria-label={stopLabel}
                      title={stopLabel}
                      style={{
                        height: 32,
                        flexShrink: 0,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        gap: 7,
                        padding: "0 12px",
                        borderRadius: 999,
                        border: "1px solid color-mix(in srgb, var(--red-deep) 30%, var(--paper-edge))",
                        background: "color-mix(in srgb, var(--red-deep) 8%, var(--paper))",
                        color: stopRequested ? "var(--muted-deep)" : "var(--red-deep)",
                        fontSize: 12,
                        fontWeight: 750,
                        opacity: stopRequested ? 0.72 : 1,
                        cursor: stopRequested ? "default" : "pointer",
                      }}
                    >
                      <span
                        style={{
                          width: 9,
                          height: 9,
                          background: "currentColor",
                          borderRadius: 2,
                          display: "inline-block",
                          flexShrink: 0,
                        }}
                        aria-hidden
                      />
                      <span>{stopLabel}</span>
                    </button>
                  )}
                  <button
                    className="chat-input-send-button"
                    data-chat-stop-button={showStop ? "true" : undefined}
                    onPointerDown={
                      showStop
                        ? (e) => {
                            e.preventDefault();
                            e.stopPropagation();
                            if (!stopRequested) onStop?.();
                          }
                        : undefined
                    }
                    onClick={showStop ? (stopRequested ? undefined : onStop) : submit}
                    disabled={showStop ? stopRequested : submitDisabled}
                    aria-label={showStop ? stopLabel : t("chatinput.send")}
                    title={showStop ? stopLabel : undefined}
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
                      cursor: showStop && !stopRequested ? "pointer" : undefined,
                      opacity: showStop && stopRequested ? 0.72 : 1,
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
                </>
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

// ── 추천 바텀시트 ──────────────────────────────────────
// routePreview(정규화된 Recommendation)를 보고 싱글/네트워크TF/파이프라인을 예상 크레딧과 함께
// 제시한다. BottomQuestionSheet 와 동일한 절대배치 바텀시트 스타일. 픽 시 onPick(choice)로 디스패치.
function RecommendationSheet({
  loading,
  preview,
  onPick,
  onCancel,
  onRetry,
  t,
  locale,
}: {
  loading: boolean;
  preview: Recommendation | null;
  onPick: (choice: RecExecChoice) => void;
  onCancel: () => void;
  onRetry: () => void;
  t: TFunction;
  locale: Locale;
}) {
  const mode = preview?.mode ?? "none";
  const routerAgent = preview?.routerAgent;
  const selectable = mode === "network" || mode === "multi";
  // 네트워크 모드: 빌릴 Hub 에이전트를 골라 담는다. 기본 전체 선택.
  const [selected, setSelected] = useState<Set<string>>(new Set());
  useEffect(() => {
    if (preview && (preview.mode === "network" || preview.mode === "multi")) {
      setSelected(new Set(preview.agents.map((a) => a.id)));
    }
  }, [preview]);
  const toggleAgent = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const suffix = t("chatinput.rec.credits_suffix");
  // 한 에이전트의 비용 라벨 — BYOC: Hub 만 실제 크레딧, 로컬/클라우드는 "내 구독"(별도 크레딧 없음).
  const agentCost = (source: string, credits: number | null | undefined): string =>
    source === "hub"
      ? credits != null
        ? `~${credits} ${suffix}`
        : t("chatinput.rec.credits_unknown")
      : t("chatinput.rec.byoc");
  // 네트워크 합계는 "선택한" Hub 에이전트의 실제 크레딧 합(미정은 제외). 선택 0이면 null.
  const selectedHubKnown = preview
    ? preview.agents.filter(
        (a) => (selectable ? selected.has(a.id) : true) && a.source === "hub" && a.estCredits != null,
      )
    : [];
  const selectedHubTotal = selectedHubKnown.length
    ? selectedHubKnown.reduce((s, a) => s + (a.estCredits ?? 0), 0)
    : null;
  const sourceLabel = (s: string): string =>
    s === "hub" ? t("chatinput.rec.source.hub") : s === "cloud" ? t("chatinput.rec.source.cloud") : t("chatinput.rec.source.local");

  const primaryBtn: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 700,
    padding: "6px 14px",
    border: "1px solid var(--ink-soft)",
    background: "var(--ink, #1a1a1a)",
    color: "#fff",
    cursor: "pointer",
  };
  const ghostBtn: React.CSSProperties = {
    fontSize: 12,
    fontWeight: 600,
    padding: "6px 12px",
    border: "1px solid var(--paper-edge)",
    background: "var(--fill-1)",
    color: "inherit",
    cursor: "pointer",
  };

  const headerLabel =
    mode === "single"
      ? t("chatinput.rec.mode.single")
      : mode === "network" || mode === "multi"
        ? t("chatinput.rec.mode.network", { n: String(preview?.agents.length ?? 0) })
        : mode === "pipeline"
          ? t("chatinput.rec.mode.pipeline", { n: String(preview?.stages?.length ?? 0) })
          : t("chatinput.rec.title");

  return (
    <section
      role="dialog"
      aria-modal="false"
      aria-label={t("chatinput.rec.title")}
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "calc(100% + 8px)",
        width: "calc(100% - 32px)",
        maxWidth: 980,
        margin: "0 auto",
        zIndex: 45,
        border: "1px solid var(--paper-edge)",
        background: "#fff",
        padding: 12,
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
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
          {t("chatinput.rec.title")}
        </span>
        <strong style={{ fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {loading ? t("chatinput.rec.loading") : headerLabel}
        </strong>
        <button
          type="button"
          onClick={onCancel}
          aria-label={t("chatinput.agent_picker.cancel")}
          title={t("chatinput.agent_picker.cancel")}
          style={{
            width: 24,
            height: 24,
            flexShrink: 0,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "none",
            background: "transparent",
            color: "var(--muted-deep)",
            cursor: "pointer",
          }}
        >
          <IconClose size={13} />
        </button>
      </div>

      {loading ? (
        <div style={{ fontSize: 12, color: "var(--ink-soft)", padding: "8px 2px" }}>{t("chatinput.rec.loading")}</div>
      ) : !preview || mode === "none" ? (
        <div style={{ fontSize: 12.5, color: "var(--ink-soft)", padding: "4px 2px 10px" }}>{t("chatinput.rec.none")}</div>
      ) : mode === "clarify" ? (
        <div style={{ fontSize: 12.5, padding: "4px 2px 10px" }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>{t("chatinput.rec.clarify")}</div>
          <div style={{ color: "var(--ink-soft)" }}>{preview.clarifyQuestion ?? ""}</div>
          {/* 후보가 있으면 클릭 가능한 선택지로 승격 — 수동 재타이핑 대신 바로 그 에이전트로 실행 */}
          {(preview.agents ?? []).length > 0 && (
            <div style={{ display: "flex", flexDirection: "column", gap: 4, marginTop: 8 }}>
              {preview.agents.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  onClick={() =>
                    onPick(
                      a.source === "hub"
                        ? { kind: "network", agents: [a.id], routerAgent: preview.routerAgent }
                        : { kind: "agent", agentId: a.id, routerAgent: preview.routerAgent },
                    )
                  }
                  style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 8,
                    fontSize: 12.5,
                    padding: "7px 10px",
                    borderRadius: 8,
                    border: "1px solid var(--paper-edge)",
                    background: "var(--paper-2)",
                    cursor: "pointer",
                    textAlign: "left",
                  }}
                >
                  <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>
                    {a.name}
                  </span>
                  <span
                    style={{
                      flexShrink: 0,
                      fontSize: 10.5,
                      fontWeight: 700,
                      color: "var(--ink-soft)",
                      border: "1px solid var(--paper-edge)",
                      padding: "0 5px",
                      borderRadius: 3,
                    }}
                  >
                    {sourceLabel(a.source)}
                  </span>
                  <span style={{ marginLeft: "auto", flexShrink: 0, color: "var(--ink-soft)", fontSize: 11.5 }}>
                    {locale === "ko" ? "이 에이전트로 →" : "run with →"}
                  </span>
                </button>
              ))}
            </div>
          )}
        </div>
      ) : mode === "pipeline" ? (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
          {(preview.stages ?? []).map((s) => (
            <div key={s.order} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12.5 }}>
              <span style={{ flexShrink: 0, width: 18, color: "var(--ink-soft)", fontWeight: 700 }}>{s.order}.</span>
              <span style={{ flexShrink: 0, fontWeight: 600 }}>{s.kind}</span>
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", color: "var(--ink-soft)" }}>
                {s.agentName ?? s.agentId ?? ""}
              </span>
            </div>
          ))}
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 4, marginBottom: 8 }}>
          {preview.agents.map((a) => (
            <div
              key={a.id}
              onClick={selectable ? () => toggleAgent(a.id) : undefined}
              style={{
                display: "flex",
                alignItems: "center",
                gap: 8,
                fontSize: 12.5,
                cursor: selectable ? "pointer" : "default",
                opacity: selectable && !selected.has(a.id) ? 0.5 : 1,
              }}
            >
              {selectable && (
                <span
                  aria-hidden
                  style={{
                    flexShrink: 0,
                    width: 14,
                    height: 14,
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    border: "1px solid var(--paper-edge)",
                    background: selected.has(a.id) ? "var(--ink, #1a1a1a)" : "#fff",
                    color: "#fff",
                    fontSize: 10,
                    fontWeight: 800,
                    borderRadius: 3,
                  }}
                >
                  {selected.has(a.id) ? "✓" : ""}
                </span>
              )}
              <span style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }}>
                {a.name}
              </span>
              <span
                style={{
                  flexShrink: 0,
                  fontSize: 10.5,
                  fontWeight: 700,
                  color: "var(--ink-soft)",
                  border: "1px solid var(--paper-edge)",
                  padding: "0 5px",
                  borderRadius: 3,
                }}
              >
                {sourceLabel(a.source)}
              </span>
              <span style={{ marginLeft: "auto", flexShrink: 0, color: "var(--ink-soft)", fontSize: 11.5 }}>
                {agentCost(a.source, a.estCredits)}
              </span>
            </div>
          ))}
        </div>
      )}

      {!loading && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 6 }}>
          {preview && mode !== "none" && mode !== "clarify" && (
            <span style={{ fontSize: 11, color: "var(--ink-soft)" }}>
              {mode === "network" || mode === "multi"
                ? selectedHubTotal != null
                  ? `~${selectedHubTotal} ${suffix} · ${t("chatinput.rec.estimate_note")}`
                  : t("chatinput.rec.credits_unknown")
                : mode === "pipeline"
                  ? t("chatinput.rec.pipeline_note")
                  : t("chatinput.rec.byoc_note")}
            </span>
          )}
          <div style={{ marginLeft: "auto", display: "flex", gap: 8 }}>
            <button type="button" onClick={onRetry} style={ghostBtn}>
              {t("chatinput.rec.cancel")}
            </button>
            <button type="button" onClick={() => onPick({ kind: "plain" })} style={ghostBtn}>
              {t("chatinput.rec.send_plain")}
            </button>
            {preview && mode === "single" && preview.agents[0] && (
              <button
                type="button"
                onClick={() =>
                  // Hub 단일 추천은 설치 에이전트가 아니므로 switchAgent 대신 borrow 경로로 실행.
                  preview.agents[0].source === "hub"
                    ? onPick({ kind: "network", agents: [preview.agents[0].id], routerAgent })
                    : onPick({ kind: "agent", agentId: preview.agents[0].id, isFirm: preview.agents[0].isFirm, routerAgent })
                }
                style={primaryBtn}
              >
                {t("chatinput.rec.run_single")}
              </button>
            )}
            {preview && (mode === "network" || mode === "multi") && (
              <button
                type="button"
                onClick={() => onPick({ kind: "network", agents: [...selected], routerAgent })}
                disabled={selected.size === 0}
                style={{ ...primaryBtn, opacity: selected.size === 0 ? 0.5 : 1, cursor: selected.size === 0 ? "not-allowed" : "pointer" }}
              >
                {t("chatinput.rec.run_network")}
              </button>
            )}
            {preview && mode === "pipeline" && (
              <button type="button" onClick={() => onPick({ kind: "pipeline", stages: preview.stages, routerAgent })} style={primaryBtn}>
                {t("chatinput.rec.run_pipeline")}
              </button>
            )}
          </div>
        </div>
      )}
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
      gemini: "Antigravity",
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
    <Popover title={title} dataKind="autocomplete" role="listbox">
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
              autocompleteOption
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
  onToggleAppsGenerate,
  onInsertSlash,
  onInsertMention,
  hepToggles,
  onToggleHep,
  locale,
  onOpenAgentPicker,
  showModeToggles,
  continuousMode,
  swarmMode,
  onToggleContinuous,
  onToggleSwarm,
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
  onToggleAppsGenerate: (v: boolean) => void;
  /** "/" 명령어 삽입 — 인라인 버튼을 + 메뉴로 통합(리사이즈 시 버튼 스캐터 방지). */
  onInsertSlash: () => void;
  /** "@" 에이전트 부르기 삽입. */
  onInsertMention: () => void;
  /** 현재 켜진 Hephaestus 모드들(다중선택). */
  hepToggles: Set<HepToggleId>;
  /** Hephaestus 모드 토글(스톰브레이커 경고·포커스 등은 부모가 처리). */
  onToggleHep: (id: HepToggleId) => void;
  locale: string;
  onOpenAgentPicker: () => void;
  /** 실행 모드 토글(계속 라이브로·스웜) 노출 여부. */
  showModeToggles: boolean;
  continuousMode: boolean;
  swarmMode: boolean;
  onToggleContinuous: () => void;
  onToggleSwarm: () => void;
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
        onClick={onInsertSlash}
        icon={<span style={{ fontFamily: "var(--font-mono)", fontSize: 13, fontWeight: 700 }}>/</span>}
        title={t("chatinput.slash")}
      />
      <Row
        onClick={onInsertMention}
        icon={<IconAtSign size={14} />}
        title={t("chatinput.mention")}
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
        on={appsGenerateMode}
        onChange={onToggleAppsGenerate}
      />
      {showModeToggles && (
        <>
          <Divider />
          <ToggleRow
            icon={
              <span
                style={{
                  width: 8,
                  height: 8,
                  borderRadius: "50%",
                  background: continuousMode ? "var(--accent)" : "var(--muted)",
                  display: "inline-block",
                  flexShrink: 0,
                }}
              />
            }
            title={locale === "ko" ? "계속 라이브로" : "Keep going live"}
            subtitle={
              locale === "ko"
                ? "멈추지 않고 라이브로 계속 작업 (끝나거나 멈출 때까지)"
                : "Keep working live without stopping until done or stopped"
            }
            on={continuousMode}
            onChange={onToggleContinuous}
          />
          <ToggleRow
            icon={<span aria-hidden style={{ fontSize: 13, lineHeight: 1 }}>🐝</span>}
            title={locale === "ko" ? "스웜" : "Swarm"}
            subtitle={
              locale === "ko"
                ? "목표를 쪼개 여러 에이전트가 동시에 협업"
                : "Split the goal across parallel agents"
            }
            on={swarmMode}
            onChange={onToggleSwarm}
          />
        </>
      )}
      <Divider />
      {HEP_TOGGLES.map((tg) => (
        <ToggleRow
          key={tg.id}
          icon={
            <span
              style={{
                width: 8,
                height: 8,
                borderRadius: "50%",
                background: hepToggles.has(tg.id) ? "var(--accent)" : "var(--muted)",
                display: "inline-block",
                flexShrink: 0,
              }}
            />
          }
          title={locale === "ko" ? tg.labelKo : tg.labelEn}
          subtitle={locale === "ko" ? tg.titleKo : tg.titleEn}
          on={hepToggles.has(tg.id)}
          onChange={() => onToggleHep(tg.id)}
        />
      ))}
      <Divider />
      <Row
        onClick={onOpenAgentPicker}
        icon={<IconUsers size={14} style={{ color: "var(--accent)" }} />}
        title={t("chatinput.plus.agents")}
        subtitle={t("chatinput.plus.agents_hint")}
        right={<IconChevronRight size={11} style={{ color: "var(--muted)" }} />}
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
  dataKind,
  role,
}: {
  title?: string;
  children: React.ReactNode;
  dataKind?: string;
  role?: React.AriaRole;
}) {
  return (
    <div
      data-popover-root
      data-popover-kind={dataKind}
      role={role}
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
  autocompleteOption = false,
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
  autocompleteOption?: boolean;
}) {
  // active일 때는 hover 색을 항상 표시 — inline 토글이라 ref로 보존하지 않음
  return (
    <button
      onClick={onClick}
      disabled={!onClick}
      data-autocomplete-option={autocompleteOption ? "true" : undefined}
      role={autocompleteOption ? "option" : undefined}
      aria-selected={autocompleteOption ? (active ? "true" : "false") : undefined}
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

// ── 에이전트 선택 팝업 ─────────────────────────────────────
function AgentPickerPopup({
  agents,
  firms,
  selected,
  onToggle,
  onConfirm,
  onClose,
  t,
  locale,
}: {
  agents: InstalledAgent[];
  firms: InstalledFirm[];
  selected: Set<string>;
  onToggle: (id: string) => void;
  onConfirm: () => void;
  onClose: () => void;
  t: TFunction;
  locale: "ko" | "en";
}) {
  const [search, setSearch] = useState("");
  const q = search.toLowerCase();

  const filteredFirms = firms.filter((f) => {
    const loc = pickLocalized(f, locale);
    return !q || loc.name.toLowerCase().includes(q) || f.slug.includes(q);
  });
  const filteredAgents = agents.filter((a) => {
    const loc = pickLocalized(a, locale);
    return !q || loc.name.toLowerCase().includes(q) || a.slug.includes(q);
  });

  const selectedCount = selected.size;

  return (
    <section
      role="dialog"
      aria-modal="true"
      aria-label={t("chatinput.agent_picker.title")}
      data-popover-root
      style={{
        position: "absolute",
        left: 0,
        right: 0,
        bottom: "calc(100% + 8px)",
        width: "calc(100% - 32px)",
        maxWidth: 480,
        margin: "0 auto",
        zIndex: 50,
        borderRadius: 16,
        border: "1px solid var(--paper-edge)",
        background: "var(--paper)",
        backdropFilter: "blur(24px)",
        boxShadow: "0 12px 40px rgba(0,0,0,0.12), 0 0 0 1px rgba(255,255,255,0.08) inset",
        padding: 0,
        overflow: "hidden",
      }}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onClose();
        }
        if (e.key === "Enter" && selectedCount > 0) {
          e.preventDefault();
          onConfirm();
        }
      }}
    >
      {/* 헤더 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "14px 16px 10px",
          borderBottom: "1px solid var(--paper-edge)",
        }}
      >
        <IconUsers size={16} style={{ color: "var(--accent)", flexShrink: 0 }} />
        <h2
          style={{
            margin: 0,
            flex: 1,
            fontSize: 14,
            fontWeight: 750,
            color: "var(--ink)",
          }}
        >
          {t("chatinput.agent_picker.title")}
        </h2>
        {selectedCount > 0 && (
          <span
            style={{
              borderRadius: 999,
              background: "color-mix(in srgb, var(--accent) 14%, transparent)",
              color: "var(--accent)",
              fontSize: 11,
              fontWeight: 700,
              padding: "2px 8px",
            }}
          >
            {t("chatinput.agent_picker.selected", { count: selectedCount })}
          </span>
        )}
        <button
          onClick={onClose}
          aria-label={t("chatinput.agent_picker.cancel")}
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
            cursor: "pointer",
          }}
        >
          <IconClose size={13} />
        </button>
      </div>

      {/* 검색 */}
      <div style={{ padding: "10px 16px 6px" }}>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder={t("chatinput.agent_picker.search")}
          autoFocus
          style={{
            width: "100%",
            border: "1px solid var(--paper-edge)",
            borderRadius: 10,
            padding: "8px 12px",
            fontSize: 12.5,
            color: "var(--ink)",
            background: "var(--fill-1)",
            outline: "none",
            fontFamily: "var(--font-body)",
          }}
        />
      </div>

      {/* 리스트 */}
      <div
        style={{
          maxHeight: 320,
          overflowY: "auto",
          padding: "4px 8px",
        }}
      >
        {filteredFirms.length === 0 && filteredAgents.length === 0 ? (
          <div
            style={{
              padding: "24px 12px",
              textAlign: "center",
              fontSize: 12,
              color: "var(--muted-deep)",
            }}
          >
            {t("chatinput.agent_picker.empty")}
          </div>
        ) : (
          <>
            {/* 팀(Firm) 섹션 */}
            {filteredFirms.length > 0 && (
              <>
                <div
                  style={{
                    padding: "8px 10px 4px",
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    textTransform: "uppercase",
                    letterSpacing: 0.6,
                    color: "var(--muted-deep)",
                  }}
                >
                  {t("chatinput.agent_picker.teams")}
                </div>
                {filteredFirms.map((f) => {
                  const loc = pickLocalized(f, locale);
                  const checked = selected.has(f.ceoAgentId);
                  return (
                    <AgentPickerRow
                      key={f.id}
                      checked={checked}
                      onToggle={() => onToggle(f.ceoAgentId)}
                      icon={<IconBuilding size={14} style={{ color: "var(--accent)" }} />}
                      name={loc.name}
                      tagline={loc.tagline}
                      badge={locale === "en" ? "Team" : "팀"}
                    />
                  );
                })}
              </>
            )}
            {/* 싱글 에이전트 섹션 */}
            {filteredAgents.length > 0 && (
              <>
                <div
                  style={{
                    padding: "8px 10px 4px",
                    fontSize: 10,
                    fontFamily: "var(--font-mono)",
                    textTransform: "uppercase",
                    letterSpacing: 0.6,
                    color: "var(--muted-deep)",
                  }}
                >
                  {t("chatinput.agent_picker.singles")}
                </div>
                {filteredAgents.map((a) => {
                  const loc = pickLocalized(a, locale);
                  const checked = selected.has(a.id);
                  return (
                    <AgentPickerRow
                      key={a.id}
                      checked={checked}
                      onToggle={() => onToggle(a.id)}
                      icon={<IconSparkles size={14} style={{ color: "var(--accent)" }} />}
                      name={loc.name}
                      tagline={loc.tagline}
                    />
                  );
                })}
              </>
            )}
          </>
        )}
      </div>

      {/* 하단 버튼 */}
      <div
        style={{
          display: "flex",
          justifyContent: "flex-end",
          gap: 8,
          padding: "10px 16px 14px",
          borderTop: "1px solid var(--paper-edge)",
        }}
      >
        <button
          onClick={onClose}
          style={{
            borderRadius: 8,
            border: "1px solid var(--paper-edge)",
            background: "var(--paper)",
            color: "var(--muted-deep)",
            padding: "7px 14px",
            fontSize: 12,
            fontWeight: 650,
            cursor: "pointer",
          }}
        >
          {t("chatinput.agent_picker.cancel")}
        </button>
        <button
          onClick={onConfirm}
          disabled={selectedCount === 0}
          style={{
            borderRadius: 8,
            border: "1px solid color-mix(in srgb, var(--accent) 28%, var(--paper-edge))",
            background: selectedCount > 0
              ? "color-mix(in srgb, var(--accent) 12%, var(--paper))"
              : "var(--fill-1)",
            color: selectedCount > 0 ? "var(--accent)" : "var(--muted-deep)",
            padding: "7px 16px",
            fontSize: 12,
            fontWeight: 750,
            cursor: selectedCount > 0 ? "pointer" : "not-allowed",
            transition: "all 0.15s",
          }}
        >
          {t("chatinput.agent_picker.confirm")}
          {selectedCount > 0 && ` (${selectedCount})`}
        </button>
      </div>
    </section>
  );
}

function AgentPickerRow({
  checked,
  onToggle,
  icon,
  name,
  tagline,
  badge,
}: {
  checked: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  name: string;
  tagline?: string;
  badge?: string;
}) {
  return (
    <button
      onClick={onToggle}
      style={{
        display: "flex",
        width: "100%",
        alignItems: "center",
        gap: 10,
        padding: "9px 10px",
        borderRadius: 10,
        background: checked
          ? "color-mix(in srgb, var(--accent) 8%, transparent)"
          : "transparent",
        border: checked
          ? "1px solid color-mix(in srgb, var(--accent) 20%, var(--paper-edge))"
          : "1px solid transparent",
        textAlign: "left",
        cursor: "pointer",
        transition: "all 0.12s",
      }}
      onMouseEnter={(e) => {
        if (!checked)
          e.currentTarget.style.background = "var(--fill-1)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = checked
          ? "color-mix(in srgb, var(--accent) 8%, transparent)"
          : "transparent";
      }}
    >
      {/* 체크박스 */}
      <span
        style={{
          width: 18,
          height: 18,
          borderRadius: 5,
          border: checked
            ? "2px solid var(--accent)"
            : "2px solid var(--paper-edge)",
          background: checked ? "var(--accent)" : "var(--paper)",
          display: "inline-flex",
          alignItems: "center",
          justifyContent: "center",
          flexShrink: 0,
          transition: "all 0.12s",
        }}
      >
        {checked && (
          <svg width="10" height="10" viewBox="0 0 10 10" fill="none">
            <path
              d="M2 5L4.2 7.5L8 2.5"
              stroke="white"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        )}
      </span>
      {/* 아이콘 */}
      <span style={{ flexShrink: 0, color: "var(--ink-soft)" }}>{icon}</span>
      {/* 텍스트 */}
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span
            style={{
              fontSize: 12.5,
              fontWeight: 650,
              color: "var(--ink)",
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {name}
          </span>
          {badge && (
            <span
              style={{
                fontSize: 9,
                fontWeight: 700,
                color: "var(--accent)",
                background: "color-mix(in srgb, var(--accent) 12%, transparent)",
                padding: "1px 5px",
                borderRadius: 4,
                flexShrink: 0,
              }}
            >
              {badge}
            </span>
          )}
        </span>
        {tagline && (
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
            {tagline}
          </span>
        )}
      </span>
    </button>
  );
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
