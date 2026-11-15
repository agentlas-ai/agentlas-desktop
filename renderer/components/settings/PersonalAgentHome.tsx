"use client";

/**
 * Settings > Personal agent: Home, Trusted devices, Sign in again (F-D15; pictures desktop-move-pieces C, desktop-home-trust I / L / V).
 * Reads `oneHome.status()` only; every button is a REQUEST the app confirms itself (the number and the final yes live in the Main-owned
 * confirm window, never here). Draws nothing when `available` is false (the server switch is closed or the pointer was never read).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { IconAlertTriangle, IconCloud, IconHome, IconMonitor, IconSmartphone, IconClock } from "@/components/Icon";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { type Lang } from "@/lib/one-home-copy";
import { deviceRows, homeKindOf, pendingOf, pendingParts, remainingOf, type DeviceRow } from "@/lib/one-home-view";
import { useHomeActions, useOneHome } from "@/lib/use-one-home";
import { Btn, dayLabel, ReauthRow, RefusalNote } from "@/components/one/OneHomeParts";
import s from "@/components/one/OneHome.module.css";

/** Whether the Personal agent section exists at all (the settings nav asks this one question). */
export function useOneHomeAvailable(): boolean {
  const { status } = useOneHome();
  return Boolean(status?.available);
}

