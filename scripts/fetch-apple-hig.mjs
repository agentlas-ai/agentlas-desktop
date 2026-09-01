#!/usr/bin/env node
/*
 * fetch-apple-hig — Apple Human Interface Guidelines 전문을 design 플러그인의
 * 로컬 캐시로 내려받고, 커밋 대상인 라우팅표(hig-lookup.md)를 다시 만든다.
 *
 * 왜 캐시인가: HIG 본문의 저작권은 Apple 에 있고 이 저장소는 공개다. 그래서
 * 원문은 `references/apple-hig/.cache/` 에만 두고(점 디렉터리라 plugin walkFiles·
 * copy-builtin-plugins·integrity 모두가 건너뛴다), 저장소에는 우리가 쓴 파생
 * 문서(체크리스트·라우팅표·용어표·리뷰 규약)만 커밋한다.
 *
 * 페이지 본문은 HIG 사이트가 JS 로 그리므로 HTML 에서는 얻을 수 없다. 실제
 * 원본은 사이트가 읽는 DocC JSON 이다:
 *   https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<slug>.json
 *
 * 사용:
 *   node scripts/fetch-apple-hig.mjs            # 캐시 갱신 + 라우팅표 재생성
 *   node scripts/fetch-apple-hig.mjs --lookup-only   # 캐시가 이미 있을 때 표만
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, "..");
const HIG_DIR = path.join(ROOT, "plugins", "design", "references", "apple-hig");
const CACHE = path.join(HIG_DIR, ".cache");
const PAGES = path.join(CACHE, "pages");
const DATA = "https://developer.apple.com/tutorials/data";
const SITE = "https://developer.apple.com";
const ROOT_PATH = "/design/human-interface-guidelines";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const SECTIONS = ["getting-started", "foundations", "patterns", "components", "inputs", "technologies"];

const lookupOnly = process.argv.includes("--lookup-only");

async function getJson(urlPath) {
  const url = `${DATA}${urlPath}.json`;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (error) {
      if (attempt === 2) {
        console.error(`  ! ${urlPath}: ${error.message}`);
        return null;
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  return null;
}

const slugOf = (url) => url.split("#")[0].replace(/\/$/, "").split("/").pop();

/* ── DocC content → markdown ─────────────────────────────────── */

function inline(nodes, refs) {
  let out = "";
  for (const n of nodes || []) {
    switch (n.type) {
      case "text":
        out += n.text ?? "";
        break;
      case "strong":
        out += `**${inline(n.inlineContent, refs)}**`;
        break;
      case "emphasis":
        out += `*${inline(n.inlineContent, refs)}*`;
        break;
      case "codeVoice":
        out += `\`${n.code ?? ""}\``;
        break;
      case "image":
        break; // 그림은 캐시하지 않는다 — 규칙은 본문에 글로 있다
      case "reference": {
        const ref = refs[n.identifier] || {};
        const title =
          inline(n.overridingTitleInlineContent, refs) || n.overridingTitle || ref.title || n.identifier || "";
        const url = ref.url || "";
        if (url.startsWith(ROOT_PATH)) {
          const [target, anchor] = url.slice(1).split("#");
          out += `[${title}](./${slugOf(target)}.md${anchor ? `#${anchor}` : ""})`;
        } else if (url) {
          out += `[${title}](${url.startsWith("http") ? url : SITE + url})`;
        } else {
          out += title;
        }
        break;
      }
      case "link":
        out += `[${n.title ?? ""}](${n.destination ?? ""})`;
        break;
      case "inlineHead":
        out += `**${inline(n.inlineContent, refs)}**`;
        break;
      default:
        if (n.inlineContent) out += inline(n.inlineContent, refs);
    }
  }
  return out;
}

