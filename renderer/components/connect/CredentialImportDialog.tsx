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
import { ipc } from "@/lib/ipc";
import { browserLoginImportNotice } from "@/lib/browser-login-import-notice";
import type {
  BrowserProfileDataScanResult,
  DiscoveredBrowserProfile,
  DiscoveredCredentialDomain,
} from "@/lib/types";
import { siteDisplayName } from "@shared/registrable-domain";

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
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(true);
  // 로그인 쿠키 필터가 너무 적게 잡아 메인이 필터를 푼 경우 — 화면이 그 사실을 말한다.
  const [relaxed, setRelaxed] = useState(false);
  const [importingNow, setImportingNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionNotice, setSessionNotice] = useState<string | null>(null);
  const [loginRequired, setLoginRequired] = useState<string[]>([]);
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
      onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  // 1단계: 어떤 브라우저 프로필이 있는지.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!api) return;
      const res = await api.browser.scanCredentials(null);
      if (!alive) return;
      setProfiles(res.profiles);
      const first = res.profiles.find((p) => p.readable) ?? res.profiles[0] ?? null;
      setProfileId(first?.id ?? null);
      if (!first) {
        setScanning(false);
        setError(
          ko
            ? "이 컴퓨터에서 Chrome 계열 브라우저 프로필을 찾지 못했습니다."
            : "No Chrome-family browser profile was found on this computer.",
        );
      }
    })();
    return () => {
      alive = false;
    };
  }, [api, ko]);

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

  const toggle = (id: string) => {
    setActiveChecked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const run = async () => {
    if (!api || !profileId || checked.size + passwordChecked.size + historyChecked.size === 0) return;
    setImportingNow(true);
    setError(null);
    setLoginRequired([]);
    setSessionNotice(null);
    try {
      let linked = 0;
      let passwordCount = 0;
      let historyCount = 0;
      let skipped = 0;
      let nativeNotice: string | null = null;
      let protectedSites: string[] = [];
      if (checked.size > 0) {
        const res = await api.browser.importCredentials(profileId, [...checked]);
        if (!res.ok) {
          setError(res.error ?? (ko ? "로그인 상태를 가져오지 못했습니다." : "Could not import sign-in sessions."));
          return;
        }
        nativeNotice = browserLoginImportNotice(res.nativeSession, ko);
        linked = res.linkedSites.length;
        skipped += res.skipped.length;
        protectedSites = res.requiresLoginSites ?? [];
      }
      if (passwordChecked.size > 0 || historyChecked.size > 0) {
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
        if (!data.ok && passwordCount + historyCount === 0) {
          setError(ko ? "선택한 항목을 가져오지 못했습니다." : "Could not import the selected items.");
          return;
        }
      }
      setSessionNotice(nativeNotice);
      if (protectedSites.length > 0) {
        // Windows Chrome can bind modern cookies to Chrome's own executable.
        // That is a normal protected-session path, not an import error: keep the
        // dialog open and transition the selected site to the dedicated login UI.
        setChecked(new Set());
        setLoginRequired(protectedSites);
        void loadProfile(profileId);
        return;
      }
      const msg = ko
        ? `로그인 ${linked} · 비밀번호 ${passwordCount} · 기록 ${historyCount}${skipped > 0 ? ` · ${skipped}개 제외` : ""}`
        : `Sign-ins ${linked} · passwords ${passwordCount} · history ${historyCount}${skipped > 0 ? ` · ${skipped} skipped` : ""}`;
      if (skipped > 0) {
        setError(ko ? "일부 항목은 브라우저 보호 또는 변경 때문에 제외됐습니다." : "Some items were skipped because they are protected or changed.");
        // 사유를 읽을 수 있게 창은 열어 두고, 목록만 새로 고친다.
        setChecked(new Set());
        setPasswordChecked(new Set());
        setHistoryChecked(new Set());
        void loadProfile(profileId);
        return;
      }
      if (nativeNotice) {
        setChecked(new Set());
        setPasswordChecked(new Set());
        setHistoryChecked(new Set());
        void loadProfile(profileId);
        return;
      }
      onDone(msg);
    } catch {
      setError(ko ? "로그인을 가져오지 못했습니다. 브라우저 연결을 확인하고 다시 시도하세요." : "Could not import logins. Check the browser connection and try again.");
    } finally {
      setImportingNow(false);
    }
  };

  return (
    <div className="cid-backdrop" onClick={onClose}>
      <div className="cid-panel" role="dialog" aria-modal="true" aria-labelledby="credential-import-title" onClick={(e) => e.stopPropagation()}>
        <header className="cid-head">
          <h2 id="credential-import-title">{ko ? "브라우저에서 가져오기" : "Import from your browser"}</h2>
          <p>
            {ko
              ? "가져올 항목만 선택하세요."
              : "Choose only the items you want to import."}
          </p>
        </header>

        {profiles.length > 1 && (
          <div className="cid-profiles">
            {profiles.map((p) => (
              <button
                key={p.id}
                className={p.id === profileId ? "on" : ""}
                disabled={importingNow}
                onClick={() => setProfileId(p.id)}
              >
                <span className="pname">{p.displayName}</span>
                <span className="pmeta">{p.browser}</span>
              </button>
            ))}
          </div>
        )}

        <div className="cid-tabs" role="tablist" aria-label={ko ? "가져올 데이터" : "Data to import"}>
          {([
            ["cookies", ko ? "로그인" : "Sign-ins", domains.length],
            ["passwords", ko ? "비밀번호" : "Passwords", profileData?.passwords.length ?? 0],
            ["history", ko ? "방문 기록" : "History", profileData?.history.length ?? 0],
          ] as const).map(([id, label, count]) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? "on" : ""} onClick={() => { setTab(id); setQuery(""); }}>
              {label}<span>{count}</span>
            </button>
          ))}
        </div>

        <div className="cid-tools">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={ko ? "목록에서 찾기" : "Filter this list"}
          />
          <button
            className="cid-linkbtn"
            disabled={selectableIds.length === 0}
            onClick={() => {
              setActiveChecked((prev) => {
                const next = new Set(prev);
                if (allVisibleChecked) selectableIds.forEach((id) => next.delete(id));
                else selectableIds.forEach((id) => next.add(id));
                return next;
              });
            }}
          >
            {allVisibleChecked ? (ko ? "전체 해제" : "Clear all") : ko ? "전체 선택" : "Select all"}
          </button>
        </div>

        {!scanning && tab === "cookies" && relaxed && domains.length > 0 && (
          <div className="cid-relaxed">
            {ko
              ? "로그인 여부를 확인할 수 없어 모든 사이트를 표시합니다."
              : "Showing all sites because sign-in status could not be checked."}
          </div>
        )}

        <div className="cid-list">
          {scanning && <div className="cid-note">{ko ? "찾는 중…" : "Scanning…"}</div>}
          {!scanning && visible.length === 0 && (
            <div className="cid-note">
              {ko ? "표시할 항목이 없습니다." : "No items to show."}
            </div>
          )}
          {!scanning && tab === "cookies" &&
            (visible as DiscoveredCredentialDomain[]).map((d) => (
              <label key={d.domain} className="cid-row">
                <input
                  type="checkbox"
                  checked={checked.has(d.domain)}
                  disabled={importingNow}
                  onChange={() => toggle(d.domain)}
                />
                {/*
                  주소와 사이트명만(오너 결정 2026-08-20). 쿠키 개수·"로그인됨"·"연동됨" 같은
                  메타 배지는 렌더하지 않는다 — 그 숫자들은 순서와 필터를 정하는 내부 신호다.

                  이름은 방문 기록 제목(d.title)이 아니라 **도메인에서** 만든다. 제목은 마지막에
                  본 페이지의 것이라 사이트 이름 구실을 못 한다 — 온보딩 실측(2026-08-20)에서
                  google.com 줄에 받은편지함 제목과 이메일 주소가 그대로 떴다. 온보딩 스텝 7과
                  같은 함수를 쓴다(두 레일이 같은 이름을 보여야 한다).
                */}
                <span className="cid-title">{siteDisplayName(d.domain) || d.domain}</span>
                <span className="cid-domain">{d.domain}</span>
              </label>
            ))}
          {!scanning && tab === "passwords" && profileData?.passwords.filter((item) => visibleItemIds.has(item.id)).map((item) => (
            <label key={item.id} className="cid-row">
              <input type="checkbox" checked={passwordChecked.has(item.id)} disabled={importingNow || !item.importable}
                aria-label={`${item.label} ${ko ? "비밀번호" : "password"}`} onChange={() => toggle(item.id)} />
              <span className="cid-title">{item.label}</span>
              <span className="cid-domain">{item.maskedUsername ?? item.origin}</span>
              {!item.importable && <span className="cid-unavailable" title={ko ? "브라우저 보호로 가져올 수 없습니다." : "Protected by the browser and unavailable for import."}>!</span>}
            </label>
          ))}
          {!scanning && tab === "history" && profileData?.history.filter((item) => visibleItemIds.has(item.id)).map((item) => (
            <label key={item.id} className="cid-row" title={!taskScopeId ? (ko ? "방문 기록은 작업 브라우저에서 가져올 수 있습니다." : "History can be imported from a task browser.") : undefined}>
              <input type="checkbox" checked={historyChecked.has(item.id)} disabled={importingNow || !taskScopeId}
                aria-label={`${item.title} ${ko ? "방문 기록" : "history"}`} onChange={() => toggle(item.id)} />
              <span className="cid-title">{item.title}</span>
              <span className="cid-domain">{item.url}</span>
            </label>
          ))}
        </div>

        {error && <div className="cid-error">{error}</div>}
        {sessionNotice && <div className="cid-error" role="status">
          {sessionNotice}
        </div>}

        {loginRequired.length > 0 && (
          <div className="cid-login-required">
            <strong>{ko ? "로그인 필요" : "Sign-in required"}</strong>
            <span>
              {ko
                ? "이 사이트는 브라우저에서 한 번 로그인해 주세요."
                : "Sign in to these sites once in the Agentlas browser."}
            </span>
            <div className="cid-login-sites">
              {loginRequired.map((site, index) => (
                <button
                  key={site}
                  type="button"
                  onClick={async () => {
                    const result = await api?.browser.openLogin(site);
                    if (!result?.ok) {
                      setError(result?.error ?? (ko ? "로그인 창을 열지 못했습니다." : "Could not open the sign-in window."));
                      return;
                    }
                    onDone(
                      ko
                        ? `${site} 전용 로그인 창을 열었습니다${loginRequired.length > 1 ? ` · 나머지 ${loginRequired.length - 1}개는 Connect 목록에서 이어서 로그인하세요` : ""}`
                        : `Opened the dedicated sign-in for ${site}${loginRequired.length > 1 ? ` · continue the remaining ${loginRequired.length - 1} from Connect` : ""}`,
                    );
                  }}
                >
                  {index === 0
                    ? (ko ? `${site} 로그인 열기` : `Open ${site} sign-in`)
                    : (ko ? `${site}는 목록에 추가됨` : `${site} added to Connect`)}
                </button>
              ))}
            </div>
          </div>
        )}

        <footer className="cid-foot">
          <span className="cid-count">
            {ko ? `${checked.size + passwordChecked.size + historyChecked.size}개 선택` : `${checked.size + passwordChecked.size + historyChecked.size} selected`}
          </span>
          <div className="cid-actions">
            <button onClick={onClose}>{ko ? "닫기" : "Close"}</button>
            <button className="accent" disabled={checked.size + passwordChecked.size + historyChecked.size === 0 || importingNow} onClick={run}>
              {importingNow ? (ko ? "가져오는 중…" : "Importing…") : ko ? "가져오기" : "Import selected"}
            </button>
          </div>
        </footer>
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
      `}</style>
    </div>
  );
}
