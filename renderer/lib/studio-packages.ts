// forge web 패키지 레지스트리 — 정식 정의는 shared/studio-packages.ts (SSOT).
// renderer는 여기서 그대로 re-export (types.ts → shared/types.ts와 동일 패턴).
export type { StudioPackage } from "@shared/studio-packages";
export { STUDIO_PACKAGES, findStudioPackage } from "@shared/studio-packages";
