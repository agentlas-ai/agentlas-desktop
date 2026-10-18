"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { ipc } from "@/lib/ipc";
import { confirmPopup } from "@/lib/popup";
import { requestOneOperationalRecovery } from "@/lib/one-operational-recovery";
import { tFor, type Locale } from "@/lib/i18n";
import type {
  OneExperienceReuseRecord,
  OneImprovementProofRecord,
  OneImprovementReusedAssetV1,
  OneMemoryAsset,
  OneMemoryCandidate,
  OneMemoryScope,
  OneMemoryState,
  OneMemoryUseOnceReceipt,
  OneMemoryUseOnceTarget,
  OneValueClosureRecord,
  OneValueClosureState,
} from "@/lib/types";
import { OneValueClosureCard } from "./OneValueClosureCard";
import { OneExperienceReuseCard } from "./OneExperienceReuseCard";
import { OneImprovementProofCard } from "./OneImprovementProofCard";
import { OneBottomSheet } from "./OneBottomSheet";
import { LoadingEstimate } from "@/components/LoadingEstimate";
import { BUILTIN_ONE_AGENT_ID } from "@shared/builtin-agent-ids";
import type { AgentAppMemorySharing } from "@shared/agent-app-memory";
import type { DesktopMemoryQueryResult, DesktopMemoryDetail, DesktopMemoryStatus } from "@shared/desktop-memory-inspector";
import type { OneDurableMemoryEntryUi } from "@shared/types";
import type { OneMemoryMapSnapshot } from "@shared/one-memory-map";
import { OneMemoryMap, ONE_MEMORY_KIND_COLORS } from "./OneMemoryMap";
import { IconBrain, IconAlertTriangle, IconFileText, IconLayers, IconRoute, IconSearch, IconSparkles, IconTarget, IconTrash, IconUser } from "@/components/Icon";
import styles from "./OneMemorySheet.module.css";

interface OneMemorySheetProps {
  open: boolean;
  state: OneMemoryState | null;
  locale: "ko" | "en";
  useOnceTarget: OneMemoryUseOnceTarget | null;
  onClose: () => void;
  onStateChange: (state: OneMemoryState) => void;
  onUseOnceReady: (receipt: OneMemoryUseOnceReceipt, target: OneMemoryUseOnceTarget) => void;
  /**
   * REQ-019 / REQ-023: compounding records stay out of the beginner-facing One
   * result, but they must still be openable and manageable somewhere. This
   * sheet is that place — it is already where `onManageExperience` points.
   */
  valueClosure?: OneValueClosureRecord | null;
  experienceReuse?: OneExperienceReuseRecord | null;
  improvementProof?: OneImprovementProofRecord | null;
  valueClosureState?: OneValueClosureState | null;
  onValueClosureStateChange?: (state: OneValueClosureState) => void;
  onManageImprovementAsset?: (asset: OneImprovementReusedAssetV1) => void;
}

function scopeLabel(scope: OneMemoryScope, locale: Locale): string {
  if (scope === "personal") return tFor(locale, "one.mem.scope.personal");
  if (scope === "project") return tFor(locale, "one.mem.scope.project");
  if (scope === "agent") return tFor(locale, "one.mem.scope.agent");
  return tFor(locale, "one.mem.scope.team");
}

function basisLabel(candidate: OneMemoryCandidate, locale: Locale): string {
  if (candidate.source.basis === "explicit_user_statement") return tFor(locale, "one.mem.basis.explicit");
  if (candidate.source.basis === "user_correction") return tFor(locale, "one.mem.basis.correction");
  return tFor(locale, "one.mem.basis.suggested");
}

function resolutionLabel(candidate: OneMemoryCandidate, locale: Locale): string {
  if (candidate.status === "saved") return tFor(locale, "one.mem.resolution.saved");
  if (candidate.status === "used_once") return tFor(locale, "one.mem.resolution.used_once");
  if (candidate.status === "rejected") return tFor(locale, "one.mem.resolution.rejected");
  return tFor(locale, "one.mem.resolution.pending");
}