function blocks(nodes, refs, lines, depth = 0) {
  const flatten = (content) => {
    const sub = [];
    blocks(content, refs, sub, depth + 1);
    return sub.filter((s) => s.trim()).join(" ").trim();
  };
  for (const n of nodes || []) {
    switch (n.type) {
      case "heading":
        lines.push("", "#".repeat(Math.min(6, Math.max(2, n.level ?? 2))) + ` ${n.text ?? ""}`, "");
        break;
      case "paragraph": {
        const s = inline(n.inlineContent, refs).trim();
        if (s) lines.push(s, "");
        break;
      }
      case "unorderedList":
      case "orderedList": {
        (n.items || []).forEach((item, i) => {
          const text = flatten(item.content);
          if (text) lines.push("  ".repeat(depth) + (n.type === "unorderedList" ? "- " : `${i + 1}. `) + text);
        });
        lines.push("");
        break;
      }
      case "aside": {
        const body = flatten(n.content);
        const label = (n.name || n.style || "note").replace(/^\w/, (c) => c.toUpperCase());
        if (body) lines.push(`> **${label}:** ${body}`, "");
        break;
      }
      case "table": {
        const rows = n.rows || [];
        if (!rows.length) break;
        const cells = (row) => row.map((cell) => flatten(cell).replace(/\|/g, "\\|") || " ");
        const header = cells(rows[0]);
        lines.push(`| ${header.join(" | ")} |`, `|${"---|".repeat(header.length)}`);
        for (const row of rows.slice(1)) lines.push(`| ${cells(row).join(" | ")} |`);
        lines.push("");
        break;
      }
      case "codeListing":
        lines.push("```" + (n.syntax || ""), ...(n.code || []), "```", "");
        break;
      case "termList":
        for (const item of n.items || []) {
          lines.push(`- **${inline(item.term?.inlineContent, refs)}** — ${flatten(item.definition?.content)}`);
        }
        lines.push("");
        break;
      case "content":
        blocks(n.content, refs, lines, depth);
        break;
      case "tabNavigator":
        for (const tab of n.tabs || []) {
          lines.push(`##### ${tab.title ?? ""}`);
          blocks(tab.content, refs, lines, depth);
        }
        break;
      case "row":
        for (const col of n.columns || []) blocks(col.content, refs, lines, depth);
        break;
      default:
        break;
    }
  }
}

function render(doc, slug) {
  const refs = doc.references || {};
  const meta = doc.metadata || {};
  const custom = meta.customMetadata || {};
  const source = `${SITE}${ROOT_PATH}${slug === "index" ? "" : `/${slug}`}`;
  const lines = ["---", `title: ${meta.title || slug}`, `slug: ${slug}`];
  if (custom["supported-platforms"]) lines.push(`platforms: ${custom["supported-platforms"]}`);
  if (custom["alert-date"]) lines.push(`apple_updated: ${custom["alert-date"]}`);
  if (custom["alert-text"]) lines.push(`apple_update_note: ${String(custom["alert-text"]).replace(/:/g, " -")}`);
  lines.push(`source: ${source}`, "---", "", `# ${meta.title || slug}`, "");
  const abstract = inline(doc.abstract, refs).trim();
  if (abstract) lines.push(abstract, "");
  for (const section of doc.primaryContentSections || []) blocks(section.content, refs, lines);
  const topics = doc.topicSections || [];
  if (topics.length) {
    lines.push("## Related pages", "");
    for (const section of topics) {
      if (section.title) lines.push(`### ${section.title}`);
      for (const id of section.identifiers || []) {
        const ref = refs[id] || {};
        if ((ref.url || "").startsWith(ROOT_PATH)) lines.push(`- [${ref.title || id}](./${slugOf(ref.url)}.md)`);
      }
      lines.push("");
    }
  }
  return `${lines.join("\n").replace(/\n{3,}/g, "\n\n").trim()}\n`;
}

/* ── crawl ───────────────────────────────────────────────────── */

async function crawl() {
  await fs.mkdir(PAGES, { recursive: true });
  const seen = new Set();
  const queue = [ROOT_PATH];
  const docs = new Map();
  while (queue.length) {
    const urlPath = queue.shift();
    if (seen.has(urlPath)) continue;
    seen.add(urlPath);
    const doc = await getJson(urlPath);
    if (!doc) continue;
    const slug = urlPath === ROOT_PATH ? "index" : slugOf(urlPath);
    docs.set(slug, doc);
    await fs.writeFile(path.join(PAGES, `${slug}.md`), render(doc, slug), "utf8");
    for (const ref of Object.values(doc.references || {})) {
      if (ref.type === "topic" && (ref.url || "").startsWith(ROOT_PATH)) {
        const next = ref.url.split("#")[0].replace(/\/$/, "");
        if (!seen.has(next)) queue.push(next);
      }
    }
    if (docs.size % 25 === 0) console.log(`  … ${docs.size} pages fetched, ${queue.length} queued`);
    await new Promise((r) => setTimeout(r, 250));
  }
  return docs;
}

/* ── lookup table (committed) ────────────────────────────────── */

