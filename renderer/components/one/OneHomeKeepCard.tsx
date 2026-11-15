"use client";

/**
 * Dashboard card "Keep your agent on this computer?" (picture desktop-move-pieces A). Shown only while the personal agent's home is the server, nothing is
 * moving, and the server switch is open (`available`). [Later] hides it until the next launch (memory only: no stored value, so no cleanup to write).
 * [Make this the main computer] is `oneHome.startMoveHere`: a request whose number and yes live in the app's own confirm window. The chat and memory
 * counts of the picture are not drawn: the status does not carry them before a move starts.
 */
import { useState } from "react";
import { IconCloud, IconMonitor } from "@/components/Icon";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import { josaEul } from "@/lib/one-home-copy";
import { homeKindOf } from "@/lib/one-home-view";
import { useAgentName, useHomeActions, useOneHome } from "@/lib/use-one-home";
import { Btn, ReauthRow, RefusalNote } from "@/components/one/OneHomeParts";
import s from "./OneHome.module.css";

export function OneHomeKeepCard() {
  const { locale } = useT();
  const ko = locale === "ko";
  const name = useAgentName(ko);
  const { status, reload } = useOneHome();
  const actions = useHomeActions(reload, status?.pendingReauth?.actionId ?? null);
  const [later, setLater] = useState(false);
  const [requested, setRequested] = useState(false);
  if (!status?.available || later || homeKindOf(status) !== "server" || status.move) return null;
  const api = ipc()!.oneHome;
  return (
    <div className={s.stack} data-one-home-keep="true" style={{ marginBottom: 16 }}>
      <article className={s.card} data-one-home-card="keep">
        <div className={s.cardHead}>
          <h3 className={s.cardTitle}><span aria-hidden="true"><IconCloud size={17} /></span>{ko ? `${name}${josaEul(name)} 이 데스크탑에 연결할까요?` : `Connect ${name} to this desktop?`}</h3>
        </div>
        <p className={s.cardBody}>{ko ? "폰과 이 데스크탑의 에이전트가 하나로 병합돼 이 데스크탑에서 실행돼요." : "The agents on your phone and this desktop merge and run here."}</p>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <span className={s.pill}><IconCloud size={13} />Agentlas</span><span aria-hidden="true">→</span><span className={s.pill}><IconMonitor size={13} />{ko ? "이 데스크탑" : "This desktop"}</span>
        </div>
        <div className={s.cardActions}>
          <Btn disabled={Boolean(actions.busy)} onClick={() => setLater(true)}>{ko ? "나중에" : "Later"}</Btn>
          <Btn kind="primary" disabled={Boolean(actions.busy)} onClick={() => { setRequested(false); void actions.press("startMoveHere", async () => { const out = await api.startMoveHere(); if (out?.ok) setRequested(true); return out; }); }}>{ko ? "이 데스크탑에 연결" : "Connect here"}</Btn>
        </div>
      </article>
      <RefusalNote line={actions.line} lang={ko ? "ko" : "en"} />
      <ReauthRow actions={actions} lang={ko ? "ko" : "en"} />
      {requested && !actions.line && !actions.reauthCode && <div className={s.note} role="status"><span /><span>{ko ? "진행은 개인 에이전트 화면에서 확인해요." : "Progress shows in the personal agent screen."}</span><span /></div>}
    </div>
  );
}
