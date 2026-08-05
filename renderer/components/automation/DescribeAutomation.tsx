// 말로 설명하면 자동화를 만들어 주는 입구.
//
// 사람이 한 문장을 쓰면, 제품이 **함부로 정하면 안 되는 것만** 되묻고 그래프를 만든다.
// 그래프는 청사진에서 코드가 짓는다(모델이 노드·연결을 직접 쓰지 않는다) — 그래서
// 참/거짓 미선언 분기나 상한 없는 반복 같은, 실사용에서 사람을 막았던 형태가 나올 수 없다.
//
// 만든 것은 **꺼진 채로** 저장된다. 자동화는 사람이 없는 동안 도는 것이라,
// "만들어 뒀습니다"로 끝내면 안 된다.
"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import type { WorkflowGraph } from "@/lib/types";
import { humanSchedule } from "@shared/graph-blueprint";

interface Question { id: string; question: string; why: string; choices?: string[] }
interface Ready {
  blueprint: { name?: string; goal?: string };
  graph: WorkflowGraph;
  scheduleHuman: string;
  triggerType: "schedule" | "manual";
}

const MAX_ROUNDS = 6;

export function DescribeAutomation({ locale, onCreated }: {
  locale: "ko" | "en";
  onCreated: () => void;
}) {
  const ko = locale === "ko";
  const router = useRouter();
  const [request, setRequest] = useState("");
  const [state, setState] = useState<{ request: string; answers: unknown[]; asked: string[]; round: number } | null>(null);
  const [questions, setQuestions] = useState<Question[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [ready, setReady] = useState<Ready | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<{ reason: string; nextAction: string } | null>(null);
  // ★저장 후 상태 — 실측: 저장이 조용히 끝나고 화면 전환이 늦자 사람이 버튼을 8번 눌러
  //   같은 그래프 사본이 8개 쌓였다. 저장했으면 "저장했고 이동 중"이라고 말해야 한다.
  const [saved, setSaved] = useState(false);
  // 확인 화면에서 "고칠 점"을 말하면 인터뷰로 되돌아간다 — 취소가 전부 버리면 안 된다.
  const [revision, setRevision] = useState("");

  async function turn(next: typeof state) {
    const api = ipc();
    if (!api || !next) return;
    setBusy(true);
    setProblem(null);
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

  async function create() {
    const api = ipc();
    if (!api || !ready || saved) return;
    setBusy(true);
    try {
      const res = await api.automations.createFromBlueprint({
        name: ready.blueprint.name || (ko ? "새 자동화" : "New automation"),
        graph: ready.graph,
        scheduleHuman: ready.scheduleHuman,
        // ★목적 문장 — 저장 안 하면 "이게 무슨 그래프인지"를 아는 유일한 문장이 여기서 사라진다.
        goal: ready.blueprint.goal,
      });
      if (!res.ok) { setProblem({ reason: res.reason, nextAction: res.nextAction }); return; }
      // ★저장됐다고 먼저 말하고, 화면을 지우지 않은 채 캔버스로 이동한다.
      //   저장 직후 reset()으로 카드를 지우면 — 특히 이동이 느릴 때 — 사람 눈에는
      //   "아무 일도 안 일어남"으로 보이고, 버튼을 다시 누른다(실측: 사본 8개).
      setSaved(true);
      onCreated();
      router.push(`/automation/flow?id=${res.id}`);
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
    setRequest(""); setState(null); setQuestions([]); setDrafts({}); setReady(null); setProblem(null);
    setSaved(false); setRevision("");
  }

  const mutations = (ready?.graph.nodes ?? []).filter((n) => n.config?.effect === "mutation");

  return (
    <section
      data-testid="describe-automation"
      style={{
        border: "1px solid var(--paper-edge)", borderRadius: "var(--radius-md)",
        background: "var(--paper)", padding: 16, display: "grid", gap: 12, marginBottom: 20,
      }}
    >
      <div style={{ fontSize: 14, fontWeight: 700, color: "var(--ink)" }}>
        {ko ? "자동으로 돌릴 일을 적어 주세요." : "Tell me what to run for you."}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
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
      </div>

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
                  // ★확인 없이 나가는 단계는 눈에 띄어야 한다 — 사람이 그렇게 정했더라도
                  //   저장 전에 자기가 무엇을 풀었는지 다시 보는 자리가 여기뿐이다.
                  node.config?.approval === "auto" ? (
                    <span style={{ color: "var(--red-deep, #b4533a)", fontWeight: 600 }}>
                      {ko ? " — 바깥으로 나감, 확인 없이 바로" : " — goes outside without asking"}
                    </span>
                  ) : (
                    <span style={{ color: "var(--muted-deep)" }}>
                      {ko ? " — 바깥으로 나감, 실행 전 확인" : " — goes outside, asks first"}
                    </span>
                  )
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
              display: "flex", alignItems: "center", gap: 8,
              padding: "10px 12px", borderRadius: "var(--radius-sm)",
              background: "var(--paper-2)", border: "1px solid var(--paper-edge)",
              fontSize: 13, fontWeight: 600, color: "var(--ink)",
            }}>
              <span className="describe-spinner" aria-hidden />
              {ko ? "저장했습니다 — 캔버스로 이동하는 중…" : "Saved — opening the canvas…"}
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