function categorize(docs) {
  const childrenOf = (slug) => {
    const doc = docs.get(slug);
    if (!doc) return [];
    const refs = doc.references || {};
    const out = [];
    for (const section of doc.topicSections || []) {
      for (const id of section.identifiers || []) {
        const url = refs[id]?.url || "";
        if (url.startsWith(ROOT_PATH)) out.push(slugOf(url));
      }
    }
    return out;
  };
  const owner = new Map();
  for (const section of SECTIONS) {
    owner.set(section, section);
    for (const child of childrenOf(section)) {
      if (!owner.has(child)) owner.set(child, section);
      for (const grand of childrenOf(child)) if (!owner.has(grand)) owner.set(grand, section);
    }
  }
  return owner;
}

async function writeLookup(docs) {
  const owner = categorize(docs);
  const rows = [];
  for (const [slug, doc] of docs) {
    if (slug === "index") continue;
    const meta = doc.metadata || {};
    const custom = meta.customMetadata || {};
    const abstract = inline(doc.abstract, doc.references || {})
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\s+/g, " ")
      .trim();
    rows.push({
      slug,
      title: meta.title || slug,
      section: owner.get(slug) || "other",
      platforms: (custom["supported-platforms"] || "").split(",").filter(Boolean),
      updated: custom["alert-date"] || "",
      abstract,
    });
  }
  rows.sort((a, b) => a.title.localeCompare(b.title));
  const label = {
    "getting-started": "Getting started — platform character and design fundamentals",
    foundations: "Foundations — color, type, layout, motion, accessibility, materials",
    patterns: "Patterns — flows people move through (onboarding, search, feedback, modality…)",
    components: "Components — concrete UI parts and their rules",
    inputs: "Inputs — how people drive the interface",
    technologies: "Technologies — system integrations with design rules of their own",
  };
  const lines = [
    "<!-- GENERATED by scripts/fetch-apple-hig.mjs — edit that script, not this file. -->",
    "",
    "# Apple HIG routing table",
    "",
    `${rows.length} guideline pages, grouped the way Apple groups them. Pick pages from here before`,
    "reading anything — a normal review needs 3–8 of them, never the whole corpus.",
    "",
    "**How to open a page**",
    "",
    "1. Local cache first: `references/apple-hig/.cache/pages/<slug>.md`.",
    "2. Cache missing (fresh install, or you want today's text): fetch",
    "   `https://developer.apple.com/tutorials/data/design/human-interface-guidelines/<slug>.json`.",
    "   That JSON is what the HIG site itself renders; the plain page URL returns an empty JS shell.",
    "3. To refill the whole cache offline, a maintainer runs `node scripts/fetch-apple-hig.mjs`.",
    "",
    "`platforms` tells you whether a page even applies: a macOS-only rule does not bind a phone layout.",
    "",
  ];
  for (const section of SECTIONS) {
    const items = rows.filter((r) => r.section === section);
    if (!items.length) continue;
    lines.push(`## ${label[section] || section} (${items.length})`, "");
    lines.push("| Page | slug | Platforms | What it rules on |", "|---|---|---|---|");
    for (const r of items) {
      const platforms = r.platforms.length === 6 ? "all" : r.platforms.join(" ") || "—";
      lines.push(`| ${r.title} | \`${r.slug}\` | ${platforms} | ${r.abstract.replace(/\|/g, "\\|")} |`);
    }
    lines.push("");
  }
  const dated = rows.filter((r) => r.updated).sort((a, b) => b.updated.localeCompare(a.updated));
  if (dated.length) {
    lines.push("## Most recently revised by Apple", "");
    for (const r of dated.slice(0, 25)) lines.push(`- \`${r.slug}\` — ${r.updated}`);
    lines.push("");
  }
  await fs.writeFile(path.join(HIG_DIR, "hig-lookup.md"), `${lines.join("\n")}\n`, "utf8");
  await fs.writeFile(
    path.join(CACHE, "manifest.json"),
    `${JSON.stringify({ fetchedAt: new Date().toISOString().slice(0, 10), pages: rows.length, rows }, null, 2)}\n`,
    "utf8",
  );
  return rows.length;
}

/* ── main ────────────────────────────────────────────────────── */

let docs;
if (lookupOnly) {
  const manifest = JSON.parse(await fs.readFile(path.join(CACHE, "manifest.json"), "utf8"));
  console.log(`[apple-hig] reusing cached manifest (${manifest.pages} pages)`);
  process.exit(0);
} else {
  console.log("[apple-hig] crawling developer.apple.com …");
  docs = await crawl();
}
const count = await writeLookup(docs);
console.log(`[apple-hig] ${docs.size} pages cached in ${path.relative(ROOT, PAGES)}`);
console.log(`[apple-hig] routing table rebuilt with ${count} rows`);
