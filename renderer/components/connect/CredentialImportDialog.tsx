"use client";

// 평소 쓰는 브라우저 프로필의 로그인 상태·저장된 비밀번호·방문 기록을 나누어 보여주고,
// 사용자가 체크한 항목만 각각 전용 세션·암호화된 autofill vault·현재 작업 기록으로 가져온다.
//
// 목록은 "로그인 쿠키가 있는 사이트"만, **사이트 이름과 주소만** 보여준다(오너 결정 2026-08-20).
// 쿠키 개수·"로그인됨"·"연동됨" 같은 메타 배지는 렌더하지 않는다 — 그 숫자로 줄을 세우면
// 광고·분석 도메인이 1등이 되고(googleadservices 23개 실측), 사용자에게도 아무 의미가 없다.
// 한 줄은 호스트가 아니라 사이트(등록 가능 도메인)이고, 고르면 그 사이트 쿠키가 전부 복사된다.
// 쿠키·비밀번호 값은 화면/로그/응답에 노출하지 않는다. 비밀번호는 explicit import 동작 뒤
// Main에서만 복호화되어 기존 암호화 vault로 저장되고, 임시 바이트는 즉시 지운다.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ipc } from "@/lib/ipc";
import { browserLoginImportNotice } from "@/lib/browser-login-import-notice";
import type {
  BrowserProfileDataScanResult,
  DiscoveredBrowserProfile,
  DiscoveredCredentialDomain,
} from "@/lib/types";
import { siteDisplayName } from "@shared/registrable-domain";
import {
  IconAlertTriangle,
  IconCheck,
  IconChevronDown,
  IconClose,
  IconKey,
  IconLock,
  IconPuzzle,
  IconRefresh,
} from "@/components/Icon";

type ImportCategory = "passwords" | "cookies" | "history" | "extensions";
type ImportResult = {
  attempted: { cookies: number; passwords: number; history: number };
  affected: { cookies: boolean; passwords: boolean; history: boolean };
  linked: number;
  passwordCount: number;
  historyCount: number;
  cookieDetail: string;
  skipped: number;
  warnings: string[];
  loginRequired: string[];
};

