// 대시보드 "퀘스트" 보드 — 온보딩 플로우 대체. 신규 유저가 앱 핵심 동선(빌드·채용·자동화·허브)을
// 미션 형태로 밟게 하고, 완료 시 Hub 크레딧을 지급한다(웹 /api/quests 프록시, ipc().quests).
//   · server 검증 퀘스트: 로컬에서 절대 막지 않는다 — 클레임하면 서버가 판정.
//   · client-attested 퀘스트: 값싼 로컬 증거(IPC)로 "완료 가능"을 미리 표시하고,
//     증거가 없으면 확인 다이얼로그를 거쳐 클레임 허용(서버가 워크스페이스당 1회만 수락).
// 시각적으로 다른 대시보드 카드(--dash-surface)와 구분되는 앰버 액센트 카드 — 왼쪽 컬럼 최상단.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { getSnapshot as getBuildSnapshot } from "@/lib/build-session";
import type { QuestInfo } from "@shared/types";

// client-attested 퀘스트 로컬 증거 — questId → true(증거 확보) / false·부재(불명 → confirm 후 클레임).
type EvidenceMap = Partial<Record<string, boolean>>;

const CARD_EDGE = "color-mix(in oklch, var(--dash-amber) 46%, transparent)";
const CARD_BG = "color-mix(in oklch, var(--dash-amber) 9%, var(--dash-surface))";
const HEAD_BG = "color-mix(in oklch, var(--dash-amber) 17%, #ffffff)";

