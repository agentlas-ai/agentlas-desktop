// 메시지 스트림 렌더 — agent 메시지는 Markdown으로, 사용자 메시지는 plain.
// 작업 중 메시지는 Codex/Claude 데스크톱처럼 step log + 경과 시간을 실시간으로 보여준다.
"use client";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { InstalledAgent, InstalledFirm, InstalledMcpServer, Project, RuntimeCommand } from "@/lib/types";
import type { AgentlasAppDefinition } from "@/lib/apps";
import { AgentAvatar } from "./AgentAvatar";
import { Markdown, StreamingMarkdown, type CodeArtifact, type MediaArtifact } from "./Markdown";
import { useT } from "@/lib/i18n";

/** 작업 중 패널에 누적되는 단일 단계. 새 이벤트마다 push (replace 아님). */
export interface StreamStep {
  id: string;
  /** thinking = 모델 사고, tool = 런타임/툴 호출 */
  kind: "thinking" | "tool";
  text: string;
  /** tool 호출 이름 (있으면 Claude Code식 접기/펴기 블록으로 렌더) */
  tool?: string;
  /** tool 인자 JSON 문자열 — 펼쳤을 때 표시 */
  args?: string;
  /** tool_use id — 호출과 결과를 같은 행으로 병합하기 위한 런타임 id */
  toolUseId?: string;
  /** tool 결과 문자열 — 펼쳤을 때 표시 */
  result?: string;
  /** 결과가 오류인지 여부 */
  resultIsError?: boolean;
  /** 실행 이벤트를 낸 에이전트 표시명. 멀티 에이전트/위임 카드에 사용한다. */
  agentName?: string;
  /** 회사/팀 안에서의 역할명. */
  role?: string;
  /** 오케스트레이션 단계 — plan/delegate/synthesize. */
  phase?: "plan" | "delegate" | "synthesize";
  /** 위임 카드 표시용 대상 노드 id 목록. */
  delegateTo?: string[];
  /** 채팅 안에서 카드로 보여줄 활동 상태. */
  activity?: "start" | "handoff" | "tool" | "complete" | "status";
  /** 이 단계가 화면에 들어온 시각. 긴 실행 중 마지막 활동 표시용. */
  createdAt?: number;
}

/** 에이전트가 사용자에게 옵션을 묻는 질문. Markdown에서 fence를 파싱해 채워진다. */
export interface ChatQuestion {
  /** 메시지 내 고유 id — 같은 메시지에서 여러 개 가능하면 인덱스로 구분 */
  id: string;
  question: string;
  /** 짧은 라벨 (UI 칩) — 선택 사항 */
  header?: string;
  /** 여러 옵션 동시 선택 허용 여부 */
  multiSelect?: boolean;
  options: Array<{ label: string; description?: string }>;
  /** 사용자가 답한 옵션 라벨(들) — 한 번 답하면 잠금 */
  answer?: string[];
}

/** PRD→build→QA 같은 다단계 파이프라인의 한 단계 — 추천 시트에서 pipeline 을 고르면 시드된다(계획 가시화). */
export interface PipelineStage {
  order: number;
  /** 엔진 stage 키(plan/build/verify 등). */
  kind: string;
  agentName?: string;
  agentId?: string;
  /** 실행 상태 — 라이브 이벤트가 이 단계의 에이전트를 낼 때만 갱신(매칭 안 되면 미정으로 둔다 — 가짜 진행 금지). */
  status?: "pending" | "running" | "done";
}

export interface StreamMessage {
  id: string;
  role: "user" | "agent" | "system";
  text: string;
  /** 가장 최근 status — 단일 줄 fallback (steps와 병행 가능) */
  status?: string;
  /** 진행 중일 때 누적된 step log. final 도착 시 비워도 되고 남겨둬도 됨. */
  steps?: StreamStep[];
  /** 호출 시작 시각 ms — 경과 시간 표시 */
  startedAt?: number;
  /** 토큰 partial이 도착하기 시작했는지. true면 본문 끝에 깜빡이는 커서. */
  streaming?: boolean;
  /** 진행 중인지 — true면 워킹 패널 노출, false면 일반 메시지 */
  busy?: boolean;
  /** 첨부된 이미지 미리보기 URL — data:image/... base64 */
  imageDataUrls?: string[];
  /** 본문에서 fence로 추출된 질문들 — UI는 본문 텍스트 아래에 카드로 렌더 */
  questions?: ChatQuestion[];
  /** 생성 토큰 수 — "N tokens" 표시 (Claude Code 스타일) */
  tokens?: number;
  /** 파이프라인 단계 계획 — 있으면 메시지 상단에 스테퍼로 표시(PRD→배포 가시화). */
  pipeline?: PipelineStage[];
}

export interface ChatEmptyDirectory {
  apps: AgentlasAppDefinition[];
  agents: InstalledAgent[];
  firms: InstalledFirm[];
  projects: Project[];
  envKeys: string[];
  commands: RuntimeCommand[];
  plugins: InstalledMcpServer[];
}

export function ChatStream({
  messages,
  agentName,
  agentTone,
  emptyDirectory,
  onOpenArtifact,
  onOpenMedia,
  onOpenWorkflow,
  onAnswerQuestion,
  onStop,
  interactionBusy = false,
  stopRequested = false,
}: {
  messages: StreamMessage[];
  agentName: string;
  agentTone: InstalledAgent["tone"];
  emptyDirectory?: ChatEmptyDirectory;
  onOpenArtifact?: (a: CodeArtifact) => void;
  onOpenMedia?: (a: MediaArtifact) => void;
  onOpenWorkflow?: () => void;
  onStop?: () => void;
  /** 사용자가 질문에 답함 — 부모가 user 메시지로 전송 */
  onAnswerQuestion?: (messageId: string, questionId: string, answers: string[]) => void;
  /** 다른 메시지가 실행 중이면 오래된 질문 카드도 전송하지 않는다. */
  interactionBusy?: boolean;
  stopRequested?: boolean;
}) {
  const { t } = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const last = messages[messages.length - 1];
  const scrollSignal = last
    ? `${messages.length}:${last.id}:${last.text.length}:${last.busy ? 1 : 0}:${last.streaming ? 1 : 0}:${last.steps?.length ?? 0}`
    : "empty";

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    const handle = window.requestAnimationFrame(() => {
      el.scrollTop = el.scrollHeight;
    });
    return () => window.cancelAnimationFrame(handle);
  }, [scrollSignal]);

  function handleScroll() {
    const el = scrollRef.current;
    if (!el) return;
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
    stickToBottomRef.current = distanceFromBottom < 96;
  }

  return (
    <div
      ref={scrollRef}
      onScroll={handleScroll}
      style={{
        flex: 1,
        overflowY: messages.length === 0 ? "hidden" : "auto",
        padding: messages.length === 0 ? "20px 28px" : "24px 32px",
        background: "var(--paper)",
        display: "flex",
        flexDirection: "column",
        gap: 16,
      }}
    >
      {messages.map((m) => (
        <Bubble
          key={m.id}
          message={m}
          agentName={agentName}
          agentTone={agentTone}
          onOpenArtifact={onOpenArtifact}
          onOpenMedia={onOpenMedia}
          onOpenWorkflow={onOpenWorkflow}
          onStop={onStop}
          onAnswerQuestion={onAnswerQuestion}
          interactionBusy={interactionBusy}
          stopRequested={stopRequested}
        />
      ))}
    </div>
  );
}