export function PersonalAgentHome() {
  const { locale } = useT();
  const lang: Lang = locale === "ko" ? "ko" : "en";
  const ko = lang === "ko";
  const { status, reload } = useOneHome();
  const actions = useHomeActions(reload, status?.pendingReauth?.actionId ?? null);
  const [gotIt, setGotIt] = useState<Set<string>>(new Set());
  const [requested, setRequested] = useState<string | null>(null);
  const rows = useMemo(() => (status ? deviceRows(status) : []), [status]);
  const shown = useRef<string>("");
  // The screen really showed these new devices: only then does the computer tell the server "seen" (oneHome:noticeShown).
  const newKids = rows.filter((r) => r.state === "new" && r.kid && !gotIt.has(r.kid)).map((r) => r.kid as string);
  useEffect(() => {
    const key = newKids.join(",");
    if (!key || shown.current === key) return;
    shown.current = key;
    void Promise.resolve(ipc()?.oneHome?.noticeShown?.({ ids: newKids.slice(0, 6) })).catch(() => {});
  });
  if (!status?.available) return null;
  const api = ipc()!.oneHome;
  const kind = homeKindOf(status);
  const nowMs = Date.now() + (typeof status.clockOffsetMs === "number" ? status.clockOffsetMs : 0);   // counted by the server's clock, so a wrong clock on this desktop does not move "N days left"
  const pointerHome = status.pointer?.home;
  const homeName = status.homeLabel ?? (pointerHome && pointerHome.kind === "desktop" ? pointerHome.label ?? null : null);
  const origins = (status.leftover?.receiver?.origins ?? []) as Array<{ computer?: string; lines?: number }>;
  const mergedLines = origins.reduce((sum, o) => sum + (typeof o.lines === "number" ? o.lines : 0), 0);
  const press = (label: string, fn: () => Promise<{ ok: boolean; code?: string; detail?: string; count?: number; actionId?: string; requestId?: string } | null | undefined>) => {
    setRequested(null);
    void actions.press(label, async () => { const out = await fn(); if (out?.ok && out.requestId) setRequested(label); return out; });
  };

  // One short line under the value, and only when there is something to say; a value the status does not carry draws no part of it (picture AO for the connected desktop, AR for the desktop the connection was changed away from).
  const pend = pendingOf(status);
  const parts = pend ? pendingParts(pend, lang, nowMs) : null;
  const pendingSub = parts ? [parts.since, parts.left].filter(Boolean).join(" · ") : "";
  const urgent = parts?.urgent === true;   // the last 7 days: the caution icon (and the owner is told once on that day, by Main)
  const homeTitle: Record<string, string> = {
    server: ko ? "없음 · 서버에서 실행 중" : "None · running on the server",
    moving: ko ? "이 데스크탑으로 연결 변경 중" : "Moving to this desktop",
    home: ko ? "이 데스크탑" : "This desktop",
    unconfirmed: ko ? "이 데스크탑 · 확인 대기" : "This desktop · Not confirmed",   // an unconfirmed home is always this desktop (homeKindOf: state "home")
    sealed: ko ? `연결 변경 중${homeName ? ` · ${homeName}` : ""}` : `Moving away${homeName ? ` · ${homeName}` : ""}`,
    away: pend ? `${homeName ?? (ko ? "다른 데스크탑" : "Another desktop")} · ${ko ? "확인 대기" : "Not confirmed"}` : homeName ?? (ko ? "다른 데스크탑" : "Another desktop"),
    elsewhere: homeName ?? (ko ? "다른 데스크탑" : "Another desktop"),
  };
  const homeSub: Record<string, string> = {
    away: ko ? "이 데스크탑의 이전 대화는 읽기 전용" : "Earlier chats on this desktop are read-only",
    sealed: ko ? "새 데스크탑이 수신할 때까지 사용 불가" : "Unavailable until the new desktop receives it",
  };
  const icon = kind === "server" ? <IconCloud size={20} /> : <IconHome size={20} />;
  const sub = pendingSub || homeSub[kind] || "";

  return (
    <section className={s.section} data-personal-agent-home="true" data-home-kind={kind}>
      <h2 className={s.h2}>{ko ? "연결된 데스크탑" : "Connected desktop"}</h2>
      <div className={s.rows}>
        <div className={s.row} data-plain="true">
          <p className={s.rowLabel}>{ko ? "현재 연결" : "Connected now"}</p>
          <div>
            <p className={s.rowTitle}>{icon} {homeTitle[kind]}</p>
            {sub ? <p className={s.rowSub}>{urgent ? <span className={s.warnIcon} aria-hidden="true"><IconAlertTriangle size={14} /></span> : null}{sub}</p> : null}
          </div>
          <div className={s.actions}>
            {kind === "server" && <Btn kind="primary" disabled={Boolean(actions.busy)} onClick={() => press("startMoveHere", () => api.startMoveHere())}>{ko ? "이 데스크탑에 연결" : "Connect here"}</Btn>}
            {(kind === "away" || kind === "elsewhere") && !(pend && kind === "away") && <Btn disabled={Boolean(actions.busy)} onClick={() => press("startHere", () => api.startHere())}>{ko ? "이 데스크탑에 연결" : "Connect here"}</Btn>}
            {kind === "away" && pend && <Btn disabled={Boolean(actions.busy)} onClick={() => press("revertHome", () => api.revertHome())}>{ko ? "복원" : "Revert"}</Btn>}
            {kind === "unconfirmed" && <>
              {pend?.revert !== "no" && <Btn disabled={Boolean(actions.busy)} onClick={() => press("revertHome", () => api.revertHome())}>{ko ? "복원" : "Revert"}</Btn>}
              {pend?.confirm !== "no" && <Btn kind="primary" disabled={Boolean(actions.busy)} onClick={() => press("confirmHome", () => api.confirmHome())}>{ko ? "본인이에요" : "Yes, it was me"}</Btn>}
            </>}
          </div>
        </div>
        {mergedLines > 0 && (
          <div className={s.row} data-plain="true">
            <p className={s.rowLabel}>{ko ? "다른 데스크탑에서" : "From other desktops"}</p>
            <div>
              <p className={s.rowTitle}>{ko ? `병합됨 · 기억 ${mergedLines}개` : `Merged · ${mergedLines} memories`}</p>
              <p className={s.rowSub}>{origins.map((o) => o.computer).filter(Boolean).join(", ")}</p>
            </div>
            <span />
          </div>
        )}
        {kind === "home" && (<>
          {/* PR-D2: drawn only while the server holds this desktop's profile (the server answers for it only then); until then no promise is made */}
          {(status.mirror as { profile?: unknown } | null | undefined)?.profile === "up" && (
            <div className={s.row} data-plain="true" data-server-answers="true">
              <p className={s.rowLabel}>{ko ? "데스크탑 종료 시" : "When this desktop is off"}</p>
              <p className={s.rowTitle} style={{ fontWeight: 500 }}>{ko ? "서버가 대신 응답하고, 데스크탑이 켜지면 대화를 가져와요." : "The server answers, and the chat is brought back when the desktop is on."}</p>
              <span />
            </div>
          )}
          <div className={s.row} data-plain="true">
            <p className={s.rowLabel}>{ko ? "연결 변경" : "Change"}</p>
            <p className={s.rowSub} style={{ margin: 0 }}>{ko ? "새 데스크탑에서 로그인한 뒤 [이 데스크탑에 연결]을 선택해 주세요." : "Sign in on the new desktop and choose [Connect here]."}</p>
            <span />
          </div>
        </>)}
      </div>
      <div className={s.stack} style={{ marginTop: 12 }}>
        <RefusalNote line={actions.line} lang={lang} />
        <ReauthRow actions={actions} lang={lang} />
        {requested && !actions.line && !actions.reauthCode && (
          <div className={s.note} role="status" data-one-home-requested={requested}><span className={s.noteIcon} aria-hidden="true"><IconClock size={15} /></span><span>{ko ? "확인 창에서 계속해 주세요." : "Continue in the confirm window."}</span><span /></div>
        )}
      </div>

      <h2 className={s.h2} style={{ marginTop: 32 }}>{ko ? "신뢰하는 기기" : "Trusted devices"}</h2>
      {rows.filter((r) => r.state === "new" && !(r.kid && gotIt.has(r.kid))).map((r) => (
        <DeviceItem key={r.key} row={r} lang={lang} busy={Boolean(actions.busy)} nowMs={nowMs}
          onRevoke={(kid) => press("requestRevokeKey", () => api.requestRevokeKey({ kid }))}
          onTrust={(deviceId) => press("requestTrustPhone", () => api.requestTrustPhone({ deviceId }))}
          onGotIt={(kid) => setGotIt((prev) => new Set(prev).add(kid))} />
      ))}
      {(["desktop", "server"] as const).map((g) => {
        const list = rows.filter((r) => r.state !== "new" && r.group === g);
        if (list.length === 0) return null;
        return (
          <div key={g} data-device-group={g}>
            <h3 className={s.groupHead}>{g === "desktop" ? (ko ? "데스크탑 작업 가능" : "Can work on the desktop") : (ko ? "서버 작업만 가능" : "Server work only")}
              <small>{g === "desktop" ? (ko ? "작업 지시 · 승인" : "give work · approve") : (ko ? "서버 대화 · 연결 앱 승인" : "server chats · approve connected apps")}</small></h3>
            <div className={s.rows}>
              {list.map((r) => (
                <DeviceItem key={r.key} row={r} lang={lang} busy={Boolean(actions.busy)} nowMs={nowMs} sameDay={sharesDay(rows, r, lang, nowMs)}
                  onRevoke={(kid) => press("requestRevokeKey", () => api.requestRevokeKey({ kid }))}
                  onTrust={(deviceId) => press("requestTrustPhone", () => api.requestTrustPhone({ deviceId }))}
                  onGotIt={(kid) => setGotIt((prev) => new Set(prev).add(kid))} />
              ))}
            </div>
          </div>
        );
      })}
    </section>
  );
}

