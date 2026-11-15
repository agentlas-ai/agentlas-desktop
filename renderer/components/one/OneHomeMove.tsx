"use client";

/**
 * The personal agent's move, as cards (F-D16; pictures desktop-move-pieces A / B, desktop-home-trust M-U, desktop-final-pieces B / C, -2 G).
 * `OneHomeMoveCards` draws the cards that apply to this computer right now; `OneHomeLockGate` swaps the composer for the "you can type again" bar
 * while this computer's own move runs. Both read `oneHome.status()` (on open, on focus, after the owner's own press: no timer) and every button
 * is a REQUEST: the number to compare and the final yes live in the Main-owned confirm window. A value the status does not carry is not drawn.
 * Draws nothing when the server switch is closed (`available: false`), so the old screens are unchanged.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconCheck, IconClose, IconClock, IconCloud, IconHome, IconLock, IconMail, IconShield, IconAlertTriangle } from "@/components/Icon";
import { OneAgentPortrait } from "@/components/one/OneAgentPortrait";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { ANSWER_CLOSE, ANSWER_DONE, ANSWER_OPEN, COUNT_LABELS, ENDED, josaEul, josaIga, STOPPED_GENERIC, t2, WAITING, WAITING_GENERIC, type Lang } from "@/lib/one-home-copy";
import { cancellableStep, homeKindOf, pendingOf, pendingParts, remainingOf, stepProgress, toMs } from "@/lib/one-home-view";
import { useAgentName, useHomeActions, useOneHome } from "@/lib/use-one-home";
import { Btn, ReauthRow, RefusalNote } from "@/components/one/OneHomeParts";
import s from "./OneHome.module.css";

const SEEN_MOVE_KEY = "agentlas.oneHome.moveSeen";      // the `lastMove.at` the owner closed (one value, overwritten by the next move)
const LEFTOVER_KEY = "agentlas.oneHome.leftoverAnswered"; // the home epoch whose "send the old chats?" question the owner declined (one value)
const readKey = (k: string): string | null => { try { return window.localStorage.getItem(k); } catch { return null; } };
const writeKey = (k: string, v: string) => { try { window.localStorage.setItem(k, v); } catch { /* the card simply shows again */ } };

/**
 * the completion card of the owner's own successful [Revert] / [This wasn't me] (`status.ownerAnswer`, a Main memory value). It is drawn once per answer: the id of the answer already drawn is kept for this window
 * (session storage, nothing durable), so a screen opened later does not draw it again; [x] closes it at once. A later answer replaces an earlier one that is still on screen.
 */
const ANSWER_DRAWN_KEY = "agentlas.oneHome.answerDrawn";
let answerDrawn = 0;
const readDrawn = (): number => { try { return Math.max(answerDrawn, Number(window.sessionStorage.getItem(ANSWER_DRAWN_KEY)) || 0); } catch { return answerDrawn; } };
const writeDrawn = (id: number): void => { answerDrawn = Math.max(answerDrawn, id); try { window.sessionStorage.setItem(ANSWER_DRAWN_KEY, String(answerDrawn)); } catch { /* the module value still holds */ } };

function leftIn(untilMs: number | null, lang: Lang, nowMs: number): string | null {
  const r = remainingOf(untilMs, nowMs);
  if (!r) return null;
  const d = r.days, h = r.hours;
  if (lang === "ko") return d > 0 ? `${d}일 ${h}시간 남음` : h > 0 ? `${h}시간 남음` : "1시간 안에";
  return d > 0 ? `${d} day${d > 1 ? "s" : ""} ${h} hour${h === 1 ? "" : "s"} left` : h > 0 ? `${h} hour${h === 1 ? "" : "s"} left` : "under an hour";
}

function Card({ icon, title, meta, children, actions, kind }: { icon: ReactNode; title: ReactNode; meta?: ReactNode; children?: ReactNode; actions?: ReactNode; kind: string }) {
  return (
    <article className={s.card} data-one-home-card={kind}>
      <div className={s.cardHead}><h3 className={s.cardTitle}><span aria-hidden="true">{icon}</span>{title}</h3>{meta ? <span className={s.cardMeta}>{meta}</span> : null}</div>
      {children}
      {actions ? <div className={s.cardActions}>{actions}</div> : null}
    </article>
  );
}

