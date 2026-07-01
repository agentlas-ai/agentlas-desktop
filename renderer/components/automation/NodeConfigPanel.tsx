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
  McpToolCatalogEntry,
  RuntimeStatus,
} from "@/lib/types";
import { ScheduleBuilder } from "./ScheduleBuilder";
import { NODE_ACCENT } from "./nodes/nodeShared";
import { IconClose } from "@/components/Icon";

export function NodeConfigPanel({
  node,
  onPatch,
  onLabel,
  onDelete,
  onClose,
}: {
  node: WorkflowNode;
  /** config 부분 갱신(머지). 부모가 그래프 노드에 반영 + dirty 표시. */
  onPatch: (patch: Record<string, unknown>) => void;
  /** 노드 표시 라벨 갱신. */
  onLabel: (label: string) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const { t, locale } = useT();
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [tools, setTools] = useState<McpToolCatalogEntry[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeStatus[]>([]);

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    void (async () => {
      const [ag, fm, tl, rt] = await Promise.all([
        api.team.list(),
        api.firms.list(),
        api.mcpTools.listCatalog(),
        api.runtime.detect(),
      ]);
      setAgents(visibleAgents(ag));
      setFirms(fm);
      setTools(tl);
      setRuntimes(rt);
    })();
  }, []);

  const cfg = node.config ?? {};
  const s = (k: string): string => (typeof cfg[k] === "string" ? (cfg[k] as string) : "");

  // trigger 노드의 기존 spec(config.scheduleSpec가 있으면 하이드레이트).
  const triggerSpec = useMemo<ScheduleSpec | null>(() => {
    const raw = cfg.scheduleSpec;
    if (raw && typeof raw === "object" && typeof (raw as { kind?: unknown }).kind === "string") {
      return raw as ScheduleSpec;
    }
    return null;
  }, [cfg.scheduleSpec]);

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
            <select value={s("ref")} onChange={(e) => onPatch({ ref: e.target.value, targetType: firmMatch(firms, e.target.value) ? "firm" : "agent" })} style={inp}>
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