function formatDate(value: string, locale: "ko" | "en"): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return value;
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function formatShortDate(value: string, locale: "ko" | "en"): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(locale === "ko" ? "ko-KR" : "en-US", { month: "numeric", day: "numeric" });
}

function shortRef(value: string): string {
  return value.length > 22 ? `${value.slice(0, 9)}…${value.slice(-8)}` : value;
}

/** Memory kinds as the owner reads them: an icon, a word, a colour (owner 2026-10-04: visuals, no filler). */
const KIND_ICON: Record<string, typeof IconRoute> = {
  procedure: IconRoute, decision: IconTarget, preference: IconUser, risk: IconAlertTriangle,
  fact: IconFileText, hypothesis: IconSparkles,
};
function kindLabel(kind: string, locale: Locale): string {
  const ko: Record<string, string> = { procedure: "방법", decision: "결정", preference: "선호", risk: "위험", fact: "사실",
    hypothesis: "가설", evidence: "근거", deprecation: "폐기", conflict: "충돌" };
  const en: Record<string, string> = { procedure: "How-to", decision: "Decision", preference: "Preference", risk: "Risk", fact: "Fact",
    hypothesis: "Hypothesis", evidence: "Evidence", deprecation: "Retired", conflict: "Conflict" };
  return (locale === "ko" ? ko : en)[kind] ?? kind;
}
function KindIcon({ kind, size = 14 }: { kind: string; size?: number }) {
  const Icon = KIND_ICON[kind] ?? IconLayers;
  return <span className={styles.kindIcon} style={{ color: ONE_MEMORY_KIND_COLORS[kind] ?? "#8a8d92" }} aria-hidden="true"><Icon size={size} /></span>;
}

/** Older preload compatibility: exactly one historical One reader is mounted
 * only when the optional Desktop Inspector is absent. No new intake or approval. */