export function OneHomeMoveCards({ className }: { className?: string }) {
  const { locale } = useT();
  const lang: Lang = locale === "ko" ? "ko" : "en";
  const ko = lang === "ko";
  const name = useAgentName(ko);
  const { status, reload } = useOneHome();
  const actions = useHomeActions(reload, status?.pendingReauth?.actionId ?? null);
  const [requested, setRequested] = useState<string | null>(null);
  const [blankCount, setBlankCount] = useState<number | null>(null);
  const [closedBlocked, setClosedBlocked] = useState(false);
  const [moveSeen, setMoveSeen] = useState<string | null>(null);
  const [leftoverDone, setLeftoverDone] = useState<string | null>(null);
  const shown = useRef("");
  const [answerCard, setAnswerCard] = useState<{ id: number; kind: "restored" | "declined"; accountUrl?: string } | null>(null);
  const answer = status?.ownerAnswer ?? null;
  useEffect(() => {
    if (!status?.available || !answer || answer.id <= readDrawn()) return;
    writeDrawn(answer.id);   // drawn now: the next screen that opens does not draw it again
    setAnswerCard({ id: answer.id, kind: answer.kind, ...(answer.accountUrl ? { accountUrl: answer.accountUrl } : {}) });
  }, [answer?.id, status?.available]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { setMoveSeen(readKey(SEEN_MOVE_KEY)); setLeftoverDone(readKey(LEFTOVER_KEY)); }, []);

  // The screen really showed these claims to the owner: only that makes the computer say "seen" (oneHome:noticeShown).
  const claims = (status?.pointer?.claims ?? []) as Array<Record<string, unknown>>;
  const theirClaims = claims.filter((c) => typeof c.claimId === "string" && (c.to as { hostId?: string } | undefined)?.hostId !== status?.hostId);
  const myClaim = claims.find((c) => (c.to as { hostId?: string } | undefined)?.hostId === status?.hostId && status?.hostId) ?? null;
  const claimIds = theirClaims.map((c) => c.claimId as string).slice(0, 6);
  useEffect(() => {
    const key = claimIds.join(",");
    if (!key || shown.current === key) return;
    shown.current = key;
    void Promise.resolve(ipc()?.oneHome?.noticeShown?.({ ids: claimIds })).catch(() => {});
  });
  if (!status?.available) return null;
  const api = ipc()!.oneHome;
  const kind = homeKindOf(status);
  const nowMs = Date.now();
  const busy = Boolean(actions.busy);
  const press = (label: string, fn: () => Promise<{ ok: boolean; code?: string; detail?: string; count?: number; actionId?: string; requestId?: string } | null | undefined>) => {
    setRequested(null);
    void actions.press(label, async () => { const out = await fn(); if (out?.ok && out.requestId) setRequested(label); return out; });
  };
  const waitingNote = requested && !actions.line && !actions.reauthCode
    ? <div className={s.note} role="status" data-one-home-requested={requested}><span className={s.noteIcon} aria-hidden="true"><IconClock size={15} /></span><span>{ko ? "확인 창에서 계속해 주세요." : "Continue in the confirm window."}</span><span /></div> : null;

  const cards: ReactNode[] = [];
  const move = status.move;
  const pm = status.pointerMove;
  const cap = (x: string) => (x ? x[0].toUpperCase() + x.slice(1) : x);

  // ── this computer receives (picture desktop-final-pieces B; Q count check; stopped T) ──
  if (move?.role === "receiver" && kind !== "unconfirmed") {   // a move that only waits for the owner's confirmation is the unconfirmed card below, not a moving card with no button
    const pr = stepProgress(move);
    const ask = move.blankAsk ? (blankCount ?? move.blankAsk.count) : null;
    if (ask !== null) {
      cards.push(
        <Card key="blank" kind="blank-ask" icon={<IconCloud size={17} />} title={ko ? "삭제할 기억 확인" : "Check before removing"} meta={pr ? `${pr.n} / ${pr.total}` : undefined}
          actions={<>
            <Btn disabled={busy} onClick={() => press("cancelMove", () => api.cancelMove())}>{ko ? "취소" : "Cancel"}</Btn>
            <Btn kind="primary" disabled={busy} onClick={() => press("confirmBlank", async () => { const out = await api.confirmBlank({ count: ask }); if (out?.code === "count_changed" && typeof out.count === "number") setBlankCount(out.count); return out; })}>{ko ? `${ask}개 삭제 후 계속` : `Remove ${ask} and continue`}</Btn>
          </>}>
          <div className={s.count}><strong>{ask}</strong><span className={s.cardBody}>{ko ? `이 데스크탑의 기억 ${ask}개가 삭제돼요.` : `${ask} memories on this desktop will be removed.`}</span></div>
          {blankCount !== null && blankCount !== move.blankAsk?.count && <p className={s.cardBody}>{ko ? "개수가 변경됐어요." : "The number changed."}</p>}
        </Card>,
      );
    } else {
      const waiting = move.waiting;
      cards.push(
        <Card key="moving" kind="moving" icon={<IconCloud size={17} />} title={ko ? `${name}${josaEul(name)} 이 데스크탑으로 연결 변경 중` : `Moving ${name} to this desktop`} meta={pr ? `${pr.n} / ${pr.total}` : undefined}
          actions={<>
            {waiting === "home_key_changed" && <Btn disabled={busy} onClick={() => press("acceptHomeKey", () => api.acceptHomeKey())}>{ko ? "새 보안 키 수락" : "Accept the new security key"}</Btn>}
            {cancellableStep(move) && <Btn disabled={busy} onClick={() => press("cancelMove", () => api.cancelMove())}>{ko ? "취소" : "Cancel"}</Btn>}
          </>}>
          {pr && <div className={s.bar} role="progressbar" aria-valuemin={0} aria-valuemax={pr.total} aria-valuenow={pr.n}><i style={{ width: `${Math.round((pr.n / pr.total) * 100)}%` }} /></div>}
          <p className={s.cardBody}>{waiting ? t2(lang, WAITING[waiting] ?? WAITING_GENERIC) : (ko ? "대화와 기억 이동 중" : "Moving chats and memory")}</p>
        </Card>,
      );
    }
  }

  // ── the home computer is asked (M) ──
  const asked = kind === "home" && !move && pm && pm.to && !pm.approved && !pm.expired;
  if (asked || (move?.role === "sender" && move.step === "asked")) {
    const label = pm?.to?.label;
    const left = leftIn(toMs(pm?.expiresAt), lang, nowMs);
    cards.push(
      <Card key="asked" kind="move-request" icon={<IconCloud size={17} />} title={label ? (ko ? `${label}에서 연결 변경을 요청했어요` : `${label} asks to move here`) : (ko ? "다른 데스크탑에서 연결 변경을 요청했어요" : "Another desktop asks to move here")} meta={left}
        actions={<>
          <Btn disabled={busy} onClick={() => press("declineMove", () => api.declineMove())}>{ko ? "본인이 아니에요" : "This wasn't me"}</Btn>
          <Btn kind="primary" disabled={busy} onClick={() => press("approveMove", () => api.approveMove())}>{ko ? "번호 확인" : "Check the number"}</Btn>
        </>}>
        <p className={s.cardBody}>{ko ? `승인하면 ${name}${josaIga(name)} 그 데스크탑에 연결돼요.` : `If approved, ${name} is connected to that desktop.`}</p>
      </Card>,
    );
  } else if (move?.role === "sender" || kind === "sealed") {
    const waiting = move?.waiting;
    cards.push(
      <Card key="sending" kind="sending" icon={<IconCloud size={17} />} title={ko ? `${name}${josaEul(name)} 다른 데스크탑으로 연결 변경 중` : `Moving ${name} to another desktop`}>
        <p className={s.cardBody}>{waiting ? t2(lang, WAITING[waiting] ?? WAITING_GENERIC) : (ko ? "새 데스크탑이 수신할 때까지 사용 불가" : "Unavailable until the new desktop receives it")}</p>
      </Card>,
    );
  }

  // ── another computer wants to become the home, shown on a trusted device (O) ──
  for (const c of theirClaims) {
    const label = (c.to as { label?: string } | undefined)?.label;
    const left = leftIn(toMs(c.matureAt), lang, nowMs);
    const claimId = c.claimId as string;
    cards.push(
      <Card key={"claim-" + claimId} kind="claim" icon={<IconCloud size={17} />} title={label ? (ko ? `${label}에서 연결 변경을 요청했어요` : `${label} asks to move here`) : (ko ? "다른 데스크탑에서 연결 변경을 요청했어요" : "Another desktop asks to move here")} meta={left ? (ko ? left.replace("남음", "뒤") : `in ${left.replace(" left", "")}`) : undefined}
        actions={<>
          <Btn disabled={busy} onClick={() => press("rejectClaim", () => api.rejectClaim({ claimId }))}>{ko ? "본인이 아니에요" : "This wasn't me"}</Btn>
          <Btn kind="primary" disabled={busy} onClick={() => press("approveClaim", () => api.approveClaim({ claimId }))}>{ko ? "번호 확인" : "Check the number"}</Btn>
        </>}>
        <p className={s.cardBody}>{ko ? "대기 기간이 지나면 자동으로 변경돼요." : "It changes by itself after the wait."}</p>
      </Card>,
    );
  }

  // ── this computer asked to become the home and waits (N) ──
  if (myClaim && kind !== "home") {
    const mature = toMs(myClaim.matureAt), created = toMs(myClaim.createdAt);
    const left = remainingOf(mature, nowMs);
    const frac = mature && created && mature > created ? Math.min(1, Math.max(0, (nowMs - created) / (mature - created))) : null;
    const tried = myClaim.noticeTry as { mail?: string } | undefined;
    cards.push(
      <Card key="my-claim" kind="my-claim" icon={<IconClock size={17} />} title={left ? (ko ? `${left.days > 0 ? `${left.days}일` : `${Math.max(1, left.hours)}시간`} 뒤 이 데스크탑으로 연결이 변경돼요` : `This desktop is connected in ${left.days > 0 ? `${left.days} day${left.days > 1 ? "s" : ""}` : `${Math.max(1, left.hours)} hour${left.hours > 1 ? "s" : ""}`}`) : (ko ? "이 데스크탑으로 연결 변경 대기 중" : "Waiting to be connected")} meta={leftIn(mature, lang, nowMs) ?? undefined}
        actions={<Btn kind="primary" disabled={busy} onClick={() => press("requestShowCode", () => api.requestShowCode())}>{ko ? "확인 번호 보기" : "Show the number"}</Btn>}>
        {frac !== null && <div className={s.bar} aria-hidden="true"><i style={{ width: `${Math.round(frac * 100)}%` }} /></div>}
        <p className={s.cardBody}>{ko ? "폰이나 연결된 데스크탑에서 확인하면 바로 변경돼요." : "Confirming on your phone or the connected desktop changes it at once."}</p>
        {myClaim.noticeVia === "mail" && <div className={s.note}><span className={s.noteIcon}><IconMail size={15} /></span><span>{ko ? "계정 주소로 메일을 보냈어요." : "We emailed the address on your account."}</span><span /></div>}
        {tried?.mail && myClaim.noticeOk !== true && <div className={s.note}><span className={s.noteIcon}><IconMail size={15} /></span><span>{ko ? "메일을 보내지 못했어요." : "The email could not be sent."}</span><span /></div>}
      </Card>,
    );
  }

  // ── a home that waited its way in: nobody confirmed it (P steps 1-2; picture AP). One card for every way in: while the move of this desktop only waits for the owner's answer it is the same card (the body says what comes after it) ──
  if (kind === "unconfirmed") {
    const pend = pendingOf(status);
    const serverNow = nowMs + (typeof status.clockOffsetMs === "number" ? status.clockOffsetMs : 0);   // counted by the server's clock, like the settings line
    const parts = pend ? pendingParts(pend, lang, serverNow) : null;
    const line = pend?.importWait === "server" ? (ko ? "확정 후 서버의 대화와 기억을 가져와요." : "Chats and memory on the server are brought here once you confirm.") : [ko ? "확인 대기" : "Not confirmed", parts?.left].filter(Boolean).join(" · ");
    cards.push(
      <Card key="unconfirmed" kind="unconfirmed" icon={parts?.urgent ? <span className={s.warnIcon}><IconAlertTriangle size={17} /></span> : <IconShield size={17} />} title={ko ? "이 데스크탑으로 연결이 변경됐어요" : "Connection changed to this desktop"}
        actions={pend && pend.revert === "no" && pend.confirm === "no" ? undefined : <>
          {pend?.revert !== "no" && <Btn disabled={busy} onClick={() => press("revertHome", () => api.revertHome())}>{ko ? "복원" : "Revert"}</Btn>}
          {pend?.confirm !== "no" && <Btn kind="primary" disabled={busy} onClick={() => press("confirmHome", () => api.confirmHome())}>{ko ? "본인이에요" : "Yes, it was me"}</Btn>}
        </>}>
        <p className={s.cardBody}>{line}</p>
        {pend && pend.revert === "no" && pend.confirm === "no" && <p className={s.cardBody}>{ko ? "이전 데스크탑이나 신뢰하는 기기에서 확인해 주세요." : "Confirm it on the previous desktop or a trusted device."}</p>}
      </Card>,
    );
  }

  // ── the owner answered a request or a change: the card of the place the unconfirmed / request card was, below any request card that is still waiting ──
  if (answerCard) {
    const words = ANSWER_DONE[answerCard.kind];
    const url = answerCard.accountUrl;
    cards.push(
      <Card key="answer-done" kind={"answer-" + answerCard.kind} icon={<IconShield size={17} />} title={t2(lang, words.title)}
        meta={<button type="button" className={s.cardClose} aria-label={t2(lang, ANSWER_CLOSE)} onClick={() => setAnswerCard(null)}><IconClose size={15} /></button>}
        actions={url ? <Btn onClick={() => { window.open(url, "_blank", "noopener,noreferrer"); }}>{t2(lang, ANSWER_OPEN)}</Btn> : undefined}>
        <p className={s.cardBody}>{t2(lang, words.body)}</p>
      </Card>,
    );
  }

  // ── a claim on this home was blocked (U) ──
  if (status.blockedClaims.length > 0 && !closedBlocked) {
    cards.push(
      <Card key="blocked" kind="blocked" icon={<IconShield size={17} />} title={ko ? "다른 데스크탑에서 연결 변경을 시도했어요" : "Another desktop tried to take over"}
        actions={<Btn onClick={() => setClosedBlocked(true)}>{ko ? "확인" : "OK"}</Btn>}>
        <p className={s.cardBody}>{ko ? "차단했어요." : "Blocked."}</p>
      </Card>,
    );
  }

  // ── the end of a move (R) or a move that stopped (T) ──
  const last = status.lastMove;
  if (last && !move) {
    if (last.outcome === "done" && last.role === "receiver" && moveSeen !== String(last.at)) {
      const rows = COUNT_LABELS.map((c) => ({ c, n: last.counts?.[c.key] })).filter((r) => typeof r.n === "number");
      cards.push(
        <Card key="done" kind="move-done" icon={<IconCheck size={17} />} title={ko ? `${name}${josaIga(name)} 이제 이 데스크탑에 연결돼 있어요` : `${cap(name)} is on this desktop now`}
          actions={<Btn kind="primary" onClick={() => { writeKey(SEEN_MOVE_KEY, String(last.at)); setMoveSeen(String(last.at)); }}>{ko ? "확인" : "OK"}</Btn>}>
          {rows.length > 0 && <div className={s.counts}>{rows.map(({ c, n }) => <div key={c.key} className={s.countRow}><span>{t2(lang, c.label)}{c.note ? <small>{t2(lang, c.note)}</small> : null}</span><b>{n}</b></div>)}</div>}
          {last.from === "server" && <p className={s.cardBody}>{ko ? "서버의 이전 대화는 읽기 전용이에요." : "Earlier chats on the server are read-only."}</p>}
        </Card>,
      );
    } else if (last.outcome !== "done" && last.code !== "reverted" && last.role === "receiver" && moveSeen !== String(last.at)) {   // `reverted`: the owner's own [Revert] ended it, nothing stopped by itself
      const code = last.code ?? "";
      cards.push(
        <Card key="stopped" kind="move-stopped" icon={<IconAlertTriangle size={17} />} title={ko ? "연결 변경이 중지됐어요" : "The change stopped"}
          actions={<>
            <Btn disabled={busy} onClick={() => { writeKey(SEEN_MOVE_KEY, String(last.at)); setMoveSeen(String(last.at)); }}>{ko ? "닫기" : "Close"}</Btn>
            <Btn kind="primary" disabled={busy} onClick={() => press(last.from === "server" ? "startMoveHere" : "startHere", () => (last.from === "server" ? api.startMoveHere() : api.startHere()))}>{ko ? "재시도" : "Try again"}</Btn>
          </>}>
          <p className={s.cardBody}>{t2(lang, ENDED[code] ?? STOPPED_GENERIC)}</p>
        </Card>,
      );
    }
  }

  // ── a computer that is not the home (picture B, bottom bar; picture AQ when the connection was changed away from THIS desktop and is not confirmed: [Revert] only, since [Connect here] would do the same with another button) ──
  if (kind === "away" || kind === "elsewhere") {
    const label = status.homeLabel ?? (status.pointer?.home.kind === "desktop" ? status.pointer.home.label : null) ?? null;
    const pend = pendingOf(status);
    const parts = pend ? pendingParts(pend, lang, nowMs + (typeof status.clockOffsetMs === "number" ? status.clockOffsetMs : 0)) : null;
    cards.push(
      <Card key="not-home" kind={pend ? "not-home-pending" : "not-home"} icon={pend ? <IconShield size={17} /> : <IconHome size={17} />} title={label ? (ko ? `개인 에이전트는 ${label}에 연결돼 있어요` : `The personal agent is connected to ${label}`) : (ko ? "개인 에이전트는 다른 데스크탑에 연결돼 있어요" : "The personal agent is connected to another desktop")}
        actions={pend ? <Btn disabled={busy} onClick={() => press("revertHome", () => api.revertHome())}>{ko ? "복원" : "Revert"}</Btn>
          : <Btn disabled={busy} onClick={() => press("startHere", () => api.startHere())}>{ko ? "이 데스크탑에 연결" : "Connect here"}</Btn>}>
        {pend ? <p className={s.cardBody}>{[ko ? "확인 대기" : "Not confirmed", parts?.since, parts?.left].filter(Boolean).join(" · ")}</p> : null}
      </Card>,
    );
  }
  // ── no home yet except the server: ask once to keep it on this computer (picture A, dashboard card) ──
  const ask = kind === "away" && Boolean(status.leftover?.sender?.ask);
  const askKey = String(status.epoch ?? "");
  const answered = leftoverDone === askKey;

  return (
    <div className={`${s.stack} ${className ?? ""}`} data-one-home-cards="true" data-home-kind={kind}>
      {cards}
      <RefusalNote line={actions.line} lang={lang} />
      <ReauthRow actions={actions} lang={lang} />
      {waitingNote}
      {ask && !answered && (
        <div className={s.scrim} role="presentation">
          <div className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="one-home-leftover">
            <h3 id="one-home-leftover">{status.homeLabel ? (ko ? `연결된 데스크탑이 변경됐어요 · ${status.homeLabel}` : `${status.homeLabel} is now the connected desktop`) : (ko ? "연결된 데스크탑이 다른 데스크탑으로 변경됐어요" : "The connected desktop changed")}</h3>
            <p className={s.cardBody}>{ko ? `이 데스크탑의 ${name} 대화와 기억을 그 데스크탑으로 전송할까요?` : `Send ${name}'s chats and memory on this desktop to that desktop?`}</p>
            <div className={s.cardActions}>
              <Btn onClick={() => { writeKey(LEFTOVER_KEY, askKey); setLeftoverDone(askKey); }}>{ko ? "전송 안 함" : "Don't send"}</Btn>
              <Btn kind="primary" disabled={busy} onClick={() => press("sendLeftover", () => api.sendLeftover())}>{ko ? "전송" : "Send"}</Btn>
            </div>
          </div>
        </div>
      )}
      {status.profileQuestion && (
        <ProfileQuestion q={status.profileQuestion} lang={lang} busy={busy} onKeep={(keep) => press("answerProfile", () => api.answerProfile({ keep }))} />
      )}
    </div>
  );
}

