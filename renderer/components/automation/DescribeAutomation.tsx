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
    if (!api || !ready) return;
    setBusy(true);
    try {
      const res = await api.automations.createFromBlueprint({
        name: ready.blueprint.name || (ko ? "새 자동화" : "New automation"),
        graph: ready.graph,
        scheduleHuman: ready.scheduleHuman,
      });
      if (!res.ok) { setProblem({ reason: res.reason, nextAction: res.nextAction }); return; }
      reset();
      onCreated();
      router.push(`/automation/flow?id=${res.id}`);
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setRequest(""); setState(null); setQuestions([]); setDrafts({}); setReady(null); setProblem(null);
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
        {ko ? "무엇을 자동으로 하고 싶으세요?" : "What would you like automated?"}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          data-testid="describe-input"
          value={request}
          disabled={busy || !!state}
          onChange={(e) => setRequest(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") start(); }}
          placeholder={ko
            ? "예: 매일 아침에 오늘 쓸 블로그 글감 하나 뽑아줘"
            : "e.g. every morning, give me one blog topic to write about"}
          style={{
            flex: 1, padding: "10px 12px", borderRadius: "var(--radius-sm)",
            border: "1px solid var(--paper-edge)", background: "var(--paper-2)",
            color: "var(--ink)", fontSize: 13, outline: "none",
          }}
        />
        {state ? (
          <button data-testid="describe-reset" onClick={reset} style={btn(false)}>
            {ko ? "처음부터" : "Start over"}
          </button>
        ) : (
          <button data-testid="describe-start" onClick={start} disabled={busy || !request.trim()} style={btn(true)}>
            {busy ? (ko ? "생각 중…" : "Thinking…") : (ko ? "만들기" : "Build it")}
          </button>
        )}
      </div>

      {questions.length > 0 ? (
        <div data-testid="describe-questions" style={{ display: "grid", gap: 12 }}>
          <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>
            {ko
              ? `제가 대신 정하면 안 되는 것들입니다 (${(state?.round ?? 0) + 1}번째 / 최대 ${MAX_ROUNDS}번)`
              : `A few things I should not decide for you (round ${(state?.round ?? 0) + 1} of ${MAX_ROUNDS})`}
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
                        ...(drafts[q.id] === choice ? { borderColor: "var(--accent-soft)", color: "var(--ink)" } : {}),
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
                placeholder={ko ? "여기에 답하세요 (모르시면 \"알아서 해주세요\")" : "Your answer (or \"you decide\")"}
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
              {busy ? (ko ? "생각 중…" : "Thinking…") : (ko ? "답했어요" : "Answered")}
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
                  <span style={{ color: "var(--muted-deep)" }}>
                    {ko ? " — 바깥을 바꿈, 실행 전 확인" : " — goes outside, asks first"}
                  </span>
                ) : null}
              </li>
            ))}
          </ol>
          <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>
            {ready.triggerType === "schedule"
              ? (ko ? `실행 시각: ${ready.scheduleHuman}` : `Runs on: ${ready.scheduleHuman}`)
              : (ko ? "값을 넣을 때마다 실행합니다." : "Runs whenever you give it a value.")}
            {mutations.length ? (ko ? ` · 바깥으로 나가는 단계 ${mutations.length}개` : ` · ${mutations.length} step(s) go outside`) : ""}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted-deep)" }}>
            {ko
              ? "꺼진 상태로 만듭니다. 확인하고 직접 켜셔야 돌아갑니다."
              : "It is created switched off. Nothing runs until you turn it on."}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <button data-testid="describe-create" onClick={() => void create()} disabled={busy} style={btn(true)}>
              {busy ? (ko ? "만드는 중…" : "Creating…") : (ko ? "이대로 만들기" : "Create it")}
            </button>
            <button onClick={reset} style={btn(false)}>{ko ? "그만두기" : "Discard"}</button>
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