/** "11/2" -> "11/2 14:02" when the row needs it (a day label that already has the time, "today 14:02", is left as it is). */
function withTime(label: string | null, ms: number | null, lang: Lang, need: boolean): string | null {
  if (!label || !need || !ms || /\d:\d\d/.test(label)) return label;
  return `${label} ${new Date(ms).toLocaleTimeString(lang === "ko" ? "ko-KR" : "en-US", { hour: "2-digit", minute: "2-digit", hour12: false })}`;
}
/** True when another row has the same name and the same drawn day (so the day alone would not tell them apart). */
function sharesDay(rows: DeviceRow[], row: DeviceRow, lang: Lang, nowMs: number): boolean {
  if (!row.dateMs || !row.name) return false;
  const mine = dayLabel(row.dateMs, lang, nowMs);
  return rows.some((r) => r !== row && r.kind !== "this" && r.name === row.name && !!r.dateMs && dayLabel(r.dateMs, lang, nowMs) === mine);
}

function DeviceItem({ row, lang, busy, nowMs, sameDay, onRevoke, onTrust, onGotIt }: { row: DeviceRow; lang: Lang; busy: boolean; nowMs: number; sameDay?: boolean; onRevoke: (kid: string) => void; onTrust: (deviceId: string) => void; onGotIt: (kid: string) => void }) {
  const ko = lang === "ko";
  const icon = row.kind === "this" || row.kind === "desktop" ? <IconMonitor size={18} /> : <IconSmartphone size={18} />;
  if (row.kind === "this") {
    return (
      <div className={s.row}>
        <span className={s.rowIcon}><IconHome size={18} /></span>
        <div><p className={s.rowTitle}>{ko ? "이 데스크탑" : "This desktop"}</p><p className={s.rowSub}>{row.home ? (ko ? "연결된 데스크탑" : "Connected desktop") : (ko ? "연결된 데스크탑 아님" : "Not the connected desktop")}</p></div>
        <span />
      </div>
    );
  }
  const label = row.name || (row.kind === "desktop" ? (ko ? "데스크탑" : "Desktop") : (ko ? "폰" : "Phone"));
  if (row.state === "new") {
    const left = remainingOf(row.matureAtMs ?? null, nowMs);
    const when = dayLabel(row.registeredAtMs, lang, nowMs);
    const parts = [ko ? "신규 기기" : "New device", row.kind === "desktop" ? (ko ? "데스크탑" : "desktop") : (ko ? "폰" : "phone"), when ? (ko ? `${when} 등록` : `registered ${when}`) : null,
      left ? (ko ? `${left.days > 0 ? `${left.days}일` : `${Math.max(1, left.hours)}시간`} 후 자동 등록` : `joins in ${left.days > 0 ? `${left.days} day${left.days > 1 ? "s" : ""}` : `${Math.max(1, left.hours)} hour${left.hours > 1 ? "s" : ""}`}`) : null].filter(Boolean);
    return (
      <div className={s.row} data-new-device="true" style={{ borderRadius: 12, border: "1px solid var(--paper-edge)", padding: "16px 18px", margin: "10px 0" }}>
        <span className={s.rowIcon}>{icon}</span>
        <div><p className={s.rowTitle}>{label}</p><p className={s.rowSub}>{parts.join(" · ")}</p></div>
        <div className={s.actions}>
          <Btn disabled={busy} onClick={() => row.kid && onRevoke(row.kid)}>{ko ? "본인 기기가 아니에요" : "Not my device"}</Btn>
          <Btn kind="primary" onClick={() => row.kid && onGotIt(row.kid)}>{ko ? "확인" : "OK"}</Btn>
        </div>
      </div>
    );
  }
  if (row.revoking) {
    // The owner confirmed this cut; the server has not taken it yet and Main cuts it when the server answers. No button: nothing is left to press.
    return (
      <div className={s.row} data-device-state="revoking">
        <span className={s.rowIcon}>{icon}</span>
        <div><p className={s.rowTitle}>{label}</p><p className={s.rowSub}>{ko ? "해제 중 · 서버 연결 대기" : "Disconnecting · waiting for the server"}</p></div>
        <div className={s.actions} />
      </div>
    );
  }
  // Two devices with the same name drawn for the same day (pairing records of one phone model all carry the same name): the time of day tells them apart, from the date this row already has.
  const when = withTime(dayLabel(row.dateMs ?? null, lang, nowMs), row.dateMs ?? null, lang, sameDay === true);
  const how = row.how === "qr" ? (ko ? "QR 연결" : "Paired by QR") : row.how === "confirmed" ? (ko ? "이 데스크탑에서 확인" : "Confirmed on this desktop") : row.how === "direct" ? (ko ? "직접 등록" : "Self-registered") : null;
  // A device that cannot get a number (it has to pair by QR again) says how it becomes able to do desktop work, and has no button.
  const needsQr = row.state === "register_first" || row.state === "pair_again";
  const keyless = row.how === "direct" && !row.kid;   // no registered security key: nothing was "registered directly"
  // Another desktop's key line: its kind and the day it was registered ("Desktop · registered 10/28").
  const other = row.kind === "desktop" ? [ko ? "데스크탑" : "Desktop", when ? (ko ? `${when} 등록` : `registered ${when}`) : null] : null;
  const sub = (other ?? [keyless && needsQr ? null : how, when, needsQr ? (ko ? "QR 재연결 시 데스크탑 작업 가능" : "pair by QR to allow desktop work") : null]).filter(Boolean).join(" · ");
  return (
    <div className={s.row} data-device-state={row.state}>
      <span className={s.rowIcon}>{icon}</span>
      <div><p className={s.rowTitle}>{label}</p><p className={s.rowSub}>{sub}</p></div>
      <div className={s.actions}>
        {row.state === "press" && row.deviceId && <Btn disabled={busy} onClick={() => onTrust(row.deviceId as string)}>{ko ? "데스크탑 작업 허용" : "Allow desktop work"}</Btn>}
        {row.kid && <Btn disabled={busy} onClick={() => onRevoke(row.kid as string)}>{ko ? "연결 해제" : "Disconnect"}</Btn>}
      </div>
    </div>
  );
}