function ProfileQuestion({ q, lang, busy, onKeep }: { q: NonNullable<import("@shared/types").OneHomeStatus["profileQuestion"]>; lang: Lang; busy: boolean; onKeep: (keep: "here" | "incoming") => void }) {
  const ko = lang === "ko";
  const [pick, setPick] = useState<"here" | "incoming">("here");
  const tone = (icon?: string) => (icon ? (icon.includes(":") ? icon : "character:" + icon) : "character:orange-dino");
  const option = (id: "here" | "incoming", who: { displayName?: string; avatarIcon?: string }, sub: string) => (
    <button type="button" role="radio" aria-checked={pick === id} className={s.choice} onClick={() => setPick(id)}>
      <OneAgentPortrait label={who.displayName ?? ""} status="quiet" size="small" tone={tone(who.avatarIcon)} />
      <strong>{who.displayName ?? ""}</strong><small>{sub}</small>
    </button>
  );
  return (
    <div className={s.scrim} role="presentation" onKeyDown={(e) => { if (e.key === "Escape" && !busy) onKeep("here"); }}>
      <div className={s.dialog} role="dialog" aria-modal="true" aria-labelledby="one-home-profile">
        <h3 id="one-home-profile">{ko ? "어느 쪽을 유지할까요?" : "Which one do you keep?"}</h3>
        <p className={s.cardBody}>{ko ? "이름과 얼굴이 서로 달라요." : "The names and faces differ."}</p>
        <div className={s.choices} role="radiogroup">
          {option("here", q.here, ko ? "이 데스크탑" : "This desktop")}
          {option("incoming", q.incoming, ko ? "이전 데스크탑" : "Previous desktop")}
        </div>
        <div className={s.dialogFoot}><span>{ko ? "닫으면 이 데스크탑 유지" : "Closing keeps this desktop's"}</span><Btn kind="primary" disabled={busy} onClick={() => onKeep(pick)}>{ko ? "유지" : "Keep"}</Btn></div>
      </div>
    </div>
  );
}

