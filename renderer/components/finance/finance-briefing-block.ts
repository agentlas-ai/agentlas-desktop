"use client";
// F-D17b F: the daily briefing is registered as a check-in of the personal agent, so a computer that is not that agent's home right now does not send it
// (`monitoring.registrationBlocked`, a machine code from Main: `one_away` = another computer is the home, `one_sealed` = the home is moving).
// This module only turns that code into the confirmed sentences (desktop-impl-gaps-2, piece F) and says where the home's name comes from:
//   the name is `oneHome.status().homeLabel` (the preload's own read), asked ONCE when `one_away` shows up, as plain text, cut to 60 characters. The label
//   is another computer's own text: it is drawn as text and nowhere else. No name (not read yet, an empty label, or a failed read) -> the picture's own
//   words for it: "the home computer" / "집 컴퓨터".
import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";

export type BriefingBlock = "one_away" | "one_sealed";
export interface BriefingBlockCopy { headline: string; line: string }

const NAME_LIMIT = 60;
export function cleanHomeName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim();
  return text ? (text.length > NAME_LIMIT ? `${text.slice(0, NAME_LIMIT - 1)}…` : text) : null;
}

export function briefingBlockCopy(block: BriefingBlock, ko: boolean, homeName: string | null): BriefingBlockCopy {
  if (block === "one_sealed") {
    return ko
      ? { headline: "정기 브리핑: 잠시 멈춤", line: "연결 변경 중이라 정기 브리핑을 잠시 멈췄어요. 변경이 끝나면 다시 보내요." }
      : { headline: "Daily briefing: paused", line: "Your personal agent is moving, so the daily briefing is paused. It starts again when the move is done." };
  }
  return ko
    ? { headline: "정기 브리핑: 이 데스크탑에서는 꺼짐", line: `개인 에이전트가 ${homeName ?? "연결된 데스크탑"}에 연결돼 있어서, 정기 브리핑은 그 데스크탑에서 보내요.` }
    : { headline: "Daily briefing: off on this computer", line: `Your personal agent lives on ${homeName ?? "the home computer"}, so the daily briefing is sent from that computer.` };
}

/** The sentence for the current block (or null). Reads the home's name once per time `one_away` appears; nothing else polls. */
export function useBriefingBlock(block: BriefingBlock | undefined, ko: boolean): BriefingBlockCopy | null {
  const [homeName, setHomeName] = useState<string | null>(null);
  useEffect(() => {
    if (block !== "one_away") return undefined;
    let alive = true;
    const status = ipc()?.oneHome?.status;
    if (typeof status !== "function") return undefined;
    void Promise.resolve(status()).then((value) => {
      if (alive) setHomeName(cleanHomeName(value?.homeLabel ?? value?.away?.homeLabel));
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [block]);
  return block ? briefingBlockCopy(block, ko, block === "one_away" ? homeName : null) : null;
}