// React.memo: props 동일 시 리렌더 스킵(스트리밍 중 무관 버블 재렌더 비용 제거). 표시명 유지.
const Bubble = memo(function Bubble({
  message,
  agentName,
  agentTone,
  onOpenArtifact,
  onOpenMedia,
  onOpenWorkflow,
  onAnswerQuestion,
  interactionBusy,
  onStop,
  stopRequested,
}: {
  message: StreamMessage;
  agentName: string;
  agentTone: InstalledAgent["tone"];
  onOpenArtifact?: (a: CodeArtifact) => void;
  onOpenMedia?: (a: MediaArtifact) => void;
  onOpenWorkflow?: () => void;
  onStop?: () => void;
  onAnswerQuestion?: (messageId: string, questionId: string, answers: string[]) => void;
  interactionBusy: boolean;
  stopRequested: boolean;
}) {
  const { t, locale } = useT();
  if (message.role === "user") {
    return (
      <div style={{ alignSelf: "flex-end", maxWidth: "75%" }}>
        {message.imageDataUrls && message.imageDataUrls.length > 0 && (
          <div style={{ display: "flex", gap: 6, marginBottom: 6, flexWrap: "wrap", justifyContent: "flex-end" }}>
            {message.imageDataUrls.map((url, i) => (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                key={i}
                src={url}
                alt=""
                style={{
                  maxWidth: 220,
                  maxHeight: 160,
                  borderRadius: 10,
                  border: "1px solid var(--paper-edge)",
                  objectFit: "cover",
                }}
              />
            ))}
          </div>
        )}
        {message.text && (
          <div
            style={{
              background: "var(--fill-2)",
              color: "var(--ink)",
              padding: "10px 14px",
              borderRadius: "var(--radius-md)",
              fontSize: 14,
              whiteSpace: "pre-wrap",
              overflowWrap: "anywhere",
            }}
          >
            {message.text}
          </div>
        )}
      </div>
    );
  }
  if (message.role === "system") {
    if (isInternalSystemNote(message.text)) return null;
    const isError = message.text.trim().startsWith("⚠️");
    return (
      <div
        style={{
          alignSelf: "stretch",
          maxWidth: 760,
          fontSize: 12.5,
          lineHeight: 1.55,
          color: isError ? "var(--red-deep)" : "var(--muted-deep)",
          background: isError ? "rgba(255,138,138,0.10)" : "transparent",
          padding: isError ? "9px 12px" : "2px 0",
          borderRadius: isError ? "var(--radius-sm)" : 0,
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
        }}
      >
        {message.text}
      </div>
    );
  }
  // agent — Markdown 렌더링.
  // 단일 실행은 한 줄 상태만 보여주고, 카드형 작업 패널은 실제 멀티/병렬 실행에서만 쓴다.
  const hasProgress = Boolean(message.busy || message.status || (message.steps && message.steps.length > 0));
  const showParallelWork = hasProgress && isParallelWorkMessage(message);
  const showInlineRun = hasProgress && !showParallelWork;
  return (
    <div style={{ display: "flex", gap: 10, alignSelf: "stretch", maxWidth: 820 }}>
      <div style={{ position: "relative", flexShrink: 0 }}>
        <AgentAvatar name={agentName} tone={agentTone} size={28} />
      </div>
      <div style={{ minWidth: 0, flex: 1, paddingTop: 1 }}>
        {message.pipeline && message.pipeline.length > 0 && showParallelWork && (
          <PipelineStepper stages={message.pipeline} running={Boolean(message.busy)} />
        )}
        {showParallelWork && (
          <WorkingPanel
            steps={message.steps ?? []}
            fallback={message.status}
            startedAt={message.startedAt}
            done={!message.busy}
            tokens={message.tokens}
            onOpenWorkflow={onOpenWorkflow}
            onStop={message.busy ? onStop : undefined}
            stopRequested={stopRequested}
          />
        )}
        {showInlineRun && (
          <InlineRunStatus
            message={message}
            locale={locale}
            onOpenWorkflow={onOpenWorkflow}
            onStop={message.busy ? onStop : undefined}
            stopRequested={stopRequested}
          />
        )}
        {message.text && message.busy && (
          <LiveOutputPanel
            text={message.text}
            streaming={message.streaming}
            onOpenArtifact={onOpenArtifact}
            onOpenMedia={onOpenMedia}
            messageId={message.id}
          />
        )}
        {message.text && !message.busy && (
          <div
            style={{
              color: "var(--ink)",
              fontSize: 14,
              lineHeight: 1.65,
              marginTop: showParallelWork || showInlineRun ? 10 : 0,
            }}
          >
            <Markdown
              text={message.text}
              messageId={message.id}
              onOpenArtifact={onOpenArtifact}
              onOpenMedia={onOpenMedia}
            />
            {message.streaming && <BlinkingCursor />}
          </div>
        )}
        {message.questions && message.questions.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 10 }}>
            {message.questions.map((q) => (
              <QuestionBlock
                key={q.id}
                question={q}
                disabled={message.busy === true || interactionBusy}
                onAnswer={(answers) => onAnswerQuestion?.(message.id, q.id, answers)}
              />
            ))}
          </div>
        )}
        {message.text && !message.busy && (
          <div style={{ display: "flex", gap: 8, marginTop: 6 }}>
            <button
              onClick={() => void navigator.clipboard.writeText(message.text)}
              style={{
                fontSize: 11,
                color: "var(--muted-deep)",
                padding: "2px 10px",
                borderRadius: 999,
                border: "1px solid var(--paper-edge)",
              }}
            >
              {t("chatstream.copy")}
            </button>
          </div>
        )}
      </div>
    </div>
  );
});
Bubble.displayName = "Bubble";

// (이전의 rAF 기반 useSmoothReveal은 제거 — 매 프레임(60fps) setState + 전체 마크다운
//  재파싱으로 긴 답변에서 스트리밍이 끊기는 주범이었다. 이제 partial 도착(≈60ms) 단위로만
//  렌더하고, StreamingMarkdown이 완결 세그먼트를 memo로 고정해 마지막 세그먼트만 재파싱한다.)

function LiveOutputPanel({
  text,
  streaming,
  messageId,
  onOpenArtifact,
  onOpenMedia,
}: {
  text: string;
  streaming?: boolean;
  messageId: string;
  onOpenArtifact?: (a: CodeArtifact) => void;
  onOpenMedia?: (a: MediaArtifact) => void;
}) {
  return (
    <div
      style={{
        color: "var(--ink-soft)",
        fontSize: 13.5,
        lineHeight: 1.6,
        marginTop: 8,
        opacity: 0.92,
      }}
    >
      {streaming ? (
        <StreamingMarkdown text={text} messageId={messageId} onOpenArtifact={onOpenArtifact} onOpenMedia={onOpenMedia} />
      ) : (
        <Markdown text={text} messageId={messageId} onOpenArtifact={onOpenArtifact} onOpenMedia={onOpenMedia} />
      )}
      {streaming && <BlinkingCursor />}
    </div>
  );
}

function InlineRunStatus({
  message,
  locale,
  onOpenWorkflow,
  onStop,
  stopRequested,
}: {
  message: StreamMessage;
  locale: "ko" | "en";
  onOpenWorkflow?: () => void;
  onStop?: () => void;
  stopRequested: boolean;
}) {
  const elapsed = useElapsedSeconds(message.startedAt, Boolean(message.busy));
  const done = !message.busy;
  const label = done ? (locale === "ko" ? "실행됨" : "Done") : (locale === "ko" ? "실행 중" : "Running");
  const detail = inlineRunDetail(message, locale, done);
  return (
    <div style={inlineRunWrapStyle} role={message.busy ? "status" : undefined}>
      <button
        type="button"
        onClick={onOpenWorkflow}
        disabled={!onOpenWorkflow}
        style={inlineRunButtonStyle(Boolean(onOpenWorkflow))}
        title={onOpenWorkflow ? (locale === "ko" ? "실행 로그 열기" : "Open run log") : undefined}
      >
        <span aria-hidden style={inlineRunDotStyle(Boolean(message.busy))} />
        <span style={inlineRunLabelStyle(Boolean(message.busy))}>{label}</span>
        {detail && <span style={inlineRunDetailStyle}>{detail}</span>}
        <span style={inlineRunTimeStyle}>{formatElapsed(elapsed, locale)}</span>
        {message.tokens != null && message.tokens > 0 && (
          <span style={inlineRunTimeStyle}>{formatTokens(message.tokens)} tokens</span>
        )}
        {onOpenWorkflow && <span aria-hidden style={inlineRunChevronStyle}>›</span>}
      </button>
      {onStop && (
        <button
          type="button"
          data-chat-stop-button="true"
          onPointerDown={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!stopRequested) onStop?.();
          }}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            if (!stopRequested) onStop?.();
          }}
          disabled={stopRequested}
          style={inlineStopButtonStyle(stopRequested)}
        >
          <span aria-hidden style={inlineStopIconStyle} />
          {stopRequested ? (locale === "ko" ? "중지 중" : "Stopping") : (locale === "ko" ? "정지" : "Stop")}
        </button>
      )}
    </div>
  );
}

