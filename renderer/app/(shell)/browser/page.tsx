"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { CredentialImportDialog } from "@/components/connect/CredentialImportDialog";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { ChipGrid, ConnectChip } from "@/components/connect/RuntimeConnect";
import { ServiceConnectPopup, waitForConnectPoll, type ServiceConnectRun } from "@/components/connect/ServiceConnect";
import { IconLock } from "@/components/Icon";
import type { BrowserSessionProbeResult } from "@shared/browser-session-probe";
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
  const [connectingSite, setConnectingSite] = useState<BrowserSite | null>(null);
  const [probes, setProbes] = useState<Record<string, BrowserSessionProbeResult>>({});

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
    // A stored/imported session is never proof. Recheck registered sites using Main's read-only dedicated-browser probe.
    setProbes({});
    if (api.browser.probeSession) {
      const results = await Promise.all(ss.map(async (site) => ({ site: site.site, probe: await api.browser.probeSession(site.site).catch(() => null) })));
      setProbes(Object.fromEntries(results.flatMap(({ site, probe }) => probe ? [[site, probe]] : [])));
    }
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

  const connectSite = useCallback<ServiceConnectRun>(async (signal, update) => {
    if (!api || !connectingSite) throw new Error(ko ? "브라우저 연결을 사용할 수 없어요. (bridge_unavailable)" : "Browser connection is unavailable. (bridge_unavailable)");
    const probeSession = api.browser.probeSession;
    const check = async () => {
      if (!probeSession) return null;
      const probe = await probeSession(connectingSite.site);
      if (signal.aborted) throw new Error("cancelled");
      setProbes((previous) => ({ ...previous, [connectingSite.site]: probe }));
      return probe;
    };
    const initial = await check();
    if (initial?.state === "signed-in") return { evidence: [initial.evidence, `${initial.latencyMs}ms · ${new Date(initial.checkedAt).toLocaleTimeString()}`] };
    update({ step: "setup", note: ko ? "Agentlas 전용 브라우저를 준비하고 있어요." : "Preparing the dedicated Agentlas browser." });
    if (signal.aborted) throw new Error("cancelled");
    const opened = await api.browser.openLogin(connectingSite.site);
    if (signal.aborted) throw new Error("cancelled");
    if (!opened.ok) throw new Error(`${opened.error ?? (ko ? "로그인 창을 열지 못했어요." : "Could not open sign-in.")} (login_open_failed)`);
    update({ step: "login", note: ko ? "전용 브라우저에서 로그인 페이지를 열었어요. 로그인을 마치면 실제 상태를 확인해요." : "Opened sign-in in the dedicated browser. We will verify the live session after you sign in." });
    if (!probeSession) throw new Error(ko ? "로그인 페이지는 열었지만 실제 상태를 확인할 수 없어요. 연결 완료로 표시하지 않습니다. (probe_unavailable)" : "Sign-in opened, but the live session cannot be verified. (probe_unavailable)");
    for (let attempt = 0; attempt < 60; attempt += 1) {
      await waitForConnectPoll(signal);
      const result = await check();
      if (result?.state === "signed-in") return { evidence: [result.evidence, `${result.latencyMs}ms · ${new Date(result.checkedAt).toLocaleTimeString()}`] };
      update({ step: "login", note: ko ? "열린 브라우저에서 로그인을 마쳐 주세요. 실제 상태를 다시 확인하고 있어요." : "Finish sign-in in the opened browser. Rechecking the live session.", evidence: result ? [result.evidence] : [] });
      if (result?.state === "unverified") throw new Error(`${result.evidence} (${result.reasonCode ?? "probe_unavailable"})`);
    }
    throw new Error(ko ? "제한 시간 안에 로그인을 확인하지 못했어요. (login_timeout)" : "Sign-in was not verified in time. (login_timeout)");
  }, [api, connectingSite, ko]);

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
                  로그인은 사이트의 공식 화면에서 진행합니다. <b>사이트의 실제 로그인 화면</b>에서 직접
                  입력하고, 이후에는 전용 프로필의 로그인 세션만 재사용합니다.
                </>
              ) : (
                <>
                  Sign-in happens on the provider’s own page. Enter them directly on the <b>provider&apos;s sign-in
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
                {ko ? "연결" : "Connect"}
              </button>
            </div>
          )}
          <div className="sites-toolbar">
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
          <ChipGrid label={ko ? "사이트 연결" : "Site connections"}>
            <ConnectChip logo="/brand/browser/chrome.png" name="Chrome" sub={ko ? "선택한 로그인 쿠키 가져오기" : "Import selected sign-in cookies"} ready={false} badge={ko ? "선택 후 가져오기" : "Choose before import"} action={{ label: ko ? "연결" : "Connect", onClick: () => setImporting(true) }} />
            {sites.map((site) => {
              const probe = probes[site.site];
              const ready = probe?.state === "signed-in";
              return <ConnectChip key={site.id} icon={<IconLock size={26} />} name={site.label || site.site} sub={site.site}
                ready={ready} badge={ready ? (ko ? "연결됨" : "Connected") : probe?.state === "unverified" ? (ko ? "로그인 확인 불가" : "Sign-in unverified") : probe?.state === "signed-out" ? (ko ? "로그인 필요" : "Sign-in needed") : site.session.status === "valid" ? (ko ? "세션 있음 · 확인 필요" : "Session saved · unverified") : (ko ? "로그인 필요" : "Sign-in needed")}
                badgeTone={ready ? "ok" : undefined} facts={probe ? [probe.evidence, `${probe.latencyMs}ms · ${new Date(probe.checkedAt).toLocaleTimeString()}`] : []}
                action={{ label: ready ? (ko ? "다시 확인" : "Recheck") : (ko ? "연결" : "Connect"), onClick: () => setConnectingSite(site) }}
                secondaryActions={[{ label: ko ? "수정" : "Edit", onClick: () => setEditing(site) }, { label: ko ? "삭제" : "Remove", onClick: () => {
                  void api?.browser.deleteSite(site.site).then(() => { setProbes((previous) => { const next = { ...previous }; delete next[site.site]; return next; }); void refresh(); }).catch(() => flash(ko ? "삭제하지 못했어요. 다시 시도해 주세요." : "Could not remove this site. Retry."));
                } }]} />;
            })}
          </ChipGrid>
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

      {connectingSite && <ServiceConnectPopup name={connectingSite.label || connectingSite.site} icon={<IconLock size={28} />} ko={ko} run={connectSite}
        onClose={() => { setConnectingSite(null); void refresh(); }} onDone={() => { setConnectingSite(null); void refresh(); }} />}

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
            ? "저장 후 사이트 칩의 ‘연결’을 눌러 공식 페이지에서 로그인하세요. 이 화면에는 비밀번호를 입력하지 않습니다."
            : "After saving, click Connect on the site chip and sign in on the provider page. Do not enter passwords on this screen."}
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
