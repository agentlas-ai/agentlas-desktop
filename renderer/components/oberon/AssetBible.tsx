// Oberon — Step 03 고정 에셋. 카테고리별 멀티앵글 레퍼런스 번들 (stable ID).
// GATE B: 인물·배경·소품을 사진 프롬프트 묶음으로 락한 뒤에야 컷 이미지를 생성한다.
// (reference 이미지 = 정체성, seed = 재현성. 얼굴 클로즈업이 가장 강한 정체성 앵커.)
"use client";
import { providerById, routeImageProvider, type FilmProduction, type ModelSettings, type ReferenceEntry } from "@/lib/oberon";
import type { OberonKeyframeAsset } from "@shared/types";
import { getMultimodalProvider } from "@shared/multimodal";
import { useT, type Locale } from "@/lib/i18n";
import { Glyph, OberonBadge, type GlyphName } from "./icons";
import { CHARCOAL, Card, Eyebrow, PanelHead, PrimaryButton, Tag, toLocalMediaSrc } from "./ui";

const CATEGORY_ORDER: { kind: ReferenceEntry["kind"]; label: string; labelEn: string; glyph: GlyphName }[] = [
  { kind: "character", label: "인물", labelEn: "Characters", glyph: "character" },
  { kind: "location", label: "배경", labelEn: "Locations", glyph: "background" },
  { kind: "prop", label: "소품", labelEn: "Props", glyph: "prop" },
  { kind: "wardrobe", label: "의상", labelEn: "Wardrobe", glyph: "style" },
  { kind: "vehicle", label: "탈것", labelEn: "Vehicles", glyph: "prop" },
  { kind: "style", label: "스타일", labelEn: "Style", glyph: "style" },
];

const BUNDLE_SLOTS: Record<string, string[]> = {
  character: ["정면", "3/4 좌", "3/4 우", "측면", "얼굴 CU★", "전신"],
  location: ["establishing", "코너 디테일", "주간 조명", "야간 조명"],
  prop: ["히어로", "손에 든 컷"],
  wardrobe: ["플랫레이", "착장"],
  vehicle: ["3/4 히어로", "측면"],
  style: ["스타일 프레임"],
};

const BUNDLE_SLOTS_EN: Record<string, string[]> = {
  character: ["Front", "3/4 Left", "3/4 Right", "Profile", "Face CU★", "Full Body"],
  location: ["establishing", "Corner Detail", "Day Lighting", "Night Lighting"],
  prop: ["Hero", "Held Cut"],
  wardrobe: ["Flat Lay", "Worn"],
  vehicle: ["3/4 Hero", "Profile"],
  style: ["Style Frame"],
};

export function AssetBible({
  production,
  model,
  approved,
  onApprove,
  sheetGenerating,
  onGenerateSheets,
}: {
  production: FilmProduction;
  model?: ModelSettings;
  approved: boolean;
  onApprove: () => void;
  /** 마스터 시트 이미지 생성 중인가 (키프레임 잡 재사용). */
  sheetGenerating?: boolean;
  /** 캐릭터/제품 마스터 시트(V2 클린 그리드) 실제 생성 트리거. */
  onGenerateSheets?: () => void;
}) {
  const { locale } = useT();
  const imgProviderId = model?.imageProvider;
  const imgProvider = imgProviderId ? getMultimodalProvider(imgProviderId) : undefined;
  const imgLabel = imgProvider ? (locale === "ko" ? imgProvider.labelKo : imgProvider.label) : undefined;
  const refs = production.bible.references;
  const cats = CATEGORY_ORDER.filter((c) => refs.some((r) => r.kind === c.kind));
  const sheetById = new Map((production.sheetAssets ?? []).map((a) => [a.shotId, a]));

  return (
    <div style={panelStyle}>
      <PanelHead
        eyebrow={locale === "ko" ? "Step 03 · 등장 요소" : "Step 03 · Cast & Elements"}
        title={locale === "ko" ? "인물·배경·소품 미리 만들기" : "Pre-Generate Characters, Locations & Props"}
        subtitle={
          locale === "ko"
            ? `인물·배경·소품을 여러 각도의 참고 이미지로 미리 만들어 둡니다${imgLabel ? ` · 이미지 엔진 ${imgLabel}` : ""}. 모든 컷이 이걸 참고해 같은 얼굴·같은 장소를 유지해요. (얼굴 정면 ★ 이미지가 제일 중요)`
            : `Pre-generate characters, locations, and props as multi-angle reference images${imgLabel ? ` · Image engine: ${imgLabel}` : ""}. Every shot references these to keep the same face and the same place. (The front-face ★ image matters most.)`
        }
        icon={<Glyph name="assets" size={18} />}
      />

      {cats.map((c) => {
        const items = refs.filter((r) => r.kind === c.kind);
        return (
          <div key={c.kind} style={{ marginBottom: 28 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 9, marginBottom: 12 }}>
              <OberonBadge name={c.glyph} size={24} glyphSize={13} />
              <span style={{ fontSize: 15, fontWeight: 600, color: "var(--ob-ink)" }}>{locale === "ko" ? c.label : c.labelEn}</span>
              <span style={{ fontSize: 12.5, color: "var(--ob-muted)", fontVariantNumeric: "tabular-nums" }}>{items.length}</span>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(330px, 1fr))", gap: 16 }}>
              {items.map((r, i) => (
                <BundleCard key={r.id} entry={r} index={i} model={model} locale={locale} sheet={sheetById.get(r.id)} />
              ))}
            </div>
          </div>
        );
      })}

      <div style={{ marginTop: 8, display: "flex", alignItems: "center", gap: 12 }}>
        {onGenerateSheets && (
          <PrimaryButton onClick={onGenerateSheets} disabled={sheetGenerating}>
            {sheetGenerating
              ? locale === "ko"
                ? "마스터 시트 생성 중…"
                : "Generating master sheets…"
              : locale === "ko"
                ? "마스터 시트 이미지 생성 (정체성 락)"
                : "Generate Master Sheet Images (Identity Lock)"}
          </PrimaryButton>
        )}
        {approved ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 13, fontWeight: 600, color: "var(--ob-success)" }}>
            <Glyph name="check" size={16} strokeWidth={2.4} />{" "}
            {locale === "ko" ? "에셋 확정됨 — 컷 이미지 단계가 열렸습니다." : "Assets confirmed — the Cut Images step is unlocked."}
          </span>
        ) : (
          <PrimaryButton onClick={onApprove}>
            {locale === "ko" ? "에셋 확정하고 컷 이미지로" : "Confirm Assets and Continue to Cut Images"} <Glyph name="chevron" size={14} strokeWidth={2.4} />
          </PrimaryButton>
        )}
      </div>
    </div>
  );
}