function isInternalSystemNote(text: string) {
  const trimmed = text.trim();
  return (
    trimmed.startsWith("Agentlas OS operated this surface hands-free.") ||
    trimmed.startsWith("Agentlas OS prepared this surface hands-free.")
  );
}

function isParallelWorkMessage(message: StreamMessage): boolean {
  const steps = message.steps ?? [];
  const stepAgents = steps
    .map((step) => (step.agentName || step.role || "").trim().toLowerCase())
    .filter(Boolean);
  const pipelineAgents = (message.pipeline ?? [])
    .map((stage) => (stage.agentId || stage.agentName || "").trim().toLowerCase())
    .filter(Boolean);
  const uniqueAgents = new Set([...stepAgents, ...pipelineAgents]);
  const fanout = steps.some((step) => (step.delegateTo?.length ?? 0) > 1);
  return uniqueAgents.size > 1 || fanout;
}

function inlineRunDetail(message: StreamMessage, locale: "ko" | "en", done: boolean): string {
  const candidates = [
    ...(message.steps ?? []).slice().reverse().map((step) => step.text),
    message.status,
  ];
  for (const candidate of candidates) {
    const cleaned = cleanInlineStatus(candidate, locale, done);
    if (cleaned) return cleaned;
  }
  return done ? "" : locale === "ko" ? "응답 준비 중" : "Preparing response";
}

function cleanInlineStatus(value: string | undefined, locale: "ko" | "en", done: boolean): string {
  const trimmed = compactStatusText(value);
  if (!trimmed) return "";
  if (isInternalRunStatus(trimmed)) return done ? "" : locale === "ko" ? "처리 중" : "Working";
  if (/^(완료|done|completed|에이전트 작업 완료|agent work completed)$/i.test(trimmed)) return "";
  if (/^(메시지 전송 중|sending|전송 중)/i.test(trimmed)) return done ? "" : trimmed;
  return trimmed;
}

function isInternalRunStatus(value: string): boolean {
  return /stormbreaker|scope-lock|verifier-first|agentlas\s*오케스트레이터|orchestrator|루프\s*stormbreaker|loop\s*[·:]|armed|route\b/i.test(value);
}

// ── 질문 카드 ───────────────────────────────────────────
// LLM이 본문 fence로 emit한 옵션 질문. 사용자가 답하면 부모가 user 메시지로 자동 전송.
// React.memo: 다른 메시지 스트리밍 중 질문 카드 리렌더 스킵. 표시명 유지.
const QuestionBlock = memo(function QuestionBlock({
  question,
  disabled,
  onAnswer,
}: {
  question: ChatQuestion;
  disabled: boolean;
  onAnswer: (answers: string[]) => void;
}) {
  const { t } = useT();
  // lazy initializer: 매 렌더마다 new Set 생성하지 않고 최초 마운트 시에만 만든다.
  const [picked, setPicked] = useState<Set<string>>(() => new Set(question.answer ?? []));
  const [otherText, setOtherText] = useState("");
  const answered = !!question.answer && question.answer.length > 0;

  // 기타(직접 입력) — 제공된 선택지 외 자유 답변. multiSelect면 고른 것과 합쳐 보냄.
  function submitOther() {
    const v = otherText.trim();
    if (!v || answered || disabled) return;
    onAnswer(question.multiSelect ? [...picked, v] : [v]);
  }

  // useCallback + 함수형 setState: memo된 옵션 버튼에 안정적인 핸들러 전달, picked 의존성 제거.
  const toggle = useCallback(
    (label: string) => {
      if (answered || disabled) return;
      if (question.multiSelect) {
        setPicked((prev) => {
          const next = new Set(prev);
          if (next.has(label)) next.delete(label);
          else next.add(label);
          return next;
        });
      } else {
        // 단일 선택도 확인 버튼 전까지는 전송하지 않는다.
        setPicked(new Set([label]));
      }
    },
    [answered, disabled, question.multiSelect],
  );

  function submit() {
    if (answered || disabled || picked.size === 0) return;
    onAnswer([...picked]);
  }

  return (
    <div
      style={{
        border: "1px solid color-mix(in srgb, var(--accent) 20%, var(--paper-edge))",
        borderRadius: 8,
        background: "linear-gradient(180deg, #fff 0%, var(--fill-1) 100%)",
        padding: 14,
        display: "flex",
        flexDirection: "column",
        gap: 9,
        boxShadow: "0 8px 22px rgba(17, 24, 39, 0.06)",
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", gap: 8, marginBottom: 2 }}>
        <span
          style={{
            flexShrink: 0,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--accent)",
            background: "color-mix(in srgb, var(--accent) 10%, #fff)",
            padding: "2px 7px",
            borderRadius: 999,
            fontWeight: 750,
            border: "1px solid color-mix(in srgb, var(--accent) 16%, transparent)",
          }}
        >
          {question.header || "1/1"}
        </span>
        <span style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)", lineHeight: 1.45 }}>
          {question.question}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 7 }}>
        {question.options.map((opt, index) => {
          const isPicked = picked.has(opt.label);
          const isAnswered = answered && (question.answer ?? []).includes(opt.label);
          const dim = answered && !isAnswered;
          const selected = isAnswered || isPicked;
          return (
            <button
              key={opt.label}
              onClick={() => toggle(opt.label)}
              disabled={answered || disabled}
              aria-pressed={selected}
              style={{
                display: "grid",
                gridTemplateColumns: "30px minmax(0, 1fr)",
                alignItems: "flex-start",
                gap: 10,
                textAlign: "left",
                padding: "10px 11px",
                borderRadius: 8,
                border: selected
                  ? "1px solid color-mix(in srgb, var(--accent) 56%, var(--paper-edge))"
                  : "1px solid transparent",
                background: selected
                  ? "linear-gradient(135deg, color-mix(in srgb, var(--accent) 14%, #fff), color-mix(in srgb, var(--amber-deep) 8%, #fff))"
                  : "var(--paper-2)",
                boxShadow: selected ? "0 8px 18px color-mix(in srgb, var(--accent) 14%, transparent)" : "none",
                opacity: dim ? 0.45 : 1,
                cursor: answered || disabled ? "default" : "pointer",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 30,
                  height: 30,
                  flexShrink: 0,
                  borderRadius: 999,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: selected
                    ? "1px solid var(--accent)"
                    : "1px solid var(--paper-edge)",
                  background: selected ? "var(--accent)" : "var(--paper)",
                  color: selected ? "#fff" : "var(--ink-soft)",
                  fontFamily: "var(--font-mono)",
                  fontSize: 11,
                  fontWeight: 800,
                }}
              >
                {index + 1}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: 12.8,
                    fontWeight: 720,
                    color: "var(--ink)",
                    lineHeight: 1.35,
                    overflowWrap: "anywhere",
                  }}
                >
                  {opt.label}
                </span>
                {opt.description && (
                  <span
                    style={{
                      display: "block",
                      fontSize: 11.5,
                      color: "var(--muted-deep)",
                      lineHeight: 1.45,
                      marginTop: 2,
                      overflowWrap: "anywhere",
                    }}
                  >
                    {opt.description}
                  </span>
                )}
              </span>
            </button>
          );
        })}
      </div>
      {/* 기타 (직접 입력) — 선택지에 없는 답을 자유 입력 */}
      {!answered && (
        <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
          <span
            style={{
              fontSize: 10,
              fontWeight: 700,
              letterSpacing: 0.4,
              textTransform: "uppercase",
              color: "var(--muted)",
              fontFamily: "var(--font-mono)",
            }}
          >
            {t("ask.other")}
          </span>
          <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
            <input
              value={otherText}
              onChange={(e) => setOtherText(e.target.value)}
              placeholder={t("ask.other_placeholder")}
              // 타이핑 자체는 항상 허용 — 실행이 끝나기 직전(busy)에도 답을 미리 작성할 수 있게.
              // 실제 제출만 submitOther/answerQuestion 쪽 busy 가드로 통제한다.
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing) return;
                if (e.key === "Enter") {
                  e.preventDefault();
                  submitOther();
                }
              }}
              style={{
                flex: 1,
                minWidth: 0,
                padding: "8px 12px",
                borderRadius: 8,
                border: "1px solid var(--paper-edge)",
                background: "var(--paper)",
                color: "var(--ink)",
                fontSize: 12.5,
              }}
            />
            <button
              onClick={submitOther}
              disabled={!otherText.trim() || disabled}
              style={{
                flexShrink: 0,
                padding: "8px 14px",
                borderRadius: 999,
                fontSize: 12,
                fontWeight: 600,
                background: otherText.trim() ? "var(--paper)" : "var(--paper-2)",
                color: otherText.trim() ? "var(--ink)" : "var(--muted-deep)",
                border: "1px solid var(--paper-edge)",
                boxShadow: otherText.trim() ? "var(--neu-raised)" : "none",
                cursor: otherText.trim() ? "pointer" : "default",
              }}
            >
              {t("ask.submit")}
            </button>
          </div>
        </div>
      )}
      {!answered && (
        <button
          onClick={submit}
          disabled={picked.size === 0 || disabled}
          style={{
            alignSelf: "flex-end",
            padding: "6px 14px",
            borderRadius: 999,
            background: picked.size === 0 ? "var(--paper-2)" : "var(--paper)",
            color: picked.size === 0 ? "var(--muted-deep)" : "var(--ink)",
            fontSize: 12,
            fontWeight: 600,
            border: "1px solid var(--paper-edge)",
            boxShadow: picked.size === 0 ? "none" : "var(--neu-raised)",
            cursor: picked.size === 0 ? "default" : "pointer",
          }}
        >
          {t("ask.submit")}
        </button>
      )}
    </div>
  );
});
QuestionBlock.displayName = "QuestionBlock";

