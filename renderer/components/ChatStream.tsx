// 메시지 스트림 렌더 — agent 메시지는 Markdown으로, 사용자 메시지는 plain.
// 작업 중 메시지는 Codex/Claude 데스크톱처럼 step log + 경과 시간을 실시간으로 보여준다.
"use client";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { InstalledAgent, InstalledFirm, InstalledMcpServer, Project, RuntimeCommand } from "@/lib/types";
import type { AgentlasAppDefinition } from "@/lib/apps";
import { AgentAvatar } from "./AgentAvatar";
import { Markdown, type CodeArtifact } from "./Markdown";
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
  onAnswerQuestion,
}: {
  messages: StreamMessage[];
  agentName: string;
  agentTone: InstalledAgent["tone"];
  emptyDirectory?: ChatEmptyDirectory;
  onOpenArtifact?: (a: CodeArtifact) => void;
  /** 사용자가 질문에 답함 — 부모가 user 메시지로 전송 */
  onAnswerQuestion?: (messageId: string, questionId: string, answers: string[]) => void;
}) {
  const { t } = useT();
  const scrollRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !stickToBottomRef.current) return;
    const handle = window.setTimeout(() => {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    }, 0);
    return () => window.clearTimeout(handle);
  }, [messages]);

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
          onAnswerQuestion={onAnswerQuestion}
        />
      ))}
    </div>
  );
}