export function QuestBoard() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [quests, setQuests] = useState<QuestInfo[]>([]);
  const [authenticated, setAuthenticated] = useState(true);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState("");
  const [evidence, setEvidence] = useState<EvidenceMap>({});
  const [claimingId, setClaimingId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ id: string; text: string } | null>(null);
  const [celebrate, setCelebrate] = useState<string | null>(null);
  const [signingIn, setSigningIn] = useState(false);
  const celebrateTimer = useRef<number | null>(null);

  const load = useCallback(async () => {
    const api = ipc();
    if (!api?.quests) {
      setLoaded(true);
      return;
    }
    try {
      const res = await api.quests.list();
      if (res.ok) {
        setQuests(res.quests);
        setAuthenticated(res.authenticated);
        setError("");
      } else {
        setError(ko ? "퀘스트를 불러오지 못했습니다." : "Could not load quests.");
      }
    } catch {
      setError(ko ? "퀘스트를 불러오지 못했습니다." : "Could not load quests.");
    } finally {
      setLoaded(true);
    }
  }, [ko]);

  // client-attested 퀘스트의 값싼 로컬 증거 수집 — 실패는 전부 무시(불명 취급).
  // server 검증 퀘스트는 여기서 아무것도 판단하지 않는다.
  const loadEvidence = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const next: EvidenceMap = {};
    // 첫 빌드 — 빌드 세션 스토어(이번 세션에서 완료된 빌드)만 값싸게 본다. 없으면 불명.
    try {
      const build = getBuildSnapshot();
      if (build.phase === "done" || build.result !== null) next.q_first_build = true;
    } catch {
      // ignore
    }
    try {
      const agents = await api.team.list();
      next.q_first_agent_hire = agents.length > 1;
    } catch {
      // ignore
    }
    try {
      const autos = await api.automations.list();
      next.q_first_automation = autos.length > 0;
      next.q_first_workflow_run = autos.some((a) => Boolean(a.lastRunAt));
    } catch {
      // ignore
    }
    setEvidence(next);
  }, []);

  useEffect(() => {
    void load();
    void loadEvidence();
  }, [load, loadEvidence]);

  useEffect(() => {
    return () => {
      if (celebrateTimer.current !== null) window.clearTimeout(celebrateTimer.current);
    };
  }, []);

  const showCelebrate = useCallback((text: string) => {
    setCelebrate(text);
    if (celebrateTimer.current !== null) window.clearTimeout(celebrateTimer.current);
    celebrateTimer.current = window.setTimeout(() => setCelebrate(null), 4000);
  }, []);

  const onClaim = useCallback(
    async (q: QuestInfo) => {
      const api = ipc();
      if (!api?.quests || claimingId) return;
      // client-attested인데 로컬 증거가 없으면 자기확인 다이얼로그 — 클레임 자체는 막지 않는다.
      if (q.verification === "client-attested" && evidence[q.id] !== true) {
        const confirmed = window.confirm(
          ko
            ? "이 작업을 완료하셨나요? 완료하셨다면 확인을 눌러 보상을 받으세요."
            : "Have you completed this task? Press OK to claim the reward.",
        );
        if (!confirmed) return;
      }
      setClaimingId(q.id);
      setNotice(null);
      try {
        const res = await api.quests.claim(q.id);
        if (res.ok) {
          const credits = res.rewardCredits ?? q.rewardCredits;
          showCelebrate(ko ? `+${credits} 크레딧 지급 완료!` : `+${credits} credits added!`);
          // 크레딧 위젯 갱신 힌트(리스너가 생기면 즉시 반영; 현재는 60초 폴링이 따라잡는다).
          try {
            window.dispatchEvent(new CustomEvent("agentlas:credits-refresh"));
          } catch {
            // ignore
          }
          await load();
        } else if (res.code === "already_claimed") {
          setQuests((prev) => prev.map((it) => (it.id === q.id ? { ...it, claimed: true } : it)));
          setNotice({ id: q.id, text: ko ? "이미 수령한 퀘스트예요." : "Already claimed." });
          await load();
        } else if (res.code === "not_completed") {
          setNotice({
            id: q.id,
            text: ko ? "아직 조건이 충족되지 않았어요. 미션을 먼저 완료해 주세요." : "Not completed yet — finish the mission first.",
          });
        } else if (res.code === "unauthenticated") {
          setAuthenticated(false);
          setNotice({ id: q.id, text: ko ? "로그인 후 보상을 받을 수 있어요." : "Sign in to claim rewards." });
        } else {
          setNotice({ id: q.id, text: ko ? "수령에 실패했습니다. 잠시 후 다시 시도해 주세요." : "Claim failed. Try again shortly." });
        }
      } catch {
        setNotice({ id: q.id, text: ko ? "수령에 실패했습니다. 잠시 후 다시 시도해 주세요." : "Claim failed. Try again shortly." });
      } finally {
        setClaimingId(null);
      }
    },
    [claimingId, evidence, ko, load, showCelebrate],
  );

  // 로그인 — AccountChip과 동일 패턴: 기본 브라우저 → 실패 시 창 로그인 폴백.
  const onSignIn = useCallback(async () => {
    const api = ipc();
    if (!api?.auth || signingIn) return;
    setSigningIn(true);
    try {
      let session = await api.auth.signInWithBrowser();
      if (!session?.signedIn) session = await api.auth.signInWithGoogle();
      if (session?.signedIn) {
        await load();
        await loadEvidence();
      }
    } catch {
      // 사용자가 취소했거나 실패 — 조용히 유지
    } finally {
      setSigningIn(false);
    }
  }, [load, loadEvidence, signingIn]);

  // Electron 밖(브라우저 dev)에서는 렌더하지 않는다.
  if (!ipc()) return null;

  const total = quests.length;
  const claimedCount = quests.filter((q) => q.claimed).length;

  return (
    <section
      aria-label={ko ? "퀘스트" : "Quests"}
      style={{
        borderRadius: 8,
        border: `1px solid ${CARD_EDGE}`,
        background: CARD_BG,
        boxShadow: "var(--dash-shadow)",
        color: "var(--dash-ink)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          minHeight: 42,
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "0 14px",
          background: HEAD_BG,
          borderBottom: `1px solid ${CARD_EDGE}`,
        }}
      >
        <span style={{ minWidth: 0, flex: 1, fontSize: 13, fontWeight: 760 }}>
          <span aria-hidden="true" style={{ marginRight: 6 }}>🎯</span>
          {ko ? "퀘스트" : "Quests"}
        </span>
        {total > 0 && (
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              fontVariantNumeric: "tabular-nums",
              color: "var(--dash-ink-soft)",
              background: "rgba(255,255,255,0.65)",
              border: `1px solid ${CARD_EDGE}`,
              borderRadius: 999,
              padding: "2px 8px",
              whiteSpace: "nowrap",
            }}
          >
            {ko ? `${claimedCount}/${total} 완료` : `${claimedCount}/${total} done`}
          </span>
        )}
      </div>

      {celebrate && (
        <div
          role="status"
          style={{
            padding: "8px 14px",
            fontSize: 12,
            fontWeight: 700,
            color: "var(--green-deep)",
            background: "color-mix(in oklch, var(--green-deep) 10%, #ffffff)",
            borderBottom: `1px solid ${CARD_EDGE}`,
          }}
        >
          {celebrate}
        </div>
      )}

      {!loaded ? (
        <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--dash-muted)" }}>
          {ko ? "퀘스트를 불러오는 중…" : "Loading quests…"}
        </div>
      ) : error ? (
        <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--dash-muted)" }}>{error}</div>
      ) : !authenticated ? (
        <UnauthedBody ko={ko} quests={quests} signingIn={signingIn} onSignIn={() => void onSignIn()} />
      ) : total === 0 ? (
        <div style={{ padding: "12px 14px", fontSize: 12, color: "var(--dash-muted)" }}>
          {ko ? "표시할 퀘스트가 없어요." : "No quests to show."}
        </div>
      ) : (
        quests.map((q, i) => (
          <QuestRow
            key={q.id}
            quest={q}
            ko={ko}
            first={i === 0}
            evidence={evidence[q.id]}
            claiming={claimingId === q.id}
            notice={notice?.id === q.id ? notice.text : null}
            onClaim={() => void onClaim(q)}
          />
        ))
      )}
    </section>
  );
}

