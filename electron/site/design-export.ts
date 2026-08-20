/**
 * 디자인 → 코드 내보내기.
 *
 * Site 축은 **디자인 생성기**다(오너 정의 2026-08-20): 웹 화면과 앱 화면을 만들어 준다.
 * 편집·미리보기의 정본은 자족 HTML 문서 하나이고(선택·패치·오버레이가 전부 그 위에서 돈다),
 * 이 모듈은 그 승인된 화면을 **개발자가 가져갈 코드**로 옮긴다.
 *
 * 왜 모델이 변환하는가: HTML→JSX 는 기계 변환이 가능하지만 그렇게 뽑은 결과는 거대한
 * 단일 컴포넌트라 아무도 쓰지 않는다. 컴포넌트 분해·명명·상태 추출은 판단이고, 이 제품의
 * 규칙상 판단은 모델이 한다. 대신 **형태 계약**(파일 목록·확장자·펜스)만 여기서 강제한다.
 *
 * 배포는 이 모듈의 일이 아니다 — 디자인과 코드까지가 지금 범위다(배포는 agent-app-publish).
 */
import type { SiteSurface } from "../../shared/site-studio";

export type SiteExportTarget = "react" | "html" | "flutter" | "react-native";

export interface SiteExportFile {
  path: string;
  content: string;
}

export interface SiteExportResult {
  ok: boolean;
  target: SiteExportTarget;
  files?: SiteExportFile[];
  /** 사람이 읽는 요약 — 무엇을 어떻게 쪼갰는지. */
  notes?: string;
  engine?: string;
  reason?: string;
}

/** 표면별로 고를 수 있는 내보내기 대상. 앱 화면을 React 웹으로 뽑는 것은 막지 않는다(프로토타입 용도). */
export function exportTargetsFor(surface: SiteSurface): SiteExportTarget[] {
  return surface === "mobile"
    ? ["flutter", "react-native", "html", "react"]
    : ["react", "html"];
}

const TARGET_SPEC: Record<SiteExportTarget, { label: string; contract: string[] }> = {
  html: {
    label: "HTML + CSS",
    contract: [
      "Split the single document into `index.html` and `styles.css`, keeping the rendered result pixel-identical.",
      "Keep every interaction that existed inline; move it to `app.js` only if the document had a <script>.",
    ],
  },
  react: {
    label: "React + TypeScript",
    contract: [
      "Emit a React 19 function component tree in TypeScript (`.tsx`). Decompose the screen into the components a developer would actually keep — never one giant component.",
      "Styling: CSS Modules (`*.module.css`) that reproduce the design exactly. No Tailwind, no CSS-in-JS, no external UI kit.",
      "Root component file is `App.tsx`. Repeated content becomes data (arrays) rendered with `.map()`, not copy-pasted markup.",
      "No data fetching, no router, no state management library. Local `useState` only where the design has real interaction.",
    ],
  },
  flutter: {
    label: "Flutter",
    contract: [
      "Emit Dart for Flutter 3.x: `lib/main.dart` plus one file per meaningful widget under `lib/widgets/`.",
      "Use Material 3 (`useMaterial3: true`) with a ColorScheme that reproduces the design's palette. Respect SafeArea; use Scaffold/AppBar/NavigationBar where the design shows those affordances.",
      "No packages beyond the Flutter SDK. No network calls. Repeated content becomes a const list rendered by ListView/GridView builders.",
    ],
  },
  "react-native": {
    label: "React Native",
    contract: [
      "Emit React Native (TypeScript): `App.tsx` plus one file per meaningful component under `components/`.",
      "Styling: `StyleSheet.create` objects colocated with each component. Use SafeAreaView; no external UI kit and no navigation library — model navigation chrome as plain views.",
      "No network calls. Repeated content becomes a data array rendered with FlatList.",
    ],
  },
};