// ── 파이프라인 스테퍼 ──────────────────────────────────────
// 추천 시트에서 pipeline 을 고르면 시드된 단계 계획(PRD→배포)을 메시지 상단에 가로 스테퍼로 보여준다.
// 단계별 실시간 상태는 아직 신뢰성 있게 추적할 수 없으므로(엔진 이벤트→단계 매핑은 후속), 전체
// 진행/완료만 정직하게 표시하고 단계는 계획으로 노출한다.
function PipelineStepper({ stages, running }: { stages: PipelineStage[]; running: boolean }) {
  const { t, locale } = useT();
  const stageLabel = (kind: string): string => {
    const key = (kind || "").toLowerCase();
    if (key === "plan") return locale === "ko" ? "기획" : "Plan";
    if (key === "build") return locale === "ko" ? "개발" : "Build";
    if (key === "verify" || key === "qa") return locale === "ko" ? "검증·QA" : "Verify · QA";
    if (key === "deploy") return locale === "ko" ? "배포" : "Deploy";
    return kind;
  };
  return (
    <div
      style={{
        border: "1px solid var(--paper-edge)",
        background: "var(--fill-1)",
        padding: "8px 10px",
        marginBottom: 10,
        display: "flex",
        flexDirection: "column",
        gap: 6,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 700, color: "var(--ink-soft)" }}>
        <span>{t("chatstream.pipeline")}</span>
        <span style={{ opacity: 0.7 }}>· {running ? t("chatstream.running") : t("chatstream.done")}</span>
      </div>
      <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 4 }}>
        {stages.map((s, i) => {
          const st = s.status;
          const marker = st === "done" ? "✓" : st === "running" ? "●" : String(s.order);
          const markerColor =
            st === "done" ? "var(--green-deep)" : st === "running" ? "var(--amber-deep)" : "var(--ink-soft)";
          return (
            <span key={s.order} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
              <span
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 5,
                  fontSize: 12,
                  fontWeight: 600,
                  border: st === "running" ? "1px solid var(--amber-deep)" : "1px solid var(--paper-edge)",
                  background: "#fff",
                  padding: "2px 8px",
                  borderRadius: 3,
                  opacity: !st || st === "pending" ? 0.72 : 1,
                }}
                title={s.agentName ?? undefined}
              >
                <span style={{ color: markerColor, fontWeight: 700 }}>{marker}</span>
                <span>{stageLabel(s.kind)}</span>
              </span>
              {i < stages.length - 1 && <span style={{ color: "var(--ink-soft)", fontSize: 12 }}>→</span>}
            </span>
          );
        })}
      </div>
    </div>
  );
}

