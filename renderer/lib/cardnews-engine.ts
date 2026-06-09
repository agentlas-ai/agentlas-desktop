import type { AppFactoryAppRecord } from "@/lib/types";

export type CardnewsFormatId = "square" | "portrait" | "threefour" | "story";
export type CardnewsLanguage = "ko" | "en";
export type CardnewsTemplateId = "signal" | "ledger" | "blueprint" | "contrast";

export interface CardnewsFormatSpec {
  label: string;
  width: number;
  height: number;
  hint: string;
}

export interface CardnewsResearchBrief {
  headline: string;
  points: string[];
  keywords: string[];
}

export interface CardnewsSlideDraft {
  kicker: string;
  title: string;
  body: string;
  footer: string;
}

export interface CardnewsTemplateSpec {
  id: CardnewsTemplateId;
  name: string;
  mood: string;
  tags: string[];
  bestFor: string;
}

export const CARDNEWS_FORMATS: Record<CardnewsFormatId, CardnewsFormatSpec> = {
  square: { label: "1:1", width: 1080, height: 1080, hint: "Feed" },
  portrait: { label: "4:5", width: 1080, height: 1350, hint: "Instagram" },
  threefour: { label: "3:4", width: 1080, height: 1440, hint: "Tall" },
  story: { label: "9:16", width: 1080, height: 1920, hint: "Story" },
};

export const CARDNEWS_TEMPLATES: CardnewsTemplateSpec[] = [
  {
    id: "signal",
    name: "Signal Stack",
    mood: "high-contrast editorial",
    tags: ["ai", "tech", "github", "news", "trend", "signal", "analysis", "모델", "기술"],
    bestFor: "AI 테크 뉴스, GitHub repo 소개, 모델 비교",
  },
  {
    id: "ledger",
    name: "Source Ledger",
    mood: "research notes",
    tags: ["research", "source", "evidence", "explain", "교육", "리서치", "근거"],
    bestFor: "근거 중심 설명, 리서치 요약, 저장용 체크리스트",
  },
  {
    id: "blueprint",
    name: "Workflow Blueprint",
    mood: "operator guide",
    tags: ["workflow", "how", "guide", "automation", "app", "자동화", "가이드"],
    bestFor: "사용법, 자동화 흐름, 단계별 튜토리얼",
  },
  {
    id: "contrast",
    name: "Compare Board",
    mood: "comparison grid",
    tags: ["compare", "vs", "alternative", "ranking", "비교", "선택"],
    bestFor: "모델/도구 비교, 대안 정리, 선택 기준",
  },
];

export function isCardnewsApp(app: AppFactoryAppRecord): boolean {
  const manifest = app.manifest;
  const haystack = [
    app.appName,
    manifest.title,
    manifest.domain,
    manifest.layout,
    manifest.app?.name,
    manifest.app?.appType,
    manifest.app?.tagline,
    manifest.app?.valueProp,
    manifest.app?.audience,
    ...(manifest.app?.routes ?? []).flatMap((route) => [route.label, route.path, route.purpose]),
    ...(manifest.widgets ?? []).map((widget) => widget.title),
  ].filter(Boolean).join(" ").toLowerCase();

  return /cardnews|card news|carousel|instagram|insta|카드뉴스|카로셀|캐러셀|인스타/.test(haystack);
}

export function initialCardnewsTopic(app: AppFactoryAppRecord, locale: CardnewsLanguage): string {
  const text = app.manifest.app?.valueProp || app.manifest.app?.tagline || app.manifest.title || app.appName;
  if (text && text.length <= 80) return text;
  return locale === "en"
    ? "Why AI agents are becoming app builders"
    : "AI 에이전트가 앱 빌더가 되는 이유";
}

