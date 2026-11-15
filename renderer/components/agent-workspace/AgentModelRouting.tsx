"use client";

// The model popover of an agent (Agentlas 2.0 F-D8, pictures agents-v6-model-worker / agents-v6-model-own, decision).
//   · Three choices: Worker (the default - an agent whose owner never chose follows it, nothing is saved), Orchestrator, Own order.
//   · Worker / Orchestrator show the global order read-only; "Own order" is up to 12 editable lines.
//   · Every write goes through agentModelOrder.setFollow / setOwn; a refusal code is said in words, never swallowed.
import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { IconClose, IconExternalLink, IconPlus, IconSettings, IconUsers, IconRoute } from "@/components/Icon";
import { RuntimeModelPicker, type RuntimeModelPickerOption } from "@/components/dashboard/RuntimeModelPicker";
import { Select } from "@/components/Select";
import { ipc } from "@/lib/ipc";
import { effortOptions } from "@/lib/effort-label";
import { runtimeUsesEngineModelSetting } from "@shared/models";
import type { AgentModelLine, AgentModelOrderResult, AgentModelOrderView, AgentRuntimeOverride, AgentRuntimeOverrideScope, RuntimeStatus } from "@shared/types";
import { effortLabel, lineLabels, modelRefusalText, runtimeForLine } from "./agent-manage-model";
import styles from "./AgentManage.module.css";

/** Which saved row would decide this agent's runtime, most specific first, or null for the global default. Pure. */
export function inheritedOverride(overrides: AgentRuntimeOverride[], targets: Array<{ scope: AgentRuntimeOverrideScope; targetId: string }>): AgentRuntimeOverride | null {
  for (const target of targets) {
    const found = overrides.find((item) => item.scope === target.scope && item.targetId === target.targetId);
    if (found) return found;
  }
  return null;
}

const MAX_LINES = 12;
const optionKey = (kind: string, backend: string | undefined, acp: string | undefined, model: string | null | undefined) => [kind, backend ?? "", acp ?? "", model ?? ""].join("\u0000");

/** One option per model of every runtime the app knows (subscription CLIs, API, local); ACP lines are listed and refused by the host with a word. */
function buildOptions(runtimes: RuntimeStatus[]): RuntimeModelPickerOption[] {
  const options: RuntimeModelPickerOption[] = [];
  for (const runtime of runtimes) {
    const ids = [...new Set([...(runtime.availableModels ?? []), ...(runtime.model ? [runtime.model] : [])])];
    if (runtimeUsesEngineModelSetting(runtime.kind)) options.push({ key: optionKey(runtime.kind, runtime.backend, runtime.acpAgentId, null), label: "", runtime, isDefault: true });
    for (const id of ids) options.push({ key: optionKey(runtime.kind, runtime.backend, runtime.acpAgentId, id), model: id, label: id, runtime });
  }
  return options;
}