// ── 워킹 패널 ──────────────────────────────────────────────
// "12s 동안 작업 중입니다" + step log. Codex/Claude 데스크톱 톤.
function WorkingPanel({
  steps,
  fallback,
  startedAt,
  done,
  tokens,
  onOpenWorkflow,
  onStop,
  stopRequested = false,
}: {
  steps: StreamStep[];
  fallback?: string;
  startedAt?: number;
  done: boolean;
  tokens?: number;
  onOpenWorkflow?: () => void;
  onStop?: () => void;
  stopRequested?: boolean;
}) {
  const { t, locale } = useT();
  const elapsed = useElapsedSeconds(startedAt, !done);
  const [override, setOverride] = useState<boolean | null>(null);

  const allRows: StreamStep[] =
    steps.length > 0 ? steps : fallback ? [{ id: "_f", kind: "thinking", text: fallback }] : [];
  const latestStep = allRows[allRows.length - 1];
  const latestStepAt = latestStep?.createdAt ?? (allRows.length > 0 ? startedAt : undefined);
  const quietFor = useElapsedSeconds(latestStepAt, !done);
  const liveState = buildLiveState({
    done,
    elapsed,
    quietFor,
    latestText: latestStep?.text,
    locale,
  });
  const toolSteps = allRows.filter((s) => s.tool);
  const thinkingSteps = allRows.filter((s) => !s.tool);

  // 도구 그룹 카운트 → "실행됨 명령 N개, 읽기 파일 N개" 요약 (스크린샷 형식).
  const counts: Record<ToolGroup, number> = { command: 0, read: 0, edit: 0, search: 0, other: 0 };
  for (const s of toolSteps) counts[toolView(s.tool!, s.args, locale).group] += 1;
  const summary = buildToolSummary(counts, locale);

  // 실행 중에는 실시간 로그를 바로 보여주고, 완료 뒤에는 요약만 남긴다.
  const expanded = override ?? !done;
  const activitySummary =
    toolSteps.length > 0
      ? summary
      : locale === "ko"
        ? `진행 상황 ${thinkingSteps.length}단계`
        : `${thinkingSteps.length} progress update${thinkingSteps.length > 1 ? "s" : ""}`;

  return (
    <div
      style={{
        color: "var(--muted-deep)",
        padding: "1px 0 4px",
        display: "flex",
        flexDirection: "column",
        gap: 7,
      }}
    >
      {/* 메트릭 줄 — 실행 상태 + "2분 58초 · 94.5k tokens" */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 8,
          fontSize: 12,
          fontWeight: 500,
          flexWrap: "wrap",
          color: "var(--muted-deep)",
        }}
      >
        <span style={statusBadge(done)}>
          {!done && <PulsingDot />}
          {done && <span aria-hidden style={doneDot} />}
          <span>{done ? t("chatstream.done") : liveState.label}</span>
        </span>
        <span style={{ color: "var(--muted-deep)" }}>
          {done
            ? t("chatstream.took", { sec: formatElapsed(elapsed, locale) })
            : t("chatstream.working_for", { sec: formatElapsed(elapsed, locale) })}
          {tokens != null && tokens > 0 && ` · ${formatTokens(tokens)} tokens`}
        </span>
      </div>

      {!done && (
        <div
          style={{ ...liveStateStyle(liveState.tone), width: "min(520px, 100%)", alignItems: "center" }}
          role="status"
        >
          <span aria-hidden style={liveStateDotStyle(liveState.tone)} />
          <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 2, flex: 1 }}>
            <span style={{ fontWeight: 760, color: "var(--ink)" }}>{liveState.message}</span>
            {liveState.detail && (
              <span style={{ color: "var(--muted-deep)" }}>
                {stopRequested
                  ? locale === "ko"
                    ? "중지 요청을 보냈습니다. 실행을 정리하는 중입니다."
                    : "Stop requested. Cleaning up the run."
                  : liveState.detail}
              </span>
            )}
          </div>
          {onStop && (
            <button
              type="button"
              data-chat-stop-button="true"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!stopRequested) onStop?.();
              }}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                if (!stopRequested) onStop?.();
              }}
              disabled={stopRequested}
              style={{
                flexShrink: 0,
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                border: "1px solid color-mix(in srgb, #b42318 30%, var(--paper-edge))",
                borderRadius: 999,
                background: stopRequested ? "var(--paper-2)" : "#fff",
                color: stopRequested ? "var(--muted-deep)" : "#b42318",
                padding: "4px 10px",
                fontSize: 11.5,
                fontWeight: 760,
                cursor: stopRequested ? "default" : "pointer",
              }}
            >
              <span
                aria-hidden
                style={{ width: 8, height: 8, borderRadius: 2, background: "currentColor", flexShrink: 0 }}
              />
              {stopRequested ? (locale === "ko" ? "중지 요청됨" : "Stopping") : t("chat.stop")}
            </button>
          )}
        </div>
      )}

      {/* 작업 로그 — 접기/펴기 요약 + 목록 (Claude Code/FleetView 형식) */}
      {allRows.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <button
            onClick={() => setOverride(!expanded)}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 6,
              width: "100%",
              textAlign: "left",
              background: "transparent",
              border: "none",
              padding: 0,
              cursor: "pointer",
              fontSize: 12.5,
              fontWeight: 600,
              color: "var(--ink-soft)",
            }}
          >
            <span style={{ minWidth: 0, flex: 1 }}>{activitySummary}</span>
            <span
              aria-hidden
              style={{
                color: "var(--muted)",
                transform: expanded ? "rotate(180deg)" : "none",
                transition: "transform .12s",
                display: "inline-flex",
                flexShrink: 0,
              }}
            >
              <ChevronDown />
            </span>
          </button>
          {expanded && (
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                paddingLeft: 14,
                borderLeft: "1px solid color-mix(in srgb, var(--muted) 28%, transparent)",
                marginLeft: 3,
                minWidth: 0,
              }}
            >
              {allRows.map((s, idx) => (
                <ActivityRow
                  key={s.id}
                  step={s}
                  current={!done && idx === allRows.length - 1}
                  done={done}
                  onOpenWorkflow={onOpenWorkflow}
                />
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ActivityRow({
  step,
  current,
  done,
  onOpenWorkflow,
}: {
  step: StreamStep;
  current?: boolean;
  done: boolean;
  onOpenWorkflow?: () => void;
}) {
  if (step.tool) return <ToolActivityCard step={step} current={current} done={done} onOpenWorkflow={onOpenWorkflow} />;
  return <AgentActivityCard step={step} current={current} onOpenWorkflow={onOpenWorkflow} />;
}

function AgentActivityCard({ step, current, onOpenWorkflow }: { step: StreamStep; current?: boolean; onOpenWorkflow?: () => void }) {
  const { locale } = useT();
  const kind = step.activity ?? activityKindFromStep(step);
  const title = agentActivityTitle(step, kind, locale);
  const eyebrow = agentActivityEyebrow(step, kind, locale);
  const detail = step.text.trim();
  const isDone = kind === "complete";
  return (
    <div
      className={`agentlas-activity-card${current && !isDone ? " is-running" : ""}${isDone ? " is-complete" : ""}`}
      style={{ ...activityCardBase, cursor: onOpenWorkflow ? "pointer" : "default" }}
      role={onOpenWorkflow ? "button" : undefined}
      tabIndex={onOpenWorkflow ? 0 : undefined}
      onClick={onOpenWorkflow}
      onKeyDown={(event) => {
        if (!onOpenWorkflow) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenWorkflow();
        }
      }}
      title={locale === "ko" ? "우측 실행 로그 열기" : "Open workflow logs"}
    >
      <div style={activityCardHeader}>
        <span aria-hidden style={activityStatusDot(kind, current)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={activityTitleStyle}>{title}</div>
          <div style={activityEyebrowStyle}>{eyebrow}</div>
        </div>
        <span style={activityChevronStyle}>›</span>
      </div>
      {detail && detail !== title && (
        <div style={activityDetailStyle}>
          {detail}
        </div>
      )}
    </div>
  );
}

function ToolActivityCard({
  step,
  current,
  done,
  onOpenWorkflow,
}: {
  step: StreamStep;
  current?: boolean;
  done: boolean;
  onOpenWorkflow?: () => void;
}) {
  const { locale } = useT();
  const [argsOpen, setArgsOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const view = toolView(step.tool!, step.args, locale);
  const tone = toolTone(view.group, step.resultIsError === true);
  const hasArgs = !!(step.args && step.args !== "{}" && step.args !== "");
  const hasResult = !!(step.result && step.result.trim());
  const hasDisclosure = hasArgs || hasResult;
  const kind = step.activity ?? (view.verb === "위임" || view.verb === "delegated" ? "handoff" : "tool");
  const isRunning = current && !done && !hasResult;
  const title = toolActivityTitle(view, locale);
  const eyebrow = hasResult
    ? step.resultIsError
      ? locale === "ko" ? "에이전트 작업 오류" : "Agent work failed"
      : locale === "ko" ? "에이전트 작업 완료" : "Agent work completed"
    : isRunning
      ? locale === "ko" ? "에이전트 시작됨" : "Agent started"
      : toolActivityEyebrow(view, locale);
  return (
    <div
      className={`agentlas-activity-card${isRunning ? " is-running" : ""}${hasResult && !step.resultIsError ? " is-complete" : ""}`}
      style={{
        ...activityCardBase,
        borderColor: isRunning ? tone.border : "var(--paper-edge)",
        cursor: onOpenWorkflow ? "pointer" : "default",
      }}
      onClick={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest("pre")) return;
        onOpenWorkflow?.();
      }}
      title={locale === "ko" ? "우측 실행 로그 열기" : "Open workflow logs"}
    >
      <button
        onClick={() => {
          if (hasResult) setResultOpen((v) => !v);
          else if (hasArgs) setArgsOpen((v) => !v);
        }}
        disabled={!hasDisclosure}
        style={{
          ...activityCardButton,
          cursor: hasDisclosure ? "pointer" : "default",
        }}
      >
        <span aria-hidden style={activityStatusDot(kind, isRunning, tone.accent)} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={activityTitleStyle}>{title}</div>
          <div style={activityEyebrowStyle}>{eyebrow}</div>
        </div>
        <span style={{ ...activityPillStyle, color: tone.accent, background: tone.bg, borderColor: tone.border }}>
          {view.verb}
        </span>
        <span style={activityChevronStyle}>›</span>
      </button>
      {step.agentName && (
        <div style={activityMetaStyle}>
          {step.role ? `${step.agentName} · ${step.role}` : step.agentName}
        </div>
      )}
      {argsOpen && hasArgs && (
        <pre style={{ ...toolPre, borderColor: tone.border }}>{prettyJson(step.args!)}</pre>
      )}
      {resultOpen && hasResult && (
        <pre
          style={{
            ...toolPre,
            background: step.resultIsError
              ? "color-mix(in srgb, #fef3f2 78%, var(--paper) 22%)"
              : "color-mix(in srgb, #f0fdf4 72%, var(--paper) 28%)",
            borderColor: step.resultIsError ? "#fecdca" : "#bbf7d0",
            color: step.resultIsError ? "#7a271a" : "#14532d",
          }}
        >
          {step.result}
        </pre>
      )}
    </div>
  );
}

function ThinkingRow({ step, current }: { step: StreamStep; current?: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 7,
        minWidth: 0,
        fontSize: 12.5,
        color: "var(--ink-soft)",
      }}
    >
      <span
        aria-hidden
        style={{
          flexShrink: 0,
          marginTop: 2,
          color: current ? "var(--accent)" : "var(--muted-deep)",
          display: "inline-flex",
        }}
      >
        <ThinkingGlyph />
      </span>
      <span
        style={{
          minWidth: 0,
          overflowWrap: "anywhere",
          lineHeight: 1.45,
          fontWeight: current ? 600 : 400,
        }}
      >
        {step.text}
      </span>
    </div>
  );
}