export function buildCardnewsResearch(topic: string, language: CardnewsLanguage): CardnewsResearchBrief {
  const clean = topic.trim() || (language === "en" ? "Untitled topic" : "이름 없는 주제");
  const tokens = clean.toLowerCase().split(/[^a-z0-9가-힣]+/).filter(Boolean).slice(0, 8);
  const ko = language === "ko";
  return {
    headline: ko ? `${clean} 리서치 브리프` : `${clean} research brief`,
    keywords: Array.from(new Set([...tokens, ...(ko ? ["실전", "비교", "전환", "근거"] : ["practical", "comparison", "conversion", "evidence"])])),
    points: ko
      ? [
          `${clean}의 핵심 변화는 사용자가 복잡한 설정보다 바로 보이는 결과를 기대한다는 점입니다.`,
          "초보자는 개념 설명보다 따라 할 수 있는 단계, 예시, 저장 가능한 요약에 반응합니다.",
          "좋은 카드뉴스는 한 장에 하나의 주장만 남기고, 다음 장으로 넘어갈 이유를 명확히 둡니다.",
          "마지막 장은 체크리스트, 비교표, 다음 행동처럼 저장할 이유가 있어야 합니다.",
        ]
      : [
          `${clean} matters because users increasingly expect visible outcomes before complex setup.`,
          "Beginners respond to steps, examples, and save-worthy summaries more than abstract explanation.",
          "A strong carousel keeps one claim per slide and gives each slide a reason to continue.",
          "The final slide should offer a checklist, comparison, or next action worth saving.",
        ],
  };
}

export function scoreCardnewsTemplates(keywords: string[], topic: string) {
  const raw = `${topic} ${keywords.join(" ")}`.toLowerCase();
  return CARDNEWS_TEMPLATES.map((template) => {
    const matches = template.tags.filter((tag) => raw.includes(tag.toLowerCase()));
    const score = matches.length * 2;
    const reason = matches.length
      ? `${matches.join(", ")} signal matched.`
      : "No direct keyword match; ranked by cardnews readability.";
    return { template, score, reason };
  }).sort((a, b) => b.score - a.score || a.template.name.localeCompare(b.template.name));
}

export function angleForCardnewsTopic(topic: string, language: CardnewsLanguage): string {
  if (language === "ko") {
    return `${topic}을 설명문이 아니라 저장 가능한 카드 흐름으로 바꿉니다. 첫 장은 문제를 압축하고, 중간 장은 선택 기준과 실행 흐름을 보여주고, 마지막 장은 체크리스트로 닫습니다.`;
  }
  return `Turn ${topic} into a save-worthy card flow. Open with the problem, use the middle slides for criteria and workflow, and close with a checklist.`;
}

export function composeCardnewsSlides(input: {
  topic: string;
  language: CardnewsLanguage;
  audience: string;
  tone: string;
  research: CardnewsResearchBrief;
  pageCount: number;
}): CardnewsSlideDraft[] {
  const ko = input.language === "ko";
  const topic = input.topic.trim() || (ko ? "카드뉴스 주제" : "Carousel topic");
  const base: CardnewsSlideDraft[] = ko
    ? [
        { kicker: "01 / 문제", title: topic, body: `${input.audience}가 지금 헷갈리는 지점을 한 문장으로 정리합니다.`, footer: input.tone },
        { kicker: "02 / 변화", title: "왜 지금 중요할까", body: input.research.points[0], footer: "Research draft" },
        { kicker: "03 / 기준", title: "좋은 선택 기준", body: input.research.points[1], footer: "Save this" },
        { kicker: "04 / 흐름", title: "바로 쓰는 흐름", body: input.research.points[2], footer: "Agentlas App" },
        { kicker: "05 / 체크", title: "마지막 체크리스트", body: input.research.points[3], footer: "PNG/JPG export" },
        { kicker: "06 / 예시", title: "한 줄 예시", body: `${topic}을 설명이 아니라 결과물 중심으로 보여줍니다.`, footer: "Editable cards" },
        { kicker: "07 / 다음", title: "다음 행동", body: "주제, 대상, 포맷을 바꿔 다시 생성하고 가장 저장하고 싶은 세트를 고릅니다.", footer: "Done in Agentlas" },
      ]
    : [
        { kicker: "01 / Problem", title: topic, body: `Frame the confusion ${input.audience} feels right now.`, footer: input.tone },
        { kicker: "02 / Shift", title: "Why it matters now", body: input.research.points[0], footer: "Research draft" },
        { kicker: "03 / Criteria", title: "What to look for", body: input.research.points[1], footer: "Save this" },
        { kicker: "04 / Flow", title: "The usable workflow", body: input.research.points[2], footer: "Agentlas App" },
        { kicker: "05 / Check", title: "Final checklist", body: input.research.points[3], footer: "PNG/JPG export" },
        { kicker: "06 / Example", title: "One-line example", body: `Show ${topic} through output, not setup language.`, footer: "Editable cards" },
        { kicker: "07 / Next", title: "Next action", body: "Change topic, audience, and format, then export the strongest set.", footer: "Done in Agentlas" },
      ];
  return base.slice(0, input.pageCount).map((slide, index) => ({
    ...slide,
    kicker: slide.kicker.replace(/^\d+/, String(index + 1).padStart(2, "0")),
  }));
}