/**
 * The composer's place while this computer's own move runs: the bar replaces the input (picture desktop-final-pieces B).
 * Children render unchanged when nothing is moving, when the server switch is closed, or when the status cannot be read.
 */
export function OneHomeLockGate({ children }: { children: ReactNode }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const { status } = useOneHome();
  if (!status?.available) return <>{children}</>;
  const kind = homeKindOf(status);
  const claims = (status.pointer?.claims ?? []) as Array<{ to?: { hostId?: string } }>;
  const own = Boolean(status.hostId) && claims.some((c) => c.to?.hostId === status.hostId) && kind !== "home";
  const moving = status.move?.role === "receiver" || kind === "sealed";   // the lock follows the move itself, as before: a move that only waits for the owner's confirmation draws the unconfirmed card (homeKindOf), the composer stays as it was
  if (!moving && !own) return <>{children}</>;
  const text = own ? (ko ? "이 데스크탑이 연결되면 입력할 수 있어요" : "You can type once this desktop is connected")
    : status.move?.waiting ? (ko ? "연결 변경이 끝나거나 취소되면 다시 입력할 수 있어요" : "You can type again when the move finishes or is cancelled")
    : (ko ? "연결 변경이 끝나면 다시 입력할 수 있어요" : "You can type again when the move finishes");
  return <p className={s.lock} role="status" data-one-home-lock="true"><IconLock size={16} />{text}</p>;
}