function BundleCard({
  entry,
  index,
  model,
  locale,
  sheet,
}: {
  entry: ReferenceEntry;
  index: number;
  model?: ModelSettings;
  locale: Locale;
  /** 실제 생성된 마스터 시트 이미지 (있으면 슬롯 자리에 표시). */
  sheet?: OberonKeyframeAsset;
}) {
  const slots = (locale === "ko" ? BUNDLE_SLOTS : BUNDLE_SLOTS_EN)[entry.kind] ?? (locale === "ko" ? ["메인", "디테일"] : ["Main", "Detail"]);
  const route = routeImageProvider(entry.kind === "character" ? "character" : entry.kind === "prop" ? "product" : "keyframe");
  const oberonProvider = providerById(route.providerId);
  const stableId = `${({ character: "CHAR", location: "LOC", prop: "PROP", wardrobe: "WARD", vehicle: "VEH", style: "STYLE" } as Record<string, string>)[entry.kind] ?? "ASSET"}_${entry.id.split("_").pop()}`;
  const seed = 1000 + index * 137;

  return (
    <Card style={{ padding: 18 }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <code style={{ fontSize: 11.5, fontFamily: "var(--font-mono)", fontWeight: 600, color: "var(--ob-ink-soft)", letterSpacing: 0.2 }}>{stableId}</code>
        <span style={{ fontSize: 14, fontWeight: 600, color: "var(--ob-ink)", flex: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{entry.name}</span>
      </div>

      {/* 실제 생성된 마스터 시트 — 정면·3/4·측면·전신·표정 클린 그리드 한 장 */}
      {sheet && (
        <img
          src={toLocalMediaSrc(sheet.url)}
          alt={`${entry.name} master sheet`}
          style={{ width: "100%", borderRadius: 6, border: "1px solid var(--ob-edge)", marginBottom: 10, display: "block" }}
        />
      )}

      {/* 멀티앵글 번들 슬롯 */}
      <div style={{ display: "grid", gridTemplateColumns: `repeat(${Math.min(slots.length, 6)}, 1fr)`, gap: 6, marginBottom: 12 }}>
        {slots.map((s) => {
          const anchor = s.includes("★");
          return (
            <div key={s} style={{ display: "flex", flexDirection: "column", gap: 4 }}>
              <div
                style={{
                  aspectRatio: "1 / 1",
                  borderRadius: 4,
                  background: CHARCOAL,
                  border: anchor ? "2px solid var(--ob-accent)" : "1px solid var(--ob-edge)",
                  boxShadow: "inset 0 0 0 1px rgba(11,11,15,0.04)",
                }}
              />
              <span style={{ fontSize: 9, textAlign: "center", color: anchor ? "var(--ob-accent)" : "var(--ob-muted)", fontWeight: anchor ? 600 : 500, lineHeight: 1.1 }}>{s}</span>
            </div>
          );
        })}
      </div>

      <div style={{ display: "flex", gap: 5, flexWrap: "wrap", marginBottom: 11 }}>
        {entry.lockedTraits.slice(0, 4).map((t, i) => (
          <Tag key={i}>{t}</Tag>
        ))}
      </div>

      <div style={{ fontSize: 12, color: "var(--ob-ink-soft)", lineHeight: 1.55, background: "var(--ob-fill)", borderRadius: 8, padding: "10px 12px", marginBottom: 10 }}>
        {entry.prompt}
      </div>

      {/* meta — 재현용 */}
      <div style={{ display: "flex", gap: 12, fontSize: 10, fontFamily: "var(--font-mono)", color: "var(--ob-muted)", flexWrap: "wrap", fontVariantNumeric: "tabular-nums" }}>
        <span>seed {seed}</span>
        <span>{oberonProvider?.name ?? route.providerId}</span>
        <span>&lt;{stableId.toLowerCase()}&gt;</span>
      </div>
    </Card>
  );
}

const panelStyle: React.CSSProperties = { flex: 1, minHeight: 0, overflowY: "auto", padding: "28px 32px 72px" };
