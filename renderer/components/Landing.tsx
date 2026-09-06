// 로그아웃 첫 화면 — Claude Design "Agentlas Landing" 핸드오프를 데스크톱용으로 옮긴 랜딩.
// 디자인 차용 + 요구사항 반영:
//   - 상단 nav / 99.2 stat 카드 / 플로팅 카드 / Watch Demo 전부 제거
//   - 카피 재작성 + 전부 가운데 정렬
//   - CTA는 "Get Started" 버튼 하나 = 로그인 버튼
//   - 시그니처 캔버스 network globe 애니메이션은 그대로 살려 중앙 배경으로
// 로그인은 AccountChip과 동일하게 시스템 기본 브라우저(크롬 등) 재사용 → 실패 시 창 로그인 폴백.
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { AuthSession } from "@/lib/types";

// 핸드오프 팔레트 (다크 — 테마와 무관하게 고정)
const C = {
  bg: "var(--landing-bg)",
  ink: "var(--landing-ink)",
  ink2: "rgba(234,243,242,0.62)",
  ink3: "rgba(234,243,242,0.40)",
  ink4: "rgba(234,243,242,0.26)",
  teal: "var(--landing-teal)",
  teal2: "var(--landing-teal-2)",
  cyan: "var(--landing-cyan)",
  hair2: "rgba(255,255,255,0.14)",
};

// 키프레임 — 핸드오프와 동일. 컴포넌트 스코프 <style>로 주입.
const KEYFRAMES = `
@keyframes lFadeUp{from{opacity:0;transform:translateY(22px)}to{opacity:1;transform:translateY(0)}}
@keyframes lFade{from{opacity:0}to{opacity:1}}
@keyframes lPulse{0%{transform:scale(.7);opacity:.7}100%{transform:scale(2.2);opacity:0}}
@media (prefers-reduced-motion: reduce){
  .landing-root *{animation:none !important;transition:none !important}
}
`;