/** 파일 펜스 계약 — 모델이 여러 파일을 낼 유일한 모양. 파서와 한 쌍이다. */
export function exportOutputContract(target: SiteExportTarget): string {
  const spec = TARGET_SPEC[target];
  return [
    `TASK: convert the approved screen below into ${spec.label} source, preserving the design exactly.`,
    "",
    "TARGET RULES:",
    ...spec.contract.map((line) => `- ${line}`),
    "",
    "OUTPUT CONTRACT (a validator rejects violations):",
    "- First output exactly one <agentlas-feedback>…</agentlas-feedback> block: 2–4 sentences on how you split the screen and why. Never expose private reasoning or tool logs.",
    "- Then output every file, each as its own fenced block immediately preceded by a line of the exact form `FILE: <relative/path>`.",
    "- Emit no prose between or after the file blocks. Emit no file you did not actually write.",
    "- Reproduce the design faithfully: same layout, spacing, palette, typography scale, and copy. Do not redesign, do not add features, do not add placeholder TODOs.",
  ].join("\n");
}

const FILE_BLOCK_RE = /^FILE:\s*([A-Za-z0-9._\-/]{1,120})\s*$\r?\n```[a-zA-Z0-9+-]*\r?\n([\s\S]*?)```/gm;

/**
 * 모델 답에서 파일들을 꺼낸다. 경로 탈출·절대경로·중복은 거절한다 —
 * 내보내기는 사용자가 고른 폴더에 실제로 쓰이므로 여기가 경계다.
 */
export function parseExportedFiles(reply: string): { files: SiteExportFile[]; errors: string[] } {
  const files: SiteExportFile[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  FILE_BLOCK_RE.lastIndex = 0;
  for (let match = FILE_BLOCK_RE.exec(reply); match; match = FILE_BLOCK_RE.exec(reply)) {
    const rawPath = match[1].trim();
    const content = match[2];
    if (rawPath.startsWith("/") || rawPath.includes("..") || rawPath.includes("\0")) {
      errors.push(`unsafe path: ${rawPath}`);
      continue;
    }
    if (seen.has(rawPath)) {
      errors.push(`duplicate file: ${rawPath}`);
      continue;
    }
    if (!content.trim()) {
      errors.push(`empty file: ${rawPath}`);
      continue;
    }
    seen.add(rawPath);
    files.push({ path: rawPath, content });
  }
  if (files.length === 0) errors.push("no FILE: blocks in the reply");
  return { files, errors };
}

/** 대상별 최소 산출물 — 이게 없으면 "변환했다"는 말이 거짓이 된다. */
export function validateExportedFiles(target: SiteExportTarget, files: SiteExportFile[]): string[] {
  const paths = files.map((file) => file.path);
  const has = (suffix: string) => paths.some((path) => path.endsWith(suffix));
  const errors: string[] = [];
  if (target === "react") {
    if (!paths.includes("App.tsx") && !has("/App.tsx")) errors.push("missing App.tsx");
    if (!has(".module.css")) errors.push("missing a CSS module");
  }
  if (target === "html") {
    if (!has("index.html")) errors.push("missing index.html");
    if (!has(".css")) errors.push("missing a stylesheet");
  }
  if (target === "flutter") {
    if (!paths.includes("lib/main.dart")) errors.push("missing lib/main.dart");
    if (files.some((file) => /^import\s+'package:(?!flutter\/)/m.test(file.content))) {
      errors.push("non-SDK package import");
    }
  }
  if (target === "react-native") {
    if (!paths.includes("App.tsx")) errors.push("missing App.tsx");
    if (!files.some((file) => file.content.includes("StyleSheet.create"))) {
      errors.push("missing StyleSheet.create styling");
    }
  }
  return errors;
}

/** 내보내기 프롬프트 — 승인된 화면이 유일한 진실 원본이다. */
export function buildExportPrompt(
  html: string,
  target: SiteExportTarget,
  surface: SiteSurface,
  retryErrors: string[] | null,
): string {
  return [
    exportOutputContract(target),
    surface === "mobile"
      ? "SOURCE NOTE: the screen below is an app screen drawn as HTML for preview. Translate its intent into native app structure — do not carry web-only constructs (media queries, hover states, page scrolling chrome) into the output."
      : "SOURCE NOTE: the screen below is the approved web design. Keep its responsive behaviour.",
    `APPROVED SCREEN:\n\`\`\`html\n${html}\n\`\`\``,
    retryErrors && retryErrors.length
      ? `YOUR PREVIOUS OUTPUT WAS REJECTED:\n- ${retryErrors.join("\n- ")}\nOutput the corrected file set.`
      : "",
  ]
    .filter(Boolean)
    .join("\n\n");
}
