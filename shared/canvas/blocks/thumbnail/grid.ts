import { z } from "zod";
import { list, optionalText, text } from "../../fields";
import { esc } from "../../kit";
import { defineAsset, type AnyAsset } from "../contract";
import { KINDS, badgeOf, kindField, kindOf, wholeNum } from "./_shared";

/** A tidy grid of up to eight mini file tiles (type badge, name, size) with a heading and a "+N more" count. It flows with the card (no frame): the tiles are rows, not pictures. */
const file = z.object({ name: text(60), kind: kindField, size: optionalText(12) }).strip();

const FOLDER = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" fill="#fff"/></svg>';
const LINK = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="#fff" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3.2 3 3.2 15 0 18M12 3c-3.2 3-3.2 15 0 18"/></svg>';

export const fileGrid = defineAsset({
  type: "file_grid", category: "thumbnail", width: "full",
  use: "A grid of up to eight files (type badge, name, size) with a heading and a +N more count: a folder listing, recent files or search results.",
  useKo: "최대 여덟 개 파일(유형 배지·이름·크기)을 격자로 보여줍니다: 폴더 목록, 최근 파일, 검색 결과에 쓰며 나머지 개수도 표시합니다.",
  tags: ["files", "file list", "grid", "recent files", "search results", "folder contents", "파일", "파일 목록", "격자", "최근 파일"],
  notes: "The block's title is the heading. Each file is {name, size?, kind?}: kind (pdf, word, sheet, slides, image, video, audio, archive, code, markdown, data, folder, link) is read from the extension when left out. more is how many files are not shown.",
  fields: { files: list(file, 1, 8), more: wholeNum },
  sample: {
    title: "Recent files", more: 24,
    files: [{ name: "Q3-financial-report.pdf", size: "2.4 MB" }, { name: "Proposal-draft.docx", size: "184 KB" }, { name: "Sales-forecast-2027.xlsx", size: "86 KB" }, { name: "Q3-growth-review.pptx", size: "8.6 MB" }, { name: "Lisbon-sunset-0412.jpg", size: "3.2 MB" }, { name: "Product-demo.mp4", size: "412 MB" }, { name: "Brand-assets-2026.zip", size: "142 MB" }, { name: "Launch campaign", kind: "folder", size: "128 items" }],
  },
  render(b, { ko, T }) {
    const tiles = b.files.map(f => {
      const kind = kindOf(f.name, f.kind), { color } = KINDS[kind], mark = kind === "folder" ? FOLDER : kind === "link" ? LINK : esc(badgeOf(f.name, kind));
      return `<div class="a-ti"><span class="a-bk" style="background:${color}">${mark}</span><span class="a-tx"><b>${esc(f.name)}</b>${f.size ? `<small>${esc(f.size)}</small>` : ""}</span></div>`;
    }).join("");
    const more = b.more ? `<span class="a-more">+${b.more.toLocaleString(ko ? "ko-KR" : "en-US")}${ko ? "개 더" : " more"}</span>` : "";
    return `${b.title || more ? `<div class="sec"><span>${esc(b.title ?? T("Files", "파일"))}</span>${more}</div>` : ""}<div class="a-gr">${tiles}</div>`;
  },
  summary: b => `${b.title ?? "Files"}: ${b.files.map(f => `${f.name}${f.size ? ` (${f.size})` : ""}`).join(", ")}${b.more ? `, and ${b.more} more` : ""}.`.slice(0, 390),
  css: ".fpc .a-file_grid .a-gr{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:10px}.fpc .a-file_grid .a-ti{display:flex;align-items:center;gap:12px;min-width:0;padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:#fff}.fpc .a-file_grid .a-bk{flex:none;display:grid;place-items:center;width:40px;height:40px;border-radius:10px;color:#fff;font-size:10px;font-weight:800;letter-spacing:.02em}.fpc .a-file_grid .a-tx{min-width:0;display:flex;flex-direction:column;gap:2px}.fpc .a-file_grid .a-tx b,.fpc .a-file_grid .a-tx small{overflow:hidden;white-space:nowrap;text-overflow:ellipsis}.fpc .a-file_grid .a-tx b{font-size:13.5px;font-weight:700}.fpc .a-file_grid .a-tx small{font-size:12px;font-weight:600;color:var(--muted)}.fpc .a-file_grid .a-more{margin-left:auto;padding:2px 10px;border-radius:999px;background:var(--surface);color:var(--muted);font-size:12px;font-weight:700}@container (max-width:700px){.fpc .a-file_grid .a-gr{grid-template-columns:repeat(2,minmax(0,1fr))}}",
});
export const ASSETS: readonly AnyAsset[] = [fileGrid];
