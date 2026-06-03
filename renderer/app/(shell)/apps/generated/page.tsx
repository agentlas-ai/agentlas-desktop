"use client";
import { useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import {
  buildGeneratedAppBlueprint,
  createGeneratedOutputs,
  demoGeneratedApp,
  initialFieldValues,
  serializeGeneratedOutputs,
  type GeneratedAppBlueprint,
  type GeneratedAppExportFormat,
  type GeneratedAppField,
  type GeneratedAppFieldValues,
  type GeneratedAppOutput,
  type GeneratedAppRecommendation,
} from "@/lib/generated-app-engine";
import type { AppFactoryAppRecord } from "@/lib/types";
import {
  IconApps,
  IconCheck,
  IconChevronRight,
  IconEdit,
  IconFileUp,
  IconImage,
  IconWand,
} from "@/components/Icon";

type FormatId = "square" | "portrait" | "story" | "threefour";
type ExportFormat = "png" | "jpg";
type TemplateId = "instrument" | "clean" | "grid" | "portrait";
type LanguageId = "ko" | "en";

interface ResearchBrief {
  headline: string;
  points: string[];
  keywords: string[];
}

interface SlideDraft {
  kicker: string;
  title: string;
  body: string;
  footer: string;
}

const FORMATS: Record<FormatId, { label: string; width: number; height: number; hint: string }> = {
  square: { label: "1:1", width: 1080, height: 1080, hint: "Feed" },
  portrait: { label: "4:5", width: 1080, height: 1350, hint: "Instagram" },
  threefour: { label: "3:4", width: 1080, height: 1440, hint: "Tall" },
  story: { label: "9:16", width: 1080, height: 1920, hint: "Story" },
};

const TEMPLATES: Array<{
  id: TemplateId;
  name: string;
  tags: string[];
  bestFor: string;
}> = [
  {
    id: "instrument",
    name: "Automotive Instrument",
    tags: ["technical", "dark", "engineering", "mission-critical", "ai", "github"],
    bestFor: "기술 분석, 인프라, AI/개발자 주제",
  },
  {
    id: "clean",
    name: "BRIX Clean SaaS",
    tags: ["saas", "startup", "clean", "blue", "product"],
    bestFor: "SaaS 설명, 제품 소개, 서비스 교육",
  },
  {
    id: "grid",
    name: "Fabled Grid Series",
    tags: ["gallery", "examples", "comparison", "design", "collection"],
    bestFor: "비교, 큐레이션, 예시 모음",
  },
  {
    id: "portrait",
    name: "Atik Portrait Stack",
    tags: ["tutorial", "step", "education", "guide", "creator"],
    bestFor: "튜토리얼, 단계별 가이드, 크리에이터 교육",
  },
];

function queryAppId(): string | null {
  if (typeof window === "undefined") return null;
  return new URLSearchParams(window.location.search).get("id");
}

export default function GeneratedAppPage() {
  const { locale } = useT();
  const [appId, setAppId] = useState<string | null>(null);
  const [app, setApp] = useState<AppFactoryAppRecord | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const id = queryAppId();
    setAppId(id);
    const api = ipc();
    if (!api || !id) {
      setApp(id ? demoGeneratedApp(id, locale) : null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    void api.appFactory.getApp(id).then((record) => {
      if (!cancelled) {
        setApp(record ?? demoGeneratedApp(id, locale));
        setLoading(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [locale]);

  const appName = app?.appName || app?.manifest.app?.name || app?.manifest.title || "Generated App";

  if (loading) {
    return (
      <GeneratedShell title="Generated App" subtitle={locale === "en" ? "Loading App" : "App 로딩 중"}>
        <div style={emptyState}>{locale === "en" ? "Loading..." : "불러오는 중..."}</div>
      </GeneratedShell>
    );
  }

  if (!app) {
    return (
      <GeneratedShell title="Generated App" subtitle={locale === "en" ? "Not found" : "찾을 수 없음"}>
        <div style={emptyState}>
          {locale === "en" ? "This generated App is not available." : "이 생성 App을 찾을 수 없습니다."}
        </div>
      </GeneratedShell>
    );
  }

  return (
    <GeneratedShell title={appName} subtitle={app.manifest.domain || app.manifest.layout}>
      <GeneratedAppRunner app={app} />
    </GeneratedShell>
  );
}

function GeneratedShell({
  title,
  subtitle,
  children,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column", background: "var(--paper)" }}>
      <header className="titlebar-drag glass-thin" style={appHeader}>
        <Link href="/apps" className="titlebar-nodrag" style={backLink}>
          <IconApps size={15} />
          Apps
        </Link>
        <IconChevronRight size={12} style={{ color: "var(--muted)" }} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <h1 style={appTitle}>{title}</h1>
          <div style={appSubtitle}>{subtitle}</div>
        </div>
        <div className="titlebar-nodrag" style={livePill}>
          <span style={liveDot} />
          Internal App
        </div>
      </header>
      {children}
    </div>
  );
}

function CardnewsStudio() {
  const { locale } = useT();
  const [step, setStep] = useState(0);
  const [topic, setTopic] = useState(
    locale === "en"
      ? "Why AI agents are becoming app builders"
      : "AI 에이전트가 앱 빌더가 되는 이유",
  );
  const [language, setLanguage] = useState<LanguageId>(locale);
  const [audience, setAudience] = useState(locale === "en" ? "solo creators and founders" : "1인 크리에이터와 창업자");
  const [tone, setTone] = useState(locale === "en" ? "clear and practical" : "명확하고 실전적인 톤");
  const [format, setFormat] = useState<FormatId>("portrait");
  const [pageCount, setPageCount] = useState(5);
  const [exportFormat, setExportFormat] = useState<ExportFormat>("png");
  const [templateId, setTemplateId] = useState<TemplateId>("instrument");
  const [editingSlides, setEditingSlides] = useState<SlideDraft[] | null>(null);
  const [exporting, setExporting] = useState(false);

  const research = useMemo(() => buildResearch(topic, language), [topic, language]);
  const rankedTemplates = useMemo(() => scoreTemplates(research.keywords, topic), [research.keywords, topic]);
  const slides = useMemo(
    () => editingSlides ?? composeSlides({ topic, language, audience, tone, research, pageCount }),
    [audience, editingSlides, language, pageCount, research, tone, topic],
  );
  const selectedTemplate = TEMPLATES.find((template) => template.id === templateId) ?? TEMPLATES[0];
  const size = FORMATS[format];

  useEffect(() => {
    if (rankedTemplates.length > 0 && !editingSlides) {
      setTemplateId(rankedTemplates[0].template.id);
    }
  }, [editingSlides, rankedTemplates]);

  function next() {
    if (step < 4) setStep((v) => v + 1);
  }

  function previous() {
    if (step > 0) setStep((v) => v - 1);
  }

  function updateSlide(index: number, patch: Partial<SlideDraft>) {
    const base = editingSlides ?? slides;
    setEditingSlides(base.map((slide, i) => (i === index ? { ...slide, ...patch } : slide)));
  }

  async function exportAll() {
    setExporting(true);
    try {
      for (let i = 0; i < slides.length; i += 1) {
        const canvas = renderSlideCanvas(slides[i], selectedTemplate.id, size, i + 1);
        await downloadCanvas(canvas, `${slugify(topic)}-${String(i + 1).padStart(2, "0")}`, exportFormat);
      }
    } finally {
      setExporting(false);
    }
  }

  return (
    <main style={studioShell}>
      <aside style={wizardRail}>
        <div style={brandBlock}>
          <div style={brandIcon}>
            <IconImage size={20} />
          </div>
          <div>
            <strong style={{ color: "var(--ink)" }}>Cardnews Studio</strong>
            <div style={{ color: "var(--muted-deep)", fontSize: 11.5 }}>Instagram output</div>
          </div>
        </div>
        {[
          locale === "en" ? "Topic" : "주제",
          locale === "en" ? "Research" : "리서치",
          locale === "en" ? "Template" : "템플릿",
          locale === "en" ? "Format" : "포맷",
          locale === "en" ? "Export" : "내보내기",
        ].map((label, index) => (
          <button
            key={label}
            onClick={() => setStep(index)}
            style={{
              ...stepButton,
              background: step === index ? "var(--paper)" : "transparent",
              borderColor: step === index ? "var(--accent)" : "transparent",
              color: step === index ? "var(--ink)" : "var(--muted-deep)",
            }}
          >
            <span style={{ ...stepIndex, background: step >= index ? "var(--accent)" : "var(--paper-edge)" }}>
              {index + 1}
            </span>
            {label}
          </button>
        ))}
      </aside>

      <section style={workArea}>
        <div style={workTop}>
          <div style={{ minWidth: 0 }}>
            <h2 style={workTitle}>{stepTitle(step, locale)}</h2>
            <div style={workMeta}>
              {size.width}x{size.height} · {pageCount} pages · {selectedTemplate.name}
            </div>
          </div>
          <div style={toolbar}>
            <button onClick={previous} disabled={step === 0} style={secondaryBtn}>
              {locale === "en" ? "Back" : "이전"}
            </button>
            {step < 4 ? (
              <button onClick={next} style={primaryBtn}>
                {locale === "en" ? "Next" : "다음"}
                <IconChevronRight size={13} />
              </button>
            ) : (
              <button onClick={exportAll} style={primaryBtn} disabled={exporting}>
                <IconFileUp size={13} />
                {exporting ? (locale === "en" ? "Exporting" : "저장 중") : `${exportFormat.toUpperCase()} ${locale === "en" ? "save all" : "일괄 저장"}`}
              </button>
            )}
          </div>
        </div>

        {step === 0 && (
          <div style={formGrid}>
            <label style={fieldLabel}>
              {locale === "en" ? "Topic" : "주제"}
              <textarea value={topic} onChange={(e) => { setTopic(e.target.value); setEditingSlides(null); }} rows={5} style={bigInput} />
            </label>
            <div style={stack}>
              <Segmented
                value={language}
                onChange={(value) => { setLanguage(value as LanguageId); setEditingSlides(null); }}
                options={[
                  { id: "ko", label: "한국어" },
                  { id: "en", label: "English" },
                ]}
              />
              <label style={fieldLabel}>
                {locale === "en" ? "Audience" : "대상"}
                <input value={audience} onChange={(e) => { setAudience(e.target.value); setEditingSlides(null); }} style={input} />
              </label>
              <label style={fieldLabel}>
                {locale === "en" ? "Tone" : "톤"}
                <input value={tone} onChange={(e) => { setTone(e.target.value); setEditingSlides(null); }} style={input} />
              </label>
            </div>
          </div>
        )}

        {step === 1 && (
          <div style={twoColumn}>
            <section style={panel}>
              <h3 style={panelTitle}>{research.headline}</h3>
              <div style={researchList}>
                {research.points.map((point, i) => (
                  <div key={point} style={researchRow}>
                    <span style={researchNo}>{i + 1}</span>
                    <span>{point}</span>
                  </div>
                ))}
              </div>
            </section>
            <section style={panel}>
              <h3 style={panelTitle}>{locale === "en" ? "Storyboard angle" : "스토리 각도"}</h3>
              <div style={angleBox}>{angleForTopic(topic, language)}</div>
              <div style={tagWrap}>
                {research.keywords.map((keyword) => (
                  <span key={keyword} style={tag}>{keyword}</span>
                ))}
              </div>
            </section>
          </div>
        )}

        {step === 2 && (
          <div style={templateList}>
            {rankedTemplates.map(({ template, score, reason }) => (
              <button
                key={template.id}
                onClick={() => setTemplateId(template.id)}
                style={{
                  ...templateCard,
                  borderColor: templateId === template.id ? "var(--accent)" : "var(--paper-edge)",
                  background: templateId === template.id ? "color-mix(in srgb, var(--accent-soft) 35%, var(--paper) 65%)" : "var(--paper)",
                }}
              >
                <div style={{ ...templatePreview, ...templatePreviewTone(template.id) }}>
                  <span />
                  <span />
                  <span />
                </div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <strong style={{ display: "block", color: "var(--ink)" }}>{template.name}</strong>
                  <div style={{ color: "var(--muted-deep)", fontSize: 12, marginTop: 3 }}>
                    match score {score} · {template.bestFor}
                  </div>
                  <div style={{ color: "var(--ink-soft)", fontSize: 12, marginTop: 8 }}>{reason}</div>
                </div>
                {templateId === template.id && <IconCheck size={16} style={{ color: "var(--accent)" }} />}
              </button>
            ))}
          </div>
        )}

        {step === 3 && (
          <div style={twoColumn}>
            <section style={panel}>
              <h3 style={panelTitle}>{locale === "en" ? "Instagram size" : "인스타그램 사이즈"}</h3>
              <div style={formatGrid}>
                {(Object.keys(FORMATS) as FormatId[]).map((id) => (
                  <button
                    key={id}
                    onClick={() => setFormat(id)}
                    style={{
                      ...formatCard,
                      borderColor: format === id ? "var(--accent)" : "var(--paper-edge)",
                      background: format === id ? "var(--fill-1)" : "var(--paper)",
                    }}
                  >
                    <strong>{FORMATS[id].label}</strong>
                    <span>{FORMATS[id].hint}</span>
                    <code>{FORMATS[id].width}x{FORMATS[id].height}</code>
                  </button>
                ))}
              </div>
            </section>
            <section style={panel}>
              <h3 style={panelTitle}>{locale === "en" ? "Pages and export" : "페이지와 저장"}</h3>
              <label style={fieldLabel}>
                {locale === "en" ? "Page count" : "페이지 수"}
                <input
                  type="range"
                  min={3}
                  max={7}
                  value={pageCount}
                  onChange={(e) => { setPageCount(Number(e.target.value)); setEditingSlides(null); }}
                />
                <span style={rangeValue}>{pageCount}</span>
              </label>
              <Segmented
                value={exportFormat}
                onChange={(value) => setExportFormat(value as ExportFormat)}
                options={[
                  { id: "png", label: "PNG" },
                  { id: "jpg", label: "JPG" },
                ]}
              />
            </section>
          </div>
        )}

        {step === 4 && (
          <div style={exportGrid}>
            <section style={slideGrid}>
              {slides.map((slide, index) => (
                <div key={index} style={{ ...slidePreview, aspectRatio: `${size.width} / ${size.height}` }}>
                  <CardPreview slide={slide} template={selectedTemplate.id} index={index + 1} />
                </div>
              ))}
            </section>
            <aside style={editPanel}>
              <h3 style={panelTitle}>
                <IconEdit size={14} />
                {locale === "en" ? "Edit cards" : "카드 편집"}
              </h3>
              <div style={{ display: "grid", gap: 10 }}>
                {slides.map((slide, index) => (
                  <details key={index} style={detailsBox} open={index === 0}>
                    <summary style={summaryStyle}>{index + 1}. {slide.title}</summary>
                    <label style={fieldLabel}>
                      Title
                      <input value={slide.title} onChange={(e) => updateSlide(index, { title: e.target.value })} style={input} />
                    </label>
                    <label style={fieldLabel}>
                      Body
                      <textarea value={slide.body} onChange={(e) => updateSlide(index, { body: e.target.value })} rows={4} style={smallTextArea} />
                    </label>
                  </details>
                ))}
              </div>
            </aside>
          </div>
        )}
      </section>
    </main>
  );
}

function GeneratedAppRunner({ app }: { app: AppFactoryAppRecord }) {
  const { locale } = useT();
  const blueprint = useMemo(() => buildGeneratedAppBlueprint(app, locale), [app, locale]);
  const [step, setStep] = useState(0);
  const [values, setValues] = useState<GeneratedAppFieldValues>(() => initialFieldValues(blueprint.fields));
  const [selectedRecommendationId, setSelectedRecommendationId] = useState(blueprint.recommendations[0]?.id ?? "");
  const [exportFormat, setExportFormat] = useState<GeneratedAppExportFormat>(blueprint.exportFormats[0] ?? "json");
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setValues(initialFieldValues(blueprint.fields));
    setSelectedRecommendationId(blueprint.recommendations[0]?.id ?? "");
    setExportFormat(blueprint.exportFormats[0] ?? "json");
    setStep(0);
  }, [blueprint]);

  const selectedRecommendation = blueprint.recommendations.find((item) => item.id === selectedRecommendationId) ?? blueprint.recommendations[0] ?? null;
  const outputs = useMemo(
    () => createGeneratedOutputs(blueprint, values, selectedRecommendation),
    [blueprint, selectedRecommendation, values],
  );
  const steps = runnerSteps(locale);

  function updateField(id: string, value: string) {
    setValues((current) => ({ ...current, [id]: value }));
  }

  function next() {
    if (step < steps.length - 1) setStep((value) => value + 1);
  }

  function previous() {
    if (step > 0) setStep((value) => value - 1);
  }

  async function exportAppResult() {
    setExporting(true);
    try {
      if (exportFormat === "png" || exportFormat === "jpg") {
        for (let index = 0; index < outputs.length; index += 1) {
          const canvas = renderGeneratedOutputCanvas(blueprint, values, outputs[index], index + 1);
          await downloadCanvas(canvas, `${slugify(blueprint.title)}-${String(index + 1).padStart(2, "0")}`, exportFormat);
        }
      } else {
        const body = serializeGeneratedOutputs(blueprint, values, selectedRecommendation, outputs, exportFormat);
        downloadTextFile(body, `${slugify(blueprint.title)}.${extensionForExport(exportFormat)}`, mimeForExport(exportFormat));
      }
    } finally {
      setExporting(false);
    }
  }

  return (
    <main style={studioShell}>
      <aside style={wizardRail}>
        <div style={brandBlock}>
          <div style={brandIcon}>
            <IconWand size={20} />
          </div>
          <div>
            <strong style={{ color: "var(--ink)" }}>{blueprint.title}</strong>
            <div style={{ color: "var(--muted-deep)", fontSize: 11.5 }}>{blueprint.appType}</div>
          </div>
        </div>
        {steps.map((item, index) => (
          <button
            key={item.id}
            onClick={() => setStep(index)}
            style={{
              ...stepButton,
              background: step === index ? "var(--paper)" : "transparent",
              borderColor: step === index ? "var(--accent)" : "transparent",
              color: step === index ? "var(--ink)" : "var(--muted-deep)",
            }}
          >
            <span style={{ ...stepIndex, background: step >= index ? "var(--accent)" : "var(--paper-edge)" }}>
              {index + 1}
            </span>
            {item.label}
          </button>
        ))}
      </aside>

      <section style={workArea}>
        <div style={workTop}>
          <div style={{ minWidth: 0 }}>
            <h2 style={workTitle}>{steps[step]?.title}</h2>
            <div style={workMeta}>{blueprint.subtitle}</div>
          </div>
          <div style={toolbar}>
            <button onClick={previous} disabled={step === 0} style={secondaryBtn}>
              {locale === "en" ? "Back" : "이전"}
            </button>
            {step < steps.length - 1 ? (
              <button onClick={next} style={primaryBtn}>
                {locale === "en" ? "Next" : "다음"}
                <IconChevronRight size={13} />
              </button>
            ) : (
              <button onClick={exportAppResult} style={primaryBtn} disabled={exporting}>
                <IconFileUp size={13} />
                {exporting ? (locale === "en" ? "Exporting" : "저장 중") : `${exportFormat.toUpperCase()} ${locale === "en" ? "export" : "내보내기"}`}
              </button>
            )}
          </div>
        </div>

        {step === 0 && (
          <div style={runnerFormGrid}>
            {blueprint.fields.map((field) => (
              <GeneratedField key={field.id} field={field} value={values[field.id] ?? ""} onChange={(value) => updateField(field.id, value)} />
            ))}
          </div>
        )}

        {step === 1 && (
          <div style={runnerCounselGrid}>
            <section style={templateList}>
              {blueprint.recommendations.map((item) => (
                <button
                  key={item.id}
                  onClick={() => setSelectedRecommendationId(item.id)}
                  style={{
                    ...templateCard,
                    borderColor: selectedRecommendation?.id === item.id ? "var(--accent)" : "var(--paper-edge)",
                    background: selectedRecommendation?.id === item.id ? "color-mix(in srgb, var(--accent-soft) 35%, var(--paper) 65%)" : "var(--paper)",
                  }}
                >
                  <div style={{ ...templatePreview, ...genericPreviewTone(item.tags[0]) }}>
                    <span />
                    <span />
                    <span />
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <strong style={{ display: "block", color: "var(--ink)" }}>{item.label}</strong>
                    <div style={{ color: "var(--ink-soft)", fontSize: 12, marginTop: 5 }}>{item.description}</div>
                    <div style={tagWrap}>
                      {item.tags.slice(0, 4).map((tagItem) => (
                        <span key={tagItem} style={tag}>{tagItem}</span>
                      ))}
                    </div>
                  </div>
                  {selectedRecommendation?.id === item.id && <IconCheck size={16} style={{ color: "var(--accent)" }} />}
                </button>
              ))}
            </section>
            <aside style={runnerSidePanel}>
              <SummaryList title={locale === "en" ? "Screens" : "화면"} items={blueprint.routeSummaries} />
              <SummaryList title={locale === "en" ? "Data" : "데이터"} items={blueprint.dataSummaries} />
              <SummaryList title={locale === "en" ? "Actions" : "액션"} items={blueprint.actionSummaries} />
            </aside>
          </div>
        )}

        {step === 2 && (
          <div style={runnerOutputGrid}>
            {outputs.map((output, index) => (
              <GeneratedOutputCard key={output.id} output={output} visual={blueprint.isVisualOutput} index={index + 1} />
            ))}
          </div>
        )}

        {step === 3 && (
          <div style={exportGrid}>
            <section style={runnerOutputGrid}>
              {outputs.map((output, index) => (
                <GeneratedOutputCard key={output.id} output={output} visual={blueprint.isVisualOutput} index={index + 1} />
              ))}
            </section>
            <aside style={editPanel}>
              <h3 style={panelTitle}>
                <IconFileUp size={14} />
                {locale === "en" ? "Export" : "내보내기"}
              </h3>
              <Segmented
                value={exportFormat}
                onChange={(value) => setExportFormat(value as GeneratedAppExportFormat)}
                options={blueprint.exportFormats.map((format) => ({ id: format, label: format.toUpperCase() }))}
              />
              <div style={{ ...angleBox, marginTop: 12 }}>
                {locale === "en"
                  ? "This internal App exports the current generated result without opening Chrome or a localhost preview."
                  : "이 내부 App은 Chrome/localhost 미리보기 없이 현재 생성 결과를 바로 저장합니다."}
              </div>
            </aside>
          </div>
        )}
      </section>
    </main>
  );
}

function GeneratedField({ field, value, onChange }: { field: GeneratedAppField; value: string; onChange: (value: string) => void }) {
  const control =
    field.kind === "textarea" ? (
      <textarea value={value} onChange={(event) => onChange(event.target.value)} rows={5} style={bigInput} />
    ) : field.kind === "select" ? (
      <select value={value} onChange={(event) => onChange(event.target.value)} style={input}>
        {(field.options ?? []).map((option) => (
          <option key={option.id} value={option.id}>{option.label}</option>
        ))}
      </select>
    ) : field.kind === "range" ? (
      <>
        <input type="range" min={field.min ?? 1} max={field.max ?? 10} value={value} onChange={(event) => onChange(event.target.value)} />
        <span style={rangeValue}>{value}</span>
      </>
    ) : (
      <input type={field.kind === "number" ? "number" : "text"} value={value} onChange={(event) => onChange(event.target.value)} style={input} />
    );
  return (
    <label style={fieldLabel}>
      {field.label}
      {control}
      {field.helper && <span style={{ color: "var(--muted-deep)", fontWeight: 600, lineHeight: 1.45 }}>{field.helper}</span>}
    </label>
  );
}

function GeneratedOutputCard({ output, visual, index }: { output: GeneratedAppOutput; visual: boolean; index: number }) {
  if (visual) {
    return (
      <div style={{ ...slidePreview, aspectRatio: "4 / 5" }}>
        <div data-card-preview style={{ ...cardVisual(index % 2 === 0 ? "clean" : "instrument"), width: "100%", height: "100%" }}>
          <div style={cardKicker}>{output.meta}</div>
          <strong data-card-title style={cardTitle}>{output.title}</strong>
          <p data-card-body style={cardBody}>{output.body}</p>
          <div style={cardFooter}>
            <span>Agentlas App</span>
            <span>{String(index).padStart(2, "0")}</span>
          </div>
        </div>
      </div>
    );
  }
  return (
    <article style={generatedOutputCard}>
      <div style={generatedOutputIndex}>{String(index).padStart(2, "0")}</div>
      <h3 style={panelTitle}>{output.title}</h3>
      <p style={{ margin: 0, color: "var(--ink-soft)", lineHeight: 1.55 }}>{output.body}</p>
      <div style={{ ...tag, justifySelf: "start", marginTop: 8 }}>{output.meta}</div>
    </article>
  );
}

function SummaryList({ title, items }: { title: string; items: Array<{ label: string; detail: string }> }) {
  return (
    <section style={panel}>
      <h3 style={panelTitle}>{title}</h3>
      <div style={{ display: "grid", gap: 8 }}>
        {items.length ? items.map((item) => (
          <div key={`${title}-${item.label}`} style={summaryRow}>
            <strong>{item.label}</strong>
            <span>{item.detail}</span>
          </div>
        )) : <div style={{ color: "var(--muted-deep)", fontSize: 12 }}>None declared</div>}
      </div>
    </section>
  );
}

function runnerSteps(locale: "ko" | "en") {
  return locale === "en"
    ? [
        { id: "input", label: "Input", title: "App inputs" },
        { id: "counsel", label: "Counsel", title: "Workflow counseling" },
        { id: "produce", label: "Produce", title: "Generated workbench" },
        { id: "export", label: "Export", title: "Export result" },
      ]
    : [
        { id: "input", label: "입력", title: "앱 입력" },
        { id: "counsel", label: "카운셀링", title: "워크플로우 카운셀링" },
        { id: "produce", label: "생성", title: "생성 작업대" },
        { id: "export", label: "내보내기", title: "결과 내보내기" },
      ];
}

function renderGeneratedOutputCanvas(
  blueprint: GeneratedAppBlueprint,
  values: GeneratedAppFieldValues,
  output: GeneratedAppOutput,
  index: number,
): HTMLCanvasElement {
  const size = sizeForFormat(values.format);
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const palette = canvasPalette(index % 2 === 0 ? "clean" : "instrument");
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.fillStyle = palette.panel;
  roundRect(ctx, size.width * 0.07, size.height * 0.07, size.width * 0.86, size.height * 0.86, 36);
  ctx.fill();
  ctx.fillStyle = palette.accent;
  ctx.font = `700 ${Math.round(size.width * 0.03)}px Arial`;
  ctx.fillText(output.meta.toUpperCase(), size.width * 0.12, size.height * 0.16);
  ctx.fillStyle = palette.ink;
  ctx.font = `800 ${Math.round(size.width * 0.068)}px Arial`;
  drawWrapped(ctx, output.title, size.width * 0.12, size.height * 0.28, size.width * 0.76, size.width * 0.082, 3);
  ctx.fillStyle = palette.soft;
  ctx.font = `500 ${Math.round(size.width * 0.038)}px Arial`;
  drawWrapped(ctx, output.body, size.width * 0.12, size.height * 0.54, size.width * 0.76, size.width * 0.055, 6);
  ctx.fillStyle = palette.accent;
  ctx.font = `700 ${Math.round(size.width * 0.028)}px Arial`;
  ctx.fillText(blueprint.title, size.width * 0.12, size.height * 0.88);
  ctx.fillText(String(index).padStart(2, "0"), size.width * 0.82, size.height * 0.88);
  return canvas;
}

function sizeForFormat(format: string | undefined): { width: number; height: number } {
  if (format === "1:1") return { width: 1080, height: 1080 };
  if (format === "3:4") return { width: 1080, height: 1440 };
  if (format === "9:16") return { width: 1080, height: 1920 };
  return { width: 1080, height: 1350 };
}

function genericPreviewTone(tagName: string | undefined): CSSProperties {
  if (tagName?.includes("visual") || tagName?.includes("creative")) return { background: "#101820", color: "#ff6b2b" };
  if (tagName?.includes("route")) return { background: "#edf4ff", color: "#2563eb" };
  if (tagName?.includes("form")) return { background: "#f5f0e8", color: "#7c3aed" };
  return { background: "#f8fbff", color: "#2563eb" };
}

function downloadTextFile(body: string, filename: string, mime: string) {
  const blob = new Blob([body], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function extensionForExport(format: GeneratedAppExportFormat): string {
  if (format === "markdown") return "md";
  if (format === "csv") return "csv";
  return "json";
}

function mimeForExport(format: GeneratedAppExportFormat): string {
  if (format === "markdown") return "text/markdown";
  if (format === "csv") return "text/csv";
  return "application/json";
}

function buildResearch(topic: string, language: LanguageId): ResearchBrief {
  const clean = topic.trim() || (language === "en" ? "Untitled topic" : "이름 없는 주제");
  const tokens = clean.toLowerCase().split(/[^a-z0-9가-힣]+/).filter(Boolean).slice(0, 8);
  const ko = language === "ko";
  return {
    headline: ko ? `${clean} 리서치 브리프` : `${clean} research brief`,
    keywords: Array.from(new Set([...tokens, ...(ko ? ["실전", "비교", "전환"] : ["practical", "comparison", "conversion"])])),
    points: ko
      ? [
          `${clean}의 핵심 변화는 사용자가 복잡한 과정을 직접 조립하지 않아도 되는 방향이다.`,
          `초보자는 개념 설명보다 바로 따라 할 수 있는 단계와 결과물을 먼저 본다.`,
          `좋은 카드뉴스는 문제, 왜 지금 중요한지, 실제 사용 흐름, 다음 행동을 짧게 연결한다.`,
          `시각적으로는 한 장마다 하나의 주장만 남겨야 저장과 공유가 늘어난다.`,
        ]
      : [
          `${clean} matters because users increasingly expect the workflow to assemble itself.`,
          `Beginners respond better to concrete steps and visible output than abstract setup language.`,
          `A strong carousel connects the problem, why now, the workflow, and the next action.`,
          `Each slide should carry one claim so the set stays saveable and shareable.`,
        ],
  };
}

function scoreTemplates(keywords: string[], topic: string) {
  const raw = `${topic} ${keywords.join(" ")}`.toLowerCase();
  return TEMPLATES.map((template) => {
    const score = template.tags.reduce((sum, tag) => sum + (raw.includes(tag) ? 2 : 0), 0);
    const reason =
      score > 0
        ? `${template.tags.filter((tag) => raw.includes(tag)).join(", ")} signal matched.`
        : "No direct keyword match; ranked by general Instagram readability.";
    return { template, score, reason };
  }).sort((a, b) => b.score - a.score || a.template.name.localeCompare(b.template.name));
}

function angleForTopic(topic: string, language: LanguageId): string {
  if (language === "ko") {
    return `${topic}을 사용자의 당장 할 일로 번역합니다. 첫 장은 문제를 압축하고, 중간 장은 선택지와 실행 흐름을 보여주고, 마지막 장은 저장할 만한 체크리스트로 닫습니다.`;
  }
  return `Translate ${topic} into a concrete user workflow. Open with the problem, use the middle slides for choices and steps, and close with a save-worthy checklist.`;
}

function composeSlides(input: {
  topic: string;
  language: LanguageId;
  audience: string;
  tone: string;
  research: ResearchBrief;
  pageCount: number;
}): SlideDraft[] {
  const ko = input.language === "ko";
  const topic = input.topic.trim() || (ko ? "카드뉴스 주제" : "Carousel topic");
  const base: SlideDraft[] = ko
    ? [
        { kicker: "01 / 문제", title: `${topic}`, body: `${input.audience}가 지금 헷갈리는 지점을 한 문장으로 정리합니다.`, footer: input.tone },
        { kicker: "02 / 변화", title: "왜 지금 중요할까", body: input.research.points[0], footer: "Research-backed draft" },
        { kicker: "03 / 선택", title: "좋은 선택 기준", body: input.research.points[1], footer: "Save for later" },
        { kicker: "04 / 실행", title: "바로 쓰는 흐름", body: input.research.points[2], footer: "Agentlas App" },
        { kicker: "05 / 체크", title: "마지막 체크리스트", body: input.research.points[3], footer: "Export PNG/JPG" },
        { kicker: "06 / 예시", title: "한 줄 예시", body: `${topic}을 설명이 아니라 결과물 중심으로 보여줍니다.`, footer: "Template counseling" },
        { kicker: "07 / 다음", title: "다음 행동", body: "주제, 대상, 포맷을 바꿔 다시 생성하고 가장 저장하고 싶은 세트를 고릅니다.", footer: "Done in Agentlas" },
      ]
    : [
        { kicker: "01 / Problem", title: topic, body: `Frame the confusion ${input.audience} feels right now.`, footer: input.tone },
        { kicker: "02 / Shift", title: "Why it matters now", body: input.research.points[0], footer: "Research-backed draft" },
        { kicker: "03 / Choice", title: "What to look for", body: input.research.points[1], footer: "Save for later" },
        { kicker: "04 / Flow", title: "The usable workflow", body: input.research.points[2], footer: "Agentlas App" },
        { kicker: "05 / Check", title: "Final checklist", body: input.research.points[3], footer: "Export PNG/JPG" },
        { kicker: "06 / Example", title: "One-line example", body: `Show ${topic} through output, not setup language.`, footer: "Template counseling" },
        { kicker: "07 / Next", title: "Next action", body: "Change topic, audience, and format, then export the strongest set.", footer: "Done in Agentlas" },
      ];
  return base.slice(0, input.pageCount).map((slide, index) => ({ ...slide, kicker: slide.kicker.replace(/^\d+/, String(index + 1).padStart(2, "0")) }));
}

function CardPreview({ slide, template, index }: { slide: SlideDraft; template: TemplateId; index: number }) {
  return (
    <div data-card-preview style={{ ...cardVisual(template), width: "100%", height: "100%" }}>
      <div style={cardKicker}>{slide.kicker}</div>
      <strong data-card-title style={cardTitle}>{slide.title}</strong>
      <p data-card-body style={cardBody}>{slide.body}</p>
      <div style={cardFooter}>
        <span>{slide.footer}</span>
        <span>{String(index).padStart(2, "0")}</span>
      </div>
    </div>
  );
}

function Segmented({
  value,
  options,
  onChange,
}: {
  value: string;
  options: Array<{ id: string; label: string }>;
  onChange: (value: string) => void;
}) {
  return (
    <div style={segmented}>
      {options.map((option) => (
        <button
          key={option.id}
          onClick={() => onChange(option.id)}
          style={{
            ...segmentButton,
            background: value === option.id ? "var(--paper)" : "transparent",
            color: value === option.id ? "var(--ink)" : "var(--muted-deep)",
            boxShadow: value === option.id ? "var(--shadow-1)" : "none",
          }}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

function renderSlideCanvas(slide: SlideDraft, template: TemplateId, size: { width: number; height: number }, index: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return canvas;
  const palette = canvasPalette(template);
  ctx.fillStyle = palette.bg;
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.fillStyle = palette.panel;
  roundRect(ctx, size.width * 0.07, size.height * 0.07, size.width * 0.86, size.height * 0.86, 36);
  ctx.fill();
  ctx.fillStyle = palette.accent;
  ctx.font = `700 ${Math.round(size.width * 0.032)}px Arial`;
  ctx.fillText(slide.kicker.toUpperCase(), size.width * 0.12, size.height * 0.16);
  ctx.fillStyle = palette.ink;
  ctx.font = `800 ${Math.round(size.width * 0.075)}px Arial`;
  drawWrapped(ctx, slide.title, size.width * 0.12, size.height * 0.28, size.width * 0.76, size.width * 0.09, 3);
  ctx.fillStyle = palette.soft;
  ctx.font = `500 ${Math.round(size.width * 0.04)}px Arial`;
  drawWrapped(ctx, slide.body, size.width * 0.12, size.height * 0.55, size.width * 0.76, size.width * 0.058, 6);
  ctx.fillStyle = palette.accent;
  ctx.font = `700 ${Math.round(size.width * 0.03)}px Arial`;
  ctx.fillText(slide.footer, size.width * 0.12, size.height * 0.88);
  const page = String(index).padStart(2, "0");
  const metric = ctx.measureText(page);
  ctx.fillText(page, size.width * 0.88 - metric.width, size.height * 0.88);
  return canvas;
}

function drawWrapped(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  lineHeight: number,
  maxLines: number,
) {
  const words = text.split(/\s+/);
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

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

async function downloadCanvas(canvas: HTMLCanvasElement, name: string, format: ExportFormat) {
  const mime = format === "jpg" ? "image/jpeg" : "image/png";
  const url = canvas.toDataURL(mime, 0.92);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${name}.${format}`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  await new Promise((resolve) => window.setTimeout(resolve, 120));
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9가-힣]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "cardnews";
}

function templatePreviewTone(id: TemplateId): CSSProperties {
  if (id === "instrument") return { background: "#101820", color: "#ff6b2b" };
  if (id === "clean") return { background: "#edf4ff", color: "#2563eb" };
  if (id === "grid") return { background: "#f5f0e8", color: "#7c3aed" };
  return { background: "#fff7d6", color: "#111827" };
}

function cardVisual(id: TemplateId): CSSProperties {
  const base: CSSProperties = {
    borderRadius: 8,
    padding: "9%",
    display: "grid",
    gridTemplateRows: "auto minmax(0, 1fr) minmax(0, .8fr) auto",
    gap: "5%",
    boxShadow: "inset 0 0 0 1px rgba(255,255,255,.14)",
    minHeight: 0,
  };
  if (id === "instrument") return { ...base, background: "linear-gradient(145deg, #0b1117, #18202a)", color: "#f5f7fb" };
  if (id === "clean") return { ...base, background: "linear-gradient(145deg, #f8fbff, #dfeeff)", color: "#10223f" };
  if (id === "grid") return { ...base, background: "linear-gradient(145deg, #fbf7ef, #eee2d2)", color: "#221a13" };
  return { ...base, background: "linear-gradient(145deg, #fff4b8, #191919)", color: "#fffdf0" };
}

function canvasPalette(id: TemplateId) {
  if (id === "instrument") return { bg: "#071016", panel: "#111a22", ink: "#f8fafc", soft: "#cbd5e1", accent: "#ff6b2b" };
  if (id === "clean") return { bg: "#dbeafe", panel: "#f8fbff", ink: "#10223f", soft: "#42526e", accent: "#2563eb" };
  if (id === "grid") return { bg: "#eadfce", panel: "#fbf7ef", ink: "#221a13", soft: "#625447", accent: "#7c3aed" };
  return { bg: "#1f1f1f", panel: "#fff4b8", ink: "#18181b", soft: "#3f3f46", accent: "#ca8a04" };
}

function stepTitle(step: number, locale: "ko" | "en"): string {
  const ko = ["주제와 언어", "리서치", "템플릿 카운셀링", "포맷과 사이즈", "카드뉴스 결과"];
  const en = ["Topic and language", "Research", "Template counseling", "Format and size", "Cardnews output"];
  return (locale === "ko" ? ko : en)[step] ?? "";
}

const appHeader: CSSProperties = {
  minHeight: 58,
  borderBottom: "1px solid var(--glass-border)",
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 24px 10px 90px",
  flexShrink: 0,
};

const backLink: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  color: "var(--accent)",
  fontWeight: 800,
  fontSize: 12,
  textDecoration: "none",
};

const appTitle: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-head)",
  fontSize: 18,
  color: "var(--ink)",
};

const appSubtitle: CSSProperties = {
  marginTop: 2,
  color: "var(--muted-deep)",
  fontSize: 11.5,
};

const livePill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  borderRadius: 999,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  padding: "5px 9px",
  fontSize: 11,
  fontWeight: 700,
};

const liveDot: CSSProperties = {
  width: 7,
  height: 7,
  borderRadius: "50%",
  background: "var(--green-deep)",
};

const emptyState: CSSProperties = {
  margin: 32,
  padding: 22,
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--paper-2)",
  color: "var(--muted-deep)",
};

const studioShell: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "grid",
  gridTemplateColumns: "220px minmax(0, 1fr)",
  overflow: "hidden",
};

const wizardRail: CSSProperties = {
  borderRight: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  padding: 16,
  display: "flex",
  flexDirection: "column",
  gap: 8,
  overflowY: "auto",
};

const brandBlock: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "4px 4px 16px",
};

const brandIcon: CSSProperties = {
  width: 40,
  height: 40,
  borderRadius: 8,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  color: "white",
  background: "linear-gradient(135deg, var(--accent), var(--peach))",
  boxShadow: "var(--neu-raised)",
  flexShrink: 0,
};

const stepButton: CSSProperties = {
  height: 42,
  border: "1px solid transparent",
  borderRadius: 8,
  display: "flex",
  alignItems: "center",
  gap: 9,
  padding: "0 10px",
  fontSize: 12.5,
  fontWeight: 800,
  textAlign: "left",
  cursor: "pointer",
};

const stepIndex: CSSProperties = {
  width: 20,
  height: 20,
  borderRadius: "50%",
  color: "white",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontSize: 11,
  flexShrink: 0,
};

const workArea: CSSProperties = {
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
};

const workTop: CSSProperties = {
  minHeight: 70,
  borderBottom: "1px solid var(--paper-edge)",
  display: "flex",
  alignItems: "center",
  gap: 16,
  padding: "14px 22px",
  flexShrink: 0,
};

const workTitle: CSSProperties = {
  margin: 0,
  fontFamily: "var(--font-head)",
  fontSize: 20,
  color: "var(--ink)",
};

const workMeta: CSSProperties = {
  marginTop: 4,
  color: "var(--muted-deep)",
  fontSize: 12,
};

const toolbar: CSSProperties = {
  display: "flex",
  gap: 8,
  marginLeft: "auto",
  flexWrap: "wrap",
};

const primaryBtn: CSSProperties = {
  minHeight: 34,
  borderRadius: 8,
  border: "1px solid var(--accent)",
  background: "var(--accent)",
  color: "white",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  gap: 6,
  padding: "0 12px",
  fontWeight: 800,
  cursor: "pointer",
};

const secondaryBtn: CSSProperties = {
  minHeight: 34,
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  padding: "0 12px",
  fontWeight: 800,
  cursor: "pointer",
};

const formGrid: CSSProperties = {
  padding: 22,
  display: "grid",
  gridTemplateColumns: "minmax(320px, 1.2fr) minmax(260px, .8fr)",
  gap: 16,
  overflowY: "auto",
};

const stack: CSSProperties = {
  display: "grid",
  gap: 12,
  alignContent: "start",
};

const fieldLabel: CSSProperties = {
  display: "grid",
  gap: 7,
  color: "var(--ink-soft)",
  fontSize: 12,
  fontWeight: 800,
};

const input: CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--paper)",
  color: "var(--ink)",
  padding: "10px 11px",
  outline: "none",
  fontSize: 13,
};

const bigInput: CSSProperties = {
  ...input,
  minHeight: 190,
  resize: "vertical",
  lineHeight: 1.5,
};

const smallTextArea: CSSProperties = {
  ...input,
  resize: "vertical",
  lineHeight: 1.45,
};

const segmented: CSSProperties = {
  display: "grid",
  gridAutoFlow: "column",
  gridAutoColumns: "1fr",
  padding: 3,
  background: "var(--paper-2)",
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
};

const segmentButton: CSSProperties = {
  border: "none",
  borderRadius: 6,
  padding: "8px 10px",
  fontWeight: 800,
  fontSize: 12,
  cursor: "pointer",
};

const twoColumn: CSSProperties = {
  padding: 22,
  display: "grid",
  gridTemplateColumns: "minmax(300px, 1fr) minmax(300px, 1fr)",
  gap: 16,
  overflowY: "auto",
};

const panel: CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--paper)",
  padding: 16,
  minWidth: 0,
};

const panelTitle: CSSProperties = {
  margin: "0 0 12px",
  color: "var(--ink)",
  fontFamily: "var(--font-head)",
  fontSize: 15,
  display: "flex",
  alignItems: "center",
  gap: 7,
};

const researchList: CSSProperties = {
  display: "grid",
  gap: 10,
};

const researchRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "28px minmax(0, 1fr)",
  gap: 10,
  alignItems: "start",
  color: "var(--ink-soft)",
  lineHeight: 1.55,
  fontSize: 13,
};

const researchNo: CSSProperties = {
  width: 24,
  height: 24,
  borderRadius: 999,
  background: "var(--fill-1)",
  color: "var(--accent)",
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  fontWeight: 900,
  fontSize: 11,
};

const angleBox: CSSProperties = {
  borderRadius: 8,
  background: "var(--paper-2)",
  padding: 14,
  color: "var(--ink-soft)",
  lineHeight: 1.6,
  fontSize: 13,
};

const tagWrap: CSSProperties = {
  display: "flex",
  flexWrap: "wrap",
  gap: 6,
  marginTop: 12,
};

const tag: CSSProperties = {
  padding: "4px 8px",
  borderRadius: 999,
  background: "var(--fill-1)",
  color: "var(--accent)",
  fontSize: 11,
  fontWeight: 800,
};

const templateList: CSSProperties = {
  padding: 22,
  display: "grid",
  gap: 12,
  overflowY: "auto",
};

const templateCard: CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  padding: 14,
  display: "flex",
  alignItems: "center",
  gap: 14,
  textAlign: "left",
  cursor: "pointer",
};

const templatePreview: CSSProperties = {
  width: 88,
  height: 112,
  borderRadius: 8,
  display: "grid",
  alignContent: "center",
  gap: 8,
  padding: 12,
  flexShrink: 0,
};

const formatGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
  gap: 10,
};

const formatCard: CSSProperties = {
  minHeight: 98,
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  display: "grid",
  gap: 6,
  alignContent: "center",
  justifyItems: "center",
  color: "var(--ink-soft)",
  cursor: "pointer",
};

const rangeValue: CSSProperties = {
  display: "inline-flex",
  width: 34,
  height: 28,
  borderRadius: 8,
  alignItems: "center",
  justifyContent: "center",
  background: "var(--fill-1)",
  color: "var(--accent)",
  fontWeight: 900,
};

const exportGrid: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 320px",
  overflow: "hidden",
};

const runnerFormGrid: CSSProperties = {
  padding: 22,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(260px, 1fr))",
  gap: 16,
  alignContent: "start",
  overflowY: "auto",
};

const runnerCounselGrid: CSSProperties = {
  flex: 1,
  minHeight: 0,
  display: "grid",
  gridTemplateColumns: "minmax(0, 1fr) 320px",
  overflow: "hidden",
};

const runnerSidePanel: CSSProperties = {
  borderLeft: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  padding: 16,
  display: "grid",
  gap: 12,
  alignContent: "start",
  overflowY: "auto",
};

const runnerOutputGrid: CSSProperties = {
  padding: 22,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(210px, 1fr))",
  gap: 14,
  alignContent: "start",
  overflowY: "auto",
};

const generatedOutputCard: CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--paper)",
  padding: 16,
  minHeight: 190,
  display: "grid",
  alignContent: "start",
  gap: 9,
  boxShadow: "var(--shadow-1)",
};

const generatedOutputIndex: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 8,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "var(--fill-1)",
  color: "var(--accent)",
  fontWeight: 900,
  fontSize: 11,
};

const summaryRow: CSSProperties = {
  display: "grid",
  gap: 2,
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  padding: 10,
  background: "var(--paper-2)",
  color: "var(--ink-soft)",
  fontSize: 12,
  lineHeight: 1.4,
};

const slideGrid: CSSProperties = {
  padding: 22,
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(180px, 1fr))",
  gap: 14,
  overflowY: "auto",
  alignContent: "start",
};

const slidePreview: CSSProperties = {
  borderRadius: 8,
  overflow: "hidden",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  boxShadow: "var(--shadow-1)",
  containerType: "inline-size",
};

const editPanel: CSSProperties = {
  borderLeft: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  padding: 16,
  overflowY: "auto",
};

const detailsBox: CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  background: "var(--paper)",
  padding: 10,
};

const summaryStyle: CSSProperties = {
  cursor: "pointer",
  color: "var(--ink)",
  fontWeight: 800,
  fontSize: 12.5,
  marginBottom: 8,
};

const cardKicker: CSSProperties = {
  color: "currentColor",
  opacity: 0.7,
  fontWeight: 900,
  fontSize: "clamp(10px, 4.4cqw, 16px)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const cardTitle: CSSProperties = {
  fontFamily: "var(--font-head)",
  fontSize: "clamp(18px, 9cqw, 30px)",
  lineHeight: 1.05,
  overflowWrap: "anywhere",
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 3,
  overflow: "hidden",
  minHeight: 0,
};

const cardBody: CSSProperties = {
  margin: 0,
  fontSize: "clamp(11px, 4.8cqw, 15px)",
  lineHeight: 1.45,
  opacity: 0.86,
  overflowWrap: "anywhere",
  display: "-webkit-box",
  WebkitBoxOrient: "vertical",
  WebkitLineClamp: 4,
  overflow: "hidden",
  minHeight: 0,
};

const cardFooter: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 10,
  fontSize: "clamp(9px, 3.5cqw, 13px)",
  fontWeight: 800,
  opacity: 0.74,
};

const genericShell: CSSProperties = {
  flex: 1,
  overflowY: "auto",
  padding: 28,
  display: "grid",
  gap: 18,
  alignContent: "start",
};

const genericHero: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 14,
  padding: 22,
  borderRadius: 8,
  background: "var(--paper-2)",
  border: "1px solid var(--paper-edge)",
};

const genericGrid: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
  gap: 12,
};
