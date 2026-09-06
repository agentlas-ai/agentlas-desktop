"use client";
// 허브 소개 페이지 — agentlas.cloud/p/<slug> 를 앱 안에 그대로 띄운다.
//
// 소개는 읽기 전용이라 데스크탑 IPC가 필요 없다. 그래서 다시 그리지 않고 원본을
// 임베드한다 — 웹에서 소개를 고치면 여기도 그날 바뀐다(손 동기화 없음).
// 설치가 걸린 플러그인 카탈로그는 반대로 데스크탑 카드가 계속 담당한다: 원격
// 페이지에는 preload가 없어 로컬 MCP 설치를 부를 수 없기 때문이다.
//
// 라우트가 `[slug]`가 아니라 `?slug=`인 이유: 렌더러는 정적 export(output:"export")
// 라서 동적 세그먼트는 빌드 시점에 slug를 전부 알아야 한다. 허브 slug는 그때 알 수 없다.
//
// 임베드 표면(WebContentsView)은 DOM 위에 떠 있다. 그래서 이 페이지는 자리만
// 잡아 두고(placeholder) 그 사각형을 main에 계속 알려 준다. 화면을 떠나면 반드시
// 닫는다 — 안 닫으면 다음 화면 위에 유령으로 남는다.
import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";

/**
 * 열기/닫기 IPC를 한 줄로 세운다.
 *
 * 이게 없으면 열기와 닫기가 main에서 서로 앞질러, 방금 연 뷰를 직전 화면의 닫기가
 * 죽인다(개발 모드의 effect 두 번 실행, 카드 연타 모두 같은 경합). 실측에서
 * 소개 화면이 "불러오지 못했습니다"로 뜬 원인이 이것이었다.
 */
let profileIpcChain: Promise<unknown> = Promise.resolve();
function serialProfileIpc<T>(run: () => Promise<T>): Promise<T> {
  const next = profileIpcChain.then(run, run);
  profileIpcChain = next.catch(() => undefined);
  return next;
}

export default function HubProfileEmbedPageWrapper() {
  return (
    <Suspense fallback={null}>
      <HubProfileEmbedPage />
    </Suspense>
  );
}

