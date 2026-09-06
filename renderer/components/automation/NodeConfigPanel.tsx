// 노드 설정 패널(설계 §4, P1) — 선택된 워크플로우 노드의 config를 타입별로 편집한다.
// trigger 노드는 전체 스케줄 빌더(§2.5 전체 문법)를, agent 노드는 대상/프롬프트/런타임 override,
// tool 노드는 catalog 선택, condition은 조건식, 나머지는 label/produces/consumes를 노출한다.
"use client";
import { useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT, pickLocalized } from "@/lib/i18n";
import { visibleAgents } from "@/lib/agent-visibility";
import type {
  WorkflowNode,
  ScheduleSpec,
  InstalledAgent,
  InstalledFirm,
  MarketplaceListing,
  McpToolCatalogEntry,
  RuntimeStatus,
} from "@/lib/types";
import { ScheduleBuilder } from "./ScheduleBuilder";
import { NODE_ACCENT } from "./nodes/nodeShared";
import { IconClose } from "@/components/Icon";
import { defaultNodeEffect } from "@/lib/graph-node-effect";

/**
 * 레거시 스케줄 토큰("cron:…", "daily-HH:MM", "weekday-HH:MM", "weekly-<dow>-HH:MM",
 * "monthly-<D>-HH:MM", "hourly", "every-Nm"/"every-Nh") → ScheduleSpec 복원. 챗 생성/레거시
 * 그래프의 트리거는 scheduleSpec 없이 토큰만 갖는데, 복원 없이는 빌더가 daily-09:00 기본값으로
 * 마운트되며 즉시 onChange를 방출해 — 트리거 노드를 클릭만 해도 기존 스케줄이 덮어써졌다.
 *
 * 문법은 백엔드 store/schedule.ts parseLegacyToken의 미러여야 한다. every-Nm이 빠져 있어
 * Stormbreaker 장기 실행 continuation("every-30m", scheduleSpec 없음)이 트리거 노드 클릭만으로
 * 하루 1회 09:00으로 바뀌었다. hourly도 백엔드와 같이 interval 1h(lastRun 기준)로 복원한다 —
 * cron "0 * * * *"로 복원하면 발사 기준이 조용히 정시 고정으로 바뀐다.
 */
const LEGACY_DOW = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
export function specFromLegacyToken(token: string, tz: string): ScheduleSpec | null {
  const s = token.trim();
  if (!s) return null;
  if (s.startsWith("cron:")) {
    const expr = s.slice(5).trim();
    return expr ? { kind: "cron", expr, tz } : null;
  }
  if (s === "hourly") return { kind: "interval", everyMs: 60 * 60 * 1000, anchor: "lastRun" };
  const every = s.match(/^every-(\d+)(m|h)$/);
  if (every) {
    const amount = parseInt(every[1], 10);
    if (!(amount > 0)) return null;
    const minutes = every[2] === "h" ? amount * 60 : amount;
    return { kind: "interval", everyMs: minutes * 60 * 1000, anchor: "lastRun" };
  }
  const hm = (v: string): { h: number; m: number } | null => {
    const m = v.match(/^(\d{1,2}):(\d{2})$/);
    return m ? { h: parseInt(m[1], 10), m: parseInt(m[2], 10) } : null;
  };
  let m = s.match(/^daily-(.+)$/);
  if (m) {
    const t = hm(m[1]);
    return t ? { kind: "cron", expr: `${t.m} ${t.h} * * *`, tz } : null;
  }
  m = s.match(/^weekday-(.+)$/);
  if (m) {
    const t = hm(m[1]);
    return t ? { kind: "cron", expr: `${t.m} ${t.h} * * 1-5`, tz } : null;
  }
  m = s.match(/^weekly-([a-z]{3})-(.+)$/);
  if (m) {
    const dow = LEGACY_DOW.indexOf(m[1]);
    const t = hm(m[2]);
    return dow >= 0 && t ? { kind: "cron", expr: `${t.m} ${t.h} * * ${dow}`, tz } : null;
  }
  m = s.match(/^monthly-(\d{1,2})-(.+)$/);
  if (m) {
    const t = hm(m[2]);
    return t ? { kind: "cron", expr: `${t.m} ${t.h} ${parseInt(m[1], 10)} * *`, tz } : null;
  }
  // ★그래프 인터뷰가 저장하는 스케줄 토큰은 원시 5필드 cron일 수 있다("*/20 * * * *").
  //   이 분기가 없으면 복원이 null이 되고, ScheduleBuilder가 value=null로 마운트해
  //   daily-09:00 기본값을 즉시 방출한다 — 트리거 노드를 **클릭만** 해도 unsaved가
  //   켜지고, Save를 누르면 20분 주기가 하루 1회로 조용히 덮어써진다
  //   (synthesizeLegacyGraph 주석의 그 사고가 그래프 경로에서 재발, 실측 2026-08-06).
  const fields = s.split(/\s+/);
  if (fields.length === 5 && fields.every((f) => /^[\dA-Za-z*,/-]+$/.test(f))) {
    return { kind: "cron", expr: s, tz };
  }
  return null;
}