export function AgentModelPopover({ agentId, locale, runtimes, order, onOrder, onClose }: {
  agentId: string; locale: "ko" | "en"; runtimes: RuntimeStatus[]; order: AgentModelOrderView;
  onOrder: (order: AgentModelOrderView) => void; onClose: () => void;
}) {
  const ko = locale === "ko";
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState("");
  const options = useMemo(() => buildOptions(runtimes), [runtimes]);
  // The tab shown follows what the agent does now; an owner who never chose follows Worker.
  const follow = order.explicit || order.follow !== "worker" ? order.follow : "worker";
  useEffect(() => {
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [onClose]);
  const run = useCallback(async (task: () => Promise<AgentModelOrderResult> | undefined) => {
    if (busy) return;
    setBusy(true); setRefusal("");
    try {
      const answer = await task();
      if (!answer) setRefusal(modelRefusalText("unavailable", ko));
      else if (answer.ok) onOrder(answer.order);
      else setRefusal(modelRefusalText(answer.code, ko));
    } catch { setRefusal(modelRefusalText("unavailable", ko)); } finally { setBusy(false); }
  }, [busy, ko, onOrder]);
  const choose = (next: "worker" | "orchestrator" | "own") => {
    if (next === follow && order.explicit) return;
    void run(() => ipc()?.agentModelOrder?.setFollow({ agentId, follow: next }));
  };
  const lines = follow === "own" ? order.own : follow === "orchestrator" ? order.global.orchestrator : order.global.worker;
  const writeOwn = (next: AgentModelLine[]) => void run(() => ipc()?.agentModelOrder?.setOwn({ agentId, lines: next }));
  const lineFromOption = (option: RuntimeModelPickerOption, previous: AgentModelLine): AgentModelLine => ({
    kind: option.runtime.kind, ...(option.runtime.backend ? { backend: option.runtime.backend } : {}), ...(option.runtime.source ? { source: option.runtime.source } : {}),
    ...(option.runtime.acpAgentId ? { acpAgentId: option.runtime.acpAgentId } : {}), model: option.model ?? null,
    effort: previous.kind === option.runtime.kind ? previous.effort : null, longContext: previous.longContext,
  });
  const segs: Array<{ key: "worker" | "orchestrator" | "own"; label: string; icon: JSX.Element }> = [
    { key: "worker", label: ko ? "워커" : "Worker", icon: <IconUsers size={16} /> }, { key: "orchestrator", label: ko ? "오케스트레이터" : "Orchestrator", icon: <IconRoute size={16} /> },
    { key: "own", label: ko ? "내 순서" : "Own order", icon: <IconSettings size={16} /> },
  ];
  const caption = follow === "own" ? (ko ? "이 에이전트만의 순서" : "This agent's own order")
    : follow === "orchestrator" ? (ko ? "오케스트레이터 순서를 따라요" : "Follows the Orchestrator order") : (ko ? "워커 순서를 따라요" : "Follows the Worker order");
  return <div className={styles.pop} role="dialog" aria-label={ko ? "모델" : "Model"} data-agent-model-popover style={{ left: 32, top: 0 }}>
    <div className={styles.popHead}>{ko ? "모델" : "Model"}<small>{follow === "own" ? caption : <Link href="/dashboard" onClick={onClose}>{caption}<IconExternalLink size={13} /></Link>}</small></div>
    <div className={styles.seg} role="tablist">{segs.map((seg) => <button key={seg.key} type="button" role="tab" aria-selected={follow === seg.key} disabled={busy} className={follow === seg.key ? styles.segOn : ""} onClick={() => choose(seg.key)}>{seg.icon}{seg.label}</button>)}</div>
    <div className={styles.lines}>
      {lines.length === 0 && <div className={`${styles.lineBox} ${styles.lineGrey}`}><span>{ko ? "등록된 모델이 없어요" : "No model yet"}</span></div>}
      {lines.map((line, index) => {
        const names = lineLabels(line, runtimes, locale);
        const effort = effortLabel(line, runtimes, locale);
        if (follow !== "own") return <div className={`${styles.line} ${styles.lineRead}`} key={index}>
          <div className={`${styles.lineBox} ${styles.lineGrey}`}><span>{names.model}</span><small>{names.engine}</small></div>
          <div className={`${styles.lineBox} ${styles.lineGrey}`}><span>{effort ?? "—"}</span></div></div>;
        const runtime = runtimeForLine(line, runtimes);
        const efforts = effortOptions(runtime?.efforts, locale);
        const selected = optionKey(line.kind, line.backend, line.acpAgentId, line.model);
        const shown = options.some((option) => option.key === selected) ? options : [{ key: selected, model: line.model ?? undefined, label: names.model, runtime: runtime ?? ({ kind: line.kind, backend: line.backend ?? "custom", source: line.source ?? "unavailable", version: null, active: false } as RuntimeStatus) }, ...options];
        return <div className={styles.line} key={index}>
          <div className={styles.pickerSlot}><RuntimeModelPicker options={shown} value={selected} locale={locale} disabled={busy} ariaLabel={`${ko ? "모델" : "Model"} ${index + 1}`} onSelect={(option) => writeOwn(order.own.map((item, at) => at === index ? lineFromOption(option, item) : item))} /></div>
          <Select aria-label={`${ko ? "작업량" : "Effort"} ${index + 1}`} value={line.effort ?? ""} disabled={busy || efforts.length === 0} onChange={(event) => writeOwn(order.own.map((item, at) => at === index ? { ...item, effort: event.target.value || null } : item))}>
            {efforts.length === 0 && <option value="">—</option>}{efforts.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </Select>
          {index > 0 ? <button type="button" className={styles.ib} disabled={busy} aria-label={ko ? "이 모델 삭제" : "Remove this line"} onClick={() => writeOwn(order.own.filter((_, at) => at !== index))}><IconClose size={14} /></button> : <span />}
        </div>;
      })}
      {follow === "own" && <button type="button" className={styles.addLine} disabled={busy || order.own.length >= MAX_LINES || options.length === 0} aria-label={ko ? "모델 추가" : "Add a model line"} onClick={() => {
        const first = options.find((option) => !option.isDefault) ?? options[0];
        if (first) writeOwn([...order.own, lineFromOption(first, { kind: first.runtime.kind, model: null, effort: null, longContext: false })]);
      }}><IconPlus size={16} /></button>}
    </div>
    {refusal && <p className={styles.refusal} role="alert">{refusal}</p>}
  </div>;
}
