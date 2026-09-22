"use client";

import Link from "next/link";
import { BrowserAutofill } from "./BrowserAutofill";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconArrowLeft, IconChevronRight, IconClose, IconFileUp, IconMoreHorizontal, IconRefresh } from "@/components/Icon";
import type { BrowserDevicePreset, BrowserDownloadSummary, BrowserDurableHistoryEntry, BrowserUiAPI, BrowserUiTarget } from "@shared/browser-ui";
import menu from "@/components/PanelPopover.module.css";
import styles from "./TaskBrowser.module.css";

type Panel = "menu" | "find" | "downloads" | "history" | "clear" | "autofill-menu" | "autofill" | "notice" | null;
function size(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

export function BrowserControls({ target, ko, onImport, onNavigate, onPrepareOverlay, onOverlayClosed }: {
  target: BrowserUiTarget | null; ko: boolean; onImport: () => void; onNavigate: (url: string) => void;
  onPrepareOverlay: () => Promise<void>; onOverlayClosed: () => void;
}) {
  const [panel, setPanel] = useState<Panel>(null);
  const [autofillMode, setAutofillMode] = useState<"passwords" | "contacts">("passwords");
  const [notice, setNotice] = useState<string | null>(null);
  const [devicePreset, setDevicePreset] = useState<BrowserDevicePreset | null>(null);
  const [zoom, setZoom] = useState<number | null>(null);
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<{ current: number; total: number } | null>(null);
  const [downloads, setDownloads] = useState<BrowserDownloadSummary[]>([]);
  const [history, setHistory] = useState<BrowserDurableHistoryEntry[]>([]);
  const [listState, setListState] = useState<"loading" | "ready" | "error">("loading");
  const [clear, setClear] = useState<Array<"history" | "downloads" | "cache" | "cookies">>(["history", "cache"]);
  const root = useRef<HTMLSpanElement>(null);
  const lastButton = useRef<HTMLElement | null>(null);
  const epoch = useRef(0);
  const findEpoch = useRef(0);
  const targetRef = useRef(target); targetRef.current = target;
  const panelRef = useRef(panel); panelRef.current = panel;
  const close = useCallback(() => {
    epoch.current++; findEpoch.current++;
    if (panelRef.current === "find" && targetRef.current) void window.agentlas?.browserUi.stopFind(targetRef.current).catch(() => {});
    setPanel(null); setNotice(null); onOverlayClosed(); lastButton.current?.focus();
  }, [onOverlayClosed]);
  const open = async (next: Panel, button?: HTMLElement) => {
    if (!next) { close(); return; }
    const currentEpoch = ++epoch.current;
    if (button) lastButton.current = button;
    setNotice(null);
    await onPrepareOverlay();
    if (epoch.current === currentEpoch) setPanel(next);
  };
  useEffect(() => {
    close(); setZoom(null); setDevicePreset(null); setMatches(null);
    return () => { epoch.current++; findEpoch.current++; };
  }, [target?.viewId, target?.taskScopeId, close]);
  useEffect(() => {
    if (!panel || panel === "autofill") return;
    root.current?.querySelector<HTMLElement>(panel === "find" ? "[data-browser-find] input" : '[role="menu"] button,[role="dialog"] button,[role="alertdialog"] button')?.focus();
    let waitingForRelease = false;
    const outside = (event: PointerEvent) => {
      if (root.current?.contains(event.target as Node)) return;
      event.preventDefault(); event.stopPropagation(); waitingForRelease = true;
    };
    const release = () => { if (waitingForRelease) { waitingForRelease = false; close(); } };
    const key = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); close(); } };
    document.addEventListener("pointerdown", outside, true); document.addEventListener("pointerup", release, true); document.addEventListener("pointercancel", release, true); document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("pointerup", release, true); document.removeEventListener("pointercancel", release, true); document.removeEventListener("keydown", key); };
  }, [panel, close]);
  useEffect(() => {
    if (panel !== "menu" || !target) return;
    let disposed = false;
    void window.agentlas?.browserUi.zoom({ ...target, action: "get" }).then(result => {
      if (!disposed && result.ok) setZoom(result.percent ?? null);
    }).catch(() => {});
    void window.agentlas?.browserUi.deviceEmulation({ ...target, preset: "get" }).then(result => {
      if (!disposed && result.ok) setDevicePreset(result.preset);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [panel, target?.viewId, target?.taskScopeId]);
  const run = async (call: (api: BrowserUiAPI, target: BrowserUiTarget) => Promise<{ ok: boolean; reason?: string }>, keepOpen = false) => {
    const current = targetRef.current; const api = window.agentlas?.browserUi;
    if (!current || !api) return;
    if (!keepOpen) close();
    const currentEpoch = epoch.current;
    const isCurrent = () => epoch.current === currentEpoch && targetRef.current?.viewId === current.viewId
      && targetRef.current?.taskScopeId === current.taskScopeId;
    const showNotice = async (message: string) => {
      if (!isCurrent()) return;
      // Native actions close the menu before running. Freeze the guest again
      // so a later failure uses the same accessible overlay as other panels.
      try { await onPrepareOverlay(); } catch { /* The notice still allows dismissal. */ }
      if (!isCurrent()) return;
      setNotice(message); setPanel("notice");
    };
    try {
      const result = await call(api, current);
      if (!result.ok && result.reason !== "dialog-cancelled") await showNotice(ko ? "이 작업을 완료하지 못했습니다. 다시 시도하세요." : "This action did not finish. Try again.");
    } catch { await showNotice(ko ? "브라우저 연결을 확인해 주세요." : "Check the browser connection."); }
  };
  const refreshDownloads = useCallback(async () => {
    const current = targetRef.current;
    if (!current) { setListState("error"); return; }
    try {
      const result = await window.agentlas?.browserUi.downloads({ taskScopeId: current.taskScopeId, limit: 50 });
      if (targetRef.current?.taskScopeId !== current.taskScopeId || panelRef.current !== "downloads") return;
      if (result?.ok) { setDownloads(result.items); setListState("ready"); } else setListState("error");
    } catch { if (targetRef.current?.taskScopeId === current.taskScopeId && panelRef.current === "downloads") setListState("error"); }
  }, []);
  useEffect(() => {
    if (panel !== "downloads") return;
    setListState("loading"); setDownloads([]);
    void refreshDownloads(); const timer = window.setInterval(() => void refreshDownloads(), 1000);
    return () => window.clearInterval(timer);
  }, [panel, target?.taskScopeId, refreshDownloads]);
  useEffect(() => {
    if (panel !== "history" || !target) return;
    let active = true; setListState("loading"); setHistory([]);
    void window.agentlas?.browserUi.historyAll({ taskScopeId: target.taskScopeId, limit: 50 }).then(result => {
      if (!active) return;
      if (result.ok) { setHistory(result.entries); setListState("ready"); } else setListState("error");
    }).catch(() => { if (active) setListState("error"); });
    return () => { active = false; };
  }, [panel, target?.viewId, target?.taskScopeId]);
  const find = useCallback(async (forward = true, findNext = false) => {
    const current = targetRef.current; if (!current) return;
    const currentEpoch = ++findEpoch.current;
    const result = await window.agentlas?.browserUi.find({ ...current, query, forward, findNext });
    if (currentEpoch === findEpoch.current && result?.ok) setMatches({ current: result.activeMatch ?? 0, total: result.matches ?? 0 });
  }, [query]);
  useEffect(() => { if (panel !== "find") return; const timer = window.setTimeout(() => void find().catch(() => {}), 180); return () => { window.clearTimeout(timer); findEpoch.current++; }; }, [panel, find]);
  const toggleDevice = () => void run(async (api, target) => {
    const preset: BrowserDevicePreset = devicePreset && devicePreset !== "off" ? "off" : "phone";
    const result = await api.deviceEmulation({ ...target, preset });
    if (result.ok) setDevicePreset(result.preset);
    return result;
  });
  const zoomBy = (action: "in" | "out" | "reset") => void run(async (api, target) => { const result = await api.zoom({ ...target, action }); if (result.ok) setZoom(result.percent ?? null); return result; }, true);

  return <span ref={root} className={styles.controls}>
    <button type="button" title={ko ? "다운로드" : "Downloads"} aria-label={ko ? "다운로드" : "Downloads"} onClick={event => void open(panel === "downloads" ? null : "downloads", event.currentTarget)}><IconFileUp size={16} style={{ transform: "rotate(180deg)" }} /></button>
    <button className={styles.menuTrigger} type="button" title={ko ? "브라우저 메뉴" : "Browser menu"} aria-label={ko ? "브라우저 메뉴" : "Browser menu"} aria-haspopup="menu" aria-expanded={panel === "menu"} onClick={event => panel === "menu" ? close() : void open("menu", event.currentTarget)}><IconMoreHorizontal size={17} /></button>
    {panel === "menu" && <div className={`${menu.panelPopover} ${styles.controlPopover} ${styles.browserMenu}`} role="menu" aria-label={ko ? "브라우저 메뉴" : "Browser menu"}>
      <button className={menu.panelMenuRow} role="menuitem" type="button" disabled={!target} onClick={() => setPanel("find")}>{ko ? "페이지에서 찾기" : "Find in page"}</button>
      <button className={menu.panelMenuRow} role="menuitem" type="button" disabled={!target} onClick={() => void run((api, target) => api.print(target))}>{ko ? "인쇄" : "Print"}</button>
      <hr className={menu.panelMenuSeparator} />
      <div className={menu.panelMenuRow}><span>{ko ? "확대/축소" : "Zoom"}</span><div className={styles.zoomControls}><button type="button" aria-label={ko ? "축소" : "Zoom out"} disabled={!target} onClick={() => zoomBy("out")}>−</button><span>{zoom === null ? "—" : `${zoom}%`}</span><button type="button" aria-label={ko ? "확대" : "Zoom in"} disabled={!target} onClick={() => zoomBy("in")}>+</button><button type="button" aria-label={ko ? "확대 배율 초기화" : "Reset zoom"} disabled={!target} onClick={() => zoomBy("reset")}><IconRefresh size={12} /></button></div></div>
      <hr className={menu.panelMenuSeparator} />
      <button className={menu.panelMenuRow} role="menuitem" type="button" disabled={!target} onClick={toggleDevice}>{devicePreset && devicePreset !== "off" ? (ko ? "기기 도구 모음 숨기기" : "Hide device toolbar") : (ko ? "기기 도구 모음 표시" : "Show device toolbar")}</button>
      <button className={menu.panelMenuRow} role="menuitem" type="button" disabled={!target} onClick={() => void run((api, target) => api.saveScreenshot(target))}>{ko ? "스크린샷 찍기" : "Take screenshot"}</button>
      <hr className={menu.panelMenuSeparator} />
      <button className={menu.panelMenuRow} role="menuitem" type="button" onClick={() => { close(); onImport(); }}>{ko ? "쿠키 및 비밀번호 가져오기…" : "Import cookies and passwords…"}</button>
      <button className={menu.panelMenuRow} role="menuitem" type="button" onClick={() => setPanel("autofill-menu")}>{ko ? "비밀번호 및 자동 완성" : "Passwords and autofill"}<IconChevronRight size={13}/></button>
      <button className={menu.panelMenuRow} role="menuitem" type="button" onClick={() => setPanel("downloads")}>{ko ? "다운로드" : "Downloads"}</button>
      <button className={menu.panelMenuRow} role="menuitem" type="button" disabled={!target} onClick={() => setPanel("history")}>{ko ? "방문 기록" : "History"}</button>
      <button className={menu.panelMenuRow} role="menuitem" type="button" disabled={!target} onClick={() => setPanel("clear")}>{ko ? "인터넷 사용 기록 삭제" : "Clear browsing data"}</button>
      <hr className={menu.panelMenuSeparator} />
      <Link className={menu.panelMenuRow} role="menuitem" href="/browser" onClick={close}>{ko ? "브라우저 설정" : "Browser settings"}</Link>
    </div>}
    {panel === "autofill-menu" && <div className={`${menu.panelPopover} ${styles.controlPopover} ${styles.browserMenu}`} role="menu" aria-label={ko ? "비밀번호 및 자동 완성" : "Passwords and autofill"}>
      <button className={menu.panelMenuRow} role="menuitem" type="button" onClick={() => setPanel("menu")}><IconArrowLeft size={13}/>{ko ? "브라우저 메뉴" : "Browser menu"}</button>
      <hr className={menu.panelMenuSeparator}/>
      <button className={menu.panelMenuRow} role="menuitem" type="button" onClick={() => { setAutofillMode("passwords"); setPanel("autofill"); }}>{ko ? "비밀번호 관리자" : "Password manager"}</button>
      <button className={menu.panelMenuRow} role="menuitem" type="button" onClick={() => { setAutofillMode("contacts"); setPanel("autofill"); }}>{ko ? "연락처 및 자동 완성" : "Contacts and autofill"}</button>
    </div>}
    {panel === "find" && <div className={`${menu.panelPopover} ${styles.controlPopover} ${styles.findPopover}`} role="dialog" aria-label={ko ? "페이지에서 찾기" : "Find in page"} data-browser-find><input value={query} onChange={event => setQuery(event.target.value)} aria-label={ko ? "찾을 텍스트" : "Find text"} placeholder={ko ? "페이지에서 찾기" : "Find in page"} onKeyDown={event => { if (event.key === "Enter") { event.preventDefault(); void find(!event.shiftKey, true); } }} /><span className={menu.panelMenuMeta}>{matches ? `${matches.current}/${matches.total}` : ""}</span><button type="button" aria-label={ko ? "이전 결과" : "Previous match"} onClick={() => void find(false, true)}><IconArrowLeft size={13}/></button><button type="button" aria-label={ko ? "다음 결과" : "Next match"} onClick={() => void find(true, true)}><IconChevronRight size={13}/></button><button type="button" aria-label={ko ? "찾기 닫기" : "Close find"} onClick={() => { if (target) void window.agentlas?.browserUi.stopFind(target); close(); }}><IconClose size={13}/></button></div>}
    {(panel === "downloads" || panel === "history") && <div className={`${menu.panelPopover} ${styles.controlPopover} ${styles.listPopover}`} role="dialog" aria-label={ko ? (panel === "downloads" ? "다운로드" : "방문 기록") : panel}>
      <div className={menu.panelMenuRow}><span>{ko ? (panel === "downloads" ? "다운로드" : "방문 기록") : panel === "downloads" ? "Downloads" : "History"}</span><button type="button" aria-label={ko ? "목록 닫기" : "Close list"} onClick={close}><IconClose size={13}/></button></div>
      {panel === "history" ? history.map(entry => <button key={entry.id} className={menu.panelMenuRow} type="button" title={entry.url} onClick={() => { close(); onNavigate(entry.url); }}><span className={styles.listTitle}>{entry.title || entry.url}</span><span className={menu.panelMenuMeta}>{new Date(entry.lastVisitedAt).toLocaleDateString(ko ? "ko-KR" : "en-US", { month: "short", day: "numeric" })}</span></button>) : downloads.map(item => <div key={item.id} className={styles.downloadRow}><div><span className={styles.listTitle}>{item.fileName}</span><span className={menu.panelMenuMeta} data-browser-download-state={item.state}>{ko ? ({ progressing: "다운로드 중", completed: "다운로드 완료", interrupted: "다운로드 실패", cancelled: "취소됨" }[item.state]) : item.state} · {size(item.receivedBytes)}</span></div><details><summary aria-label={ko ? "다운로드 작업" : "Download actions"}><IconMoreHorizontal size={15}/></summary><div className={menu.panelPopover} role="menu">{(item.state === "progressing" ? ["cancel"] as const : item.state === "completed" ? ["open", "show-in-folder", "remove"] as const : ["remove"] as const).map(action => <button key={action} className={menu.panelMenuRow} type="button" role="menuitem" onClick={() => { if (!target) return; void window.agentlas.browserUi.downloadAction({ taskScopeId: target.taskScopeId, id: item.id, action }).then(() => refreshDownloads()); }}>{ko ? ({ cancel: "취소", open: "열기", "show-in-folder": "폴더에서 보기", remove: "목록에서 삭제" }[action]) : action}</button>)}</div></details></div>)}
      {listState === "ready" && (panel === "downloads" ? downloads.length : history.length) === 0 && <p className={`${menu.panelMenuLabel} ${menu.panelMenuMeta}`}>{ko ? "아직 기록이 없습니다." : "No entries yet."}</p>}
      {listState !== "ready" && <p className={`${menu.panelMenuLabel} ${menu.panelMenuMeta}`} role="status">{listState === "loading" ? ko ? "불러오는 중…" : "Loading…" : ko ? "목록을 불러오지 못했습니다. 다시 열어 주세요." : "Could not load this list. Open it again to retry."}</p>}
    </div>}
    {panel === "clear" && <div className={`${menu.panelPopover} ${styles.controlPopover}`} role="dialog" aria-label={ko ? "인터넷 사용 기록 삭제" : "Clear browsing data"}>
      <p className={menu.panelMenuLabel}>{ko ? "삭제할 항목" : "Choose data to clear"}</p>
      {(["history", "downloads", "cache", "cookies"] as const).map(category => <label key={category} className={menu.panelMenuRow}><span>{ko ? ({ history: "이 작업의 방문 기록", downloads: "이 작업의 다운로드 목록", cache: "브라우저 캐시", cookies: "쿠키 및 로그인 정보" }[category]) : category}</span><input type="checkbox" checked={clear.includes(category)} onChange={event => setClear(rows => event.target.checked ? [...rows, category] : rows.filter(row => row !== category))}/></label>)}
      <hr className={menu.panelMenuSeparator}/><div className={menu.panelMenuRow}><button type="button" onClick={close}>{ko ? "취소" : "Cancel"}</button><button type="button" disabled={!target || !clear.length} onClick={() => void run((api, target) => api.clearData({ ...target, categories: clear }))}>{ko ? "선택한 기록 삭제" : "Clear selected data"}</button></div>
    </div>}
    <BrowserAutofill open={panel === "autofill"} mode={autofillMode} target={target} ko={ko} onClose={close} onPrepareOverlay={onPrepareOverlay} onOverlayClosed={onOverlayClosed} />
    {panel === "notice" && notice && <div className={`${menu.panelPopover} ${styles.controlPopover}`} role="alertdialog" aria-label={ko ? "브라우저 작업 알림" : "Browser action notice"}><span className={menu.panelMenuLabel}>{notice}</span><button className={menu.panelMenuRow} type="button" onClick={close}>{ko ? "닫기" : "Close"}</button></div>}
  </span>;
}
