// 말로 설명하면 자동화를 만들어 주는 입구.
//
// 사람이 한 문장을 쓰면, 제품이 **함부로 정하면 안 되는 것만** 되묻고 그래프를 만든다.
// 그래프는 청사진에서 코드가 짓는다(모델이 노드·연결을 직접 쓰지 않는다) — 그래서
// 참/거짓 미선언 분기나 상한 없는 반복 같은, 실사용에서 사람을 막았던 형태가 나올 수 없다.
//
// 만든 것은 **꺼진 채로** 저장된다. 자동화는 사람이 없는 동안 도는 것이라,
// "만들어 뒀습니다"로 끝내면 안 된다.
"use client";
import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ipc, ipcEvents } from "@/lib/ipc";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import type { GraphBuildRecoveryPlan, WorkflowGraph } from "@/lib/types";
import { humanSchedule } from "@shared/graph-blueprint";
import { IconClose } from "@/components/Icon";

interface Question { id: string; question: string; why: string; choices?: string[] }
interface Ready {
  blueprint: { name?: string; goal?: string };
  graph: WorkflowGraph;
  scheduleHuman: string;
  triggerType: "schedule" | "manual";
}

interface InterviewState {
  request: string;
  answers: unknown[];
  asked: string[];
  round: number;
}

interface RecoveryState {
  plan: GraphBuildRecoveryPlan;
  blocked: {
    nodeId: string; label: string; cause: string;
    availableVars: string[]; upstreamSample: string | null;
    varsSnapshot: Record<string, unknown>;
  };
}

interface PersistedInterview {
  request: string;
  state: InterviewState | null;
  questions: Question[];
  drafts: Record<string, string>;
  ready: Ready | null;
  problem: { reason: string; nextAction: string } | null;
  recovery: RecoveryState | null;
  graphOverride: WorkflowGraph | null;
  saved: boolean;
  savedId: string | null;
  revision: string;
}

function readPersistedInterview(key?: string): PersistedInterview | null {
  if (!key || typeof window === "undefined") return null;
  try {
    const parsed = JSON.parse(window.localStorage.getItem(key) ?? "null") as PersistedInterview | null;
    return parsed && typeof parsed.request === "string" ? parsed : null;
  } catch {
    return null;
  }
}

const MAX_ROUNDS = 6;

