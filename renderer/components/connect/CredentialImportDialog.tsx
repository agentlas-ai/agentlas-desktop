"use client";

// 평소 쓰는 브라우저에서 이미 로그인된 도메인을 목록으로 보여주고, 체크한 것만 Agentlas
// 전용 프로필로 가져온다. 가져온 도메인은 곧바로 Connect 사이트 목록에 나타나므로,
// 사용자는 주소를 손으로 치고 전용 창에서 다시 로그인하는 일을 하지 않아도 된다.
//
// 목록은 "로그인 쿠키가 있는 사이트"만, **사이트 이름과 주소만** 보여준다(오너 결정 2026-08-20).
// 쿠키 개수·"로그인됨"·"연동됨" 같은 메타 배지는 렌더하지 않는다 — 그 숫자로 줄을 세우면
// 광고·분석 도메인이 1등이 되고(googleadservices 23개 실측), 사용자에게도 아무 의미가 없다.
// 한 줄은 호스트가 아니라 사이트(등록 가능 도메인)이고, 고르면 그 사이트 쿠키가 전부 복사된다.
// 쿠키 값은 화면/로그/응답에 노출하지 않는다. macOS 메인 프로세스는 고른 쿠키만 메모리에서
// 전용 Chromium 키로 재암호화하고 즉시 폐기한다. 비밀번호·결제수단 저장소는 아예 읽지 않는다.

import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import type {
  DiscoveredBrowserProfile,
  DiscoveredCredentialDomain,
} from "@/lib/types";
import { siteDisplayName } from "@shared/registrable-domain";