// 단일 도구 행 — "실행됨 <명령>" / "읽기 <파일>" 형식. 입력과 결과를 각각 접고 펼침.
function ToolRow({ step, current }: { step: StreamStep; current?: boolean }) {
  const { t, locale } = useT();
  const [argsOpen, setArgsOpen] = useState(false);
  const [resultOpen, setResultOpen] = useState(false);
  const view = toolView(step.tool!, step.args, locale);
  const tone = toolTone(view.group, step.resultIsError === true);
  const hasArgs = !!(step.args && step.args !== "{}" && step.args !== "");
  const hasResult = !!(step.result && step.result.trim());
  const hasDisclosure = hasArgs || hasResult;
  return (
    <div
      style={{
        minWidth: 0,
        borderRadius: 8,
        padding: "4px 6px",
        background: current ? "color-mix(in srgb, var(--paper) 70%, var(--accent) 7%)" : "transparent",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
      <button
        onClick={() => {
          if (hasResult) setResultOpen((v) => !v);
          else if (hasArgs) setArgsOpen((v) => !v);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          minWidth: 0,
          flex: 1,
          textAlign: "left",
          background: "transparent",
          border: "none",
          padding: 0,
          fontSize: 12.5,
          color: "var(--ink-soft)",
          cursor: hasDisclosure ? "pointer" : "default",
        }}
      >
        <span
          style={{
            flexShrink: 0,
            fontSize: 11,
            color: tone.accent,
            background: tone.bg,
            border: `1px solid ${tone.border}`,
            borderRadius: 999,
            padding: "1px 6px",
            fontWeight: current ? 700 : 500,
          }}
        >
          {view.verb}
        </span>
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 12,
            color: current ? "var(--ink)" : "var(--ink-soft)",
            fontWeight: current ? 600 : 400,
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {view.label || step.tool}
        </span>
        {hasResult && (
          <span
            style={{
              color: step.resultIsError ? "#b42318" : "#15803d",
              fontSize: 11,
              fontWeight: 700,
              flexShrink: 0,
            }}
          >
            {step.resultIsError ? t("chatstream.tool_error") : t("chatstream.tool_result")}
          </span>
        )}
      </button>
        {hasArgs && (
          <button
            onClick={() => setArgsOpen((v) => !v)}
            style={{
              ...toolMiniButton,
              color: argsOpen ? tone.accent : "var(--muted-deep)",
              borderColor: argsOpen ? tone.border : "var(--paper-edge)",
            }}
          >
            {t("chatstream.tool_args")}
          </button>
        )}
        {hasResult && (
          <button
            onClick={() => setResultOpen((v) => !v)}
            style={{
              ...toolMiniButton,
              color: resultOpen ? (step.resultIsError ? "#b42318" : "#15803d") : "var(--muted-deep)",
              borderColor: resultOpen ? (step.resultIsError ? "#fecdca" : "#bbf7d0") : "var(--paper-edge)",
            }}
          >
            {step.resultIsError ? t("chatstream.tool_error") : t("chatstream.tool_result")}
          </button>
        )}
      </div>
      {argsOpen && hasArgs && (
        <pre
          style={{
            ...toolPre,
            borderColor: tone.border,
          }}
        >
          {prettyJson(step.args!)}
        </pre>
      )}
      {resultOpen && hasResult && (
        <pre
          style={{
            ...toolPre,
            background: step.resultIsError
              ? "color-mix(in srgb, #fef3f2 78%, var(--paper) 22%)"
              : "color-mix(in srgb, #f0fdf4 72%, var(--paper) 28%)",
            borderColor: step.resultIsError ? "#fecdca" : "#bbf7d0",
            color: step.resultIsError ? "#7a271a" : "#14532d",
          }}
        >
          {step.result}
        </pre>
      )}
    </div>
  );
}

// ── 도구 분류 (이름+인자 → 동사 + 간결 라벨 + 그룹) ───────────────
type ToolGroup = "command" | "read" | "edit" | "search" | "other";
interface ToolViewModel {
  group: ToolGroup;
  verb: string;
  label: string;
}

type ActivityKind = NonNullable<StreamStep["activity"]>;
type LiveStateTone = "active" | "quiet" | "stale";

function buildLiveState({
  done,
  elapsed,
  quietFor,
  latestText,
  locale,
}: {
  done: boolean;
  elapsed: number;
  quietFor: number;
  latestText?: string;
  locale: "ko" | "en";
}): { label: string; message: string; detail: string; tone: LiveStateTone } {
  if (done) {
    return {
      label: locale === "ko" ? "완료" : "Done",
      message: locale === "ko" ? "완료됐습니다." : "Completed.",
      detail: "",
      tone: "active",
    };
  }
  const current = compactStatusText(latestText);
  if (quietFor >= 180) {
    return {
      label: locale === "ko" ? "멈춤 가능성" : "Possibly stuck",
      message: locale === "ko" ? `마지막 업데이트 후 ${formatElapsed(quietFor, locale)} 동안 조용합니다.` : `No update for ${formatElapsed(quietFor, locale)}.`,
      detail: current
        ? locale === "ko"
          ? `마지막 단계: ${current}`
          : `Last step: ${current}`
        : locale === "ko"
          ? "아직 첫 진행 이벤트가 오지 않았습니다. 필요하면 중지 후 다시 보낼 수 있습니다."
          : "No first progress event yet. You can stop and retry if needed.",
      tone: "stale",
    };
  }
  if (quietFor >= 45) {
    return {
      label: locale === "ko" ? "조용히 실행 중" : "Quietly running",
      message: locale === "ko" ? `아직 실행 중입니다. 마지막 업데이트 ${formatElapsed(quietFor, locale)} 전.` : `Still running. Last update ${formatElapsed(quietFor, locale)} ago.`,
      detail: current
        ? locale === "ko"
          ? `현재 보이는 단계: ${current}`
          : `Visible step: ${current}`
        : locale === "ko"
          ? "첫 업데이트를 기다리는 중입니다."
          : "Waiting for the first update.",
      tone: "quiet",
    };
  }
  return {
    label: locale === "ko" ? "실행 중" : "Running",
    message: locale === "ko" ? "실행이 살아 있습니다." : "Run is active.",
    detail: current
      ? locale === "ko"
        ? `현재 단계: ${current}`
        : `Current step: ${current}`
      : elapsed >= 5
        ? locale === "ko"
          ? "첫 업데이트를 기다리는 중입니다."
          : "Waiting for the first update."
        : locale === "ko"
          ? "막 시작했습니다."
          : "Just started.",
    tone: "active",
  };
}

function compactStatusText(value?: string): string {
  const trimmed = (value ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return "";
  return trimmed.length > 96 ? `${trimmed.slice(0, 95)}…` : trimmed;
}

const doneDot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  background: "#16a34a",
  flexShrink: 0,
};

function statusBadge(done: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    color: done ? "#15803d" : "var(--muted-deep)",
    fontWeight: 700,
  };
}

function liveStateStyle(tone: LiveStateTone): CSSProperties {
  const color = tone === "stale" ? "#b42318" : tone === "quiet" ? "var(--amber-deep)" : "var(--green-deep)";
  const bg =
    tone === "stale"
      ? "color-mix(in srgb, #fef3f2 76%, var(--paper) 24%)"
      : tone === "quiet"
        ? "color-mix(in srgb, #fffbeb 72%, var(--paper) 28%)"
        : "color-mix(in srgb, #f0fdf4 68%, var(--paper) 32%)";
  const border = tone === "stale" ? "#fecdca" : tone === "quiet" ? "#fde68a" : "#bbf7d0";
  return {
    display: "flex",
    alignItems: "flex-start",
    gap: 8,
    width: "min(386px, 100%)",
    border: `1px solid ${border}`,
    borderRadius: 8,
    background: bg,
    color,
    padding: "8px 10px",
    fontSize: 11.5,
    lineHeight: 1.42,
    overflow: "hidden",
  };
}

function liveStateDotStyle(tone: LiveStateTone): CSSProperties {
  const color = tone === "stale" ? "#d92d20" : tone === "quiet" ? "var(--amber-deep)" : "var(--green-deep)";
  return {
    width: 8,
    height: 8,
    marginTop: 4,
    borderRadius: "50%",
    flexShrink: 0,
    background: color,
    boxShadow: `0 0 0 4px color-mix(in srgb, ${color} 14%, transparent)`,
  };
}

const inlineRunWrapStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  minWidth: 0,
  padding: "1px 0 4px",
  flexWrap: "wrap",
};

