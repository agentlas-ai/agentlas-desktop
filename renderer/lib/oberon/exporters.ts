// Oberon — 산출물 내보내기.
//
// 계획 단계만으로도 즉시 쓸 수 있는 산출물을 만든다. 수백~수천 샷 프롬프트는
// 어떤 영상툴(Veo/Runway/Luma/Pika 등)에든 붙여 바로 생성할 수 있다.

import { providerById } from "./providers";
import { SHOT_SIZES } from "./taxonomy";
import type { FilmProduction, ShotSpec } from "./types";

function csvCell(v: string | number): string {
  const s = String(v ?? "");
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** 샷 리스트 CSV — 스프레드시트/제작 관리툴 임포트용. */
export function exportShotListCsv(prod: FilmProduction): string {
  const header = [
    "shot_id", "scene", "beat", "duration_s", "type", "size", "angle", "movement", "lens",
    "provider", "mode", "est_cost_usd", "transition_in", "transition_out", "action", "dialogue",
  ];
  const rows = prod.shots.map((s) => [
    s.shotId, s.sceneId, s.beatId, s.durationSec, s.shotType,
    s.camera.size, s.camera.angle, s.camera.movement, s.camera.lens,
    s.providerId, s.providerMode, s.estCostUsd, s.transitionIn, s.transitionOut,
    s.action, s.dialogue ?? "",
  ]);
  return [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\n");
}

/** 프롬프트 팩 — 샷별 생성 프롬프트 + 네거티브 + 프로바이더 (텍스트). */
export function exportPromptPack(prod: FilmProduction): string {
  const lines: string[] = [];
  lines.push(`# ${prod.brief.title} — Prompt Pack`);
  lines.push(`# ${prod.stats.shotCount} shots · ${prod.stats.totalDurationSec}s · ${prod.brief.aspect}`);
  lines.push(`# Visual DNA: ${prod.bible.visualDirection}`);
  lines.push("");
  for (const scene of prod.scenes) {
    lines.push(`\n## ${scene.heading}  [${scene.type}]`);
    const shots = prod.shots.filter((s) => s.sceneId === scene.id);
    for (const s of shots) {
      const sz = SHOT_SIZES[s.camera.size].label;
      lines.push(`\n### ${s.shotId} · ${sz} · ${s.durationSec}s · → ${providerById(s.providerId)?.name ?? s.providerId} (${s.providerMode})`);
      lines.push(`PROMPT: ${s.generationPrompt}`);
      lines.push(`NEGATIVE: ${s.negativePrompt}`);
      if (s.requiresKeyframe) {
        lines.push(`KEYFRAME REQUIRED: generate and approve a first-frame image before video render`);
      }
      if (s.firstFrameAssetId) lines.push(`APPROVED FIRST FRAME: ${s.firstFrameAssetId}`);
    }
  }
  return lines.join("\n");
}

/** Continuity Bible — Markdown. 제작팀 공유용 do-not-change 문서. */
export function exportBibleMarkdown(prod: FilmProduction): string {
  const b = prod.bible;
  const lines: string[] = [];
  lines.push(`# ${prod.brief.title} — Continuity Bible`);
  lines.push(`\n**Visual Direction:** ${b.visualDirection}`);
  lines.push(`**Film Stock / Grade:** ${b.filmStock}`);
  lines.push(`**Lighting:** ${b.lightingStyle}`);
  lines.push(`**Palette:** ${b.colorPalette.map((c) => `${c.name} (${c.hex})`).join(", ")}`);
  lines.push(`\n## Global — 절대 변경 금지`);
  b.globalMustKeep.forEach((k) => lines.push(`- ✅ KEEP: ${k}`));
  b.globalMustAvoid.forEach((k) => lines.push(`- ⛔ AVOID: ${k}`));
  lines.push(`\n## References (${b.references.length})`);
  for (const r of b.references) {
    lines.push(`\n### [${r.kind}] ${r.name}  \`${r.id}\``);
    lines.push(`- Locked traits: ${r.lockedTraits.join(", ")}`);
    if (r.notes) lines.push(`- Notes: ${r.notes}`);
    lines.push(`- Reference prompt: ${r.prompt}`);
  }
  return lines.join("\n");
}

/** EDL — 편집 결정 리스트 (CMX-유사 단순 포맷). */
export function exportEdl(prod: FilmProduction): string {
  const lines: string[] = [`TITLE: ${prod.brief.title}`, `FCM: NON-DROP FRAME`, ""];
  prod.edl.forEach((e, i) => {
    lines.push(
      `${String(i + 1).padStart(3, "0")}  ${e.shotId}  V  ${e.transitionIn.toUpperCase()}  ` +
        `${e.inSec.toFixed(1)}s  ${e.outSec.toFixed(1)}s  (dur ${e.durationSec.toFixed(1)}s · take ${e.takeId})`,
    );
  });
  return lines.join("\n");
}

/** 전체 제작 JSON — 재로드/백업/외부 파이프라인 전달. */
export function exportProductionJson(prod: FilmProduction): string {
  return JSON.stringify(prod, null, 2);
}

/** 프로바이더 라우팅 매트릭스 요약 (제작 비용 리포트). */
export function exportRoutingMatrix(prod: FilmProduction): string {
  const counts = new Map<string, { shots: number; cost: number }>();
  for (const s of prod.shots) {
    const cur = counts.get(s.providerId) ?? { shots: 0, cost: 0 };
    cur.shots += 1;
    cur.cost += s.estCostUsd;
    counts.set(s.providerId, cur);
  }
  const lines = ["provider,shots,est_cost_usd,best_for"];
  for (const [id, v] of counts) {
    const p = providerById(id);
    lines.push([id, v.shots, v.cost.toFixed(2), p?.bestFor ?? ""].map(csvCell).join(","));
  }
  return lines.join("\n");
}

export interface ExportFile {
  name: string;
  content: string;
  mime: string;
}

export function buildAllExports(prod: FilmProduction): ExportFile[] {
  const slug = prod.brief.title.replace(/[^\w가-힣]+/g, "_").slice(0, 40) || "oberon";
  return [
    { name: `${slug}_shotlist.csv`, content: exportShotListCsv(prod), mime: "text/csv" },
    { name: `${slug}_prompt_pack.txt`, content: exportPromptPack(prod), mime: "text/plain" },
    { name: `${slug}_continuity_bible.md`, content: exportBibleMarkdown(prod), mime: "text/markdown" },
    { name: `${slug}_routing.csv`, content: exportRoutingMatrix(prod), mime: "text/csv" },
    { name: `${slug}_edl.txt`, content: exportEdl(prod), mime: "text/plain" },
    { name: `${slug}_production.json`, content: exportProductionJson(prod), mime: "application/json" },
  ];
}

/** 클라이언트 다운로드 트리거. */
export function downloadText(file: ExportFile): void {
  if (typeof window === "undefined") return;
  const blob = new Blob([file.content], { type: file.mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = file.name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