export function CredentialImportDialog({
  ko,
  onClose,
  onDone,
}: {
  ko: boolean;
  onClose: () => void;
  onDone: (message: string) => void;
}) {
  const api = ipc();
  const [profiles, setProfiles] = useState<DiscoveredBrowserProfile[]>([]);
  const [profileId, setProfileId] = useState<string | null>(null);
  const [domains, setDomains] = useState<DiscoveredCredentialDomain[]>([]);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [query, setQuery] = useState("");
  const [scanning, setScanning] = useState(true);
  // 로그인 쿠키 필터가 너무 적게 잡아 메인이 필터를 푼 경우 — 화면이 그 사실을 말한다.
  const [relaxed, setRelaxed] = useState(false);
  const [importingNow, setImportingNow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loginRequired, setLoginRequired] = useState<string[]>([]);

  // 1단계: 어떤 브라우저 프로필이 있는지.
  useEffect(() => {
    let alive = true;
    void (async () => {
      if (!api) return;
      const res = await api.browser.scanCredentials(null);
      if (!alive) return;
      setProfiles(res.profiles);
      const first = res.profiles.find((p) => p.readable) ?? null;
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

  // 2단계: 고른 프로필의 도메인 목록.
  const loadDomains = useCallback(
    async (id: string) => {
      if (!api) return;
      setScanning(true);
      setError(null);
      const res = await api.browser.scanCredentials(id);
      setDomains(res.domains);
      setRelaxed(Boolean(res.loginFilterRelaxed));
      setChecked(new Set());
      if (!res.ok && res.error) setError(res.error);
      setScanning(false);
    },
    [api],
  );

  useEffect(() => {
    if (profileId) void loadDomains(profileId);
  }, [profileId, loadDomains]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return domains;
    return domains.filter(
      (d) => d.domain.includes(q) || siteDisplayName(d.domain).toLowerCase().includes(q),
    );
  }, [domains, query]);

  const selectable = useMemo(() => visible.filter((d) => !d.alreadyLinked), [visible]);
  const allVisibleChecked = selectable.length > 0 && selectable.every((d) => checked.has(d.domain));

  const toggle = (domain: string) => {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(domain)) next.delete(domain);
      else next.add(domain);
      return next;
    });
  };

  const run = async () => {
    if (!api || !profileId || checked.size === 0) return;
    setImportingNow(true);
    setError(null);
    setLoginRequired([]);
    const res = await api.browser.importCredentials(profileId, [...checked]);
    setImportingNow(false);
    if (!res.ok) {
      setError(res.error ?? (ko ? "가져오지 못했습니다." : "Import failed."));
      return;
    }
    // 부분 실패를 성공으로 뭉개지 않는다 — 건너뛴 도메인이 있으면 개수를 함께 말한다.
    const linked = res.linkedSites.length;
    const skipped = res.skipped.length;
    const protectedSites = res.requiresLoginSites ?? [];
    if (protectedSites.length > 0) {
      // Windows Chrome can bind modern cookies to Chrome's own executable.
      // That is a normal protected-session path, not an import error: keep the
      // dialog open and transition the selected site to the dedicated login UI.
      setChecked(new Set());
      setLoginRequired(protectedSites);
      void loadDomains(profileId);
      return;
    }
    const msg = ko
      ? `${linked}개 연동됨${skipped > 0 ? ` · ${skipped}개 건너뜀` : ""}`
      : `Linked ${linked}${skipped > 0 ? ` · skipped ${skipped}` : ""}`;
    if (skipped > 0) {
      setError(
        (ko ? "건너뛴 항목: " : "Skipped: ") +
          res.skipped.map((s) => `${s.domain} (${s.reason})`).join(", "),
      );
      // 사유를 읽을 수 있게 창은 열어 두고, 목록만 새로 고친다.
      void loadDomains(profileId);
      return;
    }
    onDone(msg);
  };

  return (
    <div className="cid-backdrop" onClick={onClose}>
      <div className="cid-panel" onClick={(e) => e.stopPropagation()}>
        <header className="cid-head">
          <h2>{ko ? "브라우저에서 로그인 가져오기" : "Import logins from your browser"}</h2>
          <p>
            {ko
              ? "평소 쓰는 브라우저에 이미 로그인된 곳입니다. 고른 곳의 세션만 Agentlas 전용 프로필로 복사합니다. 비밀번호와 결제수단은 가져오지 않습니다."
              : "These are places you are already signed in to. Only the sessions you pick are copied into the Agentlas profile. Passwords and payment methods are never imported."}
          </p>
        </header>

        {profiles.length > 1 && (
          <div className="cid-profiles">
            {profiles.map((p) => (
              <button
                key={p.id}
                className={p.id === profileId ? "on" : ""}
                disabled={!p.readable}
                title={p.reason ?? p.path}
                onClick={() => setProfileId(p.id)}
              >
                <span className="pname">{p.displayName}</span>
                <span className="pmeta">{p.accountEmail ?? p.browser}</span>
              </button>
            ))}
          </div>
        )}

        <div className="cid-tools">
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={ko ? "도메인·이름으로 찾기" : "Filter by domain or name"}
          />
          <button
            className="cid-linkbtn"
            disabled={selectable.length === 0}
            onClick={() => {
              setChecked((prev) => {
                const next = new Set(prev);
                if (allVisibleChecked) selectable.forEach((d) => next.delete(d.domain));
                else selectable.forEach((d) => next.add(d.domain));
                return next;
              });
            }}
          >
            {allVisibleChecked ? (ko ? "전체 해제" : "Clear all") : ko ? "전체 선택" : "Select all"}
          </button>
        </div>

        {!scanning && relaxed && domains.length > 0 && (
          <div className="cid-relaxed">
            {ko
              ? "로그인 쿠키가 뚜렷한 사이트가 적게 잡혀서, 이 프로필의 사이트를 모두 보여줍니다."
              : "Few sites showed clear login cookies, so every site in this profile is listed."}
          </div>
        )}

        <div className="cid-list">
          {scanning && <div className="cid-note">{ko ? "찾는 중…" : "Scanning…"}</div>}
          {!scanning && visible.length === 0 && (
            <div className="cid-note">
              {ko ? "표시할 로그인이 없습니다." : "No logins to show."}
            </div>
          )}
          {!scanning &&
            visible.map((d) => (
              <label key={d.domain} className={d.alreadyLinked ? "cid-row linked" : "cid-row"}>
                <input
                  type="checkbox"
                  checked={checked.has(d.domain)}
                  disabled={d.alreadyLinked}
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
        </div>

        {error && <div className="cid-error">{error}</div>}

        {loginRequired.length > 0 && (
          <div className="cid-login-required">
            <strong>{ko ? "보호된 Windows 로그인" : "Protected Windows sign-in"}</strong>
            <span>
              {ko
                ? "Chrome이 이 세션을 Chrome 앱 자체에 묶어 보호하고 있어 복사본을 만들지 않았습니다. 아래에서 Agentlas 전용 로그인 창을 한 번 열면 이후 자동화가 그 세션을 계속 재사용합니다."
                : "Chrome bound this session to the Chrome app, so Agentlas did not create a broken copy. Open the dedicated sign-in once; later automations will keep reusing that session."}
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
            {ko ? `${checked.size}개 선택됨` : `${checked.size} selected`}
          </span>
          <div className="cid-actions">
            <button onClick={onClose}>{ko ? "닫기" : "Close"}</button>
            <button className="accent" disabled={checked.size === 0 || importingNow} onClick={run}>
              {importingNow ? (ko ? "연동 중…" : "Linking…") : ko ? "연동하기" : "Link selected"}
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
          grid-template-columns: auto 1fr auto;
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
        .cid-row.linked {
          opacity: 0.5;
          cursor: default;
        }
        .cid-title {
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .cid-domain {
          opacity: 0.62;
          font-size: 11.5px;
        }
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