function LegacyOneMemoryView({open,locale}:{open:boolean;locale:"ko"|"en"}) {
  const [busyId,setBusyId]=useState<string|null>(null),[message,setMessage]=useState<string|null>(null),[error,setError]=useState<string|null>(null);
  const [durable, setDurable] = useState<OneDurableMemoryEntryUi[] | null>(null);
  const [durableError, setDurableError] = useState(false);
  const [durableRetry, setDurableRetry] = useState(0);
  const [durableQuery, setDurableQuery] = useState("");
  const [durableExpanded, setDurableExpanded] = useState(false);
  const [memoryMap, setMemoryMap] = useState<OneMemoryMapSnapshot | null>(null);
  const [kindFilter, setKindFilter] = useState<string | null>(null);
  const [selectedMemory, setSelectedMemory] = useState<string | null>(null);
  const durableRequest = useRef(0);
  useEffect(() => {
    const request = ++durableRequest.current;
    // A closed sheet forgets its last read, so reopening shows "loading" instead of the old count for a frame.
    if (!open) { setDurable(null); setMemoryMap(null); setSelectedMemory(null); return; }
    setBusyId(null);
    setDurable(null);
    setDurableError(false);
    const api = ipc();
    if (!api?.oneMemory?.listEntries) {
      setDurableError(true);
      return;
    }
    api.oneMemory.listEntries({ limit: 1000 })
      .then((rows) => {
        if (request !== durableRequest.current) return;
        if (!Array.isArray(rows)) { setDurableError(true); return; }
        setDurable(rows);
      })
      .catch(() => { if (request === durableRequest.current) setDurableError(true); });
    // The map is a picture of the same entries; without it the list still works.
    void api.oneMemory.getMap?.().then((map) => { if (request === durableRequest.current) setMemoryMap(map); }).catch(() => undefined);
    return () => { ++durableRequest.current; };
  }, [open, durableRetry]);
  const forgetDurable = async (entry: OneDurableMemoryEntryUi) => {
    const api = ipc();
    if (!api?.oneMemory?.forgetEntry) return;
    const request = ++durableRequest.current;
    setBusyId(entry.id);
    setMessage(null);
    setError(null);
    try {
      const result = await api.oneMemory.forgetEntry({ memoryId: entry.id });
      if (request !== durableRequest.current) return;
      // Main may revoke several duplicate rows. Replace the complete projection
      // instead of leaving another forgotten row visible until the sheet reopens.
      setDurable(null);
      const rows = await api.oneMemory.listEntries({ limit: 1000 });
      if (request !== durableRequest.current) return;
      setDurable(rows);
      void api.oneMemory.getMap?.().then((map) => { if (request === durableRequest.current) setMemoryMap(map); }).catch(() => undefined);
      if (result.ok) {
        setMessage(locale === "ko" ? "잊었어요. 기억 지도에서도 사라집니다." : "Forgotten. It leaves the memory map too.");
        setError(null);
      }
    } catch (cause) {
      if (request === durableRequest.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === durableRequest.current) setBusyId(null);
    }
  };
  const durableFiltered = useMemo(() => {
    const rows = durable ?? [];
    const query = durableQuery.trim().toLowerCase();
    const ofKind = kindFilter ? rows.filter((row) => row.kind === kindFilter) : rows;
    const filtered = query
      ? ofKind.filter((row) => row.title.toLowerCase().includes(query) || row.content.toLowerCase().includes(query) || (row.projectSlug ?? "").toLowerCase().includes(query) || row.kind.toLowerCase().includes(query))
      : ofKind;
    // The memory picked on the map is always in view, first.
    const picked = selectedMemory ? filtered.find((row) => row.id === selectedMemory) : undefined;
    const ordered = picked ? [picked, ...filtered.filter((row) => row !== picked)] : filtered;
    return durableExpanded || query || kindFilter ? ordered : ordered.slice(0, 8);
  }, [durable, durableQuery, durableExpanded, kindFilter, selectedMemory]);
  const kindCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const row of durable ?? []) counts.set(row.kind, (counts.get(row.kind) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [durable]);
  const describeMemory = useCallback((id: string) => {
    const row = durable?.find((entry) => entry.id === id);
    return row ? { label: kindLabel(row.kind, locale), text: row.content } : null;
  }, [durable, locale]);
  useEffect(()=>{if(!open)return;return window.agentlasEvents?.onStoreChanged?.(change=>{
    if(!["agent","project","one-profile","runtime"].includes(change.entity))return;
    ++durableRequest.current;setDurable(null);setMemoryMap(null);setSelectedMemory(null);setDurableRetry(value=>value+1);
  });},[open]);
  return <><section className={styles.section} aria-labelledby="durable-memory-title" data-one-durable-memory="true">
              <h3 id="durable-memory-title" className={styles.memoryCount}>
                {locale === "ko" ? "기억" : "Memories"} <span>{durable ? durable.length : durableError ? "!" : "…"}</span>
              </h3>
              {memoryMap && memoryMap.nodes.length > 0 && (
                <div className={styles.memoryMap} data-one-memory-sheet-map="true">
                  <OneMemoryMap snapshot={memoryMap} locale={locale === "ko" ? "ko" : "en"} height={232} colorByKind
                    selectedId={selectedMemory} onSelect={setSelectedMemory} describe={describeMemory} />
                </div>
              )}
              {kindCounts.length > 1 && (
                <div className={styles.kindChips} role="group" aria-label={locale === "ko" ? "종류" : "Kind"}>
                  <button type="button" data-hover="own" data-active={kindFilter === null ? "true" : "false"} onClick={() => setKindFilter(null)}>
                    {locale === "ko" ? "전체" : "All"} <small>{durable?.length ?? 0}</small>
                  </button>
                  {kindCounts.map(([kind, count]) => (
                    <button key={kind} type="button" data-hover="own" data-kind={kind} data-active={kindFilter === kind ? "true" : "false"}
                      onClick={() => setKindFilter((current) => current === kind ? null : kind)}>
                      <KindIcon kind={kind} size={13} />{kindLabel(kind, locale)} <small>{count}</small>
                    </button>
                  ))}
                </div>
              )}
              {durable && durable.length > 8 && (
                <label className={styles.memorySearch}>
                  <IconSearch size={14} />
                  <input
                    type="search"
                    value={durableQuery}
                    onChange={(event) => setDurableQuery(event.target.value)}
                    placeholder={locale === "ko" ? "검색" : "Search"}
                    aria-label={locale === "ko" ? "기억 검색" : "Search memories"}
                  />
                </label>
              )}
              <div className={styles.memoryList}>
                {durableError ? (
                  <div>
                    <p className={styles.error} role="alert">{locale === "ko" ? "기억을 불러오지 못했습니다. 다시 시도해 주세요." : "Memories could not be loaded. Try again."}</p>
                    <button type="button" className={styles.secondaryButton} onClick={() => setDurableRetry(value => value + 1)} disabled={Boolean(busyId)}>{locale === "ko" ? "기억 다시 불러오기" : "Retry loading memories"}</button>
                  </div>
                ) : durable === null ? (
                  <p className={styles.empty} role="status">{locale === "ko" ? "기억을 불러오는 중입니다." : "Loading memories."}</p>
                ) : null}
                {durable && durable.length === 0 && (
                  <p className={styles.empty}>{locale === "ko" ? "아직 One이 남긴 기억이 없어요. 대화하고 일을 맡기면 여기에 쌓입니다." : "One has not kept anything yet. It fills up as you talk and delegate work."}</p>
                )}
                {durableFiltered.map((entry) => (
                  <article key={entry.id} className={styles.memoryRow} data-durable-entry="true" data-kind={entry.kind}
                    data-selected={selectedMemory === entry.id ? "true" : undefined}
                    onClick={() => setSelectedMemory((current) => current === entry.id ? null : entry.id)}>
                    <KindIcon kind={entry.kind} />
                    <p title={entry.content}>{entry.title || entry.content}</p>
                    <time dateTime={entry.createdAt}>{formatShortDate(entry.createdAt, locale)}</time>
                    <button type="button" className={styles.forgetIcon} data-hover="own" onClick={(event) => { event.stopPropagation(); void forgetDurable(entry); }}
                      disabled={Boolean(busyId)} aria-label={locale === "ko" ? "잊기" : "Forget"} title={locale === "ko" ? "잊기" : "Forget"}>
                      <IconTrash size={14} />
                    </button>
                    {/* The title is the ticket's line; the memory itself opens under it. */}
                    {selectedMemory === entry.id && entry.title && entry.title !== entry.content && <p className={styles.memoryDetail}>{entry.content}</p>}
                  </article>
                ))}
                {durable && !durableExpanded && !durableQuery.trim() && durable.length > 8 && (
                  <button type="button" className={styles.secondaryButton} onClick={() => setDurableExpanded(true)}>
                    {locale === "ko" ? `${durable.length - 8}개 더 보기` : `Show ${durable.length - 8} more`}
                  </button>
                )}
              </div>
            </section>{message&&<p className={styles.message} role="status">{message}</p>}{error&&<p className={styles.error} role="alert">{error}</p>}</>;
}