/**
 * 이 패널 전용 이중언어 헬퍼.
 *
 * ★실사용 실측(2026-08-06): 앱 언어가 English인데 이 패널만 "무엇을 계산·가공하나",
 * "스크립트 (AI가 채웁니다…)"처럼 한국어가 그대로 나와, 같은 화면에서 언어가 반쪽씩
 * 섞였다. 문자열 78곳이 하드코딩이고 locale 분기는 한 곳뿐이었다.
 * i18n 키를 새로 78개 만드는 대신 여기서 짝을 맞춘다 — 문구와 번역이 같은 줄에 있어
 * 한쪽만 고치는 드리프트가 구조적으로 안 생긴다.
 */
function bi(locale: "ko" | "en", ko: string, en: string): string {
  return locale === "en" ? en : ko;
}

export function NodeConfigPanel({
  node,
  onPatch,
  onLabel,
  onDelete,
  onClose,
  timezone,
  automationId,
}: {
  node: WorkflowNode;
  /** config 부분 갱신(머지). 부모가 그래프 노드에 반영 + dirty 표시. */
  onPatch: (patch: Record<string, unknown>) => void;
  /** 노드 표시 라벨 갱신. */
  onLabel: (label: string) => void;
  onDelete: () => void;
  onClose: () => void;
  /** 자동화 행의 타임존 — 레거시 토큰 복원 시 cron 해석 존(노드 config엔 tz가 없다). */
  timezone?: string | null;
  /** 지금 편집 중인 자동화 — 자기 자신을 부를 후보에서 빼기 위해 필요하다. */
  automationId?: string;
}) {
  const { t, locale } = useT();
  // 예시→채점표 역생성 상태
  const [exampleDraft, setExampleDraft] = useState("");
  const [exampleBusy, setExampleBusy] = useState(false);
  const [exampleError, setExampleError] = useState("");
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [hubAgents, setHubAgents] = useState<MarketplaceListing[]>([]);
  const [tools, setTools] = useState<McpToolCatalogEntry[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);
  /**
   * 이 단계에서 부를 수 있는 자동화들.
   * ★자기 자신은 뺀다 — 고를 수 있게 보여 놓고 커널이 거절하면 화면이 거짓말한 것이다
   *   (커널의 SUBGRAPH_SELF_CALL 과 같은 판단을 화면이 먼저 한다).
   */
  const [callableGraphs, setCallableGraphs] = useState<Array<{ id: string; name: string }>>([]);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    void (async () => {
      const [ag, fm, tl, rt, hub] = await Promise.all([
        api.team.list(),
        api.firms.list(),
        api.mcpTools.listCatalog(),
        api.runtime.detect(),
        api.marketplace.search("").catch(() => []),
      ]);
      setAgents(visibleAgents(ag));
      setFirms(fm);
      setTools(tl);
      setRuntimes(rt);
      setHubAgents(hub);
      const list = await api.automations.list().catch(() => []);
      setCallableGraphs(
        list
          .filter((row) => row.id !== automationId && (row.graph?.nodes?.length ?? 0) > 0)
          .map((row) => ({ id: row.id, name: row.name })),
      );
    })();
  }, [automationId]);

  const cfg = node.config ?? {};
  const s = (k: string): string => (typeof cfg[k] === "string" ? (cfg[k] as string) : "");

  // trigger 노드의 기존 spec — scheduleSpec 우선, 없으면 레거시 토큰(config.schedule)에서 복원.
  const triggerSpec = useMemo<ScheduleSpec | null>(() => {
    const raw = cfg.scheduleSpec;
    if (raw && typeof raw === "object" && typeof (raw as { kind?: unknown }).kind === "string") {
      return raw as ScheduleSpec;
    }
    const token = typeof cfg.schedule === "string" ? cfg.schedule : "";
    const tz = timezone && timezone.trim() ? timezone : Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    return specFromLegacyToken(token, tz);
  }, [cfg.scheduleSpec, cfg.schedule, timezone]);

  return (
    <aside
      className="titlebar-nodrag automation-embedded-panel automation-node-config"
      style={{
        background: "var(--paper)",
        overflowY: "auto",
        padding: 16,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span
          style={{
            fontSize: 10,
            fontFamily: "var(--font-mono)",
            textTransform: "uppercase",
            letterSpacing: 0.6,
            color: NODE_ACCENT[node.type] ?? "var(--muted-deep)",
            flex: 1,
          }}
        >
          {t("auto.cfg.title")} · {node.type}
        </span>
        <button onClick={onClose} aria-label={t("common.close")} style={{ color: "var(--muted-deep)", padding: 2 }}>
          <IconClose size={14} />
        </button>
      </div>

      <Field label={t("auto.cfg.label")}>
        <input value={node.label ?? ""} onChange={(e) => onLabel(e.target.value)} style={inp} />
      </Field>

      {node.type === "trigger" && (
        <Field label={t("auto.sched.title")}>
          <ScheduleBuilder
            value={triggerSpec}
            onChange={({ spec, legacyToken }) => onPatch({ scheduleSpec: spec, schedule: legacyToken })}
          />
        </Field>
      )}

      {node.type === "agent" && (
        <>
          <Field label={t("auto.cfg.ref")}>
            <select
              value={s("ref")}
              onChange={(e) => {
                const selectedHub = hubAgents.find((agent) =>
                  agent.slug === e.target.value && agent.callable === true && Boolean(agent.packageHash),
                );
                onPatch({
                  ref: e.target.value,
                  targetType: firmMatch(firms, e.target.value)
                    ? "firm"
                    : selectedHub
                      ? "hub"
                      : "agent",
                  targetVersion: selectedHub?.packageHash ?? null,
                });
              }}
              style={inp}
            >
              <option value="">—</option>
              <optgroup label={t("auto.target.firm")}>
                {firms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {pickLocalized(f, locale).name} — CEO
                  </option>
                ))}
              </optgroup>
              <optgroup label={t("auto.target.agent")}>
                {agents.map((a) => (
                  <option key={a.id} value={a.id}>
                    {pickLocalized(a, locale).name}
                  </option>
                ))}
              </optgroup>
              <optgroup label="Hub">
                {hubAgents.filter((a) => a.callable === true && Boolean(a.packageHash)).map((a) => (
                  <option key={a.slug} value={a.slug}>
                    {pickLocalized(a, locale).name} — Hub
                  </option>
                ))}
              </optgroup>
            </select>
          </Field>
          <Field label={t("auto.cfg.prompt")}>
            <textarea value={s("prompt")} onChange={(e) => onPatch({ prompt: e.target.value })} rows={3} style={{ ...inp, resize: "vertical", fontFamily: "var(--font-body)" }} />
          </Field>
          <Field label={t("auto.cfg.runtime")}>
            <select value={s("runtime")} onChange={(e) => onPatch({ runtime: e.target.value })} style={inp}>
              <option value="">{t("auto.cfg.runtime.default")}</option>
              {dedupeRuntimes(runtimes).map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
          </Field>
        </>
      )}

      {/* ★도구는 `tool` 노드에만 고른다. 예전에는 출력 노드에도 이 셀렉트를 그렸는데,
          커널은 tool 노드에서만 catalog를 읽는다(run-graph.ts declaredToolsForNode는
          agent 노드 옆의 tool 노드만 본다). 그래서 사람이 출력 노드에서 도구를 골라도
          실행에는 아무것도 안 붙었다 — 캔버스에 놓아도 아무 일 없던 tool 노드와 같은 병이다. */}
      {node.type === "tool" && (
        <Field label={t("auto.cfg.catalog")}>
          <select value={s("catalog")} onChange={(e) => onPatch({ catalog: e.target.value })} style={inp}>
            <option value="">—</option>
            {tools.map((tool) => (
              <option key={tool.id} value={tool.id}>
                {locale === "ko" ? tool.name : tool.nameEn}
              </option>
            ))}
          </select>
        </Field>
      )}

      {/* ★"어떤 동작인지"를 적는 칸은 뺐다. `notify | file-write | hep-call` 같은 값을
          받아 놓고 **읽는 코드가 제품에 하나도 없었다** — action 노드는 그냥 지시문대로 돈다.
          없는 기능을 고르게 하면 사람은 고른 대로 돌 거라고 믿는다. 출력 노드에 도구 셀렉트를
          그려 놓고 실행에는 안 붙이던 것과 같은 병이다. 무엇을 할지는 아래 지시문에 쓴다. */}

      {node.type === "output" && (
        <Field label={bi(locale, "내보낼 내용", "What goes out")}>
          <textarea
            value={s("text")}
            onChange={(e) => onPatch({ text: e.target.value })}
            rows={5}
            placeholder={bi(locale, "예: 이번 주 요약 — {{summary}}", "e.g. This week's summary — {{summary}}")}
            style={{ ...inp, minHeight: 96, resize: "vertical" }}
          />
          <div style={{ fontSize: 11, color: "var(--muted-deep)", marginTop: 4 }}>
            {bi(locale,
              "여기 적은 그대로 나갑니다. 앞 단계 결과는 {{이름}}으로 끼워 넣습니다.",
              "This goes out exactly as written. Insert an earlier result with {{name}}.")}
          </div>
        </Field>
      )}

      {node.type === "code" && (
        <>
          <Field label={bi(locale, "무엇을 계산·가공하나", "What it computes or reshapes")}>
            <textarea
              value={s("note")}
              onChange={(e) => onPatch({ note: e.target.value })}
              rows={2}
              placeholder={bi(locale, "예: 종가를 어제와 비교해 변동률(%)을 낸다", "e.g. compare the close with yesterday and give the percent change")}
              style={{ ...inp, minHeight: 48, resize: "vertical" }}
            />
            <div style={{ fontSize: 11, color: "var(--muted-deep)", marginTop: 4 }}>
              {bi(locale,
                "여기 적으면 AI가 스크립트를 짭니다. 사람이 코드를 짤 필요는 없어요.",
                "Write this and the AI produces the script — you never have to write code.")}
            </div>
          </Field>
          <Field label={bi(locale, "언어", "Language")}>
            <select value={s("codeLang") || "python"} onChange={(e) => onPatch({ codeLang: e.target.value })} style={inp}>
              <option value="python">{bi(locale, "python (데이터·계산에 강함)", "python (best for data and maths)")}</option>
              <option value="js">javascript</option>
            </select>
          </Field>
          <Field label={bi(locale, "스크립트 (AI가 채웁니다 — 직접 고쳐도 됩니다)", "Script (the AI fills this in — you can edit it)")}>
            <textarea
              value={s("code")}
              onChange={(e) => onPatch({ code: e.target.value })}
              rows={6}
              placeholder={bi(locale,
                "# 앞 단계 값은 vars 로 들어옵니다.\n# 결과는 result 에 넣으세요.\nresult = ...",
                "# Earlier values arrive in vars.\n# Put what you produce in result.\nresult = ...")}
              style={{ ...inp, minHeight: 120, resize: "vertical", fontFamily: "var(--font-mono)", fontSize: 12 }}
            />
            <div style={{ fontSize: 11, color: "var(--muted-deep)", marginTop: 4 }}>
              {bi(locale,
                "앞 단계 값은 vars 로 들어오고, result 에 넣은 것이 다음 단계로 갑니다.",
                "Earlier values arrive in vars; whatever you put in result goes to the next step.")}
            </div>
          </Field>
        </>
      )}

      {node.type === "eval" && (
        <>
          {/* 검증은 **다른 노드가** 만든 것을 기준으로 판정한다. 만든 노드가 자기를
              채점하면 그건 판정이 아니라 자기 채점이다. */}
          <Field label={t("auto.cfg.eval_subject")}>
            <input
              value={s("subject")}
              onChange={(e) => onPatch({ subject: e.target.value })}
              placeholder="draft"
              style={{ ...inp, fontFamily: "var(--font-mono)" }}
            />
          </Field>
          {/* ★채점표 — 항목별 yes/no. 한 문장 기준 하나는 "뭘 고쳐야 하는지"를 말하지
              못한다(항목을 주면 재시도 성공 31%→98% 실측). must=있어야 한다,
              mustNot=하면 안 된다(판정자의 후한 버릇·꼼수 통과 방지). */}
          <Field label={t("auto.cfg.eval_items")}>
            {(Array.isArray(node.config?.items) ? (node.config.items as Array<{ text?: string; kind?: string }>) : []).map((item, index, list) => (
              <div key={index} style={{ display: "flex", gap: 6, marginBottom: 6 }}>
                <select
                  value={item.kind === "mustNot" ? "mustNot" : "must"}
                  onChange={(e) => {
                    const next = list.map((row, i) => (i === index ? { ...row, kind: e.target.value } : row));
                    onPatch({ items: next });
                  }}
                  style={{ ...inp, width: 110, flex: "none" }}
                  data-testid={`eval-item-kind-${index}`}
                >
                  <option value="must">{t("auto.cfg.eval_item_must")}</option>
                  <option value="mustNot">{t("auto.cfg.eval_item_mustnot")}</option>
                </select>
                <input
                  value={item.text ?? ""}
                  onChange={(e) => {
                    const next = list.map((row, i) => (i === index ? { ...row, text: e.target.value } : row));
                    onPatch({ items: next });
                  }}
                  placeholder={t("auto.cfg.eval_item_placeholder")}
                  style={{ ...inp, flex: 1 }}
                  data-testid={`eval-item-text-${index}`}
                />
                <button
                  onClick={() => onPatch({ items: list.filter((_, i) => i !== index) })}
                  style={{ ...inp, width: 34, flex: "none", cursor: "pointer" }}
                  title={t("auto.cfg.eval_item_remove")}
                >
                  ×
                </button>
              </div>
            ))}
            <button
              onClick={() => {
                const list = Array.isArray(node.config?.items) ? (node.config.items as unknown[]) : [];
                onPatch({ items: [...list, { text: "", kind: "must" }] });
              }}
              style={{ ...inp, cursor: "pointer" }}
              data-testid="eval-item-add"
            >
              {t("auto.cfg.eval_item_add")}
            </button>
            <div style={{ fontSize: 11, color: "var(--muted-deep)", marginTop: 4 }}>
              {t("auto.cfg.eval_items_hint")}
            </div>
            {/* ★기준은 못 써도 좋은 산출물은 알아본다 — 예시 하나로 채점표를 역생성.
                제안일 뿐이라 위 편집기에 채워지고, 사람이 고친 뒤에야 저장된다. */}
            <details style={{ marginTop: 6 }}>
              <summary style={{ fontSize: 11, color: "var(--muted-deep)", cursor: "pointer" }}>
                {t("auto.cfg.eval_from_example")}
              </summary>
              <textarea
                value={exampleDraft}
                onChange={(e) => setExampleDraft(e.target.value)}
                rows={4}
                placeholder={t("auto.cfg.eval_from_example_placeholder")}
                style={{ ...inp, minHeight: 72, resize: "vertical", marginTop: 6 }}
                data-testid="eval-example-input"
              />
              <button
                disabled={exampleBusy || !exampleDraft.trim()}
                onClick={() => {
                  void (async () => {
                    const api = ipc();
                    if (!api || !automationId) return;
                    setExampleBusy(true);
                    try {
                      const res = await api.automations.proposeChecklistFromExample(automationId, exampleDraft);
                      if (res.ok && res.items.length) {
                        onPatch({ items: res.items });
                        setExampleDraft("");
                      } else {
                        setExampleError(t("auto.cfg.eval_from_example_failed"));
                      }
                    } finally {
                      setExampleBusy(false);
                    }
                  })();
                }}
                style={{ ...inp, cursor: "pointer", marginTop: 6 }}
                data-testid="eval-example-generate"
              >
                {exampleBusy ? t("auto.cfg.eval_from_example_busy") : t("auto.cfg.eval_from_example_go")}
              </button>
              {exampleError ? (
                <div style={{ fontSize: 11, color: "var(--red-deep, var(--danger))", marginTop: 4 }}>{exampleError}</div>
              ) : null}
            </details>
          </Field>
          <Field label={t("auto.cfg.eval_criteria")}>
            {/* 한 문장 기준(하위호환) — 채점표 항목이 있으면 항목이 우선한다. */}
            <textarea
              value={s("criteria")}
              onChange={(e) => onPatch({ criteria: e.target.value })}
              rows={2}
              placeholder={bi(locale, "근거가 두 개 이상 있고, 문장이 어색하지 않다", "has at least two sources, and reads naturally")}
              style={{ ...inp, resize: "vertical", fontFamily: "var(--font-body)" }}
            />
          </Field>
          <Field label={t("auto.cfg.eval_evidence")}>
            {/* ★사실 확인형 검증("값이 실제와 일치하나")은 대상만 보고 판정 못 한다 —
                재조회 단계가 만든 값 이름을 적으면 판정이 그 근거와 대조한다. */}
            <input
              value={s("evidence")}
              onChange={(e) => onPatch({ evidence: e.target.value })}
              placeholder="real_price"
              style={{ ...inp, fontFamily: "var(--font-mono)" }}
            />
            <div style={{ fontSize: 11, color: "var(--muted-deep)", marginTop: 4 }}>
              {t("auto.cfg.eval_evidence_hint")}
            </div>
          </Field>
          <Field label={t("auto.cfg.eval_produces")}>
            <input
              value={s("produces")}
              onChange={(e) => onPatch({ produces: e.target.value })}
              placeholder="verdict"
              style={{ ...inp, fontFamily: "var(--font-mono)" }}
            />
          </Field>
        </>
      )}

      {node.type === "subgraph" && (
        <>
          {/* ★id로 고른다. 이름은 사람이 바꾸고 겹칠 수도 있어서, 이름으로 저장하면
              어느 날 다른 자동화가 실행된다. */}
          <Field label={t("auto.cfg.subgraph_ref")}>
            <select value={s("graphRef")} onChange={(e) => onPatch({ graphRef: e.target.value })} style={inp}>
              <option value="">—</option>
              {callableGraphs.map((row) => (
                <option key={row.id} value={row.id}>{row.name}</option>
              ))}
            </select>
          </Field>
          <Field label={t("auto.cfg.subgraph_input")}>
            <input
              value={s("input")}
              onChange={(e) => onPatch({ input: e.target.value })}
              placeholder="{{topic}}"
              style={{ ...inp, fontFamily: "var(--font-mono)" }}
            />
          </Field>
          <Field label={t("auto.cfg.subgraph_produces")}>
            <input
              value={s("produces")}
              onChange={(e) => onPatch({ produces: e.target.value })}
              placeholder="innerResult"
              style={{ ...inp, fontFamily: "var(--font-mono)" }}
            />
          </Field>
        </>
      )}

      {node.type === "condition" && (
        <>
          {/* 구조화 조건 — 러너 evalCondition이 var/op/value를 읽는다(설계 §5 P2). true/false 핸들로 분기. */}
          <Field label={t("auto.cfg.cond_var")}>
            <input value={s("var")} onChange={(e) => onPatch({ var: e.target.value })} placeholder="price" style={{ ...inp, fontFamily: "var(--font-mono)" }} />
          </Field>
          <Field label={t("auto.cfg.cond_op")}>
            <select value={s("op") || "truthy"} onChange={(e) => onPatch({ op: e.target.value })} style={inp}>
              <option value="truthy">truthy</option>
              <option value="falsy">falsy</option>
              <option value="eq">= (eq)</option>
              <option value="ne">≠ (ne)</option>
              <option value="gt">&gt; (gt)</option>
              <option value="lt">&lt; (lt)</option>
              <option value="contains">contains</option>
            </select>
          </Field>
          {s("op") !== "truthy" && s("op") !== "falsy" && s("op") !== "" ? (
            <Field label={t("auto.cfg.cond_value")}>
              <input
                value={cfg.value != null ? String(cfg.value) : ""}
                onChange={(e) => onPatch({ value: e.target.value })}
                placeholder="100"
                style={{ ...inp, fontFamily: "var(--font-mono)" }}
              />
            </Field>
          ) : null}
        </>
      )}

      {node.type === "transform" && (
        <>
          {/* 변수 reshape — 러너 applyTransform이 from/to/mode/template/pattern을 읽는다(설계 §5 P2). */}
          <Field label={t("auto.cfg.tf_from")}>
            <input value={s("from")} onChange={(e) => onPatch({ from: e.target.value })} placeholder="summary" style={{ ...inp, fontFamily: "var(--font-mono)" }} />
          </Field>
          <Field label={t("auto.cfg.tf_to")}>
            <input value={s("to")} onChange={(e) => onPatch({ to: e.target.value })} placeholder="digest" style={{ ...inp, fontFamily: "var(--font-mono)" }} />
          </Field>
          <Field label={t("auto.cfg.tf_mode")}>
            <select value={s("mode") || "identity"} onChange={(e) => onPatch({ mode: e.target.value })} style={inp}>
              <option value="identity">identity</option>
              <option value="format">format</option>
              <option value="json">json</option>
              <option value="extract">extract</option>
            </select>
          </Field>
          {s("mode") === "format" ? (
            <Field label={t("auto.cfg.tf_template")}>
              <input value={s("template")} onChange={(e) => onPatch({ template: e.target.value })} placeholder="Digest: {{summary}}" style={{ ...inp, fontFamily: "var(--font-mono)" }} />
            </Field>
          ) : null}
          {s("mode") === "extract" ? (
            <Field label={t("auto.cfg.tf_pattern")}>
              <input value={s("pattern")} onChange={(e) => onPatch({ pattern: e.target.value })} placeholder="\\$([0-9.]+)" style={{ ...inp, fontFamily: "var(--font-mono)" }} />
            </Field>
          ) : null}
        </>
      )}

      {node.type !== "trigger" && node.type !== "condition" && node.type !== "transform" && (
        <>
          <Field label={t("auto.cfg.consumes")}>
            <input value={s("consumes")} onChange={(e) => onPatch({ consumes: e.target.value })} placeholder="summary" style={{ ...inp, fontFamily: "var(--font-mono)" }} />
          </Field>
          <Field label={t("auto.cfg.produces")}>
            <input value={s("produces")} onChange={(e) => onPatch({ produces: e.target.value })} placeholder="result" style={{ ...inp, fontFamily: "var(--font-mono)" }} />
          </Field>
          {s("produces") ? (
            <Field label={t("auto.cfg.reducer")}>
              <select value={s("reducer") || "overwrite"} onChange={(e) => onPatch({ reducer: e.target.value })} style={inp}>
                <option value="overwrite">{t("auto.cfg.reducer_overwrite")}</option>
                <option value="append">{t("auto.cfg.reducer_append")}</option>
                <option value="merge">{t("auto.cfg.reducer_merge")}</option>
              </select>
            </Field>
          ) : null}

          {/* 안전장치 — 이 노드가 바깥에 무엇을 하는지, 얼마나 오래·얼마나 많이 쓸 수 있는지.
              선언이 없으면 시뮬레이션은 이 노드를 조회로 보고 실제로 돌린다. */}
          <div style={{ height: 1, background: "var(--paper-edge)", margin: "2px 0" }} />
          <Field label={t("auto.cfg.effect")}>
            {/* ★화면이 보여 주는 기본값은 커널이 쓰는 기본값과 같아야 한다.
                안 그러면 "조회"로 보이는 노드가 실행에서는 내보내기로 취급된다. */}
            <select value={s("effect") || defaultNodeEffect(node.type)} onChange={(e) => onPatch({ effect: e.target.value })} style={inp}>
              <option value="pure">{t("auto.cfg.effect_pure")}</option>
              <option value="read">{t("auto.cfg.effect_read")}</option>
              <option value="mutation">{t("auto.cfg.effect_mutation")}</option>
            </select>
            <div style={{ fontSize: 11, color: "var(--muted-deep)", marginTop: 4 }}>
              {t("auto.cfg.effect_hint")}
            </div>
          </Field>

          {/* ★바깥을 바꾸는 단계의 안전장치 — 멱등키는 "두 번 나가지 않는다", 재시도는
              "한 번 실패했다고 포기하지 않는다"이다.
              (실행 중 승인 셀렉트는 오너 이사회 결정 2026-08-10 으로 제거 — 커널이 더
              이상 읽지 않으므로, 남겨 두면 골라도 아무 효과가 없는 거짓 UI 가 된다.
              바깥으로 나가는 게 걱정되면 [시뮬레이션]으로 먼저 돌려 볼 수 있다.) */}
          {/* ★출력 노드는 효과를 안 적어도 커널이 "바깥으로 나간다"로 본다. 그런데 멱등키 칸을
              `effect === "mutation"`일 때만 보여 주면, 정작 그 칸이 가장 필요한 노드에서
              **숨어 있다** — 멱등키가 없으면 발행 단계는 재시도조차 못 한다. */}
          {s("effect") === "mutation" || node.type === "output" ? (
            <Field label={bi(locale, "같은 일을 두 번 하지 않기", "Do not do the same thing twice")}>
              <input
                value={s("idempotencyKey")}
                onChange={(e) => onPatch({ idempotencyKey: e.target.value })}
                placeholder={bi(locale, "예: 발송-{{orderId}}", "e.g. send-{{orderId}}")}
                style={{ ...inp, fontFamily: "var(--font-mono)" }}
              />
              <div style={{ fontSize: 11, color: "var(--muted-deep)", marginTop: 4 }}>
                이 값을 적어야 실패한 발행을 다시 시도합니다. 비워 두면 한 번만 시도합니다 — 두 번 나가는 사고를 막기 위해서입니다.
              </div>
            </Field>
          ) : null}
          <Field label={bi(locale, "실패하면 다시 시도", "Retry on failure")}>
            <input
              type="number" min={0} max={5}
              value={s("retries")}
              onChange={(e) => {
                const n = Number(e.target.value);
                onPatch({ retries: Number.isFinite(n) && n >= 0 && n <= 5 ? Math.round(n) : undefined });
              }}
              placeholder="0"
              style={inp}
            />
          </Field>
          <Field label={t("auto.cfg.timeout")}>
            <input
              type="number"
              min={1}
              value={s("timeoutSeconds")}
              onChange={(e) => onPatch({ timeoutSeconds: e.target.value === "" ? undefined : Number(e.target.value) })}
              placeholder="3600"
              style={inp}
            />
          </Field>
          <Field label={t("auto.cfg.max_tokens")}>
            <input
              type="number"
              min={1}
              value={s("maxTokens")}
              onChange={(e) => onPatch({ maxTokens: e.target.value === "" ? undefined : Number(e.target.value) })}
              placeholder={t("auto.cfg.max_tokens_placeholder")}
              style={inp}
            />
          </Field>
        </>
      )}

      {/* ★주석 — 모든 노드에. 사람은 코드나 설정 대신 여기에 의도를 적고,
          캔버스의 "말로 고치기"(architect)가 이 주석을 그 단계에 대한 지시로 읽는다.
          코드 노드는 자기 설명 칸(note)을 위에서 이미 그렸으므로 중복해 그리지 않는다. */}
      {node.type !== "code" && (
        <Field label={t("auto.cfg.note")}>
          <textarea
            value={s("note")}
            onChange={(e) => onPatch({ note: e.target.value })}
            rows={2}
            placeholder={t("auto.cfg.note_placeholder")}
            style={{ ...inp, minHeight: 44, resize: "vertical" }}
          />
        </Field>
      )}

      <button
        onClick={onDelete}
        style={{
          marginTop: 6,
          padding: "8px 12px",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--paper-edge)",
          background: "var(--paper)",
          color: "var(--red-deep, var(--danger))",
          fontSize: 12,
          fontWeight: 600,
          cursor: "pointer",
        }}
      >
        {t("auto.flow.delete_node")}
      </button>
    </aside>
  );
}

function firmMatch(firms: InstalledFirm[], id: string): boolean {
  return firms.some((f) => f.id === id);
}

function hubMatch(agents: MarketplaceListing[], slug: string): boolean {
  return agents.some((a) => a.slug === slug);
}

function dedupeRuntimes(runtimes: RuntimeStatus[]): string[] {
  const set = new Set<string>();
  for (const r of runtimes) set.add(r.kind);
  return Array.from(set);
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 600, color: "var(--ink-soft)", marginBottom: 5 }}>{label}</div>
      {children}
    </div>
  );
}

const inp: React.CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  fontSize: 13,
  outline: "none",
};