/** 캔버스 network globe — 핸드오프 initGlobe()를 그대로 포팅. rAF 정리 포함. */
function useGlobe(canvasRef: React.RefObject<HTMLCanvasElement>) {
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const S = 580;
    canvas.width = S * dpr;
    canvas.height = S * dpr;
    canvas.style.width = S + "px";
    canvas.style.height = S + "px";
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);
    const cx = S / 2;
    const cy = S / 2;
    const R = S * 0.33;
    const N = 240;
    const pts: number[][] = [];
    for (let i = 0; i < N; i++) {
      const y = 1 - (i / (N - 1)) * 2;
      const rr = Math.sqrt(Math.max(0, 1 - y * y));
      const th = i * 2.399963;
      pts.push([Math.cos(th) * rr, y, Math.sin(th) * rr]);
    }
    const bright = pts.map(
      (p) => Math.sin(p[0] * 3.1) + Math.cos(p[1] * 3.7) + Math.sin(p[2] * 4.3) > 0.7,
    );
    const tilt = -0.42;
    const cT = Math.cos(tilt);
    const sT = Math.sin(tilt);
    const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
    let a = 0;
    // 캔버스는 CSS 변수를 해석하지 못하므로 같은 토큰을 한 번 읽어 쓴다.
    const readToken = (name: string, fallback: string) =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
    const canvasTeal = readToken("--landing-teal", "#2de6c8"); // colour-literal-allowed: canvas fallback for the landing token
    const canvasCyan = readToken("--landing-cyan", "#22d3ee"); // colour-literal-allowed: canvas fallback for the landing token
    let raf = 0;
    const frame = () => {
      ctx.clearRect(0, 0, S, S);
      const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, R * 1.7);
      g.addColorStop(0, "rgba(45,230,200,0.20)");
      g.addColorStop(0.42, "rgba(34,211,238,0.06)");
      g.addColorStop(1, "rgba(0,0,0,0)");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, S, S);
      const ca = Math.cos(a);
      const sa = Math.sin(a);
      const proj = pts.map((p, i) => {
        const x = p[0];
        const y = p[1];
        const z = p[2];
        const x1 = x * ca - z * sa;
        const z1 = x * sa + z * ca;
        const y2 = y * cT - z1 * sT;
        const z2 = y * sT + z1 * cT;
        return { x: cx + x1 * R, y: cy - y2 * R, z: z2, b: bright[i] };
      });
      // 위도 와이어 링
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(45,230,200,0.09)";
      for (let li = -3; li <= 3; li++) {
        const lat = (li * Math.PI) / 8;
        ctx.beginPath();
        for (let k = 0; k <= 54; k++) {
          const lon = (k / 54) * Math.PI * 2 + a;
          const x = Math.cos(lat) * Math.cos(lon);
          const y = Math.sin(lat);
          const z = Math.cos(lat) * Math.sin(lon);
          const y2 = y * cT - z * sT;
          ctx.lineTo(cx + x * R, cy - y2 * R);
        }
        ctx.stroke();
      }
      // 노드 점
      ctx.globalCompositeOperation = "lighter";
      proj.forEach((p) => {
        const dn = (p.z + 1) / 2;
        const front = p.z > -0.12;
        const alpha = front ? 0.22 + 0.78 * dn : 0.1 * dn;
        const size = (p.b ? 1.8 : 1.2) * (0.5 + 0.7 * dn);
        ctx.globalAlpha = alpha * (p.b ? 1 : 0.7);
        ctx.fillStyle = p.b ? canvasTeal : canvasCyan;
        ctx.beginPath();
        ctx.arc(p.x, p.y, size, 0, 7);
        ctx.fill();
        if (p.b && front) {
          ctx.globalAlpha = alpha * 0.22;
          ctx.beginPath();
          ctx.arc(p.x, p.y, size * 3.2, 0, 7);
          ctx.fill();
        }
      });
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      // 궤도 링 + 도는 노드
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(-0.38);
      ctx.strokeStyle = "rgba(45,230,200,0.16)";
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.ellipse(0, 0, R * 1.34, R * 0.4, 0, 0, 7);
      ctx.stroke();
      const oa = a * 1.7;
      const ox = Math.cos(oa) * R * 1.34;
      const oy = Math.sin(oa) * R * 0.4;
      ctx.globalCompositeOperation = "lighter";
      ctx.fillStyle = canvasTeal;
      ctx.globalAlpha = 0.95;
      ctx.beginPath();
      ctx.arc(ox, oy, 2.6, 0, 7);
      ctx.fill();
      ctx.globalAlpha = 0.3;
      ctx.beginPath();
      ctx.arc(ox, oy, 8, 0, 7);
      ctx.fill();
      ctx.restore();
      ctx.globalAlpha = 1;
      ctx.globalCompositeOperation = "source-over";
      if (!reduce) {
        a += 0.0042;
        raf = requestAnimationFrame(frame);
      }
    };
    frame();
    return () => {
      if (raf) cancelAnimationFrame(raf);
    };
  }, [canvasRef]);
}