function DesktopMemoryInspector({open,locale,revisionHint}:{open:boolean;locale:"ko"|"en";revisionHint:OneMemoryState|null}) {
  const [result,setResult]=useState<DesktopMemoryQueryResult|null>(null),[detail,setDetail]=useState<DesktopMemoryDetail|null>(null);
  const [actor,setActor]=useState(BUILTIN_ONE_AGENT_ID),[project,setProject]=useState(""),[scope,setScope]=useState("");
  const [status,setStatus]=useState<DesktopMemoryStatus|"all">("active"),[selected,setSelected]=useState<string|null>(null);
  const [text,setText]=useState(""),[editing,setEditing]=useState(false),[busy,setBusy]=useState(false),[error,setError]=useState<string|null>(null),[notice,setNotice]=useState<string|null>(null),[retry,setRetry]=useState(0);
  const [appSharing,setAppSharing]=useState<AgentAppMemorySharing|null>(null),[appChoice,setAppChoice]=useState("");
  const generation=useRef(0),detailGeneration=useRef(0);
  const errorText=(cause:unknown)=>{
    const message=cause instanceof Error?cause.message:String(cause);
    return message.includes("memory_owner_")?(locale==="ko"?"기억 상태가 바뀌었거나 사용할 수 없습니다. 다시 불러와 주세요.":"The memory changed or is unavailable. Reload it before continuing."):message;
  };
  useEffect(()=>{
    const current=++generation.current;++detailGeneration.current;setResult(null);setDetail(null);setSelected(null);setEditing(false);setError(null);
    if(!open)return;
    const api=ipc()?.oneMemory.inspector;
    if(!api){setError(locale==="ko"?"기억 정보를 불러올 수 없습니다.":"Memory information is unavailable.");return;}
    void api.query({actorId:actor==="*"?null:actor,projectId:project||null,scope:(scope||null) as OneMemoryMapSnapshot["nodes"][number]["scope"]|null,status})
      .then(value=>{if(current===generation.current){if(value.schemaVersion!=="agentlas.desktop-memory-inspector.v1")throw Error("Memory information is unavailable");setResult(value);}})
      .catch(cause=>{if(current===generation.current)setError(errorText(cause));});
    return ()=>{++generation.current;++detailGeneration.current;};
  },[open,actor,project,scope,status,retry,locale,revisionHint]);
  useEffect(()=>{if(!open)return;const events=window.agentlasEvents;
    return events?.onStoreChanged?.((change)=>{if(!["agent","project","one-profile","runtime"].includes(change.entity))return;++generation.current;++detailGeneration.current;setResult(null);setDetail(null);setSelected(null);setEditing(false);setRetry(value=>value+1);});
  },[open]);
  useEffect(()=>{
    const current=++detailGeneration.current;setDetail(null);setEditing(false);
    if(!open||!selected||!result)return;
    const api=ipc()?.oneMemory.inspector;if(!api)return;
    void api.detail({memoryId:selected,ownerRef:result.ownerRef}).then(value=>{if(current===detailGeneration.current)setDetail(value);})
      .catch(cause=>{if(current===detailGeneration.current)setError(errorText(cause));});
    return ()=>{++detailGeneration.current;};
  },[open,selected,result]);
  useEffect(()=>{
    const current=detailGeneration.current;setAppSharing(null);setAppChoice("");
    const api=ipc()?.oneMemory.inspector;
    if(!detail||!api?.appSharing||!api.setAppSharing||detail.status!=="active"||!detail.actorId||!["agent_repo","project"].includes(detail.scope))return;
    void api.appSharing({memoryId:detail.memoryId,ownerRef:detail.ownerRef,actorId:detail.actorId,expectedRevision:detail.expectedRevision,expectedEpoch:detail.expectedEpoch})
      .then(value=>{if(current===detailGeneration.current)setAppSharing(value);}).catch(()=>{if(current===detailGeneration.current)setAppSharing(null);});
  },[detail]);
  const shareWithApp=async(revoke=false)=>{
    if(!detail||!appSharing||(!revoke&&appChoice===""))return;const api=ipc()?.oneMemory.inspector;if(!api?.setAppSharing)return;
    const receiver=revoke?null:appSharing.choices[Number(appChoice)];if(!revoke&&!receiver)return;
    const current=generation.current;setBusy(true);setError(null);setNotice(null);
    try{await api.setAppSharing({memoryId:detail.memoryId,ownerRef:detail.ownerRef,actorId:detail.actorId,expectedRevision:detail.expectedRevision,expectedEpoch:detail.expectedEpoch,receiver});
      if(current===generation.current){setNotice(revoke?(locale==="ko"?"이 기억의 App 공유를 회수했어요.":"Removed App sharing for this memory."):(locale==="ko"?"선택한 App 멤버에게 이 기억만 공유했어요.":"Shared this memory with the selected App member."));setRetry(value=>value+1);}
    }catch(cause){if(current===generation.current)setError(errorText(cause));}finally{setBusy(false);}
  };
  const describe=useCallback((id:string)=>{const row=result?.entries.find(value=>value.memoryId===id);return row?{label:`${row.actorName} · ${kindLabel(row.kind,locale)}`,text:row.content}:null;},[result,locale]);
  const mutate=async(action:"edit"|"forget")=>{
    if(!detail)return;const api=ipc()?.oneMemory.inspector;if(!api)return;
    const current=generation.current;setBusy(true);setError(null);setNotice(null);
    try {
      const target={memoryId:detail.memoryId,ownerRef:detail.ownerRef,actorId:detail.actorId,expectedRevision:detail.expectedRevision,expectedEpoch:detail.expectedEpoch};
      const receipt=action==="edit"?await api.edit({...target,content:text}):await api.forget(target);
      if(current!==generation.current)return;
      setNotice(action==="edit"?(locale==="ko"?"수정했어요. 이전 내용은 이력으로 남습니다.":"Updated. The previous content remains in history.")
        :(locale==="ko"?`${receipt.affectedMemoryIds.length}개 기억을 잊었어요.`:`Forgot ${receipt.affectedMemoryIds.length} memories.`));
      setRetry(value=>value+1);
    }catch(cause){if(current===generation.current)setError(errorText(cause));}
    finally{setBusy(false);}
  };
  const recallLabel=(value:string)=>({user_identity:locale==="ko"?"개인 공통":"Personal",team_memory:locale==="ko"?"팀":"Team",agent_repo:locale==="ko"?"이 Agent":"This agent",agent_team:locale==="ko"?"Agent 팀":"Agent team",project:locale==="ko"?"프로젝트":"Project",session:locale==="ko"?"이 대화":"This conversation"}[value]??value);
  const statusLabel=(value:string)=>({active:locale==="ko"?"유효":"Active",disabled:locale==="ko"?"사용 안 함":"Disabled",superseded:locale==="ko"?"이전 내용":"Superseded",forgotten:locale==="ko"?"잊은 기록":"Forgotten",all:locale==="ko"?"모든 상태":"All statuses"}[value]??value);
  return <section className={styles.section} aria-labelledby="durable-memory-title" data-one-durable-memory="true">
    <h3 id="durable-memory-title" className={styles.memoryCount}>{locale==="ko"?"기억":"Memories"} <span>{result?.total??"…"}</span></h3>
    <div className={`${styles.editForm} ${styles.memoryFilters}`}>
      <label><span>{locale==="ko"?"One / Agent":"One / Agent"}</span><select aria-label="Memory actor" value={actor} disabled={busy} onChange={event=>setActor(event.target.value)}>
        <option value={BUILTIN_ONE_AGENT_ID}>One</option><option value="*">{locale==="ko"?"모든 Agent":"All agents"}</option>
        {result?.actors.filter(value=>value.id&&value.id!==BUILTIN_ONE_AGENT_ID).map(value=><option key={value.id} value={value.id!}>{value.name}</option>)}</select></label>
      <label><span>{locale==="ko"?"프로젝트":"Project"}</span><select aria-label="Memory project" value={project} disabled={busy} onChange={event=>setProject(event.target.value)}><option value="">{locale==="ko"?"모든 프로젝트":"All projects"}</option>{result?.projects.map(value=><option key={value.id} value={value.id}>{value.name}</option>)}</select></label>
      <label><span>{locale==="ko"?"적용 범위":"Scope"}</span><select aria-label="Memory scope" value={scope} disabled={busy} onChange={event=>setScope(event.target.value)}><option value="">{locale==="ko"?"모든 범위":"All scopes"}</option>{["user_identity","team_memory","agent_repo","agent_team","project","session"].map(value=><option key={value} value={value}>{recallLabel(value)}</option>)}</select></label>
      <label><span>{locale==="ko"?"상태":"Status"}</span><select aria-label="Memory status" value={status} disabled={busy} onChange={event=>setStatus(event.target.value as DesktopMemoryStatus|"all")}>{["active","disabled","superseded","forgotten","all"].map(value=><option key={value} value={value}>{statusLabel(value)}</option>)}</select></label>
    </div>
    <p className={styles.memoryHint}>{locale==="ko"?"Agent별 회상 범위를 유지하며 소유자가 기억을 관리할 수 있습니다.":"Manage your memories while preserving each agent's recall scope."}</p>
    {error&&<p className={styles.error} role="alert">{error} <button type="button" className={styles.secondaryButton} disabled={busy} onClick={()=>setRetry(value=>value+1)}>{locale==="ko"?"다시 불러오기":"Reload"}</button></p>}
    {notice&&<p className={styles.message} role="status">{notice}</p>}
    {!result&&!error&&<p className={styles.empty} role="status">{locale==="ko"?"기억을 불러오는 중입니다.":"Loading memories."}</p>}
    {result?.truncated&&<p className={styles.memoryHint}>{locale==="ko"?`최근 ${result.entries.length}개를 표시합니다. 필터로 범위를 좁혀 주세요.`:`Showing the latest ${result.entries.length}. Narrow the filters to see a smaller range.`}</p>}
    {result&&result.map.nodes.length>0&&<div className={styles.memoryMap}><OneMemoryMap snapshot={result.map} locale={locale} height={232} colorByKind selectedId={selected} onSelect={setSelected} describe={describe} unassignedProjectLabel={locale==="ko"?"프로젝트 없음":"No project"}/></div>}
    <div className={styles.memoryList}>{result?.entries.map(row=><button key={row.memoryId} type="button" className={styles.memoryEntryButton} data-selected={selected===row.memoryId?"true":undefined} onClick={()=>setSelected(value=>value===row.memoryId?null:row.memoryId)}>
      <KindIcon kind={row.kind}/><span>{row.title||statusLabel(row.status)}</span><small>{row.actorName} · {statusLabel(row.status)}</small></button>)}</div>
    {result&&result.entries.length===0&&<p className={styles.empty}>{locale==="ko"?"선택한 범위에 기억이 없습니다.":"No memories in this selection."}</p>}
    {detail&&<section className={styles.memoryInspectorDetail} aria-label={locale==="ko"?"기억 상세":"Memory details"}>
      <h4>{detail.actorName} · {kindLabel(detail.kind,locale)}</h4><p className={styles.memoryBody}>{detail.content}</p>
      <dl><dt>{locale==="ko"?"학습 Agent":"Source actor"}</dt><dd>{detail.actorName} · {detail.actorId??(locale==="ko"?"알 수 없음":"Unknown")}</dd><dt>{locale==="ko"?"출처":"Origins"}</dt><dd>{detail.originRefs.length?detail.originRefs.map(ref=><span key={`${ref.kind}:${ref.id}:${ref.revision}`}>{ref.kind} · {ref.id}{ref.revision?` (${shortRef(ref.revision)})`:""}</span>):locale==="ko"?"출처 기록 없음":"No recorded origin"}</dd>
        <dt>{locale==="ko"?"프로젝트 관계":"Project relations"}</dt><dd>{detail.projects.length?detail.projects.map(ref=><span key={`${ref.id}:${ref.relation}`}>{ref.relation==="origin"?(locale==="ko"?"출처":"Origin"):(locale==="ko"?"적용":"Applies to")} · {result?.projects.find(value=>value.id===ref.id)?.name??ref.id}</span>):"—"}</dd>
        <dt>{locale==="ko"?"회상 범위":"Recall scope"}</dt><dd>{recallLabel(detail.applicability.scope)}{detail.applicability.compatibilityScope?` · ${detail.applicability.compatibilityScope.scope}`:""}{detail.applicability.actorId?` · ${detail.applicability.actorId}`:""}</dd>
        <dt>{locale==="ko"?"열람 범위":"Audience"}</dt><dd>{detail.audience.declaration==="unknown"?(locale==="ko"?"알 수 없음(이전 형식)":"Unknown / legacy"):`${recallLabel(detail.audience.scope)} · ${detail.audience.sensitivity}`}</dd>
        <dt>{locale==="ko"?"현재 유효성":"Validity"}</dt><dd>{statusLabel(detail.status)} · {formatDate(detail.createdAt,locale)}{detail.supersededAt?` → ${formatDate(detail.supersededAt,locale)}`:""}</dd>
        <dt>{locale==="ko"?"개정":"Revision"}</dt><dd>{detail.bindingRevision??"—"} · {shortRef(detail.expectedRevision)} · {detail.curationActor}</dd></dl>
      {appSharing&&<div className={styles.editForm} aria-label={locale==="ko"?"이 기억의 App 공유":"App sharing for this memory"}>
        {appSharing.current&&<p className={styles.memoryHint}>{locale==="ko"?"현재 공유 대상: ":"Currently shared with: "}{appSharing.choices.find(value=>value.appId===appSharing.current?.appId&&value.actorId===appSharing.current.actorId)?.label??`${appSharing.current.appId} · ${appSharing.current.actorId}`}</p>}
        {appSharing.choices.length>0&&<><label className={styles.wideField}><span>{locale==="ko"?"이 기억을 공유할 App · 멤버":"App · member for this memory"}</span><select aria-label="Memory App receiver" value={appChoice} disabled={busy} onChange={event=>setAppChoice(event.target.value)}><option value="">{locale==="ko"?"공유 대상 선택":"Choose receiver"}</option>{appSharing.choices.map((value,index)=><option key={`${value.appId}:${value.actorId}`} value={index}>{value.label}</option>)}</select></label>
          <button type="button" className={styles.secondaryButton} disabled={busy||appChoice===""} onClick={()=>void shareWithApp()}>{locale==="ko"?"이 App에 공유":"Share with this App"}</button></>}
        {appSharing.canRevoke&&<button type="button" className={styles.secondaryButton} disabled={busy} onClick={()=>void shareWithApp(true)}>{locale==="ko"?"App 공유 회수":"Remove App sharing"}</button>}
        {(appSharing.choices.length>0||appSharing.current)&&<p className={styles.memoryHint}>{locale==="ko"?"선택한 App 멤버에게 이 기억만 적용됩니다. 프로젝트 출처와 기존 Agent 회상 범위는 유지됩니다.":"Only this memory is shared with the selected App member. Its project origins and existing agent scope stay unchanged."}</p>}
      </div>}
      {editing?<form className={styles.editForm} onSubmit={event=>{event.preventDefault();void mutate("edit");}}><label className={styles.wideField}><span>{locale==="ko"?"기억 수정":"Edit memory"}</span><textarea value={text} rows={4} maxLength={4000} required disabled={busy} onChange={event=>setText(event.target.value)}/></label><div className={styles.cardActions}><button type="submit" className={styles.primaryButton} disabled={busy||!text.trim()}>{locale==="ko"?"수정 적용":"Apply correction"}</button><button type="button" className={styles.secondaryButton} disabled={busy} onClick={()=>setEditing(false)}>{locale==="ko"?"취소":"Cancel"}</button></div></form>
        :<div className={styles.cardActions}>{detail.editable&&<button type="button" className={styles.secondaryButton} disabled={busy} onClick={()=>{setText(detail.content);setEditing(true);}}>{locale==="ko"?"수정":"Edit"}</button>}{detail.status==="active"&&detail.actorId&&<button type="button" className={styles.dangerButton} disabled={busy} onClick={()=>void mutate("forget")}>{locale==="ko"?"잊기":"Forget"}</button>}</div>}
      <p className={styles.memoryHint}>{locale==="ko"?"잊기는 같은 저장 범위의 동일한 기억과 그 보기를 함께 처리합니다.":"Forgetting also removes identical memories in the same storage scope and their views."}</p>
    </section>}
  </section>;
}

