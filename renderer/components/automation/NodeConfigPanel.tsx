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
function specFromLegacyToken(token: string, tz: string): ScheduleSpec | null {
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
  return null;
}

export function NodeConfigPanel({
  node,
  onPatch,
  onLabel,
  onDelete,
  onClose,
  timezone,
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
}) {
  const { t, locale } = useT();
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [hubAgents, setHubAgents] = useState<MarketplaceListing[]>([]);
  const [tools, setTools] = useState<McpToolCatalogEntry[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);

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
    })();
  }, []);

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
      className="titlebar-nodrag"
      style={{
        width: 320,
        flexShrink: 0,
        borderLeft: "var(--hairline)",
        background: "var(--paper)",
        overflowY: "auto",
        padding: 16,
        display: "flex",
        flexDirection: "column",
        gap: 14,
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

      {(node.type === "tool" || node.type === "output") && (
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

      {node.type === "action" && (
        <Field label={t("auto.cfg.action")}>
          <input value={s("action")} onChange={(e) => onPatch({ action: e.target.value })} placeholder="notify | file-write | hep-call …" style={inp} />
        </Field>
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
            <select value={s("effect") || "read"} onChange={(e) => onPatch({ effect: e.target.value })} style={inp}>
              <option value="pure">{t("auto.cfg.effect_pure")}</option>
              <option value="read">{t("auto.cfg.effect_read")}</option>
              <option value="mutation">{t("auto.cfg.effect_mutation")}</option>
            </select>
            <div style={{ fontSize: 11, color: "var(--muted-deep)", marginTop: 4 }}>
              {t("auto.cfg.effect_hint")}
            </div>
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

      <button
        onClick={onDelete}
        style={{
          marginTop: 6,
          padding: "8px 12px",
          borderRadius: "var(--radius-md)",
          border: "1px solid var(--paper-edge)",
          background: "var(--paper)",
          color: "var(--red-deep, #b4533a)",
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
