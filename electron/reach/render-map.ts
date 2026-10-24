import type { AppRecord, ReachLevel, ReachMap } from "./types";

// Draws a ReachMap as one standalone HTML page: a treemap where each tile is an app and its area follows how much the app
// publishes about itself. Large teal tiles are territory the agent can already work in; grey hatched tiles are the frontier,
// the apps nothing has been found for yet. App names come from other vendors' files, so every string is escaped.

interface Box { x: number; y: number; w: number; h: number }
interface Item { app: AppRecord; value: number }

const LEVEL_FILL: Record<ReachLevel, string> = { scriptable: "#0f766e", partial: "#b45309", unmapped: "#475569" };
const LEVEL_LABEL: Record<ReachLevel, string> = {
  scriptable: "Scriptable — the app publishes enough of its own to call it directly",
  partial: "Partial — only generic or a few app-specific entries; gaps remain",
  unmapped: "Unmapped — nothing found yet; GUI exploration frontier",
};

export function escapeXml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch] as string);
}

function weight(app: AppRecord): number {
  return 3 + Math.sqrt(app.usableCount) * 3;
}

// Squarified treemap (Bruls, Huizing, van Wijk 2000): fill rows along the shorter side while the worst aspect ratio improves.
export function squarify(items: Item[], box: Box): Array<{ app: AppRecord; box: Box }> {
  const sorted = [...items].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((sum, item) => sum + item.value, 0);
  const placed: Array<{ app: AppRecord; box: Box }> = [];
  if (total <= 0 || box.w <= 0 || box.h <= 0) return placed;
  const scale = (box.w * box.h) / total;
  let remaining = sorted.map((item) => ({ app: item.app, area: item.value * scale }));
  let free = { ...box };

  const worst = (row: number[], side: number): number => {
    const sum = row.reduce((a, b) => a + b, 0);
    const max = Math.max(...row);
    const min = Math.min(...row);
    return Math.max((side * side * max) / (sum * sum), (sum * sum) / (side * side * min));
  };

  while (remaining.length > 0) {
    const side = Math.min(free.w, free.h);
    const row: typeof remaining = [];
    let areas: number[] = [];
    while (remaining.length > 0) {
      const candidate = [...areas, remaining[0].area];
      if (areas.length === 0 || worst(candidate, side) <= worst(areas, side)) {
        row.push(remaining[0]);
        areas = candidate;
        remaining = remaining.slice(1);
      } else break;
    }
    const rowArea = areas.reduce((a, b) => a + b, 0);
    if (free.w >= free.h) {
      const width = rowArea / free.h;
      let y = free.y;
      for (const entry of row) {
        const height = entry.area / width;
        placed.push({ app: entry.app, box: { x: free.x, y, w: width, h: height } });
        y += height;
      }
      free = { x: free.x + width, y: free.y, w: free.w - width, h: free.h };
    } else {
      const height = rowArea / free.w;
      let x = free.x;
      for (const entry of row) {
        const width = entry.area / height;
        placed.push({ app: entry.app, box: { x, y: free.y, w: width, h: height } });
        x += width;
      }
      free = { x: free.x, y: free.y + height, w: free.w, h: free.h - height };
    }
  }
  return placed;
}

function fitLabel(text: string, widthPx: number, fontPx: number): string {
  const capacity = Math.max(0, Math.floor(widthPx / (fontPx * 0.56)));
  if (capacity < 3) return "";
  return text.length <= capacity ? text : `${text.slice(0, Math.max(1, capacity - 1))}…`;
}

export function renderMapHtml(map: ReachMap, options: { title?: string } = {}): string {
  const width = 1200;
  const height = 720;
  const gap = 2;
  const placed = squarify(map.apps.map((app) => ({ app, value: weight(app) })), { x: 0, y: 0, w: width, h: height });
  const tiles = placed.map(({ app, box }) => {
    const x = box.x + gap / 2;
    const y = box.y + gap / 2;
    const w = Math.max(0, box.w - gap);
    const h = Math.max(0, box.h - gap);
    const fontPx = Math.max(9, Math.min(15, w / 9, h / 3));
    const name = fitLabel(app.name, w - 10, fontPx);
    const detail = app.capabilityCount === 0 ? "nothing found yet"
      : app.specificCount === 0 ? "document basics only"
      : `${app.usableCount} usable · ${app.specificCount - app.usableCount} seen · ${app.capabilityCount - app.specificCount} generic`;
    const sub = h > fontPx * 3.2 ? fitLabel(detail, w - 10, fontPx * 0.8) : "";
    const dash = app.kind === "native" ? "" : ' stroke-dasharray="4 3" stroke="#f8fafc" stroke-width="1.5"';
    const title = `${app.name} ${app.version ?? ""}\n${LEVEL_LABEL[app.level]}\n${detail}\nkind: ${app.kind}${app.signals.length ? `\nsignals: ${app.signals.join(", ")}` : ""}`;
    const fill = app.level === "unmapped" ? "url(#frontier)" : LEVEL_FILL[app.level];
    return `<g><title>${escapeXml(title)}</title><rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="${fill}"${dash}/>` +
      (name ? `<text x="${(x + 6).toFixed(1)}" y="${(y + fontPx + 4).toFixed(1)}" font-size="${fontPx.toFixed(1)}" fill="#f8fafc" font-weight="600">${escapeXml(name)}</text>` : "") +
      (sub ? `<text x="${(x + 6).toFixed(1)}" y="${(y + fontPx * 2.1 + 5).toFixed(1)}" font-size="${(fontPx * 0.8).toFixed(1)}" fill="#e2e8f0">${escapeXml(sub)}</text>` : "") +
      `</g>`;
  }).join("\n");
  const t = map.totals;
  const legend = (["scriptable", "partial", "unmapped"] as const)
    .map((level) => `<li><span class="sw" style="background:${LEVEL_FILL[level]}"></span><b>${t.byLevel[level]}</b> ${escapeXml(LEVEL_LABEL[level])}</li>`).join("");
  const title = escapeXml(options.title ?? "Agentlas Reach — app map");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title>
<style>body{margin:0;background:#0f172a;color:#e2e8f0;font:14px/1.45 -apple-system,Segoe UI,sans-serif}header{padding:16px 24px}h1{margin:0 0 4px;font-size:20px}
.sub{color:#94a3b8}ul{list-style:none;padding:0;margin:10px 0 0;display:flex;flex-wrap:wrap;gap:6px 22px}.sw{display:inline-block;width:12px;height:12px;border-radius:2px;margin-right:6px;vertical-align:-1px}
svg{display:block;margin:0 24px 24px;width:calc(100% - 48px);height:auto}text{font-family:inherit}</style></head><body>
<header><h1>${title}</h1><div class="sub">${escapeXml(map.platform)} · ${t.apps} apps · ${t.capabilities.toLocaleString("en-US")} published capabilities (${t.usable.toLocaleString("en-US")} usable) · generated ${escapeXml(map.generatedAt)}. Tile area follows how much an app publishes about itself; dashed outline = not a native app.</div>
<ul>${legend}</ul></header>
<svg viewBox="0 0 ${width} ${height}" role="img" aria-label="Treemap of installed apps by published capabilities"><defs><pattern id="frontier" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="8" height="8" fill="#334155"/><rect width="2.5" height="8" fill="#475569"/></pattern></defs>
${tiles}
</svg></body></html>`;
}
