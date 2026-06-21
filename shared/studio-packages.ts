// forge web 패키지 레지스트리 (SSOT) — "forge web 패키지 = GUI의 단일 소스".
// 데스크탑은 각 패키지의 web/dist를 localhost로 띄워(런처) iframe으로 임베드한다.
//
// 이 모듈은 electron(main: studio/serve.ts)과 renderer(lib/studio-packages.ts re-export)
// 양쪽에서 import한다. renderer는 sandbox라 node:* 를 못 쓰므로 path 조립은 순수 문자열.
// 로컬 데스크탑 앱이라 패키지 절대경로 하드코딩 OK. AGENTLAS_FORGE_ROOT가 있으면 우선.

/** forge Paid 패키지 루트. 환경변수가 있으면 우선, 없으면 로컬 절대경로. */
function forgeRoot(): string {
  const fromEnv =
    typeof process !== "undefined" ? process.env?.AGENTLAS_FORGE_ROOT?.trim() : undefined;
  if (fromEnv) return fromEnv.replace(/\/+$/, "");
  return "/Users/mason/Documents/Hephaestus_agent_forge/Paid";
}

function join(base: string, child: string): string {
  return `${base.replace(/\/+$/, "")}/${child.replace(/^\/+/, "")}`;
}

export interface StudioPackage {
  /** 라우트 slug — /studio/<slug> */
  slug: string;
  /** 한국어 표시명 */
  name: string;
  /** 영어 표시명 */
  nameEn: string;
  /** 한 줄 설명 (한국어) */
  tagline: string;
  /** 한 줄 설명 (영어) */
  taglineEn: string;
  /** 패키지 루트 절대경로 (런처 cwd) */
  packageDir: string;
  /** open-*-gui.py 런처의 packageDir 기준 상대경로 */
  launcher: string;
  /** 사이드바/UI 악센트 색 */
  accent: string;
}

export const STUDIO_PACKAGES: StudioPackage[] = [
  {
    slug: "startup",
    name: "Startup 파운더 스튜디오",
    nameEn: "Startup Founder Studio",
    tagline: "아이디어→검증→사업계획→PRD→빌드",
    taglineEn: "Idea → validation → business plan → PRD → build",
    packageDir: join(forgeRoot(), "agentlas-startup-founder-studio"),
    launcher: "scripts/open-studio-gui.py",
    accent: "#f97316",
  },
  {
    slug: "oberon",
    name: "Oberon 영화 스튜디오",
    nameEn: "Oberon Film Studio",
    tagline: "AI 영화 운영체제",
    taglineEn: "AI Film Operating System",
    packageDir: join(forgeRoot(), "ai-film-operating-system"),
    launcher: "scripts/open-aifilm-gui.py",
    accent: "#7c3aed",
  },
];

export function findStudioPackage(slug: string): StudioPackage | undefined {
  return STUDIO_PACKAGES.find((p) => p.slug === slug);
}
