// BYOC 키/구독 상태 표시 — 세 화면(Build·Agent·Workspace) 공통.
// 기획안 비평 5번(통제의 대가): 키 사망은 가장 흔한 실패인데 화면에서 미설계였다. 이 컴포넌트가
// usage.snapshot() 실측에서 상태를 도출해 정상은 헤더 pill, 한도임박/오류는 배너로 책임진다.
"use client";
import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { deriveKeyStatus, type KeyStatus } from "@/lib/key-status";
import { IconBolt, IconShield, IconCheck } from "@/components/Icon";

const REFRESH_MS = 60_000;

export function KeyStatusBanner({ mode = "banner" }: { mode?: "banner" | "pill" }) {
  const { locale } = useT();
  const ko = locale === "ko";
  const [status, setStatus] = useState<KeyStatus | null>(null);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const snap = await ipc()?.usage.snapshot();
        if (alive) setStatus(deriveKeyStatus(snap ?? null));
      } catch {
        if (alive) setStatus({ health: "unknown", affected: [], connected: 0 });
      }
    };
    void load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, []);

  if (!status || status.health === "unknown") return null;

  const affected = status.affected.join(", ");

  if (mode === "pill") {
    // 정상일 때만 헤더 pill 노출(군더더기 최소화). 경고/오류는 배너 모드가 책임진다.
    if (status.health !== "ok") {
      return (
        <span className="key-status-pill" data-health={status.health} title={affected}>
          <IconShield size={12} />
          {status.health === "error"
            ? ko ? "키 연결 끊김" : "Keys down"
            : ko ? "사용량 한도 임박" : "Usage near limit"}
        </span>
      );
    }
    return (
      <span className="key-status-pill" data-health="ok">
        <IconCheck size={12} />
        {ko ? "구독 키 정상" : "Keys healthy"}
      </span>
    );
  }

  // banner 모드: 정상이면 아무것도 안 띄운다(조용한 정상).
  if (status.health === "ok") return null;

  const isError = status.health === "error";
  return (
    <div className="key-status-banner" data-health={status.health} role="status">
      {isError ? <IconShield size={15} /> : <IconBolt size={15} />}
      <div className="key-status-banner-copy">
        <strong>
          {isError
            ? ko ? "BYOC 키 연결이 끊겼습니다 — 모든 일꾼이 멈춥니다." : "BYOC keys disconnected — all workers stall."
            : ko ? "사용량 한도에 근접했습니다." : "Approaching usage limit."}
        </strong>
        <span>
          {affected
            ? ko ? `영향: ${affected}` : `Affected: ${affected}`
            : ko ? "엔진 연결 상태를 확인하세요." : "Check engine connection."}
          {" · "}
          {ko
            ? "내 구독/키로만 구동됩니다 (Agentlas 마진 ₩0)."
            : "Runs only on your own subscription/keys (Agentlas margin $0)."}
        </span>
      </div>
    </div>
  );
}