export function DescribeAutomation({
  locale,
  onCreated,
  openAfterCreate = true,
  onOpenAutomation,
  initialRequest = "",
  autoStart = false,
  presentation = "standalone",
  persistenceKey,
}: {
  locale: "ko" | "en";
  onCreated: (automationId: string) => void;
  /** One keeps the completed draft in its interview instead of ejecting to the canvas. */
  openAfterCreate?: boolean;
  onOpenAutomation?: (automationId: string) => void;
  /** Chat-authored `@graph ...` command, already visible as the user bubble. */
  initialRequest?: string;
  autoStart?: boolean;
  presentation?: "standalone" | "chat";
  /** Main chat identity keeps an unfinished interview intact across reloads. */
  persistenceKey?: string;
}) {
  const ko = locale === "ko";
  const router = useRouter();
  const persistedRef = useRef<PersistedInterview | null>(readPersistedInterview(persistenceKey));
  const autoStartedRef = useRef(false);
  const persisted = persistedRef.current;
  const [request, setRequest] = useState(persisted?.request ?? initialRequest);
  const [state, setState] = useState<InterviewState | null>(persisted?.state ?? null);
  const [questions, setQuestions] = useState<Question[]>(persisted?.questions ?? []);
  const [drafts, setDrafts] = useState<Record<string, string>>(persisted?.drafts ?? {});
  const [ready, setReady] = useState<Ready | null>(persisted?.ready ?? null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ reason: string; nextAction: string } | null>(persisted?.problem ?? null);
  /**
   * 짓다 막혔을 때 **이어갈 길**. 문장 한 줄로 끝내지 않는다 — 오너 2026-08-20:
   * "50% 정도 완성하다 실패를 했을 때도 이어갈 수 있어야지, 대안을 제시한다거나."
   */
  const [recovery, setRecovery] = useState<RecoveryState | null>(persisted?.recovery ?? null);
  const [applying, setApplying] = useState<string | null>(null);
  const [graphOverride, setGraphOverride] = useState<WorkflowGraph | null>(persisted?.graphOverride ?? null);
  // ★저장 후 상태 — 실측: 저장이 조용히 끝나고 화면 전환이 늦자 사람이 버튼을 8번 눌러
  //   같은 그래프 사본이 8개 쌓였다. 저장했으면 "저장했고 이동 중"이라고 말해야 한다.
  const [saved, setSaved] = useState(persisted?.saved ?? false);
  const [savedId, setSavedId] = useState<string | null>(persisted?.savedId ?? null);
  // 확인 화면에서 "고칠 점"을 말하면 인터뷰로 되돌아간다 — 취소가 전부 버리면 안 된다.
  const [revision, setRevision] = useState(persisted?.revision ?? "");
  /**
   * ★만들어지는 동안 **정해진 단계가 도착하는 대로** 보여준다.
   *
   * 예전에는 답이 끝날 때까지 "정리하는 중…" 한 줄뿐이라, 사람은 몇 십 초를 아무것도
   * 안 보이는 화면에서 기다렸다(그 침묵이 저장 버튼 연타의 뿌리이기도 하다).
   * 런타임은 이미 조각을 주고 있었고 판정기가 버리던 것을 열었다.
   */
  const [liveSteps, setLiveSteps] = useState<string[]>([]);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    if (!persistenceKey) return;
    const snapshot: PersistedInterview = {
      request,
      state,
      questions,
      drafts,
      ready,
      problem,
      recovery,
      graphOverride,
      saved,
      savedId,
      revision,
    };
    try { window.localStorage.setItem(persistenceKey, JSON.stringify(snapshot)); } catch { /* live state remains usable */ }
  }, [drafts, graphOverride, persistenceKey, problem, questions, ready, recovery, request, revision, saved, savedId, state]);

  useEffect(() => {
    const events = ipcEvents();
    if (!events?.on) return;
    return events.on("automations:interview:steps", (payload: unknown) => {
      const row = payload as { index?: number; title?: string } | null;
      if (!row?.title) return;
      setLiveSteps((prev) => (prev.includes(row.title!) ? prev : [...prev, row.title!]));
    });
  }, []);

  async function turn(next: typeof state) {
    const api = ipc();
    if (!api || !next) return;
    setBusy(true);
    setProblem(null);
    setLiveSteps([]);
    try {
      const res = await api.automations.interviewGraph(next);
      if (!res.ok) { setProblem({ reason: res.reason, nextAction: res.nextAction }); return; }
      if (res.kind === "ask") {
        setQuestions(res.questions);
        setDrafts({});
        setReady(null);
      } else {
        setQuestions([]);
        setReady({
          blueprint: res.blueprint as Ready["blueprint"],
          graph: res.graph,
          scheduleHuman: res.scheduleHuman,
          triggerType: res.triggerType,
        });
      }
      setState(next);
    } catch {
      setProblem({
        reason: ko ? "만들지 못했습니다." : "Could not build it.",
        nextAction: ko ? "잠시 뒤 다시 시도해 주세요." : "Try again in a moment.",
      });
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!autoStart || autoStartedRef.current || state || ready || saved) return;
    const value = (initialRequest || request).trim();
    if (!value) return;
    autoStartedRef.current = true;
    setRequest(value);
    void turn({ request: value, answers: [], asked: [], round: 0 });
    // `turn` intentionally owns the request lifecycle for this mount. Re-running
    // because a function identity changed would duplicate the Graph interview.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoStart, initialRequest]);

  function start() {
    if (!request.trim()) return;
    void turn({ request: request.trim(), answers: [], asked: [], round: 0 });
  }

  function answer() {
    if (!state) return;
    const given = questions
      .map((q) => ({ questionId: q.id, question: q.question, answer: (drafts[q.id] ?? "").trim() }))
      .filter((a) => a.answer);
    if (given.length !== questions.length) return;
    void turn({
      request: state.request,
      answers: [...state.answers, ...given],
      asked: [...new Set([...state.asked, ...given.map((a) => a.questionId)])],
      round: state.round + 1,
    });
  }

  /**
   * 저장 전에 한 번 돌려 본다. 막히면 **저장하지 않고** 이어갈 길을 보여준다.
   * `force` 는 사람이 "지금 상태로 저장(꺼둠)"을 고른 경우다.
   */
  async function create(force = false) {
    const api = ipc();
    if (!api || !ready || saved) return;
    setBusy(true);
    try {
      const graph = graphOverride ?? ready.graph;
      if (!force) {
        setProblem(null);
        setRecovery(null);
        const pre = await api.automations.checkBlueprintBeforeSave({
          graph,
          goal: ready.blueprint.goal,
        });
        /*
         * ★확인이 스스로 고친 단계가 있으면 **그 코드로 저장한다.** 안 그러면 고쳐 놓고
         *   안 되는 원본을 저장하게 되고, 사용자는 왜 여전히 안 되는지 알 수 없다
         *   (실측 2026-08-20: 첫 배선이 정확히 그랬다 — 고친 코드가 그냥 버려졌다).
         */
        if (pre.repaired && pre.repaired.length > 0) {
          const fixes = new Map(pre.repaired.map((r) => [r.nodeId, r.code]));
          const patched: WorkflowGraph = {
            ...graph,
            nodes: graph.nodes.map((n) => (
              fixes.has(n.id) ? { ...n, config: { ...(n.config ?? {}), code: fixes.get(n.id)! } } : n
            )),
          };
          setGraphOverride(patched);
          if (pre.ok) { void createWith(patched); return; }
        }
        if (!pre.ok && pre.blocked) {
          // ★고쳐진 단계가 있으면 그것부터 그래프에 반영한다 — 사람이 다시 안 하게.
          if (pre.recovery && !pre.recovery.unavailable) {
            // ★사실을 그대로 들고 있는다 — 칩을 누를 때 이 값으로 수리를 증명한다.
            setRecovery({ plan: pre.recovery, blocked: pre.blocked });
            return;
          }
          setProblem({
            reason: pre.blocked.cause || (ko ? "아직 안 되는 단계가 있습니다." : "A step does not work yet."),
            nextAction: ko ? "대화에서 이어서 봐 주세요." : "Let us look at it together in chat.",
          });
          return;
        }
      }
      await createWith(graphOverride ?? ready.graph);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 실제 저장. **넘겨받은 그래프 그대로** 저장한다 — setState 를 기다리면 그 사이에
   * 옛 그래프가 저장된다(React 상태는 다음 렌더에야 보인다).
   */
  async function createWith(graph: WorkflowGraph) {
    const api = ipc();
    if (!api || !ready) return;
    try {
      const res = await api.automations.createFromBlueprint({
        name: ready.blueprint.name || (ko ? "새 자동화" : "New automation"),
        graph,
        scheduleHuman: ready.scheduleHuman,
        // ★목적 문장 — 저장 안 하면 "이게 무슨 그래프인지"를 아는 유일한 문장이 여기서 사라진다.
        goal: ready.blueprint.goal,
      });
      if (!res.ok) { setProblem({ reason: res.reason, nextAction: res.nextAction }); return; }
      // ★저장됐다고 먼저 말하고, 화면을 지우지 않은 채 캔버스로 이동한다.
      //   저장 직후 reset()으로 카드를 지우면 — 특히 이동이 느릴 때 — 사람 눈에는
      //   "아무 일도 안 일어남"으로 보이고, 버튼을 다시 누른다(실측: 사본 8개).
      setSaved(true);
      setSavedId(res.id);
      onCreated(res.id);
      if (openAfterCreate) router.push(`/automation/flow?id=${res.id}`);
    } catch {
      // 조용한 실패 금지 — 예외가 나가면 버튼만 풀리고 아무 말이 없다.
      setProblem({
        reason: ko ? "저장하지 못했습니다." : "Could not save it.",
        nextAction: ko ? "잠시 뒤 다시 시도해 주세요." : "Try again in a moment.",
      });
    } finally {
      setBusy(false);
    }
  }

  /** 칩을 눌렀을 때 — 호스트가 실제로 실행한다. 누를 수 없는 칩은 칩이 아니다. */
  async function applyRecovery(actionId: string) {
    const api = ipc();
    if (!api || !ready || !recovery) return;
    setApplying(actionId);
    try {
      const res = await api.automations.applyBuildRecovery({
        graph: graphOverride ?? ready.graph,
        goal: ready.blueprint.goal,
        blocked: recovery.blocked,
        actionId,
      });
      if (res.graph) {
        // 고쳐진 그래프로 갈아 끼우고 다시 저장을 시도한다 — 사람이 같은 걸 또 누르지 않게.
        setGraphOverride(res.graph);
        setRecovery(null);
        setProblem(null);
        void create();
        return;
      }
      if (res.saveNow) { setRecovery(null); void create(true); return; }
      /*
       * ★한 칩이 안 통했다고 **나머지 칩을 지우지 않는다.** 실측 2026-08-20: 재작성이
       *   실패하자 칩이 전부 사라지고 "대화에서 같이 봐 주세요"만 남았다 — 그 순간
       *   "지금 상태로 저장(꺼둠)"도 함께 사라져, 만든 것을 지킬 길이 없어졌다.
       *   막다른 길을 만들지 않는다: 안 통한 칩만 빼고 나머지는 남긴다.
       */
      setRecovery((prev) => (prev
        ? { ...prev, plan: { ...prev.plan, options: prev.plan.options.filter((o) => o.actionId !== actionId) } }
        : prev));
      setProblem({
        reason: res.message,
        nextAction: res.continueInChat
          ? (ko ? "이 자동화의 대화에서 이어서 봅니다." : "Continuing in this automation's chat.")
          : (ko ? "다른 방법을 골라 주세요." : "Pick another way to continue."),
      });
    } catch {
      setProblem({
        reason: ko ? "이 조치를 실행하지 못했습니다." : "Could not run that action.",
        nextAction: ko ? "잠시 뒤 다시 시도해 주세요." : "Try again in a moment.",
      });
    } finally {
      setApplying(null);
    }
  }

  /** 확인 화면에서 "이 부분을 고쳐 주세요"라고 말하면 인터뷰가 한 턴 더 돈다. */
  function revise() {
    if (!state || !revision.trim()) return;
    const note = revision.trim();
    setRevision("");
    setReady(null);
    void turn({
      request: state.request,
      answers: [...state.answers, {
        questionId: `revise-${state.round}`,
        question: ko ? "확인 화면을 보고 사람이 고쳐 달라고 한 것" : "Revision the person asked for after reviewing the plan",
        answer: note,
      }],
      asked: state.asked,
      round: state.round + 1,
    });
  }

  function reset() {
    const restartRequest = presentation === "chat" ? initialRequest.trim() : "";
    setRequest(restartRequest); setState(null); setQuestions([]); setDrafts({}); setReady(null); setProblem(null);
    setRecovery(null); setGraphOverride(null); setSaved(false); setSavedId(null); setRevision("");
    if (persistenceKey) {
      try { window.localStorage.removeItem(persistenceKey); } catch { /* state reset still succeeds */ }
    }
    if (presentation === "chat" && restartRequest) {
      autoStartedRef.current = true;
      void turn({ request: restartRequest, answers: [], asked: [], round: 0 });
    } else {
      autoStartedRef.current = false;
    }
  }

  const mutations = (ready?.graph.nodes ?? []).filter((n) => n.config?.effect === "mutation");
  if (dismissed) return null;

  return (
    <section
      data-testid="describe-automation"
      data-presentation={presentation}
      style={{
        position: "relative",
        border: "1px solid var(--paper-edge)", borderRadius: 18,
        background: "var(--paper)", padding: 24, display: "grid", gap: 12,
        boxShadow: "0 12px 30px rgba(20, 25, 30, .06)",
        marginBottom: presentation === "chat" ? 8 : 20,
        ...(presentation === "chat" ? { maxWidth: 720 } : {}),
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>
          {presentation === "chat"
            ? (ko ? "One이 이 대화에서 자동화를 설계합니다" : "One is designing this automation in chat")
            : (ko ? "자동으로 돌릴 일을 적어 주세요." : "Tell me what to run for you.")}
        </div>
        <button type="button" aria-label={ko ? "닫기" : "Close"} onClick={() => setDismissed(true)} style={{ width: 32, height: 32, display: "inline-grid", placeItems: "center", flex: "0 0 auto", marginTop: -8, marginRight: -8, padding: 0, border: 0, borderRadius: 9, background: "transparent", color: "var(--muted-deep)", cursor: "pointer" }}>
          <IconClose size={14} />
        </button>
      </div>
      {presentation === "chat" ? (
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 12 }}>
          <div style={{ color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.55 }}>{request}</div>
          {(state || ready || saved) && <button data-testid="describe-reset" onClick={reset} style={{ ...btn(false), flex: "0 0 auto", padding: "6px 10px", fontSize: 11 }}>
            {ko ? "다시 시작" : "Start over"}
          </button>}
        </div>
      ) : <div style={{ display: "flex", gap: 8 }}>
        <input
          data-testid="describe-input"
          value={request}
          disabled={busy || !!state}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") start(); }}
          placeholder={ko
            ? "예: 평일 아침 8시에 블로그 글감 세 개 뽑아서 메모앱에 저장"
            : "e.g. weekday mornings at 8, pull three blog topics and save them to my notes"}
          style={{
            flex: 1, padding: "10px 12px", borderRadius: "var(--radius-sm)",
            border: "1px solid var(--paper-edge)", background: "var(--paper-2)",
            color: "var(--ink)", fontSize: 13, outline: "none",
          }}
        />
        {state ? (
          <button data-testid="describe-reset" onClick={reset} style={btn(false)}>
            {ko ? "처음부터 다시" : "Start over"}
          </button>
        ) : (
          <button data-testid="describe-start" onClick={start} disabled={busy || !request.trim()} style={btn(true)}>
            {busy ? <SpinnerLabel text={ko ? "정리하는 중…" : "Working…"} light /> : (ko ? "초안 잡기" : "Draft it")}
          </button>
        )}
      </div>}

      {busy && liveSteps.length > 0 ? (
        <ol data-testid="describe-live-steps" style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 3 }}>
          {liveSteps.map((title, i) => (
            <li key={`${i}-${title}`} style={{ fontSize: 12, color: "var(--ink-soft)" }}>{title}</li>
          ))}
        </ol>
      ) : null}
      {busy ? <LoadingEstimate
        locale={locale}
        operationKey={ready ? "one-graph-preflight-save" : "one-graph-interview"}
        expectedSeconds={ready ? [2, 45] : [10, 120]}
        hardMaxSeconds={ready ? 46 : 121}
      /> : null}

      {questions.length > 0 ? (
        <div data-testid="describe-questions" style={{ display: "grid", gap: 12 }}>
          <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>
            {ko
              ? `임의로 정하면 안 되는 항목입니다 (${(state?.round ?? 0) + 1}번째 / 최대 ${MAX_ROUNDS}번)`
              : `These are not mine to decide (round ${(state?.round ?? 0) + 1} of ${MAX_ROUNDS})`}
          </div>
          {questions.map((q) => (
            <div key={q.id} style={{ display: "grid", gap: 6 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{q.question}</div>
              {q.why ? <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>{q.why}</div> : null}
              {q.choices?.length ? (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
                  {q.choices.map((choice) => (
                    <button
                      key={choice}
                      onClick={() => setDrafts((d) => ({ ...d, [q.id]: choice }))}
                      style={{
                        ...btn(false),
                        padding: "5px 10px", fontSize: 12,
                        // ★shorthand(border)와 개별 속성(borderColor)을 섞으면 리렌더에서
                        //   제거 순서가 꼬인다(React 경고, 실측 항목 13). 항상 전체 border로.
                        border: `1px solid ${drafts[q.id] === choice ? "var(--accent-soft)" : "var(--paper-edge)"}`,
                        ...(drafts[q.id] === choice ? { color: "var(--ink)" } : {}),
                      }}
                    >
                      {choice}
                    </button>
                  ))}
                </div>
              ) : null}
              <input
                data-testid={`describe-answer-${q.id}`}
                value={drafts[q.id] ?? ""}
                onChange={(e) => setDrafts((d) => ({ ...d, [q.id]: e.target.value }))}
                placeholder={ko ? "답을 적어 주세요 (판단이 서지 않으면 \"알아서 해주세요\")" : "Your answer — or \"you decide\""}
                style={{
                  padding: "8px 10px", borderRadius: "var(--radius-sm)",
                  border: "1px solid var(--paper-edge)", background: "var(--paper-2)",
                  color: "var(--ink)", fontSize: 13, outline: "none",
                }}
              />
            </div>
          ))}
          <div>
            <button
              data-testid="describe-answer-submit"
              onClick={answer}
              disabled={busy || questions.some((q) => !(drafts[q.id] ?? "").trim())}
              style={btn(true)}
            >
              {busy ? <SpinnerLabel text={ko ? "정리하는 중…" : "Working…"} light /> : (ko ? "답 보내기" : "Send answers")}
            </button>
          </div>
        </div>
      ) : null}

      {ready ? (
        <div data-testid="describe-ready" style={{ display: "grid", gap: 8 }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>{ready.blueprint.name}</div>
          {ready.blueprint.goal ? (
            <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>{ready.blueprint.goal}</div>
          ) : null}
          <ol style={{ margin: 0, paddingLeft: 18, display: "grid", gap: 3 }}>
            {ready.graph.nodes.filter((n) => n.type !== "trigger").map((node) => (
              <li key={node.id} style={{ fontSize: 12, color: "var(--ink)" }}>
                {node.label}
                {node.config?.effect === "mutation" ? (
                  /* ★승인 게이트 폐지(오너 이사회 결정 2026-08-10) — 커널은 실행 중에
                     멈춰 묻지 않는다. 옛 approval 선언이 남아 있어도 멈춰 묻는다고 말하면
                     거짓이므로, 바깥으로 나가는 단계는 전부 같은 사실 하나만 알린다:
                     이 단계는 묻지 않고 바깥으로 나간다. 이 화면이 사람이 그 사실을 보는
                     마지막 자리다. */
                  <span style={{ color: "var(--red-deep, var(--danger))", fontWeight: 600 }}>
                    {ko ? " — 바깥으로 나감, 확인 없이 바로" : " — goes outside without asking"}
                  </span>
                ) : null}
                {/* ★AI가 제안한 채점표를 저장 전에 사람이 본다 — 항목이 곧 판정 기준이므로
                    안 보이면 무엇으로 채점되는지 모른 채 승인하는 셈이다. */}
                {/* ★누가 이 단계를 하는지 — 편성 결과를 저장 전에 보여준다.
                    안 보이면 사람은 "누가 내 일을 하는지" 모른 채 승인하게 된다. */}
                {typeof node.config?.role === "string" && node.config.role ? (
                  <span style={{ color: "var(--muted-deep)" }}>
                    {node.config?.ref
                      ? ` · ${node.config.targetType === "hub" ? "Hub" : ko ? "설치본" : "installed"}: ${String(node.config.ref)}`
                      : (ko ? ` · 일꾼 미정 (${node.config.role})` : ` · unstaffed (${node.config.role})`)}
                  </span>
                ) : null}
                {Array.isArray(node.config?.items) && (node.config.items as Array<{ text?: string; kind?: string }>).length > 0 ? (
                  <ul data-testid="describe-checklist" style={{ margin: "3px 0 0", paddingLeft: 14, display: "grid", gap: 2 }}>
                    {(node.config.items as Array<{ text?: string; kind?: string }>).map((item, i) => (
                      <li key={i} style={{ fontSize: 11, color: "var(--muted-deep)", listStyle: "none" }}>
                        {item.kind === "mustNot" ? "✕" : "✓"} {item.text}
                        <span style={{ opacity: 0.7 }}>
                          {item.kind === "mustNot" ? (ko ? " (하면 안 됨)" : " (must not)") : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </li>
            ))}
          </ol>
          <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>
            {ready.triggerType === "schedule"
              ? (ko ? `${humanSchedule(ready.scheduleHuman, "ko")}에 실행` : `Runs ${humanSchedule(ready.scheduleHuman, "en")}`)
              : (ko ? "값을 넣을 때만 실행합니다." : "Runs only when you give it a value.")}
            {mutations.length ? (ko ? ` · 바깥으로 나가는 단계 ${mutations.length}개` : ` · ${mutations.length} step(s) go outside`) : ""}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>
            {ko
              ? "꺼진 상태로 저장됩니다. 직접 켜기 전에는 돌지 않습니다."
              : "Saved switched off. It does not run until you turn it on."}
          </div>
          {saved ? (
            <div data-testid="describe-saved" style={{
              display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12,
              padding: "10px 12px", borderRadius: "var(--radius-sm)",
              background: "var(--paper-2)", border: "1px solid var(--paper-edge)",
              fontSize: 13, fontWeight: 600, color: "var(--ink)",
            }}>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 8 }}>
                {openAfterCreate && <span className="describe-spinner" aria-hidden />}
                {openAfterCreate
                  ? (ko ? "저장했습니다 — 캔버스로 이동하는 중…" : "Saved — opening the canvas…")
                  : (ko ? "자동화 초안을 저장했습니다. 아직 꺼진 상태입니다." : "Automation draft saved. It remains switched off.")}
              </span>
              {!openAfterCreate && presentation !== "chat" && savedId && <button
                type="button"
                style={btn(false)}
                onClick={() => onOpenAutomation ? onOpenAutomation(savedId) : router.push(`/automation/flow?id=${savedId}`)}
              >{ko ? "정밀 편집" : "Precise editor"}</button>}
            </div>
          ) : (
            <>
              <div style={{ display: "flex", gap: 8 }}>
                <button data-testid="describe-create" onClick={() => void create()} disabled={busy} style={btn(true)}>
                  {busy ? <SpinnerLabel text={ko ? "저장하는 중…" : "Saving…"} light /> : (ko ? "이대로 저장" : "Save it")}
                </button>
                <button onClick={reset} style={btn(false)}>{ko ? "버리기" : "Discard"}</button>
              </div>
              {/* ★취소가 전부 버리는 문이면 안 된다 — 확인 화면에서 본 것을 고쳐 달라고
                  말하면 인터뷰가 한 턴 더 돈다(지금까지의 답은 그대로 산다). */}
              <div style={{ display: "flex", gap: 8 }}>
                <input
                  data-testid="describe-revision"
                  value={revision}
                  disabled={busy}
                  onChange={(e) => setRevision(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter") revise(); }}
                  placeholder={ko ? "고칠 점이 있으면 적어 주세요 — 예: 메일 대신 파일로 저장" : "Anything to change? e.g. save to a file instead of email"}
                  style={{
                    flex: 1, padding: "8px 10px", borderRadius: "var(--radius-sm)",
                    border: "1px solid var(--paper-edge)", background: "var(--paper-2)",
                    color: "var(--ink)", fontSize: 12, outline: "none",
                  }}
                />
                <button onClick={revise} disabled={busy || !revision.trim()} style={{ ...btn(false), fontSize: 12 }}>
                  {ko ? "고쳐서 다시" : "Revise"}
                </button>
              </div>
            </>
          )}
        </div>
      ) : null}

      {recovery ? (
        <div data-testid="describe-recovery" style={{ display: "grid", gap: 10 }}>
          <div style={{ fontSize: 13, color: "var(--ink)", lineHeight: 1.55 }}>{recovery.plan.summary}</div>
          {recovery.plan.question ? (
            <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)" }}>{recovery.plan.question}</div>
          ) : null}
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {recovery.plan.options.map((option) => (
              <button
                key={option.actionId}
                type="button"
                data-testid={`recovery-chip-${option.kind}`}
                disabled={applying !== null}
                onClick={() => void applyRecovery(option.actionId)}
                style={{
                  borderRadius: 999,
                  border: "1px solid var(--line)",
                  padding: "7px 13px",
                  fontSize: 12.5,
                  background: "var(--surface)",
                  color: "var(--ink)",
                  cursor: applying ? "default" : "pointer",
                  opacity: applying && applying !== option.actionId ? 0.5 : 1,
                }}
              >
                {applying === option.actionId
                  ? <SpinnerLabel text={ko ? "하는 중…" : "Working…"} />
                  : option.label}
              </button>
            ))}
          </div>
        </div>
      ) : null}
      {problem ? (
        <div data-testid="describe-problem" style={{ display: "grid", gap: 4 }}>
          <div style={{ fontSize: 13, color: "var(--ink)" }}>{problem.reason}</div>
          <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>{problem.nextAction}</div>
        </div>
      ) : null}
    </section>
  );
}

/** 도는 중임을 몸으로 보여주는 라벨 — 글자만 "Working…"으로 바꾸면 아무도 못 알아본다(실측). */
function SpinnerLabel({ text, light }: { text: string; light?: boolean }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 7 }}>
      <span className={light ? "describe-spinner describe-spinner-light" : "describe-spinner"} aria-hidden />
      {text}
    </span>
  );
}

function btn(primary: boolean): React.CSSProperties {
  return {
    padding: "8px 14px",
    borderRadius: "var(--radius-md)",
    border: `1px solid ${primary ? "var(--ink)" : "var(--paper-edge)"}`,
    background: primary ? "var(--ink)" : "var(--paper)",
    color: primary ? "var(--paper)" : "var(--ink-soft)",
    fontWeight: 600,
    fontSize: 13,
    cursor: "pointer",
  };
}
