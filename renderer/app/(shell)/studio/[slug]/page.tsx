// Studio web 임베드 라우트 — /studio/<slug>.
// forge web 패키지(SSOT)를 localhost로 띄워 전체화면 iframe으로 임베드한다.
//
// 이 앱은 production에서 next export(정적)라 동적 세그먼트 [slug]는 generateStaticParams로
// 알려진 slug만 사전 렌더한다. 실제 serve→url→iframe 로직은 클라이언트(StudioFrame).
import { STUDIO_PACKAGES } from "@/lib/studio-packages";
import { StudioFrame } from "./StudioFrame";

// 정적 export — 레지스트리의 모든 slug를 사전 생성. 미지의 slug는 404(dynamicParams=false).
export function generateStaticParams(): Array<{ slug: string }> {
  return STUDIO_PACKAGES.map((p) => ({ slug: p.slug }));
}

export const dynamicParams = false;

export default function StudioPage() {
  return <StudioFrame />;
}