function Bubble({
  message,
  agentName,
  agentTone,
  onOpenArtifact,
  onAnswerQuestion,
}: {
  message: StreamMessage;
  agentName: string;
  agentTone: InstalledAgent["tone"];
  onOpenArtifact?: (a: CodeArtifact) => void;
  onAnswerQuestion?: (messageId: string, questionId: string, answers: string[]) => void;
}) {
  const { t } = useT();
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
  // agent — Markdown 렌더링. 작업 중이거나 step/tool 기록이 있으면 워킹 패널(완료 후엔 시간·토큰·툴블록).
  const showWorking = message.busy || (message.steps && message.steps.length > 0);
  return (
    <div style={{ display: "flex", gap: 10, alignSelf: "stretch", maxWidth: 820 }}>
      <div style={{ position: "relative", flexShrink: 0 }}>
        <AgentAvatar name={agentName} tone={agentTone} size={28} />
      </div>
      <div style={{ minWidth: 0, flex: 1, paddingTop: 1 }}>
        {showWorking && (
          <WorkingPanel
            steps={message.steps ?? []}
            fallback={message.status}
            startedAt={message.startedAt}
            done={!message.busy}
            tokens={message.tokens}
          />
        )}
        {message.text && message.busy && (
          <LiveOutputPanel
            text={message.text}
            streaming={message.streaming}
            onOpenArtifact={onOpenArtifact}
            messageId={message.id}
          />
        )}
        {message.text && !message.busy && (
          <div
            style={{
              color: "var(--ink)",
              fontSize: 14,
              lineHeight: 1.65,
              marginTop: showWorking ? 10 : 0,
            }}
          >
            <Markdown
              text={message.text}
              messageId={message.id}
              onOpenArtifact={onOpenArtifact}
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
                disabled={message.busy === true}
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
}

function LiveOutputPanel({
  text,
  streaming,
  messageId,
  onOpenArtifact,
}: {
  text: string;
  streaming?: boolean;
  messageId: string;
  onOpenArtifact?: (a: CodeArtifact) => void;
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
      <Markdown text={text} messageId={messageId} onOpenArtifact={onOpenArtifact} />
      {streaming && <BlinkingCursor />}
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

// ── 질문 카드 ───────────────────────────────────────────
// LLM이 본문 fence로 emit한 옵션 질문. 사용자가 답하면 부모가 user 메시지로 자동 전송.
function QuestionBlock({
  question,
  disabled,
  onAnswer,
}: {
  question: ChatQuestion;
  disabled: boolean;
  onAnswer: (answers: string[]) => void;
}) {
  const { t } = useT();
  const [picked, setPicked] = useState<Set<string>>(new Set(question.answer ?? []));
  const [otherText, setOtherText] = useState("");
  const answered = !!question.answer && question.answer.length > 0;

  // 기타(직접 입력) — 제공된 선택지 외 자유 답변. multiSelect면 고른 것과 합쳐 보냄.
  function submitOther() {
    const v = otherText.trim();
    if (!v || answered || disabled) return;
    onAnswer(question.multiSelect ? [...picked, v] : [v]);
  }

  function toggle(label: string) {
    if (answered) return;
    if (question.multiSelect) {
      const next = new Set(picked);
      if (next.has(label)) next.delete(label);
      else next.add(label);
      setPicked(next);
    } else {
      // 단일 선택 — 클릭 즉시 답변
      onAnswer([label]);
    }
  }

  function submit() {
    if (answered || picked.size === 0) return;
    onAnswer([...picked]);
  }

  return (
    <div
      style={{
        border: "1px solid var(--paper-edge)",
        borderRadius: 0,
        background: "#fff",
        padding: 12,
        display: "flex",
        flexDirection: "column",
        gap: 7,
        boxShadow: "none",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 2 }}>
        <span
          style={{
            flexShrink: 0,
            fontSize: 11,
            fontFamily: "var(--font-mono)",
            color: "var(--amber-deep)",
            background: "var(--fill-1)",
            padding: "2px 7px",
            borderRadius: 999,
            fontWeight: 750,
          }}
        >
          {question.header || "1/1"}
        </span>
        <span style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>
          {question.question}
        </span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
        {question.options.map((opt, index) => {
          const isPicked = picked.has(opt.label);
          const isAnswered = answered && (question.answer ?? []).includes(opt.label);
          const dim = answered && !isAnswered;
          return (
            <button
              key={opt.label}
              onClick={() => toggle(opt.label)}
              disabled={answered || disabled}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: 10,
                textAlign: "left",
                padding: "9px 10px",
                borderRadius: 8,
                border: isAnswered || isPicked
                  ? "1px solid color-mix(in srgb, var(--accent) 34%, var(--paper-edge))"
                  : "1px solid transparent",
                background: isAnswered || isPicked ? "var(--fill-1)" : "var(--paper-2)",
                opacity: dim ? 0.45 : 1,
                cursor: answered || disabled ? "default" : "pointer",
              }}
            >
              <span style={{ flex: 1, minWidth: 0 }}>
                <span
                  style={{
                    display: "block",
                    fontSize: 12.5,
                    fontWeight: 600,
                    color: "var(--ink)",
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
                    }}
                  >
                    {opt.description}
                  </span>
                )}
              </span>
              <span
                aria-hidden
                style={{
                  minWidth: 22,
                  height: 22,
                  flexShrink: 0,
                  borderRadius: 6,
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  border: "1px solid var(--paper-edge)",
                  background: "var(--paper)",
                  color: isAnswered || isPicked ? "var(--accent)" : "var(--muted-deep)",
                  fontSize: 11,
                  fontWeight: 700,
                }}
              >
                {index + 1}
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
              disabled={disabled}
              onKeyDown={(e) => {
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
      {question.multiSelect && !answered && (
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
}

// ── 워킹 패널 ──────────────────────────────────────────────
// "12s 동안 작업 중입니다" + step log. Codex/Claude 데스크톱 톤.
function WorkingPanel({
  steps,
  fallback,
  startedAt,
  done,
  tokens,
}: {
  steps: StreamStep[];
  fallback?: string;
  startedAt?: number;
  done: boolean;
  tokens?: number;
}) {
  const { t, locale } = useT();
  const elapsed = useElapsedSeconds(startedAt, !done);
  const [override, setOverride] = useState<boolean | null>(null);

  const allRows: StreamStep[] =
    steps.length > 0 ? steps : fallback ? [{ id: "_f", kind: "thinking", text: fallback }] : [];
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
        ? `진행 로그 ${thinkingSteps.length}개`
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
          <span>{done ? t("chatstream.done") : t("chatstream.running")}</span>
        </span>
        <span style={{ color: "var(--muted-deep)" }}>
          {done
            ? t("chatstream.took", { sec: formatElapsed(elapsed, locale) })
            : t("chatstream.working_for", { sec: formatElapsed(elapsed, locale) })}
          {tokens != null && tokens > 0 && ` · ${formatTokens(tokens)} tokens`}
        </span>
      </div>

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
                s.tool ? (
                  <ToolRow key={s.id} step={s} current={!done && idx === allRows.length - 1} />
                ) : (
                  <ThinkingRow key={s.id} step={s} current={!done && idx === allRows.length - 1} />
                )
              ))}
            </div>
          )}
        </div>
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
    const id = setInterval(() => setNow(Date.now()), 250);
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
