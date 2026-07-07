"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { ipc } from "@/lib/ipc";
import type { BrowserStatus, BrowserSite, BrowserActionLog } from "@/lib/types";

type Tab = "sites" | "logs";

export default function BrowserPage() {
  const [status, setStatus] = useState<BrowserStatus | null>(null);
  const [sites, setSites] = useState<BrowserSite[]>([]);
  const [logs, setLogs] = useState<BrowserActionLog[]>([]);
  const [tab, setTab] = useState<Tab>("sites");
  const [editing, setEditing] = useState<BrowserSite | "new" | null>(null);
  const [toast, setToast] = useState<string | null>(null);

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
    <div className="rd browser-root">
      <header className="browser-head">
        <div>
          <div className="browser-kicker">브라우저</div>
          <h1>로그인해 둔 사이트를 에이전트가 대신 조작해요</h1>
        </div>
        <button className="browser-btn ghost" onClick={() => void refresh()}>
          새로고침
        </button>
      </header>

      {/* 쉬운 설명 — 비개발자용 */}
      <section className="browser-explain">
        <p className="lead">
          Agentlas는 <b>전용 브라우저 프로필</b> 하나를 따로 만들어 씁니다. 여러분이 매일 쓰는 크롬은
          건드리지 않아요. 아래에서 사이트에 <b>한 번만 로그인</b>해 두면, 그 세션을 기억했다가
          에이전트가 그 자리에서 이어서 일합니다.
        </p>
        <ul className="browser-points">
          <li>
            <span className="dot ok" /> 여러분의 진짜 크롬·비밀번호는 그대로. 전용 프로필만 사용해요.
          </li>
          <li>
            <span className="dot ok" /> 비밀번호를 저장하면 <b>OS 금고(Keychain·Windows 자격증명)</b>에만
            암호화되어 들어갑니다. 화면·에이전트엔 절대 안 보여요.
          </li>
          <li>
            <span className="dot warn" /> 전송·게시·결제처럼 되돌릴 수 없는 행동은 <b>실행 전에 확인</b>을
            받아요. (결제는 매번, 나머지는 “항상 승인”을 기억)
          </li>
        </ul>
      </section>

      {/* 상태 */}
      <section className="browser-status">
        <div className="stat">
          <span className="stat-label">브라우저 감지</span>
          <span className={`stat-val ${status?.chromeFound ? "ok" : "err"}`}>
            {status ? (status.chromeFound ? "✓ Chrome 준비됨" : "✗ Chrome을 찾을 수 없음") : "확인 중…"}
          </span>
        </div>
        <div className="stat">
          <span className="stat-label">전용 프로필</span>
          <span className="stat-val mono">{status?.profilePath ?? "—"}</span>
        </div>
      </section>

      <nav className="browser-tabs">
        <button className={tab === "sites" ? "on" : ""} onClick={() => setTab("sites")}>
          사이트 ({sites.length})
        </button>
        <button className={tab === "logs" ? "on" : ""} onClick={() => setTab("logs")}>
          사용 기록
        </button>
      </nav>

      {tab === "sites" && (
        <section className="browser-sites">
          <div className="sites-toolbar">
            <button className="browser-btn accent" onClick={() => setEditing("new")}>
              + 사이트 추가
            </button>
          </div>
          {sites.length === 0 && (
            <div className="browser-empty">
              아직 등록한 사이트가 없어요. “사이트 추가”로 로그인해 둘 곳을 등록하세요.
            </div>
          )}
          <div className="sites-grid">
            {sites.map((s) => (
              <SiteCard
                key={s.id}
                site={s}
                onEdit={() => setEditing(s)}
                onLogin={async () => {
                  const r = await api?.browser.openLogin(s.site);
                  if (r?.ok) flash(`${s.site} 로그인 창을 열었어요. 로그인 후 창을 닫으면 저장됩니다.`);
                  else flash(r?.error ?? "로그인 창을 열지 못했어요.");
                }}
                onCaptured={async () => {
                  await api?.browser.markSession(s.site, "valid");
                  flash("로그인 세션을 저장했어요.");
                  void refresh();
                }}
                onDelete={async () => {
                  await api?.browser.deleteSite(s.site);
                  flash(`${s.site} 삭제됨`);
                  void refresh();
                }}
              />
            ))}
          </div>
        </section>
      )}

      {tab === "logs" && (
        <section className="browser-logs">
          {logsByDate.length === 0 && <div className="browser-empty">아직 기록이 없어요.</div>}
          {logsByDate.map(([day, items]) => (
            <div key={day} className="log-day">
              <div className="log-date">{day}</div>
              <ul>
                {items.map((l) => (
                  <li key={l.id}>
                    <span className="log-time">{l.ts.slice(11, 19)}</span>
                    <span className="log-action">{l.action}</span>
                    {l.site && <span className="log-site">{l.site}</span>}
                    {l.result && <span className={`log-result ${l.result}`}>{l.result}</span>}
                    {l.approval && <span className="log-approval">{l.approval}</span>}
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
            flash("저장했어요.");
            void refresh();
          }}
        />
      )}

      {toast && <div className="browser-toast">{toast}</div>}

      <style jsx>{`
        .browser-root {
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
        .dot {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          margin-top: 6px;
          flex-shrink: 0;
        }
        .dot.ok {
          background: var(--rd-ok, #22a06b);
        }
        .dot.warn {
          background: var(--rd-warn, #d98a00);
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
          color: var(--rd-ok, #22a06b);
        }
        .stat-val.err {
          color: var(--rd-err, #e5484d);
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
          color: var(--rd-accent-text, #fff);
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
          color: var(--rd-err, #e5484d);
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
  );
}

function SiteCard({
  site,
  onEdit,
  onLogin,
  onCaptured,
  onDelete,
}: {
  site: BrowserSite;
  onEdit: () => void;
  onLogin: () => void;
  onCaptured: () => void;
  onDelete: () => void;
}) {
  const st = site.session.status;
  const badge = st === "valid" ? "🟢 로그인됨" : st === "expired" ? "🟡 만료" : "⚪ 로그인 안 됨";
  return (
    <div className="sc">
      <div className="sc-main">
        <div className="sc-site">{site.label || site.site}</div>
        <div className="sc-sub">
          {site.site}
          {site.username ? ` · ${site.username}` : ""}
          {site.hasPassword ? " · 🔑 비번 저장됨" : ""}
        </div>
        <div className="sc-badge">
          {badge}
          {site.session.capturedAt ? ` · ${site.session.capturedAt.slice(0, 10)}` : ""}
        </div>
      </div>
      <div className="sc-actions">
        <button onClick={onLogin} title="전용 프로필로 로그인 창 열기">
          로그인 창
        </button>
        <button onClick={onCaptured} title="지금 로그인돼 있으면 세션 저장">
          세션 저장
        </button>
        <button onClick={onEdit}>수정</button>
        <button className="danger" onClick={onDelete}>
          삭제
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
        .sc-actions button.danger {
          color: var(--rd-err, #e5484d);
        }
      `}</style>
    </div>
  );
}

function SiteEditor({
  site,
  onClose,
  onSave,
}: {
  site: BrowserSite | null;
  onClose: () => void;
  onSave: (input: {
    site: string;
    label?: string | null;
    username?: string | null;
    password?: string | null;
  }) => void;
}) {
  const [siteAddr, setSiteAddr] = useState(site?.site ?? "");
  const [label, setLabel] = useState(site?.label ?? "");
  const [username, setUsername] = useState(site?.username ?? "");
  const [password, setPassword] = useState("");

  return (
    <div className="be-backdrop" onClick={onClose}>
      <div className="be" onClick={(e) => e.stopPropagation()}>
        <h2>{site ? "사이트 수정" : "사이트 추가"}</h2>
        <label>
          사이트 주소
          <input
            value={siteAddr}
            disabled={Boolean(site)}
            onChange={(e) => setSiteAddr(e.target.value)}
            placeholder="instagram.com"
          />
        </label>
        <label>
          이름(선택)
          <input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="인스타 계정" />
        </label>
        <label>
          아이디(선택)
          <input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="myid" />
        </label>
        <label>
          비밀번호(선택 · 자동 재로그인용)
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder={site?.hasPassword ? "•••••• (저장됨 — 바꿀 때만 입력)" : "세션 만료 시 자동 로그인"}
          />
          <span className="hint">비밀번호는 OS 금고에만 암호화 저장됩니다. 화면·에이전트엔 안 보여요.</span>
        </label>
        <div className="be-actions">
          <button className="ghost" onClick={onClose}>
            취소
          </button>
          <button
            className="accent"
            onClick={() =>
              onSave({
                site: siteAddr,
                label: label || null,
                username: username || null,
                password: password.length > 0 ? password : undefined,
              })
            }
          >
            저장
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
          z-index: 70;
        }
        .be {
          width: min(440px, 92vw);
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
          color: var(--rd-accent-text, #fff);
          border-color: transparent;
        }
      `}</style>
    </div>
  );
}