function QuestRow({
  quest,
  ko,
  first,
  evidence,
  claiming,
  notice,
  onClaim,
}: {
  quest: QuestInfo;
  ko: boolean;
  first: boolean;
  evidence: boolean | undefined;
  claiming: boolean;
  notice: string | null;
  onClaim: () => void;
}) {
  const title = ko ? quest.titleKo : quest.titleEn;
  const desc = ko ? quest.descKo : quest.descEn;
  // 상태 칩: 수령 완료 > (client-attested 로컬 증거 확보) 완료 가능 > 진행 전.
  // server 검증 퀘스트는 로컬에서 완료 여부를 모른다 — 미수령이면 "진행 전"으로 두되 클레임은 항상 허용.
  const chip = quest.claimed
    ? { text: ko ? "수령 완료" : "Claimed", color: "var(--green-deep)", bg: "color-mix(in oklch, var(--green-deep) 12%, #ffffff)" }
    : quest.verification === "client-attested" && evidence === true
      ? { text: ko ? "완료 가능" : "Ready", color: "var(--amber-deep)", bg: "color-mix(in oklch, var(--dash-amber) 22%, #ffffff)" }
      : { text: ko ? "진행 전" : "Open", color: "var(--dash-muted)", bg: "rgba(255,255,255,0.55)" };

  return (
    <div
      style={{
        padding: "10px 14px",
        borderTop: first ? "none" : "1px solid var(--dash-line)",
        display: "grid",
        gap: 5,
        opacity: quest.claimed ? 0.62 : 1,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
        <span
          style={{
            minWidth: 0,
            flex: 1,
            fontSize: 12.5,
            fontWeight: 680,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
          title={title}
        >
          {title}
        </span>
        <span
          style={{
            fontSize: 10.5,
            fontWeight: 700,
            color: chip.color,
            background: chip.bg,
            borderRadius: 999,
            padding: "2px 7px",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          {chip.text}
        </span>
        <span
          style={{
            fontSize: 11.5,
            fontWeight: 760,
            fontVariantNumeric: "tabular-nums",
            color: "var(--amber-deep)",
            whiteSpace: "nowrap",
            flexShrink: 0,
          }}
        >
          +{quest.rewardCredits}cr
        </span>
      </div>
      <div style={{ fontSize: 11, lineHeight: 1.45, color: "var(--dash-muted)" }}>{desc}</div>
      {!quest.claimed && (
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={onClaim}
            disabled={claiming}
            style={{
              padding: "4px 12px",
              borderRadius: 8,
              border: "none",
              background: claiming ? "var(--dash-line)" : "var(--dash-teal)",
              color: "#ffffff",
              fontSize: 11,
              fontWeight: 700,
              cursor: claiming ? "default" : "pointer",
              whiteSpace: "nowrap",
            }}
          >
            {claiming ? (ko ? "확인 중…" : "Checking…") : ko ? "보상 받기" : "Claim"}
          </button>
          {notice && <span style={{ fontSize: 10.5, color: "var(--dash-muted)" }}>{notice}</span>}
        </div>
      )}
      {quest.claimed && notice && <div style={{ fontSize: 10.5, color: "var(--dash-muted)" }}>{notice}</div>}
    </div>
  );
}

// 미로그인 — 컴팩트 안내 + 로그인 버튼. 퀘스트 카탈로그가 오면 보상 미리보기로만 나열.
function UnauthedBody({
  ko,
  quests,
  signingIn,
  onSignIn,
}: {
  ko: boolean;
  quests: QuestInfo[];
  signingIn: boolean;
  onSignIn: () => void;
}) {
  return (
    <div style={{ padding: "12px 14px", display: "grid", gap: 8 }}>
      <div style={{ fontSize: 12, lineHeight: 1.5, color: "var(--dash-ink-soft)" }}>
        {ko ? "로그인하고 퀘스트 보상 받기" : "Sign in to claim quest rewards"}
      </div>
      <div>
        <button
          type="button"
          onClick={onSignIn}
          disabled={signingIn}
          style={{
            padding: "5px 14px",
            borderRadius: 8,
            border: "none",
            background: signingIn ? "var(--dash-line)" : "var(--dash-teal)",
            color: "#ffffff",
            fontSize: 11.5,
            fontWeight: 700,
            cursor: signingIn ? "default" : "pointer",
          }}
        >
          {signingIn ? (ko ? "로그인 중…" : "Signing in…") : ko ? "로그인" : "Sign in"}
        </button>
      </div>
      {quests.length > 0 && (
        <div style={{ display: "grid", gap: 4, marginTop: 2 }}>
          {quests.map((q) => (
            <div key={q.id} style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0 }}>
              <span
                style={{
                  minWidth: 0,
                  flex: 1,
                  fontSize: 11.5,
                  color: "var(--dash-muted)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {ko ? q.titleKo : q.titleEn}
              </span>
              <span style={{ fontSize: 11, fontWeight: 700, color: "var(--amber-deep)", whiteSpace: "nowrap" }}>
                +{q.rewardCredits}cr
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
