// 새 자동화 / 기존 자동화 편집(설계 §2.5 스케줄 빌더, §3.5 트리거, P1 한계 #7·#8).
// - 4-프리셋 <select>를 전체 문법 스케줄 빌더로 교체.
// - 트리거 종류 선택(시간/파일 변경/체인) — 이벤트 트리거는 스케줄 대신 트리거 상세를 노출.
// - "빈 캔버스에서 만들기" 진입점(빈 자동화 생성 후 flow 편집기로 이동).
// - ?id= 가 있으면 기존 자동화를 로드해 in-place 수정(삭제-재생성 회피).
"use client";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { visibleAgents, withCurrentTarget } from "@/lib/agent-visibility";
import { pickLocalized, useT } from "@/lib/i18n";
import { navigate } from "@/lib/navigation";
import type {
  Automation,
  AutomationHubMode,
  AutomationToolMode,
  InstalledAgent,
  InstalledFirm,
  MarketplaceListing,
  OneSuggestionReviewSeed,
  Project,
  RuntimeStatus,
  ScheduleSpec,
  Trigger,
  TriggerKind,
} from "@/lib/types";
import { ScheduleBuilder, type ScheduleBuilderValue } from "@/components/automation/ScheduleBuilder";
import { IconBuilding, IconSparkles } from "@/components/Icon";
import { OneSuggestionReviewHandoffBanner, type OneReviewSeedApplyResult } from "@/components/one/OneSuggestionReviewHandoff";

type TargetType = "agent" | "firm" | "hub";

const AUTOMATION_RUNTIME_PROVIDER_LABEL: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  ollama: "Ollama",
  lmstudio: "LM Studio",
  mlx: "MLX",
  agentlas: "Agentlas",
};

function automationRuntimeKey(runtime: RuntimeStatus): string {
  return `${runtime.kind}:${runtime.backend}:${runtime.source}`;
}

function automationRuntimeLabel(runtime: RuntimeStatus): string {
  const provider = AUTOMATION_RUNTIME_PROVIDER_LABEL[runtime.backend] ?? runtime.backend;
  return `${runtime.kind} · ${provider}`;
}

export default function NewAutomationWrapper() {
  return (
    <Suspense fallback={null}>
      <NewAutomationPage />
    </Suspense>
  );
}

function NewAutomationPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const editId = searchParams.get("id") ?? "";
  const { t, locale } = useT();

  const [name, setName] = useState("");
  const [sched, setSched] = useState<ScheduleBuilderValue | null>(null);
  const [initialSpec, setInitialSpec] = useState<ScheduleSpec | null>(null);
  const [prompt, setPrompt] = useState("");
  const [targetType, setTargetType] = useState<TargetType>("firm");
  const [targetId, setTargetId] = useState<string>("");
  const [projectContextChoice, setProjectContextChoice] = useState<string>("");
  const [projects, setProjects] = useState<Project[]>([]);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [hubAgents, setHubAgents] = useState<MarketplaceListing[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [triggerType, setTriggerType] = useState<TriggerKind>("schedule");
  const [toolMode, setToolMode] = useState<AutomationToolMode>("auto");
  // 빈 문자열 = "활성 런타임 따라가기"(runtimeSelection null). 그 외에는 kind:backend:source 키.
  const [runtimeKey, setRuntimeKey] = useState("");
  const [runtimeModel, setRuntimeModel] = useState("");
  const [runtimeTouched, setRuntimeTouched] = useState(false);
  const [runtimeOptions, setRuntimeOptions] = useState<RuntimeStatus[]>([]);
  const [runtimeModels, setRuntimeModels] = useState<Record<string, Array<{ id: string; label: string; tag?: string }>>>({});
  const [toolModeTouched, setToolModeTouched] = useState(false);
  const [hubMode, setHubMode] = useState<AutomationHubMode>("hub-allowed");
  const [fsPath, setFsPath] = useState("");
  const [fsOn, setFsOn] = useState<"create" | "modify" | "delete">("create");
  const [chainAfter, setChainAfter] = useState("");
  const [allAutomations, setAllAutomations] = useState<Automation[]>([]);
  const [loaded, setLoaded] = useState(!editId);
  const reviewUntouchedRef = useRef(true);
  const executionAiRef = useRef<HTMLDivElement>(null);

  const applyOneReviewSeed = useCallback((seed: OneSuggestionReviewSeed): OneReviewSeedApplyResult => {
    if (seed.kind !== "automation" || seed.targetSurface !== "automation") return "blocked";
    if (!loaded) return "defer";
    if (
      editId
      || !reviewUntouchedRef.current
      || name !== ""
      || prompt !== ""
      || initialSpec !== null
      || fsPath !== ""
      || chainAfter !== ""
      || toolModeTouched
    ) return "blocked";
    // Intentionally materialize only the safe label. triggerPreview and
    // permission remain read-only in the verified banner; schedule, prompt,
    // target, enablement, and execution are never inferred here.
    setName(seed.name);
    return "applied";
  }, [chainAfter, editId, fsPath, initialSpec, loaded, name, prompt, toolModeTouched]);

  useEffect(() => {
    const api = ipc();
    if (!api?.runtime?.detect) return;
    void api.runtime.detect(false).then((list) => setRuntimeOptions(list ?? [])).catch(() => setRuntimeOptions([]));
  }, []);

  useEffect(() => {
    const api = ipc();
    // 브릿지가 없으면 로드할 것도 없다 — loaded를 열어 두지 않으면 편집 진입 시
    // 스케줄 필드가 영영 렌더되지 않는다.
    if (!api) {
      setLoaded(true);
      return;
    }
    void (async () => {
      const [ag, fm, autos, hub, projectRows] = await Promise.all([
        api.team.list(),
        api.firms.list(),
        api.automations.list(),
        api.marketplace.search("").catch(() => []),
        api.projects.list(),
      ]);
      const visible = visibleAgents(ag);
      // ★이 자동화가 이미 쓰고 있는 대상은 자기 편집기에서 빼지 않는다 — 빼면
      //   "유효한 대상이 없다"로 자기 자신을 저장 불가로 만든다(agent-visibility 주석 참조).
      const editingRow = editId ? autos.find((a) => a.id === editId) : null;
      setAgents(withCurrentTarget(visible, ag, editingRow?.targetType, editingRow?.targetId));
      setFirms(fm);
      setAllAutomations(autos);
      setHubAgents(hub);
      setProjects(projectRows);

      if (editId) {
        const existing = autos.find((a) => a.id === editId);
        if (existing) {
          setName(existing.name);
          setPrompt(existing.promptTemplate);
          setTargetType(existing.targetType);
          setTargetId(existing.targetId);
          setProjectContextChoice(existing.projectId ?? "__none__");
          setTriggerType(existing.triggerType ?? "schedule");
          setToolMode(existing.toolMode ?? "auto");
          const sel = existing.runtimeSelection;
          setRuntimeKey(sel ? `${sel.kind}:${sel.backend}:${sel.source}` : "");
          setRuntimeModel(sel?.model ?? "");
          setToolModeTouched(true);
          setHubMode(existing.hubMode ?? "hub-allowed");
          setInitialSpec(existing.scheduleSpec ?? null);
          if (existing.trigger?.kind === "fs") {
            setFsPath(existing.trigger.path);
            setFsOn(existing.trigger.on);
          } else if (existing.trigger?.kind === "chain") {
            setChainAfter(existing.trigger.afterAutomationId);
          }
        }
        setLoaded(true);
        return;
      }
    })();
  }, [editId]);

  useEffect(() => {
    if (!loaded || typeof window === "undefined" || window.location.hash !== "#execution-ai") return;
    const frame = window.requestAnimationFrame(() => {
      executionAiRef.current?.scrollIntoView({ behavior: "auto", block: "center" });
      executionAiRef.current?.querySelector<HTMLElement>("[data-automation-runtime-select]")?.focus({ preventScroll: true });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [loaded]);

  useEffect(() => {
    const api = ipc();
    if (!api?.runtime || runtimeOptions.length === 0) return;
    let alive = true;
    void Promise.all(runtimeOptions.map(async (runtime) => {
      const fallback = (runtime.availableModels ?? []).map((id) => ({ id, label: id }));
      const rows = await api.runtime.listModels({
        kind: runtime.kind,
        backend: runtime.backend,
        availableModels: runtime.availableModels,
      }).catch(() => []);
      return [automationRuntimeKey(runtime), rows.length > 0 ? rows : fallback] as const;
    })).then((entries) => {
      if (alive) setRuntimeModels(Object.fromEntries(entries));
    });
    return () => { alive = false; };
  }, [runtimeOptions]);

  // NOTE: this form no longer flips the tool mode while the user types. It used to run a
  // keyword test over the name/prompt and silently switch to Computer Use — which fired on
  // unrelated jobs in English/Korean and never fired at all in any other language. The mode
  // the user picks stays put; "auto" is resolved at run time by the resident judge.

  function chooseTargetType(type: TargetType) {
    setTargetType(type);
    setTargetId("");
    setError("");
  }

  function buildTrigger(): Trigger | null {
    if (triggerType === "fs") {
      return { kind: "fs", path: fsPath.trim(), on: fsOn };
    }
    if (triggerType === "chain") {
      return { kind: "chain", afterAutomationId: chainAfter };
    }
    return { kind: "schedule" };
  }

  const scheduleJson = useMemo(() => (sched ? JSON.stringify(sched.spec) : null), [sched]);
  const scheduleHuman = sched?.legacyToken ?? "daily-09:00";

  async function submit(blankCanvas = false) {
    const api = ipc();
    if (!api || !name.trim() || busy) return;
    const validTarget =
      targetType === "firm"
        ? firms.some((f) => f.id === targetId)
        : targetType === "hub"
          ? hubAgents.some((a) => a.slug === targetId && a.callable === true && Boolean(a.packageHash))
          : agents.some((a) => a.id === targetId);
    if (!validTarget) {
      setError(locale === "ko" ? "선택한 대상이 없습니다. 다른 대상 탭을 선택하세요." : "No valid target is selected. Choose another target tab.");
      return;
    }
    const selectedHubVersion = targetType === "hub"
      ? hubAgents.find((agent) => agent.slug === targetId && agent.callable === true)?.packageHash
      : undefined;
    if (targetType === "hub" && !selectedHubVersion) {
      setError(locale === "ko"
        ? "정확한 Hub 패키지 버전을 확인할 수 없어 자동화를 저장하지 않았습니다. Hub 목록을 새로고침한 뒤 다시 선택하세요."
        : "The exact Hub package version is unavailable. Refresh Hub and select the agent again.");
      return;
    }
    if (triggerType === "fs" && !fsPath.trim()) {
      setError(locale === "ko" ? "감시할 경로를 입력하세요." : "Enter a path to watch.");
      return;
    }
    if (triggerType === "chain" && !chainAfter) {
      setError(locale === "ko" ? "선행 자동화를 선택하세요." : "Choose an automation to run after.");
      return;
    }
    setBusy(true);
    setError("");
    try {
      const commonPatch = {
        name: name.trim(),
        scheduleHuman,
        targetType,
        targetId,
        targetVersion: targetType === "hub" ? selectedHubVersion : "",
        projectId: projectContextChoice === "__none__" ? null : projectContextChoice,
        promptTemplate: prompt.trim() || (locale === "ko" ? "오늘 할 일 요약해줘" : "Summarize today's tasks"),
        toolMode,
        hubMode,
        scheduleJson: triggerType === "schedule" ? scheduleJson : null,
        triggerType,
        trigger: buildTrigger(),
      };
      // 사용자가 실행 AI를 건드렸을 때만 보낸다. 만들기는 null 을 받지 않으므로(활성 런타임을
      // 따라가는 것이 기본) 값이 있을 때만 싣고, 편집은 null 로 "따라가기"로 되돌릴 수 있다.
      const pickedRuntime = runtimeKey
        ? runtimeOptions.find((r) => `${r.kind}:${r.backend}:${r.source}` === runtimeKey)
        : undefined;
      const pickedModel = runtimeModel.trim() || undefined;
      if (editId) {
        await api.automations.update(editId, {
          ...commonPatch,
          ...(runtimeTouched
            ? {
                runtimeSelection: pickedRuntime
                  ? {
                      kind: pickedRuntime.kind,
                      backend: pickedRuntime.backend,
                      source: pickedRuntime.source,
                      ...(pickedModel ? { model: pickedModel } : {}),
                    }
                  : null,
              }
            : {}),
        });
        navigate(`/automation/flow?id=${encodeURIComponent(editId)}`, "replace");
        return;
      }
      const created = await api.automations.create({
        ...commonPatch,
        ...(runtimeTouched && pickedRuntime
          ? {
              runtimeSelection: {
                kind: pickedRuntime.kind,
                backend: pickedRuntime.backend,
                source: pickedRuntime.source,
                ...(pickedModel ? { model: pickedModel } : {}),
              },
            }
          : {}),
      });
      if (blankCanvas) {
        navigate(`/automation/flow?id=${encodeURIComponent(created.id)}`, "replace");
      } else {
        navigate("/automation", "replace");
      }
    } catch {
      setError(locale === "en" ? "Automation was not created." : "자동화를 만들지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  const selectedRuntime = runtimeOptions.find((runtime) => automationRuntimeKey(runtime) === runtimeKey);
  const selectedRuntimeModels = selectedRuntime ? runtimeModels[runtimeKey] ?? [] : [];
  const modelRows = selectedRuntime?.model && !selectedRuntimeModels.some((model) => model.id === selectedRuntime.model)
    ? [{ id: selectedRuntime.model, label: selectedRuntime.model }, ...selectedRuntimeModels]
    : selectedRuntimeModels;
  const defaultModelAllowed = selectedRuntime
    ? selectedRuntime.kind !== "byok" && !["ollama", "lmstudio", "mlx", "agentlas"].includes(selectedRuntime.kind)
    : false;
  const canSubmit = !!name.trim() && !!targetId && !!projectContextChoice && !busy;

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "var(--paper-2)" }}>
      <header
        className="titlebar-drag"
        style={{ padding: "16px 32px", minHeight: 56, borderBottom: "var(--hairline)", background: "var(--paper)" }}
      >
        <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 17, fontWeight: 700 }}>
          {editId ? t("auto.edit.title") : t("auto.new")}
        </h1>
      </header>

      <section
        className="titlebar-nodrag"
        data-tour-id="automation.form"
        style={{ maxWidth: 640, margin: "32px auto", padding: "0 24px" }}
        onChangeCapture={() => { reviewUntouchedRef.current = false; }}
        onClickCapture={() => { reviewUntouchedRef.current = false; }}
      >
        <OneSuggestionReviewHandoffBanner surface="automation" locale={locale} onReviewSeed={applyOneReviewSeed} />

        <Field label={t("auto.field.name")}>
          <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t("auto.field.name.placeholder")} autoFocus style={inputStyle} />
        </Field>

        {/* 트리거 종류 */}
        <Field label={t("auto.trigger.type")}>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            {(["schedule", "fs", "chain"] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setTriggerType(k)}
                style={{
                  padding: "7px 12px",
                  borderRadius: 999,
                  fontSize: 12,
                  fontWeight: 600,
                  background: triggerType === k ? "var(--fill-1)" : "var(--paper-2)",
                  color: triggerType === k ? "var(--accent)" : "var(--ink-soft)",
                  border: triggerType === k ? "1px solid var(--accent-soft)" : "1px solid var(--paper-edge)",
                  cursor: "pointer",
                }}
              >
                {t(`auto.trigger.${k}`)}
              </button>
            ))}
          </div>
        </Field>

        {triggerType === "schedule" && (
          <Field label={t("auto.field.schedule")}>
            {/* 로드가 끝나기 전에는 마운트하지 않는다. ScheduleBuilder의 하이드레이트는
                마운트 시 1회뿐이라(ScheduleBuilder.tsx의 최초 1회 useEffect), initialSpec이
                아직 null인 첫 렌더에 마운트되면 저장된 스케줄을 영영 못 읽고 기본값
                (daily 09:00)을 그대로 emit → 이름만 고쳐 저장해도 실행 시각이 조용히 바뀐다. */}
            {loaded && <ScheduleBuilder value={initialSpec} onChange={setSched} />}
          </Field>
        )}

        {triggerType === "fs" && (
          <>
            <Field label={t("auto.trigger.fs.path")}>
              <input value={fsPath} onChange={(e) => setFsPath(e.target.value)} placeholder="/Users/you/Downloads" style={{ ...inputStyle, fontFamily: "var(--font-mono)" }} />
            </Field>
            <Field label={t("auto.trigger.fs.on")}>
              <div style={{ display: "flex", gap: 6 }}>
                {(["create", "modify", "delete"] as const).map((o) => (
                  <button
                    key={o}
                    type="button"
                    onClick={() => setFsOn(o)}
                    style={{
                      padding: "7px 12px",
                      borderRadius: 999,
                      fontSize: 12,
                      fontWeight: 600,
                      background: fsOn === o ? "var(--fill-1)" : "var(--paper-2)",
                      color: fsOn === o ? "var(--accent)" : "var(--ink-soft)",
                      border: fsOn === o ? "1px solid var(--accent-soft)" : "1px solid var(--paper-edge)",
                      cursor: "pointer",
                    }}
                  >
                    {t(`auto.trigger.fs.on.${o}`)}
                  </button>
                ))}
              </div>
            </Field>
          </>
        )}

        {triggerType === "chain" && (
          <Field label={t("auto.trigger.chain.after")}>
            <select value={chainAfter} onChange={(e) => setChainAfter(e.target.value)} style={inputStyle}>
              <option value="">—</option>
              {allAutomations.filter((a) => a.id !== editId).map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                </option>
              ))}
            </select>
          </Field>
        )}

        <Field label={locale === "ko" ? "작업 컨텍스트" : "Work context"}>
          <select value={projectContextChoice} onChange={(event) => setProjectContextChoice(event.target.value)} style={inputStyle}>
            <option value="" disabled>{locale === "ko" ? "프로젝트 사용 여부를 선택하세요" : "Choose whether this automation uses a project"}</option>
            <option value="__none__">{locale === "ko" ? "프로젝트 없음 · 독립 작업" : "No project · standalone work"}</option>
            {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
          </select>
          <p style={{ margin: "7px 0 0", color: "var(--muted-deep)", fontSize: 11, lineHeight: 1.5 }}>
            {locale === "ko" ? "프로젝트를 선택하면 그 소스·지시·기억을 실행 컨텍스트로 사용합니다." : "A selected project supplies its source, instructions, and memory to every run."}
          </p>
        </Field>

        <Field label={t("auto.field.target")}>
          <div style={{ display: "flex", gap: 8, marginBottom: 10 }}>
            <TabBtn active={targetType === "firm"} onClick={() => chooseTargetType("firm")} icon={<IconBuilding size={13} />} label={`${t("auto.target.firm")} (${firms.length})`} disabled={firms.length === 0} />
            <TabBtn active={targetType === "agent"} onClick={() => chooseTargetType("agent")} icon={<IconSparkles size={13} />} label={`${t("auto.target.agent")} (${agents.length})`} disabled={agents.length === 0} />
            <TabBtn active={targetType === "hub"} onClick={() => chooseTargetType("hub")} icon={<IconSparkles size={13} />} label={`Hub (${hubAgents.length})`} disabled={hubAgents.length === 0} />
          </div>
          {targetType === "firm" && (
            firms.length === 0 ? (
              <Empty>{t("auto.empty_firms")}</Empty>
            ) : (
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)} style={inputStyle}>
                <option value="" disabled>{locale === "ko" ? "회사를 선택하세요" : "Choose a firm"}</option>
                {firms.map((f) => (
                  <option key={f.id} value={f.id}>
                    {pickLocalized(f, locale).name} — CEO
                  </option>
                ))}
              </select>
            )
          )}
          {targetType === "agent" && (
            agents.length === 0 ? (
              <Empty>{t("auto.empty_agents")}</Empty>
            ) : (
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)} style={inputStyle}>
                <option value="" disabled>{locale === "ko" ? "에이전트를 선택하세요" : "Choose an agent"}</option>
                {agents.map((a) => {
                  const loc = pickLocalized(a, locale);
                  return (
                    <option key={a.id} value={a.id}>
                      {loc.name} — {loc.tagline}
                    </option>
                  );
                })}
              </select>
            )
          )}
          {targetType === "hub" && (
            hubAgents.length === 0 ? (
              <Empty>{locale === "ko" ? "Hub 에이전트를 불러오지 못했습니다." : "No Hub agents are available."}</Empty>
            ) : (
              <select value={targetId} onChange={(e) => setTargetId(e.target.value)} style={inputStyle}>
                <option value="" disabled>{locale === "ko" ? "Hub 에이전트를 선택하세요" : "Choose a Hub agent"}</option>
                {hubAgents.map((a) => (
                  <option key={a.slug} value={a.slug}>
                    {pickLocalized(a, locale).name} — Hub
                  </option>
                ))}
              </select>
            )
          )}
        </Field>

        {/* ★어떤 AI가 이 자동화를 돌리는지. 값은 예전부터 자동화마다 저장되고 있었는데(runtime_selection_json)
            자동화 화면 어디에도 보이지도 바꾸지도 못했다 — 사용자가 대시보드나 채팅에서 런타임을 바꿔도
            자동화는 자기 것을 계속 썼고, 그 사실이 화면에 없어 "바꿨는데 왜 그대로냐"가 됐다(오너 실측). */}
        <div ref={executionAiRef} id="execution-ai" data-testid="execution-ai-field" style={{ scrollMarginBlock: 24 }}>
          <Field label={locale === "ko" ? "실행 AI" : "Run with"}>
            <select
              data-automation-runtime-select
              value={runtimeKey}
              onChange={(e) => {
                setRuntimeTouched(true);
                const nextKey = e.target.value;
                const nextRuntime = runtimeOptions.find((runtime) => automationRuntimeKey(runtime) === nextKey);
                setRuntimeKey(nextKey);
                setRuntimeModel(nextRuntime?.model ?? "");
              }}
              style={inputStyle}
            >
              <option value="">
                {locale === "ko" ? "역할 기본값 사용 · Worker 풀 우선순위·fallback" : "Role default · Worker pool priority + fallback"}
              </option>
              {runtimeOptions.map((r) => (
                <option key={automationRuntimeKey(r)} value={automationRuntimeKey(r)}>
                  {automationRuntimeLabel(r)}
                  {r.version ? ` (${r.version})` : ""}
                  {r.active ? (locale === "ko" ? " · 현재 활성" : " · active now") : ""}
                </option>
              ))}
            </select>
            {runtimeKey && selectedRuntime && (modelRows.length > 0 || runtimeModel) && (
              <label style={{ display: "grid", gap: 6, marginTop: 10 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: "var(--ink-soft)" }}>{locale === "ko" ? "모델" : "Model"}</span>
                <select
                  data-automation-model-select
                  value={runtimeModel}
                  onChange={(event) => { setRuntimeTouched(true); setRuntimeModel(event.target.value); }}
                  style={inputStyle}
                  disabled={modelRows.length === 0}
                >
                  {defaultModelAllowed && <option value="">{locale === "ko" ? "공급자 기본 모델" : "Provider default"}</option>}
                  {modelRows.map((model) => <option key={model.id} value={model.id}>{model.label}{model.tag ? ` · ${model.tag}` : ""}</option>)}
                  {runtimeModel && !modelRows.some((model) => model.id === runtimeModel) && <option value={runtimeModel}>{runtimeModel} · {locale === "ko" ? "저장된 모델" : "stored"}</option>}
                </select>
              </label>
            )}
            <p data-testid="automation-runtime-semantics" style={{ margin: "7px 0 0", color: "var(--muted-deep)", fontSize: 11, lineHeight: 1.5 }}>
              {runtimeKey
                ? (locale === "ko"
                  ? "자동화별 고정 · 역할 기본보다 우선합니다. 사용할 수 없으면 실행을 중단하며 다른 공급자로 바꾸지 않습니다."
                  : "Automation pin · overrides the role default. If unavailable, the run stops; it does not switch providers.")
                : (locale === "ko"
                  ? "역할 기본값 사용: Worker 풀의 우선순위와 fallback을 따릅니다."
                  : "Role default: follows the Worker pool priority and fallback.")}
            </p>
          </Field>
        </div>

        <Field label={locale === "ko" ? "실행 도구" : "Run tool"}>
          <div style={choiceGridStyle}>
            <ChoiceBtn
              active={toolMode === "auto"}
              onClick={() => {
                setToolModeTouched(true);
                setToolMode("auto");
              }}
              label={locale === "ko" ? "자동 선택" : "Auto"}
              detail={locale === "ko" ? "Agentlas가 작업에 맞춰 고름" : "Agentlas picks per task"}
            />
            <ChoiceBtn
              active={toolMode === "browser"}
              onClick={() => {
                setToolModeTouched(true);
                setToolMode("browser");
              }}
              label={locale === "ko" ? "브라우저" : "Browser"}
              detail={locale === "ko" ? "웹 로그인·게시·검색" : "Web login, post, search"}
            />
            <ChoiceBtn
              active={toolMode === "computer-use"}
              onClick={() => {
                setToolModeTouched(true);
                setToolMode("computer-use");
              }}
              label={locale === "ko" ? "컴퓨터 유즈" : "Computer Use"}
              detail={locale === "ko" ? "Mac 화면·앱 조작" : "Mac screen and apps"}
            />
          </div>
        </Field>

        <Field label={locale === "ko" ? "Hub 사용" : "Hub usage"}>
          <div style={choiceGridStyle}>
            <ChoiceBtn
              active={hubMode === "hub-allowed"}
              onClick={() => setHubMode("hub-allowed")}
              label={locale === "ko" ? "로컬 우선" : "Local first"}
              detail={locale === "ko" ? "부족하면 Hub 후보 연결" : "Use Hub when local falls short"}
            />
            <ChoiceBtn
              active={hubMode === "hub-first"}
              onClick={() => setHubMode("hub-first")}
              label={locale === "ko" ? "Hub 우선" : "Hub first"}
              detail={locale === "ko" ? "Hub 전문가부터 찾음" : "Resolve Hub specialists first"}
            />
            <ChoiceBtn
              active={hubMode === "local-only"}
              onClick={() => setHubMode("local-only")}
              label={locale === "ko" ? "로컬만" : "Local only"}
              detail={locale === "ko" ? "설치된 도구만 사용" : "Use installed tools only"}
            />
          </div>
        </Field>

        <Field label={t("auto.field.prompt")} hint={t("auto.field.prompt.hint")}>
          <textarea
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            rows={4}
            style={{ ...inputStyle, fontFamily: "var(--font-body)", resize: "vertical" }}
            placeholder={targetType === "firm" ? t("auto.placeholder.firm") : t("auto.placeholder.agent")}
          />
        </Field>

        {error && (
          <div role="alert" style={errorStyle}>
            {error}
          </div>
        )}

        <div style={{ display: "flex", gap: 10, marginTop: 24, flexWrap: "wrap" }}>
          <button onClick={() => void submit(false)} disabled={!canSubmit} style={primaryBtn(canSubmit)}>
            {editId ? t("auto.edit.save") : t("project.btn.create")}
          </button>
          {!editId && (
            <button onClick={() => void submit(true)} disabled={!canSubmit} title={t("auto.new.blank.hint")} style={secondaryBtn}>
              {t("auto.new.blank")}
            </button>
          )}
          <button onClick={() => router.back()} style={secondaryBtn}>
            {t("common.cancel")}
          </button>
        </div>
      </section>
    </div>
  );
}