export function OneMemorySheet({ open, state, locale, onClose, valueClosure, experienceReuse,
  improvementProof, valueClosureState, onValueClosureStateChange, onManageImprovementAsset }: OneMemorySheetProps) {
  return <OneBottomSheet open={open} onClose={onClose} closeLabel={tFor(locale, "one.mem.aria.close_memory")} ariaLabelledBy="one-memory-title" size="wide" title={tFor(locale, "one.mem.header.title")}
    icon={<IconBrain size={20} />} titleId="one-memory-title">
    {ipc()?.oneMemory.inspector ? <DesktopMemoryInspector open={open} locale={locale} revisionHint={state} />
      : <LegacyOneMemoryView open={open} locale={locale} />}
    {valueClosure && <section className={styles.section}>
      {valueClosureState && onValueClosureStateChange && <OneValueClosureCard record={valueClosure} state={valueClosureState}
        locale={locale} onStateChange={onValueClosureStateChange} />}
      {experienceReuse && <OneExperienceReuseCard record={experienceReuse} locale={locale} onManage={onClose} />}
      {improvementProof && onManageImprovementAsset && <OneImprovementProofCard record={improvementProof} locale={locale}
        onManageAsset={onManageImprovementAsset} />}
    </section>}
  </OneBottomSheet>;
}