export function Landing({
  onSignedIn,
}: {
  onSignedIn: (session: AuthSession) => void;
}) {
  const { t, locale } = useT();
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  useGlobe(canvasRef);

  // 크롬 등 이미 로그인된 기본 브라우저 재사용 → 미완료 시 창 로그인 폴백 (AccountChip과 동일).
  const getStarted = useCallback(async () => {
    const api = ipc();
    if (busy) return;
    if (!api) {
      setNotice(
        locale === "ko"
          ? "데스크톱 앱 안에서 열어야 로그인을 시작할 수 있습니다. 브라우저 미리보기에서는 Electron 브릿지가 없어 실행되지 않습니다."
          : "Open this inside the desktop app to start sign-in. Browser preview has no Electron bridge.",
      );
      return;
    }
    setBusy(true);
    setNotice(null);
    cancelledRef.current = false;
    try {
      const next = await api.auth.signInWithBrowser();
      if (next.signedIn) {
        onSignedIn(next);
        return;
      }
      // 사용자가 대기를 취소했다면 두 번째(창 로그인) 폴백을 새로 열지 않는다 —
      // 취소했는데 또 다른 로그인 창이 뜨는 것이 갇힘의 두 번째 형태다(U-D-7).
      if (cancelledRef.current) return;
      const fallback = await api.auth.signInWithGoogle();
      if (fallback.signedIn) onSignedIn(fallback);
      else if (!cancelledRef.current) {
        setNotice(
          locale === "ko"
            ? "로그인이 완료되지 않았습니다. 브라우저 창을 확인하거나 다시 시도하세요."
            : "Sign-in did not complete. Check the browser window or try again.",
        );
      }
    } catch (err) {
      if (!cancelledRef.current) setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [busy, locale, onSignedIn]);
  // 로그인 대기에서 빠져나올 길 (U-D-7): 대기 화면에 취소가 없어 사용자가
  // location.href 강제 이탈로만 탈출했다(S9). 취소는 화면을 즉시 되돌린다.
  // 이미 브라우저에서 로그인을 끝냈다면 그 성공(onSignedIn)은 그대로 존중한다.
  const cancelWait = useCallback(() => {
    cancelledRef.current = true;
    setBusy(false);
    setNotice(null);
  }, []);

  return (
    <div
      className="landing-root"
      style={{
        position: "fixed",
        inset: 0,
        overflow: "hidden",
        background: C.bg,
        color: C.ink,
        fontFamily: "var(--font-body)",
      }}
    >
      <style dangerouslySetInnerHTML={{ __html: KEYFRAMES }} />

      {/* 창 드래그 영역 (macOS 신호등 확보) */}
      <div
        className="titlebar-drag"
        style={{ position: "absolute", top: 0, left: 0, right: 0, height: 44, zIndex: 10 }}
      />

      {/* 배경 — 도트 그리드 + 글로우 블롭 (핸드오프 renderApp 배경) */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          backgroundImage:
            "radial-gradient(rgba(255,255,255,0.04) 1px, transparent 1px)",
          backgroundSize: "34px 34px",
          opacity: 0.5,
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          top: "-12%",
          left: "12%",
          width: 600,
          height: 600,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(45,230,200,0.10), transparent 65%)",
          filter: "blur(50px)",
          pointerEvents: "none",
        }}
      />
      <div
        style={{
          position: "absolute",
          bottom: "-14%",
          right: "8%",
          width: 520,
          height: 520,
          borderRadius: "50%",
          background:
            "radial-gradient(circle, rgba(34,211,238,0.07), transparent 66%)",
          filter: "blur(54px)",
          pointerEvents: "none",
        }}
      />

      {/* 중앙 globe (배경) */}
      <div
        style={{
          position: "absolute",
          left: "50%",
          top: "50%",
          transform: "translate(-50%,-50%) scale(1.15)",
          animation: "lFade 1.2s both",
          pointerEvents: "none",
          opacity: 0.92,
        }}
      >
        <canvas ref={canvasRef} />
      </div>
      {/* 텍스트 가독성용 중앙 비네트 */}
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(closest-side at 50% 48%, rgba(6,8,11,0.78), rgba(6,8,11,0.30) 46%, transparent 70%)",
          pointerEvents: "none",
        }}
      />

      {/* 중앙 정렬 hero */}
      <div
        style={{
          position: "relative",
          zIndex: 5,
          height: "100%",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          textAlign: "center",
          padding: "44px 28px 0",
        }}
      >
        {/* 헤드라인 */}
        <h1
          style={{
            margin: 0,
            fontFamily: "var(--font-head)",
            fontSize: 64,
            lineHeight: 1.05,
            fontWeight: 700,
            letterSpacing: 0,
            color: C.ink,
            wordBreak: "keep-all",
            textShadow: "0 4px 40px rgba(6,8,11,.85)",
            animation: "lFadeUp .8s .12s both",
          }}
        >
          {t("landing.title.l1")}
          <br />
          <span
            style={{
              background: `linear-gradient(100deg,${C.teal},${C.cyan})`,
              WebkitBackgroundClip: "text",
              backgroundClip: "text",
              color: "transparent",
            }}
          >
            {t("landing.title.l2")}
          </span>
        </h1>

        {/* 서브카피 */}
        <p
          style={{
            margin: "24px 0 0",
            fontSize: 17,
            lineHeight: 1.65,
            color: C.ink2,
            maxWidth: 540,
            wordBreak: "keep-all",
            textShadow: "0 2px 20px rgba(6,8,11,.9)",
            animation: "lFadeUp .8s .22s both",
          }}
        >
          {t("landing.subtitle")}
        </p>

        {/* CTA — Get Started = 로그인 */}
        <div style={{ marginTop: 36, animation: "lFadeUp .8s .32s both" }}>
          <button
            className="titlebar-nodrag"
            onClick={() => { if (!busy) void getStarted(); }}
            // aria-disabled, not disabled: a disabled button leaves the tab
            // order, so on the very first screen a keyboard-only user could
            // never reach the only control there is. The click is guarded
            // instead, which keeps it focusable and announced.
            aria-disabled={busy}
            aria-busy={busy}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 9,
              height: 54,
              padding: "0 30px",
              borderRadius: 999,
              fontSize: 16.5,
              fontWeight: 600,
              fontFamily: "inherit",
              cursor: busy ? "default" : "pointer",
              whiteSpace: "nowrap",
              color: "var(--ok)",
              background: `linear-gradient(180deg, ${C.teal} 0%, ${C.teal2} 100%)`,
              border: "1px solid rgba(45,230,200,.5)",
              boxShadow: "0 10px 30px rgba(45,230,200,.28)",
              opacity: busy ? 0.75 : 1,
              transition:
                "transform .2s cubic-bezier(.2,.7,.2,1), box-shadow .2s, filter .2s",
            }}
            onMouseEnter={(e) => {
              if (busy) return;
              e.currentTarget.style.transform = "translateY(-2px)";
              e.currentTarget.style.filter = "brightness(1.06)";
            }}
            onMouseLeave={(e) => {
              e.currentTarget.style.transform = "";
              e.currentTarget.style.filter = "";
            }}
          >
            <span>{busy ? t("landing.cta_busy") : t("landing.cta")}</span>
            {busy ? (
              // Nine to eleven seconds of an unchanged label is indistinguishable
              // from a hang. Give the wait something that moves.
              <span
                aria-hidden="true"
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  border: "2px solid rgba(4,35,31,.25)",
                  borderTopColor: "var(--ok)",
                  animation: "agentlas-cta-spin .8s linear infinite",
                }}
              />
            ) : null}
            {!busy && (
              <svg
                width="17"
                height="17"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth={1.9}
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                <path d="M5 12h14M13 6l6 6-6 6" />
              </svg>
            )}
          </button>
          {busy && (
            // 대기 화면의 탈출구 (U-D-7): 취소가 없으면 로그인을 못/안 하는
            // 사용자는 이 화면에 갇힌다.
            <button
              type="button"
              className="titlebar-nodrag"
              onClick={cancelWait}
              style={{
                display: "block",
                margin: "14px auto 0",
                padding: "8px 18px",
                borderRadius: 999,
                fontSize: 13.5,
                fontFamily: "inherit",
                cursor: "pointer",
                color: C.ink2,
                background: "transparent",
                border: "1px solid rgba(255,255,255,.22)",
              }}
            >
              {locale === "ko" ? "로그인 취소" : "Cancel sign-in"}
            </button>
          )}
          {notice && (
            <div
              role="status"
              style={{
                margin: "14px auto 0",
                maxWidth: 520,
                color: C.ink2,
                fontSize: 13,
                lineHeight: 1.55,
                textAlign: "center",
              }}
            >
              {notice}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
