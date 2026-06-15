// Oberon — Continuity Bible. 인물·공간·의상·소품을 수백 샷에 걸쳐 유지하는 캐논.
"use client";
import type { ContinuityBible as Bible, ReferenceEntry, FilmProduction } from "@/lib/oberon";
import { providerById, routeImageProvider } from "@/lib/oberon";
import { IconShield, IconCheck, IconClose, IconImage } from "@/components/Icon";
import { Card, PanelHead, Swatch, Tag, providerColor } from "./ui";

const KIND_KO: Record<ReferenceEntry["kind"], string> = {
  character: "인물",
  location: "공간",
  wardrobe: "의상",
  prop: "소품",
  vehicle: "탈것",
  style: "스타일",
};
const KIND_GRAD: Record<ReferenceEntry["kind"], string> = {
  character: "linear-gradient(135deg,#3a2438,#1a0f18)",
  location: "linear-gradient(135deg,#1e3a3a,#08161a)",
  wardrobe: "linear-gradient(135deg,#3a3424,#1a1608)",
  prop: "linear-gradient(135deg,#24343a,#0a161a)",
  vehicle: "linear-gradient(135deg,#2a2a3a,#0c0c18)",
  style: "linear-gradient(135deg,#3a2a2a,#1a0c0c)",
};

export function ContinuityBiblePanel({ production }: { production: FilmProduction }) {
  const b: Bible = production.bible;
  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "20px 28px 60px" }}>
      <PanelHead
        title="Continuity Bible — 절대 변하면 안 되는 것"
        subtitle="인물·공간·소품의 식별 특징을 락(lock)하고, 모든 샷 프롬프트가 이 레퍼런스 id를 인용합니다. QA는 이 바이블로 정합성을 검사합니다."
        icon={<IconShield size={18} />}
      />

      {/* 비주얼 DNA */}
      <Card style={{ padding: 16, marginBottom: 18 }}>
        <div style={{ fontSize: 11, fontFamily: "var(--font-mono)", letterSpacing: 0.5, color: "var(--muted-deep)", marginBottom: 8 }}>VISUAL DNA</div>
        <p style={{ margin: "0 0 14px", fontSize: 14, color: "var(--ink)", lineHeight: 1.5, fontWeight: 600 }}>{b.visualDirection}</p>
        <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-end" }}>
          <div>
            <div style={miniLabel}>PALETTE</div>
            <div style={{ display: "flex", gap: 10 }}>
              {b.colorPalette.map((s) => (
                <Swatch key={s.hex} hex={s.hex} name={s.name} />
              ))}
            </div>
          </div>
          <div style={{ flex: 1, minWidth: 200, display: "flex", flexDirection: "column", gap: 8 }}>
            <div>
              <div style={miniLabel}>FILM STOCK / GRADE</div>
              <div style={valueText}>{b.filmStock}</div>
            </div>
            <div>
              <div style={miniLabel}>LIGHTING</div>
              <div style={valueText}>{b.lightingStyle}</div>
            </div>
          </div>
        </div>
      </Card>

      {/* 글로벌 do-not-change */}
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, marginBottom: 22 }}>
        <Card style={{ padding: 14 }}>
          <div style={{ ...miniLabel, color: "var(--green-deep)" }}>✅ KEEP — 유지</div>
          <ul style={listStyle}>
            {b.globalMustKeep.map((k, i) => (
              <li key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                <IconCheck size={12} style={{ color: "var(--green-deep)", marginTop: 2, flexShrink: 0 }} />
                <span>{k}</span>
              </li>
            ))}
          </ul>
        </Card>
        <Card style={{ padding: 14 }}>
          <div style={{ ...miniLabel, color: "var(--red-deep)" }}>⛔ AVOID — 금지</div>
          <ul style={listStyle}>
            {b.globalMustAvoid.map((k, i) => (
              <li key={i} style={{ display: "flex", gap: 6, alignItems: "flex-start" }}>
                <IconClose size={12} style={{ color: "var(--red-deep)", marginTop: 2, flexShrink: 0 }} />
                <span>{k}</span>
              </li>
            ))}
          </ul>
        </Card>
      </div>

      {/* 레퍼런스 세트 */}
      <div style={{ ...miniLabel, marginBottom: 10 }}>REFERENCE SET — {b.references.length}개</div>
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 14 }}>
        {b.references.map((r) => (
          <ReferenceCard key={r.id} entry={r} />
        ))}
      </div>
    </div>
  );
}

function ReferenceCard({ entry }: { entry: ReferenceEntry }) {
  const imgRoute = routeImageProvider(entry.kind === "character" ? "character" : entry.kind === "prop" ? "product" : "keyframe");
  const provider = providerById(imgRoute.providerId);
  const pColor = providerColor(imgRoute.providerId);
  return (
    <Card style={{ display: "flex", flexDirection: "column" }}>
      <div style={{ height: 96, background: KIND_GRAD[entry.kind], position: "relative", display: "flex", alignItems: "flex-end", padding: 8 }}>
        <Tag color="#fff">{KIND_KO[entry.kind]}</Tag>
        <code style={{ position: "absolute", top: 8, right: 8, fontSize: 9.5, fontFamily: "var(--font-mono)", color: "rgba(255,255,255,0.85)", background: "rgba(0,0,0,0.4)", padding: "2px 5px", borderRadius: 4 }}>
          {entry.id}
        </code>
      </div>
      <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 7 }}>
        <div style={{ fontSize: 13.5, fontWeight: 700, color: "var(--ink)" }}>{entry.name}</div>
        {entry.notes && <div style={{ fontSize: 11, color: "var(--muted-deep)" }}>{entry.notes}</div>}
        <div>
          <div style={{ fontSize: 9, fontFamily: "var(--font-mono)", color: "var(--muted-deep)", marginBottom: 4 }}>LOCKED TRAITS</div>
          <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
            {entry.lockedTraits.map((t, i) => (
              <Tag key={i}>{t}</Tag>
            ))}
          </div>
        </div>
        <div style={{ fontSize: 10.5, color: "var(--ink-soft)", lineHeight: 1.5, background: "var(--fill-1)", borderRadius: 8, padding: "7px 9px", border: "1px solid var(--paper-edge)" }}>
          {entry.prompt}
        </div>
        <div style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10.5, fontWeight: 600, color: pColor }}>
          <IconImage size={11} /> {provider?.name ?? imgRoute.providerId}
        </div>
      </div>
    </Card>
  );
}

const miniLabel: React.CSSProperties = { fontSize: 10, fontFamily: "var(--font-mono)", letterSpacing: 0.5, color: "var(--muted-deep)", marginBottom: 6, fontWeight: 700 };
const valueText: React.CSSProperties = { fontSize: 12.5, color: "var(--ink-soft)", lineHeight: 1.4 };
const listStyle: React.CSSProperties = { margin: 0, padding: 0, listStyle: "none", display: "flex", flexDirection: "column", gap: 6, fontSize: 12, color: "var(--ink-soft)", lineHeight: 1.4 };
