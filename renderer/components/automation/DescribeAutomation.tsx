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
            {busy ? (ko ? "정리하는 중…" : "Working…") : (ko ? "초안 잡기" : "Draft it")}
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
              {busy ? (ko ? "정리하는 중…" : "Working…") : (ko ? "답 보내기" : "Send answers")}
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
                    {ko ? " — 바깥으로 나감, 실행 전 확인" : " — goes outside, asks first"}
                  </span>
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
          <div style={{ display: "flex", gap: 8 }}>
            <button data-testid="describe-create" onClick={() => void create()} disabled={busy} style={btn(true)}>
              {busy ? (ko ? "저장하는 중…" : "Saving…") : (ko ? "이대로 저장" : "Save it")}
            </button>
            <button onClick={reset} style={btn(false)}>{ko ? "취소" : "Discard"}</button>
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
