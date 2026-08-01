// SPA 내비게이션 헬퍼.
//
// 주의(중요): static export를 agentlas://·file://로 띄우는 데스크톱 셸에서
// window.location 기반 hard navigation은 브라우저가 새 document를 protocol 핸들러로
// 로드한다. packaged(asar) 환경에서 이 경로가 Next.js RSC(.txt, text/plain) 페이로드를
// 메인 document로 로드해버려 화면에 self.__next_f.push(...) 원시 텍스트가 노출되는
// 버그를 일으킬 수 있다(특히 /workspace/task?id=... 전환).
//
// 따라서 App Router의 router.push/replace(soft navigation)를 우선 사용한다.
// soft navigation은 document를 교체하지 않고 RSC만 클라이언트에서 처리하므로 안전하다.
// (history.pushState + popstate 직접 조작은 App Router 내부 상태와 어긋날 수 있어 지양.)
// 라우터가 아직 등록되지 않은 초기 렌더 등에서만 window.location으로 폴백한다.
// 라우터 등록은 AppShell이 마운트 시 registerRouter()로 수행한다.

type SoftRouter = {
  push: (href: string) => void;
  replace: (href: string) => void;
};

let routerRef: SoftRouter | null = null;

export function registerRouter(router: SoftRouter | null): void {
  routerRef = router;
}

export function navigate(path: string, mode: "assign" | "replace" = "assign") {
  if (routerRef) {
    if (mode === "replace") routerRef.replace(path);
    else routerRef.push(path);
    return;
  }
  // 폴백 — 라우터 미등록(예: 셸 마운트 전). hard navigation이지만 동작은 한다.
  if (typeof window === "undefined") return;
  if (mode === "replace") window.location.replace(path);
  else window.location.assign(path);
}