function ChoiceBtn({ active, onClick, label, detail }: { active: boolean; onClick: () => void; label: string; detail: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        minHeight: 64,
        padding: "10px 12px",
        borderRadius: "var(--radius-md)",
        background: active ? "var(--fill-1)" : "var(--paper)",
        color: active ? "var(--accent)" : "var(--ink-soft)",
        border: active ? "1px solid var(--accent-soft)" : "1px solid var(--paper-edge)",
        cursor: "pointer",
        textAlign: "left",
      }}
    >
      <span style={{ display: "block", fontSize: 13, fontWeight: 700, marginBottom: 4 }}>{label}</span>
      <span style={{ display: "block", fontSize: 11, lineHeight: 1.35, color: active ? "var(--accent)" : "var(--muted-deep)" }}>{detail}</span>
    </button>
  );
}

function TabBtn({ active, onClick, icon, label, disabled }: { active: boolean; onClick: () => void; icon: React.ReactNode; label: string; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        flex: 1,
        padding: "10px 14px",
        borderRadius: "var(--radius-md)",
        background: active ? "var(--fill-1)" : disabled ? "var(--paper-2)" : "var(--paper)",
        color: active ? "var(--accent)" : disabled ? "var(--muted)" : "var(--ink-soft)",
        border: active ? "1px solid var(--accent-soft)" : "1px solid var(--paper-edge)",
        fontWeight: 600,
        fontSize: 13,
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.62 : 1,
      }}
    >
      {icon}
      {label}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: 12, background: "var(--paper)", border: "1px dashed var(--paper-edge)", borderRadius: "var(--radius-md)", fontSize: 12, color: "var(--muted-deep)", textAlign: "center" }}>
      {children}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 16 }}>
      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "var(--ink-soft)", marginBottom: 6 }}>{label}</label>
      {children}
      {hint && <p style={{ fontSize: 11, color: "var(--muted-deep)", margin: "6px 2px 0", lineHeight: 1.5 }}>{hint}</p>}
    </div>
  );
}

