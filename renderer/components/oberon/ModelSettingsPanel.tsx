// Oberon — 모델 설정 패널. 시작 창에서 "어떤 모델로 만들지" 고른다.
//  · 대본·기획   → BYOK CLI 런타임 (runtime.detect)
//  · 컷·이미지   → 멀티모달 image provider (codex-cli-image 등 — 병렬)
//  · 영상(복수)  → 멀티모달 video provider (Higgsfield/Seedance/Veo … — 병렬)
"use client";
import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { providersForModality, type MultimodalProvider } from "@shared/multimodal";
import type { RuntimeStatus } from "@/lib/types";
import type { ModelSettings } from "@/lib/oberon";
import { Glyph, OberonBadge } from "./icons";

interface RuntimeOpt {
  kind: string;
  label: string;
  detected: boolean;
}

const RUNTIME_FALLBACK: RuntimeOpt[] = [
  { kind: "claude-code", label: "Claude Code", detected: false },
  { kind: "codex", label: "Codex", detected: false },
  { kind: "gemini", label: "Gemini CLI", detected: false },
];

const RUNTIME_LABEL: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  gemini: "Gemini CLI",
};
const CLI_RUNTIMES = new Set(["claude-code", "codex", "gemini"]);

export function ModelSettingsPanel({
  value,
  onChange,
}: {
  value: ModelSettings;
  onChange: (next: ModelSettings) => void;
}) {
  const [runtimes, setRuntimes] = useState<RuntimeOpt[]>(RUNTIME_FALLBACK);
  const [ready, setReady] = useState<Record<string, boolean>>({});

  const imageProviders = providersForModality("image");
  const videoProviders = providersForModality("video").filter((p) => p.id !== "openai-sora"); // Sora 제외(종료)

  useEffect(() => {
    const api = ipc();
    if (!api) return;
    let cancelled = false;
    void api.runtime
      .detect()
      .then((list: RuntimeStatus[]) => {
        if (cancelled || !list?.length) return;
        const opts: RuntimeOpt[] = list
          .filter((r) => CLI_RUNTIMES.has(r.kind))
          .map((r) => ({ kind: r.kind, label: RUNTIME_LABEL[r.kind] ?? r.kind, detected: true }));
        // 감지 안 된 런타임도 fallback으로 채워 선택지 유지
        const merged: RuntimeOpt[] = [...opts];
        for (const f of RUNTIME_FALLBACK) if (!merged.some((m) => m.kind === f.kind)) merged.push(f);
        setRuntimes(merged);
        const activeR = list.find((r) => r.active && CLI_RUNTIMES.has(r.kind)) ?? list.find((r) => CLI_RUNTIMES.has(r.kind));
        if (activeR && activeR.kind !== value.textRuntime) {
          onChange({ ...value, textRuntime: activeR.kind, textRuntimeLabel: RUNTIME_LABEL[activeR.kind] ?? activeR.kind });
        }
      })
      .catch(() => {});
    void api.multimodal
      ?.status?.()
      .then((rows: Array<{ provider: { id: string }; ready: boolean }>) => {
        if (cancelled || !rows) return;
        const m: Record<string, boolean> = {};
        for (const r of rows) m[r.provider.id] = r.ready;
        setReady(m);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function toggleVideo(id: string) {
    const has = value.videoProviders.includes(id);
    const next = has ? value.videoProviders.filter((x) => x !== id) : [...value.videoProviders, id];
    onChange({ ...value, videoProviders: next.length ? next : value.videoProviders });
  }

  return (
    <div
      style={{
        border: "1px solid var(--ob-edge, #ececf0)",
        borderRadius: 14,
        background: "var(--ob-paper, #fff)",
        padding: 14,
        marginBottom: 20,
        boxShadow: "0 1px 2px rgba(20,22,30,0.04)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
        <OberonBadge name="setup" color="#5b5bd6" size={26} glyphSize={15} />
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: "var(--ob-ink, #16171d)" }}>모델 스택</div>
          <div style={{ fontSize: 10.5, color: "var(--ob-muted, #6b7280)" }}>단계별로 어떤 모델/CLI로 만들지 고릅니다 (BYOK)</div>
        </div>
      </div>

      <Row glyph="cli" color="#0b7285" title="대본 · 기획 엔진" hint="기획·대본·스토리보드를 쓰는 BYOK CLI">
        {runtimes.map((r) => (
          <Pick
            key={r.kind}
            label={r.label}
            sub={r.detected ? "감지됨" : undefined}
            selected={value.textRuntime === r.kind}
            onClick={() => onChange({ ...value, textRuntime: r.kind, textRuntimeLabel: r.label })}
          />
        ))}
      </Row>

      <Row glyph="keyframe" color="#e8590c" title="컷 · 이미지 엔진" hint="레퍼런스·키프레임 (병렬 생성)">
        {imageProviders.map((p) => (
          <Pick
            key={p.id}
            label={p.labelKo}
            sub={statusSub(ready, p)}
            selected={value.imageProvider === p.id}
            onClick={() => onChange({ ...value, imageProvider: p.id })}
            title={p.summaryKo}
          />
        ))}
      </Row>

      <Row glyph="video" color="#d6336c" title="영상 엔진 (복수 선택 · 병렬)" hint="샷을 선택한 엔진들에 병렬 분배">
        {videoProviders.map((p) => (
          <Pick
            key={p.id}
            label={p.labelKo}
            sub={statusSub(ready, p)}
            selected={value.videoProviders.includes(p.id)}
            onClick={() => toggleVideo(p.id)}
            title={p.summaryKo}
            multi
          />
        ))}
      </Row>
    </div>
  );
}

function statusSub(ready: Record<string, boolean>, p: MultimodalProvider): string | undefined {
  if (Object.keys(ready).length === 0) return p.envKeys.length === 0 ? "구독" : undefined;
  return ready[p.id] ? "키 등록됨" : "키 필요";
}

function Row({
  glyph,
  color,
  title,
  hint,
  children,
}: {
  glyph: string;
  color: string;
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <div style={{ display: "flex", gap: 12, padding: "8px 0", borderTop: "1px dashed var(--ob-edge, #eff0f3)" }}>
      <div style={{ width: 130, flexShrink: 0, display: "flex", gap: 8, alignItems: "flex-start", paddingTop: 2 }}>
        <OberonBadge name={glyph as never} color={color} size={22} glyphSize={13} />
        <div>
          <div style={{ fontSize: 11.5, fontWeight: 700, color: "var(--ob-ink, #16171d)", lineHeight: 1.2 }}>{title}</div>
          <div style={{ fontSize: 9.5, color: "var(--ob-muted, #9aa0ad)", lineHeight: 1.3, marginTop: 1 }}>{hint}</div>
        </div>
      </div>
      <div style={{ flex: 1, display: "flex", gap: 6, flexWrap: "wrap", alignItems: "flex-start" }}>{children}</div>
    </div>
  );
}

function Pick({
  label,
  sub,
  selected,
  onClick,
  title,
  multi,
}: {
  label: string;
  sub?: string;
  selected: boolean;
  onClick: () => void;
  title?: string;
  multi?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 6,
        padding: "6px 11px",
        borderRadius: 8,
        border: `1px solid ${selected ? "var(--ob-ink)" : "var(--ob-edge-strong)"}`,
        background: selected ? "var(--ob-ink)" : "var(--ob-paper)",
        color: selected ? "#fff" : "var(--ob-ink-soft)",
        fontSize: 12.5,
        fontWeight: 500,
        cursor: "pointer",
        transition: "all 0.13s",
      }}
    >
      {multi && (
        <span style={{ display: "inline-flex", opacity: selected ? 1 : 0.4 }}>
          <Glyph name={selected ? "check" : "plus"} size={11} strokeWidth={2.4} />
        </span>
      )}
      {label}
      {sub && (
        <span style={{ fontSize: 10, fontWeight: 500, color: selected ? "rgba(255,255,255,0.7)" : "var(--ob-muted)" }}>
          {sub}
        </span>
      )}
    </button>
  );
}
