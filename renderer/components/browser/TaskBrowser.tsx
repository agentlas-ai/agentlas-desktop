"use client";

import { createPortal } from "react-dom";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { IconArrowLeft, IconChevronRight, IconClose, IconMoreHorizontal, IconPlus, IconRefresh } from "@/components/Icon";
import { NativeLiveWebView } from "@/components/NativeLiveWebView";
import { browserLoginImportDiagnostic, browserLoginImportNotice } from "@/lib/browser-login-import-notice";
import type { WorkLiveViewStatus } from "@/lib/types";
import styles from "./TaskBrowser.module.css";

type BrowserTab = { id: string; initialUrl: string; status: WorkLiveViewStatus };
const tabHost = (url: string) => { try { return new URL(url).host; } catch { return "Agentlas Browser"; } };
function navigationUrl(input: string): string | null {
  const value = input.trim();
  try {
    const url = new URL(/^(localhost|127\.0\.0\.1|\[::1\])(?::|\/|$)/i.test(value) ? `http://${value}`
      : /^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`);
    return !url.username && !url.password && (url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ? url.href : null;
  } catch { return null; }
}

/** Main owns the tabs. One, Work and their tools attach to the same scoped guests. */
export function TaskBrowser({ taskScopeId, preferredUrl, locale, active = true, headerHost, onActivate, newTabRequest = 0, presentation }: {
  taskScopeId: string; preferredUrl?: string; locale: "ko" | "en"; active?: boolean;
  headerHost?: HTMLElement | null; onActivate?: () => void; newTabRequest?: number; presentation?: { viewId: string; id: string };
}) {
  const ko = locale === "ko";
  const [tabs, setTabs] = useState<BrowserTab[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [creating, setCreating] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const menuButton = useRef<HTMLButtonElement>(null);
  const createInFlight = useRef(false);
  const current = tabs.find((tab) => tab.id === selectedId) ?? tabs[0];
  const loginNotice = browserLoginImportNotice(current?.status.nativeSession, ko);
  const loginDiagnostic = browserLoginImportDiagnostic(current?.status.nativeSession, ko);
  const tabsRef = useRef(tabs);
  tabsRef.current = tabs;
  const mounted = useRef(false);
  const navigation = useRef(0);
  const currentId = useRef(current?.id);
  currentId.current = current?.id;
  const newTabRequestRef = useRef(newTabRequest);
  newTabRequestRef.current = newTabRequest;
  const observedUrl = useRef(preferredUrl);
  const knownTabs = useRef(new Set<string>());

  const consumedPresentation = useRef<string | null>(null);
  useEffect(() => {
    if (!presentation || consumedPresentation.current === presentation.id
      || !tabs.some((tab) => tab.id === presentation.viewId)) return;
    consumedPresentation.current = presentation.id;
    setSelectedId(presentation.viewId);
  }, [presentation, tabs.length]);
  useEffect(() => { if (!active) setMenuOpen(false); }, [active]);
  useEffect(() => {
    if (!menuOpen) return;
    menuRef.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus();
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !menuButton.current?.contains(event.target)) setMenuOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setMenuOpen(false); menuButton.current?.focus(); }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [menuOpen]);

  const acceptStatus = useCallback((status: WorkLiveViewStatus) => {
    if (status.taskScopeId !== taskScopeId) return;
    if (status.state === "closed") knownTabs.current.delete(status.viewId);
    else if (!knownTabs.current.has(status.viewId)) {
      knownTabs.current.add(status.viewId);
      setSelectedId(status.viewId);
    }
    setTabs((prior) => {
      if (status.state === "closed") return prior.filter((tab) => tab.id !== status.viewId);
      const existing = prior.find((tab) => tab.id === status.viewId);
      return existing ? prior.map((tab) => tab.id === status.viewId ? { ...tab, status } : tab)
        : [...prior, { id: status.viewId, initialUrl: status.url || "about:blank", status }];
    });
  }, [taskScopeId]);

  useEffect(() => {
    const api = window.agentlas?.workLiveView;
    mounted.current = true;
    let disposed = false;
    const closed = new Set<string>();
    const off = api?.onStatus((status) => {
      if (disposed || status.taskScopeId !== taskScopeId) return;
      if (status.state === "closed") closed.add(status.viewId);
      else closed.delete(status.viewId);
      acceptStatus(status);
    });
    if (api?.listTabs) void api.listTabs({ taskScopeId }).then(async (result) => {
      if (disposed) return;
      if (!result.ok) { setNotice(result.reason || (ko ? "이 작업의 브라우저에 연결하지 못했습니다." : "Could not connect this task browser.")); return; }
      setConnected(true);
      for (const tab of result.tabs) if (tab.taskScopeId === taskScopeId && !closed.has(tab.viewId)) knownTabs.current.add(tab.viewId);
      setTabs((current) => {
        const merged = new Map(result.tabs.filter((tab) => tab.taskScopeId === taskScopeId && !closed.has(tab.viewId))
          .map((status) => [status.viewId, { id: status.viewId, initialUrl: status.url || "about:blank", status }]));
        for (const tab of current) if (!closed.has(tab.id)) merged.set(tab.id, { ...tab, status: { ...tab.status, taskScopeId, url: tab.status.url || tab.initialUrl } });
        return [...merged.values()];
      });
      if (!result.tabs.length && preferredUrl && newTabRequestRef.current === 0 && knownTabs.current.size === 0 && !createInFlight.current) {
        createInFlight.current = true;
        setCreating(true);
        try {
          const created = await api.createTab({ taskScopeId, url: preferredUrl });
          if (!disposed && created.tab) {
            acceptStatus(created.tab);
          }
          else if (!disposed && !created.ok) setNotice(created.reason ?? "Browser unavailable");
        } finally {
          createInFlight.current = false;
          if (!disposed) setCreating(false);
        }
      }
    }).catch(() => { if (!disposed) setNotice(ko ? "브라우저 연결을 확인해 주세요." : "Check the browser connection."); });
    return () => { disposed = true; mounted.current = false; navigation.current += 1; off?.(); };
  // Initial connection owns its captured URL; later proven navigation is handled below.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskScopeId, acceptStatus]);

  useEffect(() => {
    const url = current?.status.url ?? current?.initialUrl ?? "";
    setAddress(url === "about:blank" ? "" : url);
    setNotice(null);
  }, [current?.id, current?.status.url, current?.initialUrl]);

  const create = useCallback(async (url = "about:blank") => {
    if (!connected || createInFlight.current) return;
    createInFlight.current = true;
    setCreating(true);
    try {
      const result = await window.agentlas.workLiveView.createTab({ taskScopeId, url });
      if (!mounted.current) return;
      if (result.tab) {
        acceptStatus(result.tab);
        setSelectedId(result.tab.viewId);
      }
      else if (!result.ok) setNotice(result.reason ?? (ko ? "탭을 열지 못했습니다." : "Could not open a tab."));
    } catch { if (mounted.current) setNotice(ko ? "브라우저 연결을 확인해 주세요." : "Check the browser connection."); }
    finally { createInFlight.current = false; if (mounted.current) setCreating(false); }
  }, [acceptStatus, connected, ko, taskScopeId]);

  const navigate = useCallback(async (tabId: string | undefined, input: string) => {
    const url = navigationUrl(input);
    if (!url) { setNotice(ko ? "HTTPS 주소 또는 로컬 앱 주소를 입력해 주세요." : "Enter an HTTPS address or a local app URL."); return; }
    if (!tabId) { await create(url); return; }
    setNotice(null);
    const generation = ++navigation.current;
    try {
      const result = await window.agentlas.workLiveView.navigate({ viewId: tabId, taskScopeId, url });
      if (!mounted.current || generation !== navigation.current || currentId.current !== tabId) return;
      if (!result.ok && result.reason !== "navigation-superseded") setNotice(result.reason ?? (ko ? "페이지를 열지 못했습니다." : "Could not open this page."));
    } catch {
      if (mounted.current && generation === navigation.current && currentId.current === tabId) setNotice(ko ? "브라우저 연결을 확인해 주세요." : "Check the browser connection.");
    }
  }, [create, ko, taskScopeId]);

  useEffect(() => {
    if (!connected || !preferredUrl || observedUrl.current === preferredUrl) return;
    observedUrl.current = preferredUrl;
    const tab = tabsRef.current.find((item) => item.status.url === preferredUrl)
      ?? tabsRef.current.find((item) => !item.status.url && item.initialUrl === preferredUrl);
    if (tab) setSelectedId(tab.id);
    else if (knownTabs.current.size === 0) void create(preferredUrl);
  }, [preferredUrl, connected, navigate, create]);

  const close = async (id: string) => {
    navigation.current += 1;
    try {
      const result = await window.agentlas?.workLiveView.close(id, taskScopeId);
      if (!mounted.current) return;
      if (result?.ok) setTabs((prior) => prior.filter((tab) => tab.id !== id));
      else setNotice(ko ? "탭을 닫지 못했습니다." : "Could not close this tab.");
    } catch { if (mounted.current) setNotice(ko ? "브라우저 연결이 끊겼습니다." : "Browser connection lost."); }
  };
  const history = async (direction: "back" | "forward" | "reload") => {
    if (!current) return;
    const api = window.agentlas?.workLiveView;
    if (!api) return;
    const tabId = current.id;
    const generation = ++navigation.current;
    try {
      const result = await (direction === "back" ? api.goBack(tabId, taskScopeId)
        : direction === "forward" ? api.goForward(tabId, taskScopeId) : api.reload(tabId, taskScopeId));
      if (mounted.current && navigation.current === generation && currentId.current === tabId && !result.ok) setNotice(ko ? "이 탭에서 작업을 수행하지 못했습니다." : "The action is unavailable in this tab.");
    } catch {
      if (mounted.current && navigation.current === generation && currentId.current === tabId) setNotice(ko ? "브라우저 연결이 끊겼습니다." : "Browser connection lost.");
    }
  };

  const lastNewTabRequest = useRef(0);
  useEffect(() => {
    if (!connected || creating || lastNewTabRequest.current === newTabRequest) return;
    lastNewTabRequest.current = newTabRequest;
    void create();
  }, [newTabRequest, connected, creating, create]);
  const header = (
    <div className={styles.tabs} data-inline={Boolean(headerHost)} role={headerHost ? "presentation" : "tablist"} aria-label={headerHost ? undefined : ko ? "브라우저 탭" : "Browser tabs"}>
      {tabs.map((tab) => <div key={tab.id} className={styles.tab} data-selected={active && tab.id === current?.id}>
        <button role="tab" type="button" aria-selected={active && tab.id === current?.id} onClick={() => { setSelectedId(tab.id); onActivate?.(); }}>
          <span className={styles.dot} data-state={tab.status?.state ?? "closed"} />
          <span>{tab.status.url === "about:blank" ? (ko ? "새 탭" : "New tab") : tab.status.title || tabHost(tab.status.url || tab.initialUrl)}</span>
        </button>
        <button type="button" aria-label={ko ? "브라우저 탭 닫기" : "Close browser tab"} onClick={() => void close(tab.id)}><IconClose size={12}/></button>
      </div>)}
      {!headerHost && <button className={styles.add} type="button" disabled={!connected || creating || tabs.length >= 8} aria-label={ko ? "새 브라우저 탭" : "New browser tab"} onClick={() => void create()}><IconPlus size={16}/></button>}
    </div>
  );
  return <section className={styles.browser} data-task-browser={taskScopeId} data-inline-header={Boolean(headerHost)} aria-label={ko ? "작업 브라우저" : "Task browser"}>
    {headerHost ? createPortal(header, headerHost) : header}
    <form className={styles.navigation} onSubmit={(event) => { event.preventDefault(); void navigate(current?.id, address); }}>
      <button type="button" disabled={!current?.status?.canGoBack} aria-label={ko ? "뒤로" : "Back"} onClick={() => void history("back")}><IconArrowLeft size={16}/></button>
      <button type="button" disabled={!current?.status?.canGoForward} aria-label={ko ? "앞으로" : "Forward"} onClick={() => void history("forward")}><IconChevronRight size={16}/></button>
      <button type="button" disabled={!current?.initialUrl} aria-label={ko ? "새로고침" : "Reload"} onClick={() => void history("reload")}><IconRefresh size={15}/></button>
      <input aria-label={ko ? "브라우저 주소" : "Browser address"} placeholder={ko ? "주소 입력" : "Enter address"} value={address} onChange={(event) => setAddress(event.target.value)} onFocus={(event) => event.target.select()} spellCheck={false}/>
      <button ref={menuButton} type="button" aria-label={ko ? "브라우저 메뉴" : "Browser menu"} aria-haspopup="menu" aria-expanded={menuOpen} onClick={() => setMenuOpen((value) => !value)}><IconMoreHorizontal size={16}/></button>
    </form>
    {menuOpen && <div ref={menuRef} className={styles.menu} role="menu" aria-label={ko ? "브라우저 메뉴" : "Browser menu"}>
      <Link href="/browser" role="menuitem" onClick={() => setMenuOpen(false)}>{ko ? "로그인 연결 관리" : "Manage browser logins"}</Link>
      <p>{ko ? "커넥트 → 브라우저에서 가져온 로그인을 함께 사용합니다." : "Uses logins imported in Connect → Browser."}</p>
    </div>}
    {loginNotice && <p className={styles.notice} role="status">
      {ko ? "이 브라우저를 열 때 확인한 로그인 연결: " : "Login transfer checked when opening this browser: "}{loginNotice}
      {loginDiagnostic && <details><summary>{ko ? "자세히" : "Details"}</summary><code>{loginDiagnostic}</code></details>}
    </p>}
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    <div className={styles.pages}>
      {tabs.filter((tab) => tab.initialUrl).map((tab) => <div key={tab.id} className={styles.page} hidden={tab.id !== current?.id}>
        <NativeLiveWebView mode="browser" bare stableNavigation retainOnUnmount viewId={tab.id} taskScopeId={taskScopeId} url={tab.initialUrl}
          title={tab.status?.title ?? "Agentlas Browser"} active={active && tab.id === current?.id && tab.status.url !== "about:blank"} onStatus={acceptStatus}/>
      </div>)}
      {(!current || current.status.url === "about:blank") && <div className={styles.empty}><strong>Agentlas Browser</strong><p>{ko ? "이 작업에서 사용할 페이지를 여세요." : "Open a page for this task."}</p></div>}
    </div>
  </section>;
}