export function renderCardnewsSlideCanvas(
  slide: CardnewsSlideDraft,
  template: CardnewsTemplateId,
  size: { width: number; height: number },
  index: number,
  total: number,
): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const palette = paletteForCardnewsTemplate(template);
  const margin = size.width * 0.075;
  const rail = size.width * 0.018;
  const top = size.height * 0.075;
  const innerW = size.width - margin * 2;
  const innerH = size.height - top * 2;

  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.fillStyle = palette.paper;
  sharpPanel(ctx, margin, top, innerW, innerH);
  ctx.fill();
  ctx.fillStyle = palette.accent;
  ctx.fillRect(margin, top, rail, innerH);

  ctx.fillStyle = palette.muted;
  ctx.font = `800 ${Math.round(size.width * 0.028)}px ${canvasFont()}`;
  ctx.fillText(slide.kicker.toUpperCase(), margin + size.width * 0.052, top + size.height * 0.085);

  ctx.fillStyle = palette.ink;
  ctx.font = `900 ${Math.round(size.width * 0.074)}px ${canvasFont()}`;
  drawWrappedText(ctx, slide.title, margin + size.width * 0.052, top + size.height * 0.22, innerW * 0.78, size.width * 0.087, 3);

  ctx.fillStyle = palette.soft;
  ctx.font = `600 ${Math.round(size.width * 0.039)}px ${canvasFont()}`;
  drawWrappedText(ctx, slide.body, margin + size.width * 0.052, top + size.height * 0.49, innerW * 0.8, size.width * 0.058, 7);

  ctx.fillStyle = palette.accentSoft;
  ctx.fillRect(margin + size.width * 0.052, top + innerH - size.height * 0.14, innerW * 0.52, 2);
  ctx.fillStyle = palette.muted;
  ctx.font = `800 ${Math.round(size.width * 0.027)}px ${canvasFont()}`;
  ctx.fillText(slide.footer, margin + size.width * 0.052, top + innerH - size.height * 0.07);

  const page = `${String(index).padStart(2, "0")} / ${String(total).padStart(2, "0")}`;
  const metric = ctx.measureText(page);
  ctx.fillStyle = palette.accent;
  ctx.fillText(page, margin + innerW - metric.width - size.width * 0.052, top + innerH - size.height * 0.07);
  return canvas;
}

export function cardnewsCssPalette(template: CardnewsTemplateId) {
  return paletteForCardnewsTemplate(template);
}

function paletteForCardnewsTemplate(template: CardnewsTemplateId) {
  if (template === "ledger") {
    return { bg: "#e7eef3", paper: "#ffffff", ink: "#172033", soft: "#4d5d73", muted: "#7b8798", accent: "#1e7f68", accentSoft: "#9ed8c5" };
  }
  if (template === "blueprint") {
    return { bg: "#10151d", paper: "#eef5ff", ink: "#10233f", soft: "#344b68", muted: "#5d7494", accent: "#2563eb", accentSoft: "#8bb6ff" };
  }
  if (template === "contrast") {
    return { bg: "#151316", paper: "#fff7ea", ink: "#1d1711", soft: "#5c4c3c", muted: "#7e6f60", accent: "#d94b2b", accentSoft: "#f5b19d" };
  }
  return { bg: "#091015", paper: "#f8fafc", ink: "#0e1726", soft: "#425066", muted: "#6a788d", accent: "#ff6b2b", accentSoft: "#ffc0a4" };
}

function canvasFont(): string {
  return `"Inter", "Apple SD Gothic Neo", "Noto Sans KR", Arial, sans-serif`;
}

function sharpPanel(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number) {
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.closePath();
}

function drawWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  const words = text.split(/\s+/).filter(Boolean);
  let line = "";
  let drawn = 0;
  for (const word of words) {
    const next = line ? `${line} ${word}` : word;
    if (ctx.measureText(next).width > maxWidth && line) {
      ctx.fillText(line, x, y + drawn * lineHeight);
      drawn += 1;
      line = word;
      if (drawn >= maxLines) return;
    } else {
      line = next;
    }
  }
  if (line && drawn < maxLines) ctx.fillText(line, x, y + drawn * lineHeight);
}
