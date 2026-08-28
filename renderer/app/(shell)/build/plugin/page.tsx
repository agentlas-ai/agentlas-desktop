"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type {
  PluginBuilderAnswers,
  PluginBuilderPhase,
  PluginBuilderSession,
  PluginDraftResult,
  PluginGateReport,
  PluginInstallReceipt,
  PluginProofReceipt,
  OneSuggestionReviewSeed,
} from "@/lib/types";
import { isOneSuggestionReviewSeed } from "@shared/one-review-seed";
import styles from "./page.module.css";

const PHASES: PluginBuilderPhase[] = ["interview", "draft", "verify", "install", "prove"];

function slugFromRequest(request: string): string {
  const value = request.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return value.length >= 2 ? value : "my-procedure";
}

function lines(value: string, fallback: string): string[] {
  const parsed = value.split("\n").map((line) => line.trim()).filter(Boolean);
  return parsed.length ? parsed : [fallback];
}

function isPluginSeed(seed: OneSuggestionReviewSeed): seed is Extract<OneSuggestionReviewSeed, { kind: "plugin_build" }> {
  return seed.kind === "plugin_build" && seed.targetSurface === "plugin";
}

export default function PluginBuilderPage() {
  const params = useSearchParams();
  const { locale } = useT();
  const ko = locale === "ko";
  const chatId = params.get("chat") || "plugin-builder";
  const request = params.get("request") || (ko ? "반복 작업을 처리하는 절차 플러그인" : "A procedure plugin for a repeated task");
  const suggestionId = params.get("suggestionId");
  const suggestionVersion = params.get("suggestionVersion");
  const reviewRequestId = params.get("reviewRequestId");
  const draftId = params.get("draftId");
  const originTaskId = params.get("originTaskId");
  const startedKey = `${chatId}:${suggestionId ?? "mention"}:${request}`;
  const startedRef = useRef<string | null>(null);
  const [session, setSession] = useState<PluginBuilderSession | null>(null);
  const [draft, setDraft] = useState<PluginDraftResult | null>(null);
  const [gate, setGate] = useState<PluginGateReport | null>(null);
  const [install, setInstall] = useState<PluginInstallReceipt | null>(null);
  const [proof, setProof] = useState<PluginProofReceipt | null>(null);
  const [log, setLog] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [savedDraftCount, setSavedDraftCount] = useState(0);
  const [answers, setAnswers] = useState<PluginBuilderAnswers>(() => ({
    slug: slugFromRequest(request),
    name: "My Procedure",
    description: request,
    category: "custom",
    workflows: [{
      name: "run",
      description: "Run the repeated procedure and verify its result.",
      steps: ["Read the request and choose the required host capability.", "Run the procedure in the declared order."],
      outputs: ["A concise result summary."],
      verification: ["Confirm the result is non-empty and matches the requested procedure."],
    }],
    requiresTools: [],
    permissions: { fileWrite: "none", network: "none", shell: "deny" },
    state: { files: [], assets: false },
  }));

  const api = ipc();
  const workflow = answers.workflows[0];
  const ui = useMemo(() => ko ? {
    eyebrow: "@plugin-make · 로컬 빌더",
    title: "반복 작업을 플러그인으로",
    lede: "대화에서 정한 절차를 일반 agentlas.plugin/v2 패키지로 만들고, 설치 전에 스펙 게이트를 통과시킨 뒤 실제 워크플로 하나를 실행합니다.",
    saved: (count: number) => `이 채팅에서 이어갈 수 있는 초안 ${count}개가 있습니다. 현재 세션은 SQLite에 보존됩니다.`,
    phases: { interview: "인터뷰", draft: "초안", verify: "검증", install: "설치", prove: "실행 증명" },
    interview: "1. 인터뷰 답변",
    slugHint: "설치 경로와 @멘션이 되므로 초안 이후 바꿀 수 없습니다.",
    name: "이름",
    routerDescription: "라우터 설명",
    routerHint: "플러그인을 언제 열지 결정하는 한 문장입니다.",
    workflowName: "워크플로 이름",
    workflowDescription: "워크플로 설명",
    hostTools: "필요한 호스트 도구",
    hostToolsHint: "쉼표로 구분: browser, computer-use, agent-routing, time, data, custom",
    stateFiles: "상태 파일",
    stateFilesHint: "쉼표로 구분. 사용자 상태는 설치/갱신 때 보존됩니다.",
    steps: "단계",
    stepsHint: "한 줄에 한 단계",
    outputs: "산출물",
    verification: "검증 기준",
    fileWrite: "파일 쓰기 권한",
    network: "네트워크",
    shell: "셸",
    build: "초안 만들고 검증",
    cancel: "취소",
    draft: "2. 초안",
    gate: "3. 게이트 결과",
    gatePass: "PASS · 설치 가능",
    gateFail: "FAIL · 설치 차단",
    installProof: "4. 설치와 실행 증명",
    installProofBody: "설치 후 라우터 주입을 확인하고 첫 워크플로를 실제 런타임에 호출합니다. 런타임이나 도구가 없으면 성공으로 포장하지 않고 설치됨·미검증으로 남깁니다.",
    installAction: "설치하고 실행 증명",
    installReceipt: "설치 영수증",
    proof: "실행 증명",
    proofDone: (name: string) => `검증 완료: 라우터가 주입됐고 ${name} 워크플로가 실제 실행됐습니다.`,
    unproven: "설치됨 · 미검증",
    unprovenReason: "필요한 런타임 또는 도구가 없어 실행 증명을 완료하지 못했습니다.",
    blocked: "검증이 막혔습니다. 아래 게이트 원문을 고친 뒤 다시 초안을 만드세요.",
    invalidSeed: "이 추천은 플러그인 빌더 seed가 아닙니다.",
  } : {
    eyebrow: "@plugin-make · Local builder",
    title: "Turn repeated work into a plugin",
    lede: "Turn the procedure agreed in chat into a standard agentlas.plugin/v2 package, pass its specification gates before installation, and run one real workflow.",
    saved: (count: number) => `${count} resumable draft${count === 1 ? "" : "s"} exist for this chat. The current session is preserved in SQLite.`,
    phases: { interview: "Interview", draft: "Draft", verify: "Verify", install: "Install", prove: "Execution proof" },
    interview: "1. Interview answers",
    slugHint: "This becomes the install path and @mention, so it cannot change after drafting.",
    name: "Name",
    routerDescription: "Router description",
    routerHint: "One sentence that determines when this plugin should open.",
    workflowName: "Workflow name",
    workflowDescription: "Workflow description",
    hostTools: "Required host tools",
    hostToolsHint: "Comma-separated: browser, computer-use, agent-routing, time, data, custom",
    stateFiles: "State files",
    stateFilesHint: "Comma-separated. User state is preserved across install and update.",
    steps: "Steps",
    stepsHint: "One step per line",
    outputs: "Outputs",
    verification: "Verification criteria",
    fileWrite: "File-write permission",
    network: "Network",
    shell: "Shell",
    build: "Create draft and verify",
    cancel: "Cancel",
    draft: "2. Draft",
    gate: "3. Gate result",
    gatePass: "PASS · Ready to install",
    gateFail: "FAIL · Installation blocked",
    installProof: "4. Install and prove execution",
    installProofBody: "After installation, verify router injection and invoke the first workflow in the real runtime. If the runtime or tools are unavailable, the result remains installed but unverified.",
    installAction: "Install and prove execution",
    installReceipt: "Install receipt",
    proof: "Execution proof",
    proofDone: (name: string) => `Verified: the router was injected and the ${name} workflow actually ran.`,
    unproven: "Installed · Unverified",
    unprovenReason: "The required runtime or tools were unavailable, so execution proof could not be completed.",
    blocked: "Verification is blocked. Fix the gate output below, then create the draft again.",
    invalidSeed: "This recommendation is not a plugin-builder seed.",
  }, [ko]);
  const update = <K extends keyof PluginBuilderAnswers>(key: K, value: PluginBuilderAnswers[K]) => {
    setAnswers((current) => ({ ...current, [key]: value }));
  };
  const updateWorkflow = (key: keyof typeof workflow, value: string | string[]) => {
    setAnswers((current) => ({
      ...current,
      workflows: [{ ...current.workflows[0], [key]: value }],
    }));
  };

  useEffect(() => {
    if (!api || startedRef.current === startedKey) return;
    startedRef.current = startedKey;
    let disposed = false;
    const off = api.pluginBuilder.onProgress((event) => {
      if (event.sessionId === session?.id || !session) setLog((current) => [...current.slice(-39), event.line]);
    });
    const start = async () => {
      try {
        let seed: Parameters<typeof api.pluginBuilder.start>[0]["seed"] = { kind: "mention", request };
        if (suggestionId && suggestionVersion && reviewRequestId && draftId && originTaskId) {
          const raw = await api.oneSuggestions.getReviewSeed({
            suggestionId,
            expectedSuggestionVersion: Number(suggestionVersion),
            reviewRequestId,
            draftId,
            originTaskId,
          });
          if (!isOneSuggestionReviewSeed(raw) || !isPluginSeed(raw)) throw new Error(ui.invalidSeed);
          seed = { kind: "suggestion", suggestionId, signal: raw.signal };
        }
        const started = await api.pluginBuilder.start({ chatId, seed });
        if (disposed) return;
        setSession(started);
        const drafts = await api.pluginBuilder.listDrafts(chatId);
        setSavedDraftCount(drafts.length);
        setLog((current) => [...current, `session ${started.id} · ${seed.kind}`]);
      } catch (cause) {
        if (!disposed) setError(cause instanceof Error ? cause.message : String(cause));
      }
    };
    void start();
    return off;
  }, [api, chatId, draftId, originTaskId, request, reviewRequestId, startedKey, suggestionId, suggestionVersion, ui.invalidSeed]);

  const phase = proof ? "prove" : install ? "install" : gate ? "verify" : draft ? "draft" : "interview";
  const phaseIndex = PHASES.indexOf(phase);
  const phaseLabel = ui.phases as Record<PluginBuilderPhase, string>;

  const buildDraft = async () => {
    if (!api || !session) return;
    setBusy(true); setError(null); setGate(null); setProof(null);
    try {
      const result = await api.pluginBuilder.draft({ sessionId: session.id, answers });
      setDraft(result);
      setSession(result.session);
      const report = await api.pluginBuilder.verify({ sessionId: session.id });
      setGate(report);
      setSession((current) => current ? { ...current, phase: "verify", gateReport: report } : current);
      if (!report.ok) setError(ui.blocked);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const installAndProve = async () => {
    if (!api || !session || !gate?.ok) return;
    setBusy(true); setError(null);
    try {
      const receipt = await api.pluginBuilder.install({ sessionId: session.id });
      setInstall(receipt);
      const installedSession = { ...session, phase: "install" as const, stagingDir: receipt.installedDir };
      setSession(installedSession);
      const proofReceipt = await api.pluginBuilder.prove({ sessionId: session.id });
      setProof(proofReceipt);
      setSession((current) => current ? { ...current, phase: "prove" } : current);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };

  const discard = async () => {
    if (!api || !session) return;
    setBusy(true);
    try { await api.pluginBuilder.discard({ sessionId: session.id }); window.history.back(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusy(false); }
  };

  return (
    <main className={styles.page}>
      <div className={styles.shell}>
        <div className={styles.eyebrow}>{ui.eyebrow}</div>
        <h1 className={styles.title}>{ui.title}</h1>
        <p className={styles.lede}>{ui.lede}</p>
        {savedDraftCount > 0 && <div className={styles.notice}>{ui.saved(savedDraftCount)}</div>}
        {error && <div className={styles.error}>{error}</div>}

        <div className={styles.phase} aria-label="plugin builder phases">
          {PHASES.map((item, index) => <span key={item} className={index < phaseIndex ? styles.done : item === phase ? styles.active : ""}>{phaseLabel[item]}</span>)}
        </div>

        <section className={styles.card}>
          <h2>{ui.interview}</h2>
          <div className={styles.grid}>
            <label className={styles.label}>Slug <span className={styles.hint}>{ui.slugHint}</span><input className={styles.input} value={answers.slug} onChange={(event) => update("slug", event.target.value)} /></label>
            <label className={styles.label}>{ui.name}<input className={styles.input} value={answers.name} onChange={(event) => update("name", event.target.value)} /></label>
            <label className={`${styles.label} ${styles.wide}`}>{ui.routerDescription} <span className={styles.hint}>{ui.routerHint}</span><textarea className={styles.textarea} value={answers.description} onChange={(event) => update("description", event.target.value)} /></label>
            <label className={styles.label}>{ui.workflowName}<input className={styles.input} value={workflow.name} onChange={(event) => updateWorkflow("name", event.target.value)} /></label>
            <label className={styles.label}>{ui.workflowDescription}<input className={styles.input} value={workflow.description} onChange={(event) => updateWorkflow("description", event.target.value)} /></label>
            <label className={styles.label}>{ui.hostTools} <span className={styles.hint}>{ui.hostToolsHint}</span><input className={styles.input} value={answers.requiresTools.join(", ")} onChange={(event) => update("requiresTools", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} /></label>
            <label className={styles.label}>{ui.stateFiles} <span className={styles.hint}>{ui.stateFilesHint}</span><input className={styles.input} value={answers.state.files.join(", ")} onChange={(event) => update("state", { ...answers.state, files: event.target.value.split(",").map((item) => item.trim()).filter(Boolean) })} /></label>
            <label className={`${styles.label} ${styles.wide}`}>{ui.steps} <span className={styles.hint}>{ui.stepsHint}</span><textarea className={styles.textarea} value={workflow.steps.join("\n")} onChange={(event) => updateWorkflow("steps", lines(event.target.value, "Run the procedure in order."))} /></label>
            <label className={styles.label}>{ui.outputs} <textarea className={styles.textarea} value={workflow.outputs.join("\n")} onChange={(event) => updateWorkflow("outputs", lines(event.target.value, "A concise result summary."))} /></label>
            <label className={styles.label}>{ui.verification} <textarea className={styles.textarea} value={workflow.verification.join("\n")} onChange={(event) => updateWorkflow("verification", lines(event.target.value, "Confirm the result is non-empty."))} /></label>
            <label className={styles.label}>{ui.fileWrite}<select className={styles.select} value={answers.permissions.fileWrite} onChange={(event) => update("permissions", { ...answers.permissions, fileWrite: event.target.value as PluginBuilderAnswers["permissions"]["fileWrite"] })}><option value="none">none</option><option value="project-only">project-only</option><option value="ask">ask</option><option value="full">full</option></select></label>
            <label className={styles.label}>{ui.network}<select className={styles.select} value={answers.permissions.network} onChange={(event) => update("permissions", { ...answers.permissions, network: event.target.value as PluginBuilderAnswers["permissions"]["network"] })}><option value="none">none</option><option value="ask">ask</option><option value="allow">allow</option></select></label>
            <label className={styles.label}>{ui.shell}<select className={styles.select} value={answers.permissions.shell} onChange={(event) => update("permissions", { ...answers.permissions, shell: event.target.value as PluginBuilderAnswers["permissions"]["shell"] })}><option value="deny">deny</option><option value="ask">ask</option><option value="allow">allow</option></select></label>
          </div>
          <div className={styles.actions}>
            <button className={styles.button} type="button" disabled={busy || !session} onClick={() => void buildDraft()}>{ui.build}</button>
            <button className={`${styles.button} ${styles.danger}`} type="button" disabled={busy || !session} onClick={() => void discard()}>{ui.cancel}</button>
          </div>
        </section>

        {draft && <section className={styles.card}><h2>{ui.draft}</h2><p className={styles.small}>{draft.summary}</p><div className={styles.log}>{draft.files.join("\n")}</div></section>}
        {gate && <section className={styles.card}><h2>{ui.gate}</h2><div className={styles.gate}><strong>{gate.ok ? ui.gatePass : ui.gateFail}</strong>{gate.violations.length > 0 && <ul>{gate.violations.map((violation) => <li key={violation}>{violation}</li>)}</ul>}</div><div className={styles.log}>{[gate.stdout, gate.stderr].filter(Boolean).join("\n")}</div></section>}
        {gate?.ok && !proof && <section className={styles.card}><h2>{ui.installProof}</h2><p className={styles.small}>{ui.installProofBody}</p><div className={styles.actions}><button className={styles.button} type="button" disabled={busy} onClick={() => void installAndProve()}>{ui.installAction}</button></div></section>}
        {install && <section className={styles.card}><h2>{ui.installReceipt}</h2><p className={styles.small}>{install.summary}</p><div className={styles.log}>{JSON.stringify(install, null, 2)}</div></section>}
        {proof && <section className={styles.card}><h2>{ui.proof}</h2>{proof.proven ? <div className={styles.success}>{ui.proofDone(proof.workflowRun?.name || "run")}<br />{proof.workflowRun?.summary}</div> : <div className={styles.unproven}>{ui.unproven}<br />{proof.reason || ui.unprovenReason}</div>}<div className={styles.log}>{JSON.stringify(proof, null, 2)}</div></section>}
        {log.length > 0 && <div className={styles.log}>{log.join("\n")}</div>}
      </div>
    </main>
  );
}