function inlineRunButtonStyle(clickable: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 7,
    minWidth: 0,
    maxWidth: "100%",
    border: "none",
    background: "transparent",
    padding: 0,
    color: "var(--muted-deep)",
    fontSize: 12.5,
    lineHeight: 1.45,
    cursor: clickable ? "pointer" : "default",
    textAlign: "left",
  };
}

function inlineRunDotStyle(active: boolean): CSSProperties {
  return {
    width: 7,
    height: 7,
    borderRadius: "50%",
    flexShrink: 0,
    background: active ? "var(--green-deep)" : "var(--muted)",
    boxShadow: active ? "0 0 0 4px color-mix(in srgb, var(--green-deep) 13%, transparent)" : undefined,
  };
}

function inlineRunLabelStyle(active: boolean): CSSProperties {
  return {
    flexShrink: 0,
    fontWeight: 800,
    color: active ? "transparent" : "var(--ink-soft)",
    backgroundImage: active
      ? "linear-gradient(90deg, var(--green-deep), var(--accent), var(--amber-deep))"
      : undefined,
    backgroundClip: active ? "text" : undefined,
    WebkitBackgroundClip: active ? "text" : undefined,
  };
}

const inlineRunDetailStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--ink-soft)",
  fontWeight: 650,
};

const inlineRunTimeStyle: CSSProperties = {
  flexShrink: 0,
  color: "var(--muted)",
  fontSize: 11,
  fontWeight: 650,
};

const inlineRunChevronStyle: CSSProperties = {
  flexShrink: 0,
  color: "var(--muted)",
  fontSize: 18,
  lineHeight: 1,
};

function inlineStopButtonStyle(disabled: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    flexShrink: 0,
    border: "none",
    background: "transparent",
    color: disabled ? "var(--muted)" : "#b42318",
    padding: "0 2px",
    fontSize: 11.5,
    fontWeight: 800,
    cursor: disabled ? "default" : "pointer",
  };
}

const inlineStopIconStyle: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: 2,
  background: "currentColor",
  flexShrink: 0,
};

const toolMiniButton: CSSProperties = {
  flexShrink: 0,
  border: "1px solid var(--paper-edge)",
  borderRadius: 999,
  background: "var(--paper)",
  padding: "2px 7px",
  fontSize: 11,
  fontWeight: 700,
  cursor: "pointer",
};

const toolPre: CSSProperties = {
  margin: "5px 0 2px 0",
  padding: "8px 10px",
  background: "var(--paper)",
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  fontSize: 11,
  fontFamily: "var(--font-mono)",
  color: "var(--ink-soft)",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 220,
  overflow: "auto",
};

const activityCardBase: CSSProperties = {
  position: "relative",
  width: "min(386px, 100%)",
  minHeight: 58,
  overflow: "hidden",
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "color-mix(in srgb, var(--paper-2) 88%, var(--paper) 12%)",
  padding: "10px 12px",
  boxShadow: "0 1px 2px rgba(11, 11, 15, 0.03)",
};

const activityCardHeader: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  minWidth: 0,
};

const activityCardButton: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 9,
  width: "100%",
  minWidth: 0,
  border: "none",
  background: "transparent",
  padding: 0,
  textAlign: "left",
};

const activityTitleStyle: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--ink)",
  fontSize: 12.5,
  fontWeight: 720,
  letterSpacing: 0,
};

const activityEyebrowStyle: CSSProperties = {
  marginTop: 2,
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  color: "var(--muted-deep)",
  fontSize: 11.5,
  fontWeight: 560,
  letterSpacing: 0,
};

const activityDetailStyle: CSSProperties = {
  marginTop: 8,
  color: "var(--ink-soft)",
  fontSize: 11.5,
  lineHeight: 1.45,
  overflowWrap: "anywhere",
  display: "-webkit-box",
  WebkitLineClamp: 2,
  WebkitBoxOrient: "vertical",
  overflow: "hidden",
};