function primaryBtn(enabled: boolean): React.CSSProperties {
  return {
    padding: "10px 18px",
    borderRadius: "var(--radius-md)",
    background: enabled ? "var(--paper)" : "var(--paper-2)",
    color: enabled ? "var(--ink)" : "var(--muted-deep)",
    fontWeight: 600,
    fontSize: 13,
    border: "1px solid var(--paper-edge)",
    boxShadow: enabled ? "var(--neu-raised)" : "none",
    cursor: enabled ? "pointer" : "default",
  };
}

const secondaryBtn: React.CSSProperties = {
  padding: "10px 18px",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  border: "1px solid var(--paper-edge)",
  fontSize: 13,
  color: "var(--ink-soft)",
  cursor: "pointer",
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  border: "1px solid var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  background: "var(--paper)",
  fontSize: 13,
  outline: "none",
};

const choiceGridStyle: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))",
  gap: 8,
};

const errorStyle: React.CSSProperties = {
  marginTop: 8,
  border: "1px solid color-mix(in srgb, var(--red-deep, #b4533a) 28%, var(--paper-edge))",
  borderRadius: "var(--radius-md)",
  background: "color-mix(in srgb, var(--red-deep, #b4533a) 8%, var(--paper))",
  color: "var(--red-deep, #b4533a)",
  padding: "9px 11px",
  fontSize: 12,
  lineHeight: 1.45,
};