function HubProfileEmbedPage() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const { locale } = useT();
  const ko = locale === "ko";
  const slug = (searchParams.get("slug") ?? "").trim().toLowerCase();
  const title = searchParams.get("name") ?? slug;
  const hostRef = useRef<HTMLDivElement | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opened, setOpened] = useState(false);
  const [copied, setCopied] = useState(false);
  const [copyPending, setCopyPending] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  // 임베드는 CSS가 아니라 창 좌표로 놓인다 — 리사이즈·사이드바 접힘까지 이 한 함수로 따라간다.
  const readBounds = useCallback(() => {
    const host = hostRef.current;
    if (!host) return null;
    const rect = host.getBoundingClientRect();
    return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }, []);

  useEffect(() => {
    const api = ipc();
    if (!api?.marketplace?.openProfileView) {
      setError(ko ? "이 빌드에서는 소개 페이지를 열 수 없습니다." : "This build cannot open the profile view.");
      return;
    }
    if (!slug) {
      setError(ko ? "주소가 올바르지 않습니다." : "Invalid address.");
      return;
    }
    let cancelled = false;
    const bounds = readBounds();
    if (!bounds) return;
    const failed = () => {
      if (cancelled) return;
      setError(ko
        ? "소개 페이지를 불러오지 못했습니다. 네트워크를 확인해 주세요."
        : "The profile page could not be loaded. Check your connection.");
    };
    void serialProfileIpc(() => api.marketplace.openProfileView({ slug, bounds, locale }))
      .then((result) => {
        if (cancelled) return;
        if (!result.ok) { failed(); return; }
        setOpened(true);
      })
      .catch(() => { if (!cancelled) failed(); });
    return () => {
      cancelled = true;
      // 라우트를 떠나면 무조건 닫는다. 조건부로 닫으면 실패 경로에서 뷰가 살아남는다.
      void serialProfileIpc(() => api.marketplace.closeProfileView()).catch(() => undefined);
    };
  }, [slug, locale, ko, readBounds]);

  // 임베드 안의 링크가 웹의 다른 화면으로 가려 하면 데스크탑 허브로 되돌린다.
  // (브라우저를 열지 않는다 — 앱 안에서 같은 화면이 두 벌이 되는 것도 막는다.)
  useEffect(() => {
    const api = ipc();
    if (!api?.marketplace?.onProfileViewExit) return;
    return api.marketplace.onProfileViewExit(() => router.push("/marketplace"));
  }, [router]);

  useEffect(() => {
    if (!opened) return;
    const api = ipc();
    const host = hostRef.current;
    if (!api?.marketplace?.setProfileViewBounds || !host) return;
    const sync = () => {
      const bounds = readBounds();
      if (bounds) void api.marketplace.setProfileViewBounds(bounds).catch(() => undefined);
    };
    sync();
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(sync);
    observer?.observe(host);
    window.addEventListener("resize", sync);
    window.addEventListener("scroll", sync, true);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", sync);
      window.removeEventListener("scroll", sync, true);
    };
  }, [opened, readBounds]);

  useEffect(() => () => {
    if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
  }, []);

  const copyCall = useCallback(async () => {
    if (copyPending) return;
    setCopyPending(true);
    setCopied(false);
    setCopyError(false);
    try {
      if (!navigator.clipboard?.writeText) throw new Error("clipboard_unavailable");
      await navigator.clipboard.writeText(`/hep-call ${slug}`);
      setCopied(true);
      if (copiedTimerRef.current !== null) window.clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = window.setTimeout(() => {
        setCopied(false);
        copiedTimerRef.current = null;
      }, 1600);
    } catch {
      setCopyError(true);
    } finally {
      setCopyPending(false);
    }
  }, [copyPending, slug]);

  return (
    <section style={{ display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      {/* 데스크탑 액션 바 — 임베드된 웹 페이지는 이 앱의 기능을 부를 수 없으므로,
          앱이 해야 하는 일(뒤로 가기·호출어 복사)은 데스크탑 쪽에 남긴다. */}
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 10,
          padding: "12px 20px",
          borderBottom: "1px solid var(--paper-edge)",
          flexShrink: 0,
        }}
      >
        <button type="button" className="btn sm" onClick={() => router.push("/marketplace")}>
          ← {ko ? "허브로" : "Back to Hub"}
        </button>
        <strong
          style={{ fontSize: 13, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {title}
        </strong>
        <button
          type="button"
          className="btn sm"
          style={{ marginLeft: "auto" }}
          disabled={copyPending}
          onClick={() => { void copyCall(); }}
          title={ko ? "복사한 호출어를 대화에 붙여넣으세요." : "Paste the copied call into a conversation."}
        >
          {copyPending
            ? (ko ? "복사 중…" : "Copying…")
            : copied
              ? (ko ? "복사됨" : "Copied")
              : (ko ? "호출어 복사" : "Copy call")}
        </button>
        {copyError && (
          <span role="alert" style={{ fontSize: 11, color: "var(--danger)", lineHeight: 1.3 }}>
            {ko ? "복사 권한이 없어 자동 복사하지 못했습니다. 직접 선택하세요: " : "Clipboard access failed. Select the call directly: "}
            <code style={{ userSelect: "all", color: "var(--ink)" }}>{`/hep-call ${slug}`}</code>
          </span>
        )}
      </header>

      {/* 임베드가 놓일 자리. 실제 페이지는 이 사각형 위에 main이 얹는다. */}
      <div ref={hostRef} style={{ flex: 1, minHeight: 0, position: "relative" }}>
        {error ? (
          <div style={{ padding: 32, textAlign: "center", color: "var(--muted-deep)", fontSize: 13, lineHeight: 1.7 }}>
            {error}
            <div style={{ marginTop: 12 }}>
              <button type="button" className="btn sm" onClick={() => router.push("/marketplace")}>
                {ko ? "허브로 돌아가기" : "Back to Hub"}
              </button>
            </div>
          </div>
        ) : !opened ? (
          <div style={{ padding: 32, textAlign: "center", color: "var(--muted)", fontSize: 13 }}>
            {ko ? "소개를 불러오는 중입니다…" : "Loading the profile…"}
          </div>
        ) : null}
      </div>
    </section>
  );
}
