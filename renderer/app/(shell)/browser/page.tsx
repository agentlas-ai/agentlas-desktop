"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CredentialImportDialog } from "@/components/connect/CredentialImportDialog";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import type { BrowserStatus, BrowserSite, BrowserActionLog } from "@/lib/types";

type Tab = "sites" | "logs";

export default function BrowserPage() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [sites, setSites] = useState<BrowserSite[]>([]);
  const [logs, setLogs] = useState<BrowserActionLog[]>([]);
  const [tab, setTab] = useState<Tab>("sites");
  const [editing, setEditing] = useState<BrowserSite | "new" | null>(null);
  const [importing, setImporting] = useState(false);
  const [consentPrompt, setConsentPrompt] = useState<{ count: number } | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [openingSite, setOpeningSite] = useState<string | null>(null);

  const api = ipc();

  const refresh = useCallback(async () => {
    if (!api) return;
    const [st, ss, lg] = await Promise.all([
      api.browser.status(),
      api.browser.listSites(),
      api.browser.listLogs(300),
    ]);
    setStatus(st);
    setSites(ss);
    setLogs(lg);
    // 승인 상태는 목록과 함께 다시 읽는다 — 가져오기 직후 배너가 스스로 사라져야 한다.
    try {
      const c = await api.browser.credentialConsent();
      setConsentPrompt(c.pending && c.count > 0 ? { count: c.count } : null);
    } catch {
      setConsentPrompt(null);
    }
  }, [api]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const flash = useCallback((msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2600);
  }, []);

  const logsByDate = useMemo(() => {
    const groups: Record<string, BrowserActionLog[]> = {};
    for (const l of logs) {
      const day = l.ts.slice(0, 10);
      (groups[day] ??= []).push(l);
    }
    return Object.entries(groups).sort((a, b) => (a[0] < b[0] ? 1 : -1));
  }, [logs]);

  return (
    <div
      className="browser-scroll"
      style={{
        flex: 1,
        minHeight: 0,
        width: "100%",
        overflowX: "hidden",
        overflowY: "auto",
        overscrollBehavior: "contain",
      }}
    >
    <div className="rd browser-root">
      <header className="browser-head">
        <div>
          <div className="browser-kicker">{ko ? "브라우저" : "Browser"}</div>
          <h1>
            {ko
              ? "로그인해 둔 사이트를 에이전트가 대신 조작해요"
              : "Let agents operate the sites you sign in to"}
          </h1>
        </div>
        <button className="browser-btn ghost" onClick={() => void refresh()}>
          {ko ? "새로고침" : "Refresh"}
        </button>
      </header>

      <section className="browser-explain">
        <p className="lead">
          {ko ? (
            <>
              Agentlas는 <b>전용 브라우저 프로필</b> 하나를 따로 만들어 씁니다. 여러분이 매일 쓰는
              크롬은 건드리지 않아요. 아래에서 사이트에 <b>한 번만 로그인</b>해 두면, 그 세션을
              기억했다가 에이전트가 그 자리에서 이어서 일합니다.
            </>
          ) : (
            <>
              Agentlas uses a separate <b>dedicated browser profile</b>. It does not touch your everyday
              Chrome profile. Sign in to a site <b>once</b> below, and agents can resume work from that
              saved session.
            </>
          )}
        </p>
        <ul className="browser-points">
          <li>
            <span className="dot ok" aria-hidden="true" />
            <span className="browser-point-copy">
              {ko
                ? "여러분의 진짜 크롬·비밀번호는 그대로. 전용 프로필만 사용해요."
                : "Your real Chrome profile and passwords stay untouched. Agents only use the dedicated profile."}
            </span>
          </li>
          <li>
            <span className="dot ok" aria-hidden="true" />
            <span className="browser-point-copy">
              {ko ? (
                <>
                  비밀번호는 Agentlas에 저장하지 않습니다. <b>사이트의 실제 로그인 화면</b>에서 직접
                  입력하고, 이후에는 전용 프로필의 로그인 세션만 재사용합니다.
                </>
              ) : (
                <>
                  Agentlas does not store site passwords. Enter them directly on the <b>provider&apos;s sign-in
                  page</b>; only the dedicated profile&apos;s signed-in session is reused afterward.
                </>
              )}
            </span>
          </li>
          <li>
            <span className="dot warn" aria-hidden="true" />
            <span className="browser-point-copy">
              {ko ? (
                <>
                  전송·게시·결제처럼 되돌릴 수 없는 행동은 <b>실행 전에 확인</b>을 받아요. (결제는
                  매번, 나머지는 “항상 승인”을 기억)
                </>
              ) : (
                <>
                  Irreversible actions like sending, posting, or payment require <b>confirmation before
                  execution</b>. Payments are always confirmed; other actions can remember “always allow.”
                </>
              )}
            </span>
          </li>
        </ul>
      </section>

      <section className="browser-status">
        <div className="stat">
          <span className="stat-label">{ko ? "브라우저 감지" : "Browser detection"}</span>
          <span className={`stat-val ${status?.chromeFound ? "ok" : "err"}`}>
            {status
              ? status.chromeFound
                ? ko
                  ? "✓ Chrome 준비됨"
                  : "✓ Chrome ready"
                : ko
                  ? "✗ Chrome을 찾을 수 없음"
                  : "✗ Chrome not found"
              : ko
                ? "확인 중…"
                : "Checking…"}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">{ko ? "전용 프로필" : "Dedicated profile"}</span>
          <span className="stat-val mono">{status?.profilePath ?? "—"}</span>
        </div>
      </section>

      <nav className="browser-tabs">
        <button className={tab === "sites" ? "on" : ""} onClick={() => setTab("sites")}>
          {ko ? "사이트" : "Sites"} ({sites.length})
        </button>
        <button className={tab === "logs" ? "on" : ""} onClick={() => setTab("logs")}>
          {ko ? "사용 기록" : "Activity log"}
        </button>
      </nav>

      {tab === "sites" && (
        <section className="browser-sites">
          {/* ★승인 전 한 번만 묻는다. 승인하면 그 뒤로는 제품이 알아서 갱신하므로 이 줄은 사라진다.
              물어볼 로그인이 실제로 있을 때만 나온다 — 빈 제안은 소음이다. */}
          {consentPrompt && (
            <div className="sites-consent">
              <div>
                <strong>
                  {ko
                    ? `평소 쓰는 브라우저에 로그인된 곳 ${consentPrompt.count}개를 찾았습니다.`
                    : `Found ${consentPrompt.count} places you are already signed in to.`}
                </strong>
                <span>
                  {ko
                    ? "가져오면 에이전트가 그 로그인으로 일합니다. 이후에는 자동으로 최신 상태를 유지합니다."
                    : "Import them and agents work with those logins. They are kept fresh automatically afterwards."}
                </span>
              </div>
              <button className="browser-btn accent" onClick={() => setImporting(true)}>
                {ko ? "골라서 가져오기" : "Choose what to import"}
              </button>
            </div>
          )}
          <div className="sites-toolbar">
            {/* ★주 행동은 "가져오기"다. 평소 브라우저에 이미 있는 로그인을 고르기만 하면 되는데
                주소를 손으로 치고 다시 로그인하는 쪽이 기본일 이유가 없다. */}
            <button className="browser-btn accent" onClick={() => setImporting(true)}>
              {ko ? "브라우저에서 가져오기" : "Import from your browser"}
            </button>
            <button className="browser-btn" onClick={() => setEditing("new")}>
              {ko ? "+ 직접 추가" : "+ Add manually"}
            </button>
          </div>
          {sites.length === 0 && (
            <div className="browser-empty">
              {ko
                ? "아직 등록한 사이트가 없어요. “사이트 추가”로 로그인해 둘 곳을 등록하세요."
                : "No sites have been added yet. Use “Add site” to register a place to sign in."}
            </div>
          )}
          <div className="sites-grid">
            {sites.map((s) => (
              <SiteCard
                key={s.id}
                site={s}
                opening={openingSite === s.site}
                loginBusy={openingSite !== null}
                onEdit={() => setEditing(s)}
                onLogin={async () => {
                  if (openingSite) return;
                  setOpeningSite(s.site);
                  try {
                    const r = await api?.browser.openLogin(s.site);
                    if (r?.ok) {
                      flash(
                        ko
                          ? `${s.site} 로그인 창을 열었어요. 로그인 후 이 화면에서 ‘세션 저장’을 누르세요.`
                          : `Opened the ${s.site} sign-in window. Sign in, then click Save session here.`,
                      );
                    } else {
                      flash(r?.error ?? (ko ? "로그인 창을 열지 못했어요." : "Could not open the sign-in window."));
                    }
                  } finally {
                    setOpeningSite(null);
                  }
                }}
                onCaptured={async () => {
                  const result = await api?.browser.markSession(s.site, "valid");
                  flash(result?.ok
                    ? (ko ? "로그인 세션을 확인하고 저장했어요." : "Verified and saved the login session.")
                    : (result?.error ?? (ko ? "실제 로그인 상태를 확인하지 못했어요." : "The signed-in session could not be verified.")));
                  void refresh();
                }}
                onDelete={async () => {
                  try {
                    await api?.browser.deleteSite(s.site);
                    flash(ko ? `${s.site} 삭제됨` : `${s.site} removed`);
                    void refresh();
                  } catch {
                    flash(
                      ko
                        ? `${s.site}의 보안 저장소 정리에 실패해 삭제하지 않았어요. 다시 시도해 주세요.`
                        : `Could not clear ${s.site} from secure storage, so it was not removed. Try again.`,
                    );
                  }
                }}
                ko={ko}
              />
            ))}
          </div>
        </section>
      )}

      {tab === "logs" && (
        <section className="browser-logs">
          {logsByDate.length === 0 && (
            <div className="browser-empty">{ko ? "아직 기록이 없어요." : "No activity yet."}</div>
          )}
          {logsByDate.map(([day, items]) => (
            <div key={day} className="log-day">
              <div className="log-date">{day}</div>
              <ul>
                {items.map((l) => (
                  <li key={l.id}>
                    <span className="log-time">{l.ts.slice(11, 19)}</span>
                    <span className="log-action" title={l.action}>
                      {formatBrowserLogAction(l.action, ko)}
                    </span>
                    {l.site && <span className="log-site">{l.site}</span>}
                    {l.result && (
                      <span className={`log-result ${l.result}`} title={l.result}>
                        {formatBrowserLogResult(l.result, ko)}
                      </span>
                    )}
                    {l.approval && (
                      <span className="log-approval" title={l.approval}>
                        {formatBrowserApproval(l.approval, ko)}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </section>
      )}

      {editing && (
        <SiteEditor
          site={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSave={async (input) => {
            await api?.browser.saveSite(input);
            setEditing(null);
            flash(ko ? "저장했어요." : "Saved.");
            void refresh();
          }}
          ko={ko}
        />
      )}

      {importing && (
        <CredentialImportDialog
          ko={ko}
          onClose={() => setImporting(false)}
          onDone={(msg) => {
            setImporting(false);
            flash(msg);
            void refresh();
          }}
        />
      )}

      {toast && <div className="browser-toast">{toast}</div>}

      <style jsx>{`
        .sites-consent {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          padding: 12px 14px;
          margin-bottom: 12px;
          border: 1px solid var(--paper-edge);
          border-radius: 11px;
          background: var(--paper);
        }
        .sites-consent > div {
          display: flex;
          flex-direction: column;
          gap: 3px;
        }
        .sites-consent strong {
          font-size: 13px;
        }
        .sites-consent span {
          font-size: 12px;
          opacity: 0.72;
          line-height: 1.5;
        }
        .browser-root {
          width: 100%;
          max-width: 920px;
          margin: 0 auto;
          padding: 28px 26px 80px;
          color: var(--rd-ink);
          display: flex;
          flex-direction: column;
          gap: 20px;
        }
        .browser-head {
          display: flex;
          align-items: flex-end;
          justify-content: space-between;
          gap: 16px;
        }
        .browser-head h1 {
          font-size: 22px;
          font-weight: 800;
          letter-spacing: -0.01em;
          margin: 4px 0 0;
        }
        .browser-kicker {
          font-size: 12px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          color: var(--rd-accent);
        }
        .browser-explain {
          background: var(--rd-bg-soft, rgba(127, 127, 160, 0.06));
          border: 1px solid var(--rd-hair);
          border-radius: 14px;
          padding: 18px 20px;
        }
        .browser-explain .lead {
          margin: 0 0 12px;
          line-height: 1.65;
          font-size: 14.5px;
        }
        .browser-points {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 8px;
        }
        .browser-points li {
          display: flex;
          gap: 9px;
          align-items: flex-start;
          font-size: 13.5px;
          line-height: 1.55;
          color: var(--rd-ink);
          opacity: 0.92;
        }
        .browser-point-copy {
          display: block;
          flex: 1 1 auto;
          min-width: 0;
          word-break: keep-all;
          overflow-wrap: break-word;
        }
        .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          margin-top: 6px;
          flex-shrink: 0;
        }
        .dot.ok {
          background: var(--rd-ok);
        }
        .dot.warn {
          background: var(--rd-warn);
        }
        .browser-status {
          display: grid;
          grid-template-columns: 1fr 2fr;
          gap: 10px;
          background: var(--rd-surface, rgba(127, 127, 160, 0.04));
          border: 1px solid var(--rd-hair);
          border-radius: 12px;
          padding: 14px 16px;
        }
        .stat {
          display: flex;
          flex-direction: column;
          gap: 4px;
          min-width: 0;
        }
        .stat-label {
          font-size: 11.5px;
          opacity: 0.6;
          font-weight: 600;
        }
        .stat-val {
          font-size: 13.5px;
          font-weight: 600;
        }
        .stat-val.ok {
          color: var(--rd-ok);
        }
        .stat-val.err {
          color: var(--rd-err);
        }
        .stat-val.mono {
          font-family: ui-monospace, Menlo, monospace;
          font-size: 12px;
          opacity: 0.75;
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .browser-tabs {
          display: flex;
          gap: 4px;
          border-bottom: 1px solid var(--rd-hair);
        }
        .browser-tabs button {
          background: none;
          border: none;
          padding: 9px 14px;
          font-size: 13.5px;
          font-weight: 600;
          color: var(--rd-ink);
          opacity: 0.55;
          cursor: pointer;
          border-bottom: 2px solid transparent;
          margin-bottom: -1px;
        }
        .browser-tabs button.on {
          opacity: 1;
          border-bottom-color: var(--rd-accent);
        }
        .sites-toolbar {
          display: flex;
          justify-content: flex-end;
          margin-bottom: 12px;
        }
        .sites-grid {
          display: grid;
          gap: 12px;
        }
        .browser-empty {
          padding: 28px;
          text-align: center;
          opacity: 0.55;
          font-size: 13.5px;
          border: 1px dashed var(--rd-hair);
          border-radius: 12px;
        }
        .browser-btn {
          border: 1px solid var(--rd-hair);
          background: var(--rd-surface, transparent);
          color: var(--rd-ink);
          border-radius: 9px;
          padding: 7px 13px;
          font-size: 13px;
          font-weight: 600;
          cursor: pointer;
        }
        .browser-btn.accent {
          background: var(--rd-accent);
          color: var(--white);
          border-color: transparent;
        }
        .browser-btn.ghost {
          background: none;
        }
        .log-day {
          margin-bottom: 16px;
        }
        .log-date {
          font-size: 12px;
          font-weight: 700;
          opacity: 0.55;
          margin-bottom: 6px;
        }
        .log-day ul {
          list-style: none;
          margin: 0;
          padding: 0;
          display: flex;
          flex-direction: column;
          gap: 2px;
        }
        .log-day li {
          display: flex;
          gap: 10px;
          align-items: center;
          font-size: 12.5px;
          padding: 5px 8px;
          border-radius: 7px;
        }
        .log-day li:hover {
          background: var(--rd-surface, rgba(127, 127, 160, 0.05));
        }
        .log-time {
          font-family: ui-monospace, Menlo, monospace;
          opacity: 0.5;
          font-size: 11.5px;
        }
        .log-action {
          font-weight: 600;
        }
        .log-site {
          opacity: 0.6;
        }
        .log-result {
          margin-left: auto;
          font-size: 11px;
          padding: 1px 7px;
          border-radius: 999px;
          background: var(--rd-surface, rgba(127, 127, 160, 0.1));
        }
        .log-result.denied,
        .log-result.blocked {
          color: var(--rd-err);
        }
        .log-approval {
          font-size: 11px;
          opacity: 0.5;
        }
        .browser-toast {
          position: fixed;
          bottom: 22px;
          left: 50%;
          transform: translateX(-50%);
          background: var(--rd-ink);
          color: var(--rd-bg);
          padding: 10px 18px;
          border-radius: 10px;
          font-size: 13px;
          font-weight: 600;
          z-index: 60;
          box-shadow: 0 8px 30px rgba(0, 0, 0, 0.25);
        }
      `}</style>
    </div>
    </div>
  );
}

function SiteCard({
  site,
  opening,
  loginBusy,
  onEdit,
  onLogin,
  onCaptured,
  onDelete,
  ko,
}: {
  site: BrowserSite;
  opening: boolean;
  loginBusy: boolean;
  onEdit: () => void;
  onLogin: () => void;
  onCaptured: () => void;
  onDelete: () => void;
  ko: boolean;
}) {
  const st = site.session.status;
  const badge =
    st === "valid"
      ? ko
        ? "🟢 로그인됨"
        : "🟢 Signed in"
      : st === "expired"
        ? ko
          ? "🟡 만료"
          : "🟡 Expired"
        : ko
          ? "⚪ 로그인 안 됨"
          : "⚪ Not signed in";
  return (
    <div className="sc">
      <div className="sc-main">
        <div className="sc-site">{site.label || site.site}</div>
        <div className="sc-sub">
          {site.site}
          {site.username ? ` · ${site.username}` : ""}
        </div>
        <div className="sc-badge">
          {badge}
          {site.session.capturedAt ? ` · ${site.session.capturedAt.slice(0, 10)}` : ""}
        </div>
      </div>
      <div className="sc-actions">
        <button
          onClick={onLogin}
          disabled={loginBusy}
          aria-busy={opening}
          title={ko ? "전용 프로필로 로그인 창 열기" : "Open the sign-in window in the dedicated profile"}
        >
          {opening ? (ko ? "확인 중…" : "Checking…") : ko ? "로그인 창" : "Sign in"}
        </button>
        <button
          onClick={onCaptured}
          title={ko ? "지금 로그인돼 있으면 세션 저장" : "Save the session if it is currently signed in"}
        >
          {ko ? "세션 저장" : "Save session"}
        </button>
        <button onClick={onEdit}>{ko ? "수정" : "Edit"}</button>
        <button className="danger" onClick={onDelete}>
          {ko ? "삭제" : "Delete"}
        </button>
      </div>
      <style jsx>{`
        .sc {
          border: 1px solid var(--rd-hair);
          border-radius: 12px;
          padding: 14px 16px;
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 14px;
          background: var(--rd-surface, transparent);
        }
        .sc-site {
          font-weight: 700;
          font-size: 14.5px;
        }
        .sc-sub {
          font-size: 12px;
          opacity: 0.6;
          margin-top: 2px;
        }
        .sc-badge {
          font-size: 12px;
          margin-top: 6px;
        }
        .sc-actions {
          display: flex;
          gap: 6px;
          flex-shrink: 0;
        }
        .sc-actions button {
          border: 1px solid var(--rd-hair);
          background: var(--rd-bg, transparent);
          color: var(--rd-ink);
          border-radius: 8px;
          padding: 6px 10px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
        }
        .sc-actions button:disabled {
          cursor: wait;
          opacity: 0.55;
        }
        .sc-actions button.danger {
          color: var(--rd-err);
        }
      `}</style>
    </div>
  );
}

function SiteEditor({
  site,
  onClose,
  onSave,
  ko,
}: {
  site: BrowserSite | null;
  onClose: () => void;
  onSave: (input: {
    site: string;
    label?: string | null;
    username?: string | null;
  }) => void;
  ko: boolean;
}) {
  const [siteAddr, setSiteAddr] = useState(site?.site ?? "");
  const [label, setLabel] = useState(site?.label ?? "");
  const [username, setUsername] = useState(site?.username ?? "");

  return (
    <div className="be-backdrop" onClick={onClose}>
      <div className="be" onClick={(e) => e.stopPropagation()}>
        <h2>{site ? (ko ? "사이트 수정" : "Edit site") : ko ? "사이트 추가" : "Add site"}</h2>
        <label>
          {ko ? "사이트 주소" : "Site address"}
          <input
            value={siteAddr}
            disabled={Boolean(site)}
            onChange={(e) => setSiteAddr(e.target.value)}
            placeholder="instagram.com"
          />
        </label>
        <label>
          {ko ? "이름(선택)" : "Name (optional)"}
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={ko ? "인스타 계정" : "Instagram account"} />
        </label>
        <label>
          {ko ? "아이디(선택)" : "Username (optional)"}
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="myid" />
        </label>
        <p className="hint">
          {ko
            ? "저장 후 ‘로그인 창’을 열어 사이트에서 직접 로그인하세요. Agentlas는 비밀번호를 받거나 저장하지 않습니다."
            : "After saving, open Sign in and authenticate on the provider page. Agentlas never receives or stores the password."}
        </p>
        <div className="be-actions">
          <button className="ghost" onClick={onClose}>
            {ko ? "취소" : "Cancel"}
          </button>
          <button
            className="accent"
            onClick={() =>
              onSave({
                site: siteAddr,
                label: label || null,
                username: username || null,
              })
            }
          >
            {ko ? "저장" : "Save"}
          </button>
        </div>
      </div>
      <style jsx>{`
        .be-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.42);
          display: flex;
          align-items: center;
          justify-content: center;
          padding: 16px;
          overflow-y: auto;
          z-index: 70;
        }
        .be {
          width: var(--popup-3-width);
          max-height: calc(100vh - 32px);
          overflow-y: auto;
          background: var(--rd-bg);
          color: var(--rd-ink);
          border: 1px solid var(--rd-hair);
          border-radius: 16px;
          padding: 22px 22px 18px;
          display: flex;
          flex-direction: column;
          gap: 12px;
        }
        .be h2 {
          margin: 0 0 4px;
          font-size: 17px;
          font-weight: 800;
        }
        .be label {
          display: flex;
          flex-direction: column;
          gap: 5px;
          font-size: 12.5px;
          font-weight: 600;
          opacity: 0.85;
        }
        .be input {
          border: 1px solid var(--rd-hair);
          background: var(--rd-surface, transparent);
          color: var(--rd-ink);
          border-radius: 9px;
          padding: 9px 11px;
          font-size: 13.5px;
          font-weight: 500;
        }
        .be input:disabled {
          opacity: 0.55;
        }
        .hint {
          font-weight: 500;
          opacity: 0.55;
          font-size: 11.5px;
        }
        .be-actions {
          display: flex;
          justify-content: flex-end;
          gap: 8px;
          margin-top: 6px;
        }
        .be-actions button {
          border-radius: 9px;
          padding: 8px 16px;
          font-size: 13px;
          font-weight: 700;
          cursor: pointer;
          border: 1px solid var(--rd-hair);
          background: none;
          color: var(--rd-ink);
        }
        .be-actions button.accent {
          background: var(--rd-accent);
          color: var(--white);
          border-color: transparent;
        }
      `}</style>
    </div>
  );
}

function formatBrowserLogAction(action: string, ko: boolean): string {
  const labels: Record<string, [string, string]> = {
    "vault.save": ["사이트 저장", "Site saved"],
    "vault.delete": ["사이트 삭제", "Site removed"],
    "session.capture": ["세션 캡처", "Session captured"],
    "session.login_window": ["로그인 창 열림", "Sign-in window opened"],
    "session.login_window_blocked": ["로그인 창 차단", "Sign-in window blocked"],
    "session.login_window_failed": ["로그인 창 실패", "Sign-in window failed"],
    "session.mark": ["세션 상태 변경", "Session status changed"],
    send: ["메시지 전송", "Message sent"],
    publish: ["게시/공개", "Published"],
    post: ["게시", "Posted"],
    submit: ["제출", "Submitted"],
    delete: ["삭제", "Deleted"],
    payment: ["결제", "Payment"],
  };
  const hit = labels[action];
  if (hit) return ko ? hit[0] : hit[1];
  return humanizeBrowserCode(action);
}

function formatBrowserLogResult(result: string, ko: boolean): string {
  const labels: Record<string, [string, string]> = {
    ok: ["정상", "OK"],
    opened: ["열림", "Opened"],
    valid: ["유효", "Valid"],
    expired: ["만료", "Expired"],
    none: ["없음", "None"],
    auto: ["자동 승인", "Auto-approved"],
    blocked: ["차단됨", "Blocked"],
    approved: ["승인됨", "Approved"],
    denied: ["거부됨", "Denied"],
  };
  const hit = labels[result];
  if (hit) return ko ? hit[0] : hit[1];
  return humanizeBrowserCode(result);
}

function formatBrowserApproval(approval: string, ko: boolean): string {
  const labels: Record<string, [string, string]> = {
    once: ["한 번만", "Once"],
    always: ["항상 승인", "Always allow"],
    deny: ["거부", "Denied"],
  };
  const hit = labels[approval];
  if (hit) return ko ? hit[0] : hit[1];
  return humanizeBrowserCode(approval);
}

function humanizeBrowserCode(value: string): string {
  return value
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (m) => m.toUpperCase());
}
