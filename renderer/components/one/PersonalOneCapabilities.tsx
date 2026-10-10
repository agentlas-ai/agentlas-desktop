"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import type { Automation, InstalledMcpServer, McpToolCatalogEntry } from "@/lib/types";
import type { OneToolReadiness } from "@shared/one-harness";
import { DescribeAutomation } from "@/components/automation/DescribeAutomation";
import { humanSchedule } from "@shared/graph-blueprint";
import { runMcpOAuthAttempt, mcpOAuthAPI } from "@/components/plugins/McpOAuthAttempt";
import { OneBottomSheet } from "./OneBottomSheet";
import { IconRefresh, IconRoute } from "@/components/Icon";
import styles from "./PersonalOneCapabilities.module.css";

export type PersonalOneCapabilityTab = "connections" | "repeat";
export function PersonalOneCapabilities({ open, locale, chatId, oneId, onClose, onPrompt }: {
  open: PersonalOneCapabilityTab | null; locale: "ko" | "en"; chatId?: string; oneId?: string;
  onClose(): void; onPrompt(prompt: string): void;
}) {
  const ko = locale === "ko";
  const copy = (a: string, b: string) => ko ? a : b;
  const [installed, setInstalled] = useState<InstalledMcpServer[]>([]);
  const [catalog, setCatalog] = useState<McpToolCatalogEntry[]>([]);
  const [readiness, setReadiness] = useState<OneToolReadiness[]>([]);
  const [automations, setAutomations] = useState<Automation[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [install, setInstall] = useState<string | null>(null);
  const [configure, setConfigure] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [createRepeat, setCreateRepeat] = useState(false);
  const [manualUrl,setManualUrl]=useState<string|null>(null);
  const [oauthMessage, setOauthMessage] = useState<string | null>(null);
  const abort = useRef<AbortController | null>(null);
  const revision = useRef(0);
  const load = useCallback(async () => {
    const current = ++revision.current;
    const api = ipc();
    if (!api || !open) return;
    const reads = open === "connections"
      ? await Promise.allSettled([api.mcpTools.listInstalled(), api.mcpTools.listCatalog(), oneId && api.oneHarness ? api.oneHarness.readiness({oneId}) : Promise.reject(new Error("readiness_unavailable"))])
      : await Promise.allSettled([api.automations.list()]);
    if (current !== revision.current) return;
    setError(reads.some(item => item.status === "rejected") ? copy("일부 연결 상태를 확인하지 못했습니다. 다시 확인해 주세요.", "Some connection states could not be confirmed. Try refreshing.") : null);
    if (open === "connections") {
      if (reads[0].status === "fulfilled") setInstalled(reads[0].value as InstalledMcpServer[]);
      if (reads[1]?.status === "fulfilled") setCatalog(reads[1].value as McpToolCatalogEntry[]);
      if (reads[2]?.status === "fulfilled") setReadiness(reads[2].value as OneToolReadiness[]);
    } else if (reads[0].status === "fulfilled") setAutomations(reads[0].value as Automation[]);
  // Locale changes only presentation; each reload reads Main-owned state.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, locale, oneId]);
  useEffect(() => {
    if (!open) return;
    void load();
    const off = ipcEvents()?.onStoreChanged?.(() => { void load(); });
    return () => { ++revision.current; off?.(); abort.current?.abort(); };
  }, [open, load]);
  useEffect(() => { setConfigure(null); setInstall(null); setError(null); setOauthMessage(null);setManualUrl(null); }, [open]);
  const perform = async (id: string, action: () => Promise<unknown>) => {
    if (busy) return;
    setBusy(id); setError(null);
    try { await action(); await load(); }
    catch { setError(copy("실행 결과를 확인하지 못했습니다. 현재 상태를 새로 확인해 주세요.", "The outcome was not confirmed. Refresh the current state before retrying.")); }
    finally { setBusy(null); }
  };
  const connect = (server: InstalledMcpServer) => perform(server.id, async () => {
    const api = ipc();
    if (!api) throw new Error("desktop_unavailable");
    const auth = await api.mcpTools.oauthStatus(server.id);
    if (auth.supported && !auth.connected) {
      abort.current?.abort(); const controller = new AbortController(); abort.current = controller;
      await runMcpOAuthAttempt({ api: mcpOAuthAPI(api.mcpTools), serverId: server.id, signal: controller.signal,
        update: progress => {setOauthMessage(copy("로그인을 기다리고 있습니다. 취소하거나 창을 닫을 수 있습니다.", "Waiting for sign-in. You can cancel or close this sheet."));try{setManualUrl(progress.manualUrl&&new URL(progress.manualUrl).protocol==="https:"?progress.manualUrl:null);}catch{setManualUrl(null);}} });
    }
    const status = await api.mcpTools.test(server.id);
    setOauthMessage(null);setManualUrl(null);

    if (!status.connected) throw new Error("capability_not_ready");
  });
  const requestSecureSetup = (server:InstalledMcpServer) => {
    onPrompt(copy(`도구 '${server.name}' (ID: ${server.id})의 필요한 연결 키를 원래 One 요청에 묶어 전용 Vault 입력으로 준비해줘. 현재 계정·범위·Desktop host·권한·저장 위치·유료 동작을 먼저 확인해줘.`, `Prepare dedicated Vault entry for tool '${server.name}' (ID: ${server.id}) bound to this original One request. Check current account, scope, exact Desktop host, permissions, storage and paid actions first.`));
    setConfigure(null);onClose();
  };
  const repeatItems = automations.filter(item => !!chatId && (item.monitor?.originChatId === chatId));
  const visibleCatalog = catalog.filter(item => !installed.some(server => server.catalogId === item.id)
    && `${item.name} ${item.nameEn} ${item.description}`.toLowerCase().includes(query.toLowerCase())).slice(0, 30);
  return <OneBottomSheet open={!!open} onClose={onClose} closeLabel={copy("닫기", "Close")}
    ariaLabel={open === "repeat" ? copy("반복 업무", "Recurring work") : copy("연결 도구", "Connected tools")}
    title={open === "repeat" ? copy("반복 업무", "Recurring work") : copy("연결 도구", "Connected tools")}
    icon={<IconRoute size={20}/>} size="compact">
    <div className={styles.root}>
      <div className={styles.top}><p>{open === "repeat" ? copy("이 대화에 연결된 업무의 조건과 다음 실행을 확인합니다.", "Review conditions and the next run for work bound to this conversation.") : copy("현재 계정과 실제 준비 상태를 확인하고 필요한 도구만 연결합니다.", "Check connected accounts and live readiness, then connect only what you need.")}</p>
        <button type="button" onClick={() => void load()} aria-label={copy("상태 새로고침", "Refresh status")}><IconRefresh size={16}/></button></div>
      {error && <p role="status" className={styles.notice}>{error}</p>}
      {open === "connections" && <>
        {installed.length === 0 && <p>{copy("연결한 도구가 없습니다. 아래에서 필요한 도구를 찾아보세요.", "No tools are connected. Find a tool below.")}</p>}
        {installed.map(server => {
          const status = readiness.find(item => item.installedServerId === server.id);
          const label = ({ready:copy("사용 준비 확인됨","Readiness verified"),disabled:copy("꺼짐","Off"),"needs-auth":copy("로그인 필요","Sign-in required"),"needs-configuration":copy("설정 필요","Configuration required"),offline:copy("연결 안 됨","Offline"),unknown:copy("관측 미확인","Observation unconfirmed"),"not-installed":copy("설치 필요","Installation required")} as const)[status?.state ?? "unknown"];
          return <article className={styles.card} key={server.id} data-one-connection={server.id}>
            <header><strong>{ko ? server.name : server.nameEn || server.name}</strong><span>{label}</span></header>
            {status?.observedAt && <small>{copy("관측","Observed")}: {new Date(status.observedAt).toLocaleTimeString()}</small>}
            <div className={styles.actions}>
              <button type="button" disabled={!!busy} onClick={() => void perform(server.id, () => ipc()!.mcpTools.setEnabled(server.id, !server.enabled))}>{server.enabled ? copy("끄기", "Turn off") : copy("켜기", "Turn on")}</button>
              <button type="button" disabled={!!busy || !server.enabled} onClick={() => void connect(server)}>{copy("로그인·연결 확인", "Sign in / verify")}</button>
              {server.envKeys.length > 0 && <button type="button" onClick={() => {setConfigure(configure === server.id ? null : server.id);}}>{copy("키 설정", "Set keys")}</button>}
            </div>
            {configure === server.id && <div>
              <p>{copy("키는 현재 One 실행에 묶인 전용 Vault 창에서 직접 입력합니다. 현재 권한과 안전한 경로가 확인돼야 입력할 수 있습니다.","Enter keys directly in a dedicated Vault window bound to the current One run after current authority and the secure route are verified.")}</p>
              <button type="button" disabled={!!busy} onClick={()=>requestSecureSetup(server)}>{copy("보안 입력 요청 준비","Prepare secure entry request")}</button>
            </div>}
          </article>;
        })}
        {oauthMessage && <div role="status" className={styles.notice}>{oauthMessage}{manualUrl&&<p><a href={manualUrl} target="_blank" rel="noopener noreferrer">{copy("공식 로그인 페이지 열기","Open official sign-in page")}</a></p>}<button type="button" onClick={() => {abort.current?.abort(); setOauthMessage(null);setManualUrl(null);}}>{copy("로그인 취소", "Cancel sign-in")}</button></div>}
        <label className={styles.search}>{copy("도구 찾기", "Find a tool")}<input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder={copy("이름이나 하는 일", "Name or capability")}/></label>
        {visibleCatalog.map(item => <article className={styles.card} key={item.id}>
          <header><strong>{ko ? item.name : item.nameEn || item.name}</strong><span>{item.trust === "official" ? copy("공식", "Official") : copy("커뮤니티", "Community")}</span></header>
          <p>{ko ? item.description : item.descriptionEn || item.description}</p>
          {install !== item.id ? <button type="button" onClick={() => setInstall(item.id)}>{copy("연결 조건 보기", "Review setup")}</button>
            : <div className={styles.confirm}>
              <p>{item.transport === "stdio" ? copy("이 컴퓨터에서 아래 프로그램을 실행하는 도구입니다.", "This tool runs the following program on this computer.") : copy("아래 외부 서비스에 연결합니다.", "This tool connects to the following external service.")}</p>
              <code>{item.transport === "stdio" ? [item.command, ...(item.args ?? [])].join(" ") : item.url}</code>
              {item.envRequirements.length > 0 && <p>{copy("필요한 키", "Required keys")}: {item.envRequirements.map(key => key.key).join(", ")}</p>}
              <div className={styles.actions}><button type="button" disabled={!!busy} onClick={() => void perform(item.id, async () => {await ipc()!.mcpTools.install(item.id); setInstall(null);})}>{copy("이 도구 연결", "Connect this tool")}</button><button type="button" onClick={() => setInstall(null)}>{copy("취소", "Cancel")}</button></div>
            </div>}
        </article>)}
      </>}
      {open === "repeat" && <>
        <button type="button" onClick={() => setCreateRepeat(value => !value)}>{copy("새 반복 업무 준비", "Prepare recurring work")}</button>
        {createRepeat && <DescribeAutomation locale={locale} openAfterCreate={false} presentation="chat" persistenceKey={chatId ? `agentlas.one.companion.graph.${chatId}` : undefined} onCreated={() => void load()}/>}
        {repeatItems.length === 0 && <p>{copy("이 대화에 연결된 반복 업무가 없습니다.", "No recurring work is bound to this conversation.")}</p>}
        {repeatItems.map(item => <article className={styles.card} key={item.id} data-one-repeat={item.id}>
          <header><strong>{item.name}</strong><span>{item.enabled ? copy("예약 켜짐", "Scheduled") : copy("일시 중지", "Paused")}</span></header>
          <p>{humanSchedule(item.scheduleHuman, locale)}</p><small>{item.nextRunAt ? `${copy("다음", "Next")}: ${new Date(item.nextRunAt).toLocaleString()}` : copy("다음 실행 미확인", "Next run not confirmed")}</small>
          <div className={styles.actions}>
            <button type="button" disabled={!!busy} onClick={() => void perform(item.id, () => ipc()!.automations.toggle(item.id, !item.enabled))}>{item.enabled ? copy("중지", "Pause") : copy("다시 켜기", "Resume")}</button>
            <button type="button" disabled={!!busy} onClick={() => void perform(item.id, () => ipc()!.automations.runNow(item.id))}>{copy("지금 실행", "Run now")}</button>
            <button type="button" onClick={() => {onPrompt(copy(`반복 업무 '${item.name}' (ID: ${item.id})의 조건을 수정해줘. 현재 등록 범위와 권한을 먼저 확인하고 변경할 조건을 물어봐.`, `Update the conditions for recurring work '${item.name}' (ID: ${item.id}). Check its current scope and grants, then ask which conditions to change.`)); onClose();}}>{copy("조건 수정", "Change conditions")}</button>
          </div>
        </article>)}
      </>}
    </div>
  </OneBottomSheet>;
}