const activityMetaStyle: CSSProperties = {
  marginTop: 7,
  color: "var(--muted-deep)",
  fontSize: 10.5,
  fontWeight: 650,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const activityPillStyle: CSSProperties = {
  flexShrink: 0,
  border: "1px solid var(--paper-edge)",
  borderRadius: 999,
  padding: "2px 7px",
  fontSize: 10.5,
  fontWeight: 760,
};

const activityChevronStyle: CSSProperties = {
  flexShrink: 0,
  color: "var(--muted)",
  fontSize: 22,
  lineHeight: 1,
  marginLeft: 1,
};

function activityStatusDot(kind: ActivityKind, active?: boolean, accent?: string): CSSProperties {
  const base = accent ?? (kind === "complete" ? "var(--green-deep)" : kind === "handoff" ? "var(--accent)" : "var(--muted-deep)");
  return {
    width: kind === "handoff" ? 10 : 9,
    height: 9,
    borderRadius: kind === "handoff" ? 3 : "50%",
    flexShrink: 0,
    background: active || kind === "complete" ? base : "transparent",
    border: active || kind === "complete" ? "none" : `1.5px solid ${base}`,
    boxShadow: active ? `0 0 0 4px color-mix(in srgb, ${base} 14%, transparent)` : undefined,
  };
}

function activityKindFromStep(step: StreamStep): ActivityKind {
  if (step.delegateTo && step.delegateTo.length > 0) return "handoff";
  if (step.phase === "delegate") return "start";
  if (step.phase === "synthesize") return "complete";
  return "status";
}

function agentActivityTitle(step: StreamStep, kind: ActivityKind, locale: "ko" | "en"): string {
  const name = step.agentName || (locale === "ko" ? "에이전트" : "Agent");
  if (kind === "handoff") return locale === "ko" ? `${name} 위임` : `${name} delegation`;
  return name;
}

function agentActivityEyebrow(step: StreamStep, kind: ActivityKind, locale: "ko" | "en"): string {
  if (kind === "complete") return locale === "ko" ? "에이전트 작업 완료" : "Agent work completed";
  if (kind === "handoff") {
    const count = step.delegateTo?.length ?? 0;
    if (count > 0) return locale === "ko" ? `${count}개 에이전트로 위임` : `Delegated to ${count} agent${count > 1 ? "s" : ""}`;
    return locale === "ko" ? "위임" : "Delegation";
  }
  if (kind === "start") return locale === "ko" ? "에이전트 시작됨" : "Agent started";
  if (step.role) return step.role;
  return locale === "ko" ? "에이전트" : "Agent";
}

function toolActivityTitle(view: ToolViewModel, locale: "ko" | "en"): string {
  const label = view.label || (locale === "ko" ? "에이전트 작업" : "Agent task");
  if (view.verb === "위임") return `${label} 위임`;
  if (view.verb === "delegated") return `Delegated ${label}`;
  return locale === "ko" ? `${view.verb} ${label}` : `${view.verb} ${label}`;
}

function toolActivityEyebrow(view: ToolViewModel, locale: "ko" | "en"): string {
  if (view.verb === "위임" || view.verb === "delegated") return locale === "ko" ? "에이전트" : "Agent";
  return locale === "ko" ? "에이전트 작업" : "Agent activity";
}

function toolTone(group: ToolGroup, isError: boolean): { accent: string; bg: string; border: string } {
  if (isError) {
    return { accent: "#b42318", bg: "#fef3f2", border: "#fecdca" };
  }
  const tones: Record<ToolGroup, { accent: string; bg: string; border: string }> = {
    command: { accent: "#2563eb", bg: "#eff6ff", border: "#bfdbfe" },
    read: { accent: "#0f766e", bg: "#ecfdf5", border: "#99f6e4" },
    edit: { accent: "#b45309", bg: "#fffbeb", border: "#fde68a" },
    search: { accent: "#7c3aed", bg: "#f5f3ff", border: "#ddd6fe" },
    other: { accent: "#475569", bg: "#f8fafc", border: "#cbd5e1" },
  };
  return tones[group];
}

const VERB: Record<ToolGroup, { ko: string; en: string }> = {
  command: { ko: "실행됨", en: "ran" },
  read: { ko: "읽기", en: "read" },
  edit: { ko: "편집", en: "edited" },
  search: { ko: "검색", en: "searched" },
  other: { ko: "사용", en: "used" },
};

function baseName(p: string): string {
  const parts = p.split(/[/\\]/).filter(Boolean);
  return parts[parts.length - 1] || p;
}
function squish(s: string, n = 72): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
}
function parseArgs(s?: string): Record<string, unknown> {
  if (!s) return {};
  try {
    const o = JSON.parse(s);
    return o && typeof o === "object" ? (o as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function toolView(tool: string, argsStr: string | undefined, locale: "ko" | "en"): ToolViewModel {
  const a = parseArgs(argsStr);
  const name = tool.toLowerCase();
  const str = (x: unknown) => (typeof x === "string" ? x : "");
  const v = (g: ToolGroup) => VERB[g][locale];
  if (name.includes("stormbreaker")) {
    const label = tool.replace(/^.*Stormbreaker(?: Loop)?\s*·\s*/i, "Stormbreaker Loop · ");
    return { group: "other", verb: locale === "ko" ? "루프" : "loop", label: squish(label) };
  }
  if (name === "bash")
    return { group: "command", verb: v("command"), label: squish(str(a.command).split("\n")[0]) };
  if (name === "grep")
    return {
      group: "search",
      verb: v("search"),
      label: squish(`grep ${str(a.pattern)}${a.path ? " " + str(a.path) : ""}`),
    };
  if (name === "glob")
    return { group: "search", verb: v("search"), label: squish(`find ${str(a.pattern) || str(a.glob)}`) };
  if (name === "read")
    return {
      group: "read",
      verb: v("read"),
      label: baseName(str(a.file_path) || str(a.path) || str(a.notebook_path)),
    };
  if (name === "edit" || name === "multiedit" || name === "write" || name === "notebookedit")
    return { group: "edit", verb: v("edit"), label: baseName(str(a.file_path) || str(a.notebook_path)) };
  if (name === "websearch") return { group: "search", verb: v("search"), label: squish(str(a.query)) };
  if (name === "webfetch")
    return { group: "command", verb: locale === "ko" ? "가져옴" : "fetched", label: squish(str(a.url)) };
  if (name === "task")
    return {
      group: "command",
      verb: locale === "ko" ? "위임" : "delegated",
      label: squish(str(a.description) || str(a.subagent_type)),
    };
  if (name.startsWith("mcp__")) {
    const parts = tool.split("__");
    const pretty = parts.length >= 3 ? `${parts[1]}·${parts.slice(2).join("·")}` : tool;
    return { group: "command", verb: locale === "ko" ? "호출" : "called", label: pretty };
  }
  return { group: "other", verb: v("other"), label: tool };
}

function buildToolSummary(counts: Record<ToolGroup, number>, locale: "ko" | "en"): string {
  const order: ToolGroup[] = ["command", "read", "edit", "search", "other"];
  const ko: Record<ToolGroup, (n: number) => string> = {
    command: (n) => `실행됨 명령 ${n}개`,
    read: (n) => `읽기 파일 ${n}개`,
    edit: (n) => `편집 파일 ${n}개`,
    search: (n) => `검색 ${n}개`,
    other: (n) => `도구 ${n}개`,
  };
  const en: Record<ToolGroup, (n: number) => string> = {
    command: (n) => `ran ${n} command${n > 1 ? "s" : ""}`,
    read: (n) => `read ${n} file${n > 1 ? "s" : ""}`,
    edit: (n) => `edited ${n} file${n > 1 ? "s" : ""}`,
    search: (n) => `${n} search${n > 1 ? "es" : ""}`,
    other: (n) => `${n} tool${n > 1 ? "s" : ""}`,
  };
  const fmt = locale === "ko" ? ko : en;
  return order
    .filter((g) => counts[g] > 0)
    .map((g) => fmt[g](counts[g]))
    .join(", ");
}

function ChevronDown() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="m6 9 6 6 6-6" />
    </svg>
  );
}

function prettyJson(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function formatTokens(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

function ThinkingGlyph() {
  return (
    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M9 18h6M10 22h4M12 2a7 7 0 0 0-4 12.7V17h8v-2.3A7 7 0 0 0 12 2z" />
    </svg>
  );
}

function PulsingDot() {
  return (
    <span
      aria-hidden
      style={{
        width: 7,
        height: 7,
        borderRadius: "50%",
        background: "var(--accent)",
        boxShadow: "0 0 0 3px color-mix(in srgb, var(--accent) 12%, transparent)",
        flexShrink: 0,
      }}
    />
  );
}

function BlinkingCursor() {
  return (
    <span
      aria-hidden
      style={{
        display: "inline-block",
        width: 7,
        height: 14,
        marginLeft: 2,
        verticalAlign: "text-bottom",
        background: "var(--accent)",
        opacity: 0.55,
        borderRadius: 1,
      }}
    />
  );
}

function useElapsedSeconds(startedAt: number | undefined, ticking: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking || !startedAt) return;
    // 경과초 표시는 1초 단위라 250ms→1000ms로 낮춰 초당 setState 4회→1회.
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [ticking, startedAt]);
  if (!startedAt) return 0;
  return Math.max(0, Math.floor((now - startedAt) / 1000));
}

function formatElapsed(sec: number, locale: "ko" | "en"): string {
  if (sec < 60) return locale === "ko" ? `${sec}초` : `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return locale === "ko" ? `${m}분 ${s}초` : `${m}m ${s}s`;
}