export function CredentialImportDialog({
  ko,
  taskScopeId,
  onClose,
  onDone,
}: {
  ko: boolean;
  taskScopeId?: string;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const api = ipc();
  const [profiles, setProfiles] = useState<DiscoveredBrowserProfile[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [domains, setDomains] = useState<DiscoveredCredentialDomain[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [profileData, setProfileData] = useState<BrowserProfileDataScanResult | null>(null);
  const [passwordChecked, setPasswordChecked] = useState<Set<string>>(new Set());
  const [historyChecked, setHistoryChecked] = useState<Set<string>>(new Set());
  const [tab, setTab] = useState<"cookies" | "passwords" | "history">("cookies");
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [consented, setConsented] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(true);
  const [scanNonce, setScanNonce] = useState(0);
  // 로그인 쿠키 필터가 너무 적게 잡아 메인이 필터를 푼 경우 — 화면이 그 사실을 말한다.
  const [relaxed, setRelaxed] = useState(false);
  const [importingNow, setImportingNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scanRevision = useRef(0);

  /*
   * ★대화상자는 Escape 로 닫혀야 한다 (실측 2026-09-08).
   *   이 대화상자에는 Escape 처리가 **아예 없었다.** 나가는 길이 뒷배경 클릭뿐이라
   *   키보드만 쓰는 사람은 갇힌다. 모달은 어디서나 같은 방법으로 닫혀야 한다.
   */
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      if (!importingNow) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [importingNow, onClose]);

  // 1단계: 어떤 브라우저 프로필이 있는지.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!api) {
        setScanning(false);
        setError(ko ? "브라우저 가져오기를 사용할 수 없습니다." : "Browser import is unavailable.");
        return;
      }
      try {
        const res = await api.browser.scanCredentials(null);
        if (!alive) return;
        setProfiles(res.profiles);
        const first = res.profiles.find((p) => p.readable) ?? res.profiles[0] ?? null;
        setProfileId(first?.id ?? null);
        if (first && !res.ok) setError(res.error ?? (ko ? "프로필 목록을 일부 읽지 못했습니다." : "Some profiles could not be scanned."));
        if (!first) {
          setScanning(false);
          setError(res.error ?? (ko ? "이 컴퓨터에서 Chrome 계열 브라우저 프로필을 찾지 못했습니다." : "No Chrome-family browser profile was found on this computer."));
        }
      } catch {
        if (!alive) return;
        setScanning(false);
        setError(ko ? "브라우저 프로필을 찾지 못했습니다. 다시 시도해 주세요." : "Could not scan browser profiles. Please try again.");
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, ko, scanNonce]);

  // 2단계: 고른 프로필의 쿠키·비밀번호·방문 기록 메타데이터.
  const loadProfile = useCallback(
    async (id: string) => {
      if (!api) return;
      const revision = ++scanRevision.current;
      setScanning(true);
      setError(null);
      const [cookieResult, dataResult] = await Promise.allSettled([
        api.browser.scanCredentials(id),
        api.browserProfileImport.scan({ profileId: id }),
      ]);
      if (scanRevision.current !== revision) return;
      const cookieOk = cookieResult.status === "fulfilled" && cookieResult.value.ok;
      const dataOk = dataResult.status === "fulfilled" && dataResult.value.ok;
      if (cookieResult.status === "fulfilled") {
        setDomains(cookieResult.value.domains);
        setRelaxed(Boolean(cookieResult.value.loginFilterRelaxed));
      } else {
        setDomains([]);
        setRelaxed(false);
      }
      if (dataResult.status === "fulfilled") setProfileData(dataResult.value);
      else setProfileData(null);
      if (!cookieOk && !dataOk) {
        setError(ko ? "이 프로필을 읽지 못했습니다." : "Could not read this profile.");
      }
      setChecked(new Set());
      setPasswordChecked(new Set());
      setHistoryChecked(new Set());
      setScanning(false);
    },
    [api, ko],
  );

  useEffect(() => {
    if (profileId) void loadProfile(profileId);
    return () => { scanRevision.current += 1; };
  }, [profileId, loadProfile]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (tab === "cookies") return q ? domains.filter(
      (d) => d.domain.includes(q) || siteDisplayName(d.domain).toLowerCase().includes(q),
    ) : domains;
    if (tab === "passwords") return (profileData?.passwords ?? []).filter((item) => !q
      || `${item.label}\n${item.origin}\n${item.maskedUsername ?? ""}`.toLowerCase().includes(q));
    return (profileData?.history ?? []).filter((item) => !q
      || `${item.title}\n${item.url}`.toLowerCase().includes(q));
  }, [domains, profileData, query, tab]);
  const visibleItemIds = useMemo(() => new Set(visible.flatMap((item) => "id" in item ? [item.id] : [])), [visible]);

  // Existing connections can be selected again to recover an incomplete transfer.
  const selectableIds = useMemo(() => visible.flatMap((item) => {
    if (tab === "cookies") return [(item as DiscoveredCredentialDomain).domain];
    if (tab === "passwords") return (item as NonNullable<typeof profileData>["passwords"][number]).importable
      ? [(item as NonNullable<typeof profileData>["passwords"][number]).id] : [];
    return taskScopeId ? [(item as NonNullable<typeof profileData>["history"][number]).id] : [];
  }), [profileData, tab, taskScopeId, visible]);
  const activeChecked = tab === "cookies" ? checked : tab === "passwords" ? passwordChecked : historyChecked;
  const setActiveChecked = tab === "cookies" ? setChecked : tab === "passwords" ? setPasswordChecked : setHistoryChecked;
  const allVisibleChecked = selectableIds.length > 0 && selectableIds.every((id) => activeChecked.has(id));

  const categoryIds = useMemo(() => ({
    cookies: domains.map((item) => item.domain),
    passwords: (profileData?.passwords ?? []).filter((item) => item.importable).map((item) => item.id),
    history: taskScopeId ? (profileData?.history ?? []).map((item) => item.id) : [],
    extensions: [],
  }), [domains, profileData, taskScopeId]);

  const categorySelection = (category: ImportCategory) => {
    const ids = categoryIds[category];
    const selected = category === "cookies" ? checked : category === "passwords" ? passwordChecked : historyChecked;
    return { count: ids.filter((id) => selected.has(id)).length, total: ids.length };
  };

  const toggleCategory = (category: ImportCategory) => {
    if (category === "extensions" || importingNow || scanning) return;
    const ids = categoryIds[category];
    if (ids.length === 0) return;
    const setter = category === "cookies" ? setChecked : category === "passwords" ? setPasswordChecked : setHistoryChecked;
    setter((prev) => {
      const next = new Set(prev);
      const all = ids.every((id) => next.has(id));
      ids.forEach((id) => { if (all) next.delete(id); else next.add(id); });
      return next;
    });
  };

  const toggle = (id: string) => {
    setActiveChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = async () => {
    if (!api || !profileId || !consented || checked.size + passwordChecked.size + historyChecked.size === 0) return;
    setImportingNow(true);
    setError(null);
    try {
      const attempted = { cookies: checked.size, passwords: passwordChecked.size, history: historyChecked.size };
      const affected = { cookies: false, passwords: false, history: false };
      let linked = 0;
      let passwordCount = 0;
      let historyCount = 0;
      let skipped = 0;
      let nativeNotice: string | null = null;
      let protectedSites: string[] = [];
      const warnings: string[] = [];
      // 가져오기는 누적이다 — 이번에 더한 것, 갱신한 것, 이미 있어서 그대로 둔 것을 나눠 말한다.
      let cookieDetail = "";
      if (checked.size > 0) {
        const res = await api.browser.importCredentials(profileId, [...checked]);
        if (!res.ok) {
          affected.cookies = true;
          warnings.push(res.error ?? (ko ? "로그인 상태를 가져오지 못했습니다." : "Could not import sign-in sessions."));
        } else {
          nativeNotice = browserLoginImportNotice(res.nativeSession, ko);
          linked = res.linkedSites.length;
          skipped += res.skipped.length;
          protectedSites = res.requiresLoginSites ?? [];
          affected.cookies = res.skipped.length > 0 || protectedSites.length > 0 || Boolean(nativeNotice);
          const added = res.cookiesAdded ?? 0;
          const updated = res.cookiesUpdated ?? 0;
          const kept = res.cookiesPreserved ?? 0;
          cookieDetail = ko
            ? `쿠키 +${added} · 갱신 ${updated} · 유지 ${kept}`
            : `Cookies +${added} · updated ${updated} · kept ${kept}`;
        }
      }
      if (passwordChecked.size > 0 || historyChecked.size > 0) {
        try {
          const data = await api.browserProfileImport.import({
            profileId,
            passwordIds: [...passwordChecked],
            historyIds: [...historyChecked],
            ...(taskScopeId ? { taskScopeId } : {}),
            userConfirmed: true,
          });
          passwordCount = data.passwords.imported + data.passwords.updated;
          historyCount = data.history.imported;
          skipped += data.skipped.length;
          affected.passwords = data.skipped.some((item) => item.kind === "password") || (!data.ok && attempted.passwords > passwordCount);
          affected.history = data.skipped.some((item) => item.kind === "history") || (!data.ok && attempted.history > historyCount);
          if (!data.ok) warnings.push(ko ? "일부 비밀번호 또는 방문 기록을 가져오지 못했습니다." : "Some passwords or history items could not be imported.");
        } catch {
          affected.passwords = attempted.passwords > 0;
          affected.history = attempted.history > 0;
          warnings.push(ko ? "비밀번호 또는 방문 기록을 가져오지 못했습니다." : "Could not import passwords or history.");
        }
      }
      if (nativeNotice) warnings.push(nativeNotice);
      if (skipped > 0) warnings.push(ko ? `${skipped}개 항목은 브라우저 보호 또는 변경 때문에 제외됐습니다.` : `${skipped} items were skipped because they are protected or changed.`);
      if (linked + passwordCount + historyCount === 0 && protectedSites.length === 0) {
        setError(warnings.join(" ") || (ko ? "선택한 항목을 가져오지 못했습니다." : "Could not import the selected items."));
        return;
      }
      setResult({ attempted, affected, linked, passwordCount, historyCount, cookieDetail, skipped, warnings, loginRequired: protectedSites });
    } catch {
      setError(ko ? "로그인을 가져오지 못했습니다. 브라우저 연결을 확인하고 다시 시도하세요." : "Could not import logins. Check the browser connection and try again.");
    } finally {
      setImportingNow(false);
    }
  };

  const selectedCount = checked.size + passwordChecked.size + historyChecked.size;
  const summary = result && (ko
    ? `연결 사이트 ${result.linked} · 비밀번호 ${result.passwordCount} · 기록 ${result.historyCount}${result.skipped ? ` · ${result.skipped}개 제외` : ""}`
    : `Connected sites ${result.linked} · passwords ${result.passwordCount} · history ${result.historyCount}${result.skipped ? ` · ${result.skipped} skipped` : ""}`);
  const resultStatus = (count: number, attempted: number, affected: boolean) => attempted === 0
    ? <span className="cid-result-unselected">{ko ? "미선택" : "Not selected"}</span>
    : count > 0 && !affected && count >= attempted
      ? <span className="cid-result-status" aria-label={ko ? "반영됨" : "Imported"}><IconCheck size={14}/></span>
      : <span className="cid-result-status warn" aria-label={ko ? "반영되지 않음" : "Not imported"}><IconAlertTriangle size={17}/></span>;

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="cid-backdrop" onClick={() => { if (!importingNow) onClose(); }}>
      <div className={`cid-panel${result ? " cid-complete" : ""}`} role="dialog" aria-modal="true" aria-labelledby="credential-import-title" onClick={(event) => event.stopPropagation()}>
        <header className="cid-head">
          <div>
            <h2 id="credential-import-title">{result ? (ko ? "가져오기 결과" : "Import results") : (ko ? "브라우저에서 가져오기" : "Import from your browser")}</h2>
            <p>{result
              ? (ko ? "선택한 데이터의 실제 처리 결과입니다." : "Here is what was actually imported.")
              : (ko ? "내장 브라우저로 가져올 데이터를 선택하세요" : "Choose what to import into the Agentlas browser")}</p>
          </div>
          {!result && <button className="cid-close" type="button" aria-label={ko ? "닫기" : "Close"} disabled={importingNow} onClick={onClose}><IconClose size={18} /></button>}
        </header>

        {result ? (
          <div className="cid-result-body">
            <div className="cid-categories cid-result-list">
              <div className="cid-category"><IconKey size={22} /><strong>{ko ? "저장된 비밀번호" : "Saved passwords"}</strong><span className="cid-result-count">{result.passwordCount}</span>{resultStatus(result.passwordCount, result.attempted.passwords, result.affected.passwords)}</div>
              <div className="cid-category"><IconLock size={22} /><strong>{ko ? "쿠키 · 연결 사이트" : "Cookies · connected sites"}</strong><span className="cid-result-count">{result.linked}</span>{resultStatus(result.linked, result.attempted.cookies, result.affected.cookies)}</div>
              <div className="cid-category"><IconRefresh size={22} /><strong>{ko ? "방문 기록" : "Browsing history"}</strong><span className="cid-result-count">{result.historyCount}</span>{resultStatus(result.historyCount, result.attempted.history, result.affected.history)}</div>
              <div className="cid-category"><IconPuzzle size={22} /><strong>{ko ? "확장 프로그램" : "Extensions"}</strong><span className="cid-result-status warn"><IconAlertTriangle size={17}/></span></div>
            </div>
            {result.cookieDetail && <p className="cid-result-note">{result.cookieDetail}</p>}
            <div className="cid-result-warnings">
              <strong>{ko ? "확장 프로그램" : "Extensions"}</strong>
              <p>{ko ? "확장 프로그램 가져오기는 현재 지원하지 않습니다." : "Extension import is not currently supported."}</p>
              {result.warnings.map((warning, index) => <p className="cid-warning" key={`${index}-${warning}`}>{warning}</p>)}
              {result.loginRequired.length > 0 && <>
                <strong>{ko ? "다시 로그인해야 하는 사이트" : "Sites requiring sign-in"}</strong>
                <p>{ko ? "브라우저 보호로 세션을 옮길 수 없어, Agentlas 브라우저에서 한 번 로그인해야 합니다." : "Browser protection prevented session transfer. Sign in once in the Agentlas browser."}</p>
                <div className="cid-login-sites">{result.loginRequired.map((site) => <button type="button" key={site} onClick={async () => {
                  const opened = await api?.browser.openLogin(site);
                  if (!opened?.ok) { setError(opened?.error ?? (ko ? "로그인 창을 열지 못했습니다." : "Could not open the sign-in window.")); return; }
                  onDone(ko ? `${site} 로그인 창을 열었습니다. ${summary}` : `Opened sign-in for ${site}. ${summary}`);
                }}>{ko ? `${site} 로그인 열기` : `Sign in to ${site}`}</button>)}</div>
              </>}
            </div>
            {error && <p className="cid-error" role="alert">{error}</p>}
          </div>
        ) : (
          <div className="cid-body">
            <div className="cid-source-row">
              <label htmlFor="cid-profile">{ko ? "원본" : "Source"}</label>
              <div className="cid-select-wrap">
                <select id="cid-profile" value={profileId ?? ""} disabled={importingNow || profiles.length === 0} onChange={(event) => { setProfileId(event.target.value); setConsented(false); }}>
                  {profiles.length === 0 && <option value="">{scanning ? (ko ? "브라우저를 찾는 중…" : "Finding browsers…") : (ko ? "프로필 없음" : "No profile found")}</option>}
                  {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.browser} · {profile.displayName}</option>)}
                </select>
                <IconChevronDown size={16}/>
              </div>
            </div>
            <div className="cid-source-hint">
              <span>{ko ? "선택한 프로필에서 읽을 수 있는 항목만 표시됩니다." : "Only available items from this profile are shown."}</span>
              <button className="cid-details-toggle" type="button" aria-expanded={detailsOpen} onClick={() => setDetailsOpen((open) => !open)}>{ko ? "항목별 선택" : "Choose items"}<IconChevronDown size={15}/></button>
            </div>

            <div className="cid-categories" aria-label={ko ? "가져올 데이터" : "Data to import"}>
              {([
                ["passwords", ko ? "저장된 비밀번호" : "Saved passwords", <IconKey size={22} />],
                ["cookies", ko ? "쿠키" : "Cookies", <IconLock size={22} />],
                ["history", ko ? "방문 기록" : "Browsing history", <IconRefresh size={22} />],
                ["extensions", ko ? "확장 프로그램" : "Extensions", <IconPuzzle size={22} />],
              ] as const).map(([category, label, icon]) => {
                const selection = categorySelection(category);
                const disabled = category === "extensions" || selection.total === 0 || scanning || importingNow;
                return <div className="cid-category" key={category}>
                  {icon}<div className="cid-category-label"><strong>{label}</strong>{category !== "extensions" && selection.count > 0 && <small>{selection.count}/{selection.total}</small>}{category === "history" && !taskScopeId && <small>{ko ? "작업 브라우저에서만" : "Task browser only"}</small>}</div>
                  <button type="button" className={`cid-switch${selection.count > 0 ? " on" : ""}${selection.count > 0 && selection.count < selection.total ? " partial" : ""}`} role="checkbox" aria-label={label} aria-checked={selection.count === selection.total && selection.total > 0 ? true : selection.count > 0 ? "mixed" : false} disabled={disabled} onClick={() => toggleCategory(category)}><span /></button>
                </div>;
              })}
            </div>
            {(profileData?.passwords.some((item) => !item.importable) || profileData?.capabilities.passwords === "unsupported") && <p className="cid-availability">{ko ? "일부 비밀번호는 브라우저 보호로 가져올 수 없습니다." : "Some passwords are protected by the browser and cannot be imported."}</p>}

            {detailsOpen && <div className="cid-details">
              <div className="cid-tabs" role="tablist" aria-label={ko ? "상세 선택" : "Detailed selection"}>
                {([ ["cookies", ko ? "쿠키" : "Cookies"], ["passwords", ko ? "비밀번호" : "Passwords"], ["history", ko ? "방문 기록" : "History"] ] as const).map(([id, label]) => <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => { setTab(id); setQuery(""); }}>{label}</button>)}
              </div>
              <div className="cid-tools"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={ko ? "목록에서 찾기" : "Filter this list"}/><button className="cid-linkbtn" type="button" disabled={selectableIds.length === 0 || importingNow} onClick={() => setActiveChecked((prev) => { const next = new Set(prev); selectableIds.forEach((id) => { if (allVisibleChecked) next.delete(id); else next.add(id); }); return next; })}>{allVisibleChecked ? (ko ? "전체 해제" : "Clear all") : (ko ? "전체 선택" : "Select all")}</button></div>
              {!scanning && tab === "cookies" && relaxed && domains.length > 0 && <p className="cid-relaxed">{ko ? "로그인 여부를 확인할 수 없어 모든 사이트를 표시합니다." : "Showing all sites because sign-in status could not be checked."}</p>}
              <div className="cid-list">
                {scanning && <div className="cid-note">{ko ? "찾는 중…" : "Scanning…"}</div>}
                {!scanning && visible.length === 0 && <div className="cid-note">{ko ? "표시할 항목이 없습니다." : "No items to show."}</div>}
                {!scanning && tab === "cookies" && (visible as DiscoveredCredentialDomain[]).map((item) => <label className="cid-row" key={item.domain}><input type="checkbox" checked={checked.has(item.domain)} disabled={importingNow} onChange={() => toggle(item.domain)}/><span className="cid-item-text"><strong>{siteDisplayName(item.domain) || item.domain}</strong><small>{item.domain}</small></span></label>)}
                {!scanning && tab === "passwords" && profileData?.passwords.filter((item) => visibleItemIds.has(item.id)).map((item) => <label className="cid-row" key={item.id}><input type="checkbox" checked={passwordChecked.has(item.id)} disabled={importingNow || !item.importable} onChange={() => toggle(item.id)}/><span className="cid-item-text"><strong>{item.label}</strong><small>{item.maskedUsername ?? item.origin}</small></span>{!item.importable && <span className="cid-unavailable" title={ko ? "브라우저 보호로 가져올 수 없습니다." : "Protected by the browser and unavailable for import."}>!</span>}</label>)}
                {!scanning && tab === "history" && profileData?.history.filter((item) => visibleItemIds.has(item.id)).map((item) => <label className="cid-row" key={item.id}><input type="checkbox" checked={historyChecked.has(item.id)} disabled={importingNow || !taskScopeId} onChange={() => toggle(item.id)}/><span className="cid-item-text"><strong>{item.title}</strong><small>{item.url}</small></span></label>)}
              </div>
            </div>}

            <div className="cid-consent"><strong>{ko ? "가져오기 전 확인" : "Before you import"}</strong><p>{ko ? "선택한 항목만 이 컴퓨터의 브라우저 프로필에서 읽어 Agentlas로 복사합니다. 비밀번호는 암호화된 저장소에, 쿠키는 전용 브라우저 세션에 저장되며 방문 기록은 현재 작업에만 추가됩니다. 브라우저 보호로 일부 항목은 가져올 수 없을 수 있습니다." : "Only selected items are copied from this computer's browser profile. Passwords go into the encrypted vault, cookies into the dedicated browser session, and history into this task only. Browser protection may prevent some transfers."}</p><label><input type="checkbox" checked={consented} disabled={importingNow} onChange={(event) => setConsented(event.target.checked)}/><span>{ko ? "선택한 브라우저 데이터를 Agentlas로 가져오는 데 동의합니다." : "I agree to import the selected browser data into Agentlas."}</span></label></div>
            {error && <div className="cid-error-row"><p className="cid-error" role="alert">{error}</p>{!scanning && selectedCount === 0 && <button type="button" onClick={() => { if (profileId) { void loadProfile(profileId); } else { setScanning(true); setError(null); setScanNonce((value) => value + 1); } }}>{ko ? "다시 찾기" : "Scan again"}</button>}</div>}
          </div>
        )}

        <footer className="cid-foot"><span className="cid-count">{result ? summary : (ko ? `${selectedCount}개 선택` : `${selectedCount} selected`)}</span><div className="cid-actions">{!result && <button type="button" onClick={onClose} disabled={importingNow}>{ko ? "취소" : "Cancel"}</button>}<button className="accent" type="button" disabled={!result && (!consented || selectedCount === 0 || importingNow)} onClick={result ? () => onDone(summary || "") : () => void run()}>{result ? (ko ? "완료" : "Done") : importingNow ? (ko ? "가져오는 중…" : "Importing…") : (ko ? "가져오기" : "Import")}</button></div></footer>
      </div>

      <style jsx>{`
        .cid-backdrop {
          position: fixed;
          inset: 0;
          z-index: 70;
          background: rgba(0, 0, 0, 0.32);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 24px;
        }
        .cid-panel {
          width: var(--popup-2-width);
          max-width: calc(100vw - 32px);
          max-height: 82vh;
          display: flex;
          flex-direction: column;
          gap: 12px;
          background: var(--paper);
          border: var(--hairline);
          border-radius: 14px;
          padding: 20px;
        }
        .cid-head h2 {
          margin: 0 0 6px;
          font-family: var(--font-head);
          font-size: 16px;
        }
        .cid-head p {
          margin: 0;
          font-size: 12.5px;
          line-height: 1.55;
          opacity: 0.75;
        }
        .cid-profiles {
          display: flex;
          gap: 8px;
          flex-wrap: wrap;
        }
        .cid-profiles button {
          display: flex;
          flex-direction: column;
          align-items: flex-start;
          gap: 2px;
          padding: 7px 11px;
          border-radius: 9px;
          border: 1px solid var(--paper-edge);
          background: transparent;
          cursor: pointer;
          font-size: 12px;
        }
        .cid-profiles button.on {
          border-color: var(--accent);
        }
        .cid-profiles button:disabled {
          opacity: 0.45;
          cursor: not-allowed;
        }
        .pname {
          font-weight: 600;
        }
        .pmeta {
          opacity: 0.6;
          font-size: 11px;
        }
        .cid-tabs {
          display: grid;
          grid-template-columns: repeat(3, minmax(0, 1fr));
          gap: 4px;
          padding: 3px;
          border-radius: 10px;
          background: var(--paper-soft);
        }
        .cid-tabs button {
          display: flex;
          align-items: center;
          justify-content: center;
          gap: 6px;
          min-width: 0;
          padding: 7px 8px;
          border: 0;
          border-radius: 8px;
          color: inherit;
          background: transparent;
          font-size: 12px;
          cursor: pointer;
        }
        .cid-tabs button.on { background: var(--paper); box-shadow: 0 1px 4px rgba(0, 0, 0, 0.08); }
        .cid-tabs button span { opacity: 0.55; font-size: 11px; }
        .cid-tools {
          display: flex;
          gap: 8px;
        }
        .cid-tools input {
          flex: 1;
          padding: 7px 11px;
          border-radius: 9px;
          border: 1px solid var(--paper-edge);
          background: var(--paper);
          font-size: 12.5px;
          outline: none;
        }
        .cid-linkbtn {
          border: 1px solid var(--paper-edge);
          background: transparent;
          border-radius: 9px;
          padding: 7px 11px;
          font-size: 12px;
          cursor: pointer;
        }
        .cid-relaxed {
          font-size: 11.5px;
          line-height: 1.5;
          opacity: 0.7;
        }
        .cid-list {
          flex: 1;
          min-height: 140px;
          overflow-y: auto;
          border: 1px solid var(--paper-edge);
          border-radius: 10px;
        }
        .cid-row {
          display: grid;
          grid-template-columns: auto minmax(0, 1fr) minmax(0, auto) auto;
          align-items: center;
          gap: 10px;
          padding: 8px 11px;
          border-bottom: 1px solid var(--paper-edge);
          font-size: 12.5px;
          cursor: pointer;
        }
        .cid-row:last-child {
          border-bottom: 0;
        }
        .cid-title {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .cid-domain {
          max-width: 180px;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
          opacity: 0.62;
          font-size: 11.5px;
        }
        .cid-unavailable { font-weight: 700; color: var(--danger); }
        .cid-note {
          padding: 22px 12px;
          text-align: center;
          font-size: 12.5px;
          opacity: 0.6;
        }
        .cid-error {
          font-size: 12px;
          line-height: 1.5;
          color: var(--danger);
        }
        .cid-login-required {
          display: flex;
          flex-direction: column;
          gap: 7px;
          padding: 11px 12px;
          border: 1px solid var(--paper-edge);
          border-radius: 10px;
          font-size: 12px;
          line-height: 1.5;
        }
        .cid-login-required span { opacity: 0.76; }
        .cid-login-sites { display: flex; flex-wrap: wrap; gap: 6px; }
        .cid-login-sites button {
          border: 1px solid var(--paper-edge);
          border-radius: 8px;
          background: transparent;
          padding: 6px 9px;
          cursor: pointer;
        }
        .cid-foot {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 12px;
        }
        .cid-count {
          font-size: 12px;
          opacity: 0.7;
        }
        .cid-actions {
          display: flex;
          gap: 8px;
        }
        .cid-actions button {
          padding: 8px 14px;
          border-radius: 9px;
          border: 1px solid var(--paper-edge);
          background: transparent;
          font-size: 12.5px;
          cursor: pointer;
        }
        .cid-actions button.accent {
          background: var(--accent);
          border-color: transparent;
          color: var(--white);
        }
        .cid-actions button:disabled {
          opacity: 0.5;
          cursor: not-allowed;
        }

        /* The import sheet follows the browser's quiet, white native-dialog language. */
        .cid-backdrop { background: rgba(16, 20, 26, 0.18); padding: 18px; }
        .cid-panel {
          width: min(650px, 100%);
          max-width: calc(100vw - 36px);
          max-height: min(88vh, 790px);
          gap: 0;
          padding: 0;
          overflow: hidden;
          border: 1px solid #dedfe3;
          border-radius: 23px;
          background: #fff;
          color: #202328;
          box-shadow: 0 12px 32px rgba(27, 31, 36, .14);
        }
        .cid-head { display: flex; justify-content: space-between; gap: 18px; padding: 27px 25px 0; }
        .cid-head h2 { margin: 0 0 5px; font-family: inherit; font-size: 24px; font-weight: 700; letter-spacing: -.035em; line-height: 1.3; }
        .cid-head p { margin: 0; color: #858990; font-size: 16px; line-height: 1.45; opacity: 1; }
        .cid-close { flex: 0 0 auto; display: grid; place-items: center; width: 26px; height: 26px; margin-top: -5px; border: 0; background: transparent; color: #555b63; cursor: pointer; }
        .cid-close:hover { color: #171a1e; }
        .cid-close:disabled { opacity: .45; cursor: default; }
        .cid-body, .cid-result-body { overflow-y: auto; min-height: 0; padding: 17px 25px 0; }
        .cid-source-row { display: grid; grid-template-columns: 35px minmax(0, 1fr); align-items: center; gap: 10px; }
        .cid-source-row label { color: #898e95; font-size: 15px; }
        .cid-select-wrap { position: relative; min-width: 0; }
        .cid-select-wrap select { appearance: none; display: block; width: 100%; height: 36px; padding: 0 36px 0 13px; border: 1px solid #e0e2e7; border-radius: 10px; outline: none; background: #fff; color: #333940; font: inherit; font-size: 15px; cursor: pointer; }
        .cid-select-wrap select:focus-visible { outline: 2px solid #326fc3; outline-offset: 1px; }
        .cid-select-wrap select:disabled { opacity: .62; cursor: default; }
        .cid-select-wrap :global(svg) { position: absolute; right: 13px; top: 10px; pointer-events: none; color: #747a82; }
        .cid-source-hint { display: flex; align-items: center; justify-content: space-between; flex-wrap: wrap; gap: 4px 10px; margin: 10px 0 12px; color: #898e95; font-size: 14px; line-height: 1.45; }
        .cid-categories { border: 1px solid #e5e6ea; border-radius: 18px; padding: 0 20px; overflow: hidden; background: #fff; }
        .cid-category { display: flex; align-items: center; gap: 16px; min-height: 55px; border-bottom: 1px solid #eceef0; color: #666c73; }
        .cid-category:last-child { border-bottom: 0; }
        .cid-category-label { display: flex; align-items: baseline; gap: 9px; flex: 1; min-width: 0; }
        .cid-category strong { color: #202328; font-size: 16px; font-weight: 650; }
        .cid-category small { color: #888e95; font-size: 12px; }
        .cid-switch { flex: 0 0 auto; position: relative; width: 40px; height: 25px; margin-left: auto; border: 0; border-radius: 99px; background: #e3e5e9; cursor: pointer; transition: background .16s ease; }
        .cid-switch span { position: absolute; left: 3px; top: 3px; width: 19px; height: 19px; border-radius: 50%; background: #fff; box-shadow: 0 1px 3px #0002; transition: transform .16s ease; }
        .cid-switch.on { background: #43a552; }
        .cid-switch.on span { transform: translateX(15px); }
        .cid-switch.partial { background: #80ba88; }
        .cid-switch:disabled { cursor: not-allowed; }
        .cid-switch:focus-visible, .cid-details-toggle:focus-visible, .cid-close:focus-visible, .cid-actions button:focus-visible { outline: 2px solid #326fc3; outline-offset: 2px; }
        .cid-availability { margin: 8px 0 0; color: #868b92; font-size: 12px; line-height: 1.4; }
        .cid-details-toggle { display: inline-flex; align-items: center; gap: 4px; flex: 0 0 auto; padding: 2px 0; border: 0; background: transparent; color: #5b646c; font-size: 12px; font-weight: 600; text-align: left; cursor: pointer; }
        .cid-details-toggle[aria-expanded="true"] :global(svg) { transform: rotate(180deg); }
        .cid-details { margin-bottom: 15px; padding: 10px; border: 1px solid #e5e6ea; border-radius: 12px; }
        .cid-tabs { background: #f5f6f8; }
        .cid-tabs button { font-size: 12px; }
        .cid-tools { margin-top: 9px; }
        .cid-tools input { min-width: 0; border-color: #e2e5e9; background: #fff; color: #202328; }
        .cid-linkbtn { border-color: #e2e5e9; color: #3d444b; }
        .cid-relaxed { margin: 8px 0; color: #727981; opacity: 1; }
        .cid-list { flex: none; min-height: 0; max-height: 180px; margin-top: 9px; border-color: #e5e6ea; }
        .cid-row { display: flex; gap: 11px; padding: 7px 11px; border-color: #eef0f2; color: #283038; }
        .cid-row input { flex: 0 0 auto; accent-color: #43a552; }
        .cid-item-text { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
        .cid-item-text strong, .cid-item-text small { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        .cid-item-text strong { font-size: 12.5px; font-weight: 600; }
        .cid-item-text small { color: #828991; font-size: 11.5px; }
        .cid-consent { margin: 15px 0 16px; padding: 15px; border: 1px solid #dedfe4; border-radius: 11px; background: #fbfbfc; }
        .cid-consent > strong { display: block; margin-bottom: 10px; font-size: 15px; }
        .cid-consent p { margin: 0 0 10px; color: #777e87; font-size: 13px; line-height: 1.55; }
        .cid-consent label { display: flex; align-items: flex-start; gap: 9px; color: #343a41; font-size: 13px; line-height: 1.45; cursor: pointer; }
        .cid-consent input { flex: 0 0 auto; width: 18px; height: 18px; margin: 0; accent-color: #43a552; }
        .cid-error { margin: 0 0 14px; color: #b44335; font-size: 12px; }
        .cid-error-row { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; }
        .cid-error-row button { flex: 0 0 auto; padding: 4px 8px; border: 1px solid #d8dce1; border-radius: 6px; background: #fff; color: #38414a; font-size: 12px; cursor: pointer; }
        .cid-foot { flex: 0 0 auto; min-height: 69px; padding: 12px 25px 19px; background: #fff; }
        .cid-count { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: #868c92; opacity: 1; }
        .cid-actions { flex: 0 0 auto; gap: 15px; }
        .cid-actions button { min-width: 75px; min-height: 40px; padding: 8px 17px; border: 0; border-radius: 11px; background: #f0f1f4; color: #30353a; font-size: 14px; }
        .cid-actions button.accent { background: #1f2327; color: #fff; }
        .cid-actions button:disabled { opacity: .45; }
        .cid-complete .cid-head { padding-top: 27px; }
        .cid-result-body { padding-top: 16px; }
        .cid-result-list { max-height: 386px; overflow-y: auto; }
        .cid-result-list .cid-category { min-height: 55px; }
        .cid-result-list .cid-category strong { flex: 1; }
        .cid-result-count { color: #646b72; font-size: 13px; }
        .cid-result-unselected { color: #8a9097; font-size: 12px; }
        .cid-result-status { display: grid; place-items: center; width: 20px; height: 20px; border-radius: 50%; background: #059a4d; color: #fff; }
        .cid-result-status.warn { background: transparent; color: #ed6821; }
        .cid-result-note { margin: 9px 3px 0; color: #737980; font-size: 12px; }
        .cid-result-warnings { margin: 14px 0 0; }
        .cid-result-warnings strong { display: block; margin: 10px 0 5px; font-size: 13px; }
        .cid-result-warnings p { margin: 0 0 8px; color: #e4511b; font-size: 13px; line-height: 1.45; }
        .cid-result-warnings .cid-warning { overflow-wrap: anywhere; }
        .cid-login-sites { margin-bottom: 8px; }
        .cid-login-sites button { border-color: #e5e6ea; color: #27323c; }
        @media (max-width: 600px) {
          .cid-panel { max-width: calc(100vw - 24px); max-height: calc(100vh - 24px); border-radius: 18px; }
          .cid-head { padding: 20px 18px 0; }
          .cid-head h2 { font-size: 21px; }
          .cid-head p { font-size: 14px; }
          .cid-body, .cid-result-body { padding-left: 18px; padding-right: 18px; }
          .cid-foot { padding: 11px 18px 16px; }
          .cid-count { max-width: 110px; }
        }
      `}</style>
    </div>,
    document.body
  );
}
