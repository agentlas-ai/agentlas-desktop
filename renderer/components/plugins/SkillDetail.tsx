"use client";

// Skill viewer — Claude's IDE-style page: back link, header, 개요 / 내용 tabs, file
// tree on the left (folders collapse), file on the right with rendered/source toggle.
import { useMemo, useState } from "react";
import { IconArrowLeft, IconChevronDown, IconChevronRight, IconCode, IconFolder } from "@/components/Icon";
import { Markdown } from "@/components/Markdown";
import { GlyphSkill } from "./DetailParts";
import { stripFrontmatter } from "./SkillModal";
import type { SkillRef } from "./toolsModel";
import styles from "./ToolsUi.module.css";

function IconEye({ size = 15 }: { size?: number }) {
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z" /><circle cx="12" cy="12" r="3" /></svg>;
}

export function SkillDetail({ ko, skill, pluginName, backLabel, onBack, installed, installing, onAdd }: {
  ko: boolean;
  skill: SkillRef;
  pluginName: string;
  backLabel: string;
  onBack: () => void;
  installed: boolean;
  installing: boolean;
  onAdd: () => void;
}) {
  const files = useMemo(() => [...skill.files].sort((left, right) => {
    const depth = (path: string) => path.split("/").length;
    return depth(right.path) - depth(left.path) || left.path.localeCompare(right.path);
  }), [skill.files]);
  const initial = files.find((file) => /(^|\/)SKILL\.md$/i.test(file.path)) ?? files[0];
  const [tab, setTab] = useState<"overview" | "content">(files.length ? "content" : "overview");
  const [path, setPath] = useState(initial?.path ?? "");
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [source, setSource] = useState(false);
  const file = files.find((entry) => entry.path === path) ?? initial;

  // Folders first (as in the reference tree), then root files.
  const folders = [...new Set(files.filter((entry) => entry.path.includes("/")).map((entry) => entry.path.split("/")[0]))];
  const rootFiles = files.filter((entry) => !entry.path.includes("/"));

  const fileButton = (entryPath: string, label: string, depth: number) => <button key={entryPath} type="button" className={styles.treeItem} data-depth={depth} data-active={entryPath === file?.path} onClick={() => setPath(entryPath)}>{label}</button>;

  return <div className={styles.skillPage}>
    <button type="button" className={styles.backLink} onClick={onBack}><IconArrowLeft size={16} />{backLabel}</button>
    <div className={styles.skillHeader}>
      <span className={styles.skillTile}><GlyphSkill size={20} /></span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <h1 className={styles.skillName}>{skill.name}</h1>
        <p className={styles.skillFrom}>{ko ? `${pluginName}에서` : `From ${pluginName}`}</p>
      </div>
      {!installed && <button type="button" className={styles.darkButton} disabled={installing} onClick={onAdd}>{installing ? ko ? "추가하는 중…" : "Adding…" : ko ? "추가" : "Add"}</button>}
    </div>
    <div className={styles.tabs} role="tablist">
      <button type="button" role="tab" aria-selected={tab === "overview"} className={styles.tab} data-active={tab === "overview"} onClick={() => setTab("overview")}>{ko ? "개요" : "Overview"}</button>
      {files.length > 0 && <button type="button" role="tab" aria-selected={tab === "content"} className={styles.tab} data-active={tab === "content"} onClick={() => setTab("content")}>{ko ? "내용" : "Contents"} · {files.length}</button>}
    </div>
    {tab === "overview" || !file
      ? <p className={styles.overview}>{skill.description || (ko ? "설명 없음" : "No description")}</p>
      : <div className={styles.viewer}>
        <div className={styles.tree}>
          {folders.map((folder) => {
            const open = !closed.has(folder);
            return <div key={`dir-${folder}`}>
              <button type="button" className={styles.treeItem} aria-expanded={open} onClick={() => setClosed((current) => { const next = new Set(current); if (next.has(folder)) next.delete(folder); else next.add(folder); return next; })}>
                <IconFolder size={15} /><span style={{ flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}>{folder}</span>{open ? <IconChevronDown size={14} /> : <IconChevronRight size={14} />}
              </button>
              {open && files.filter((entry) => entry.path.startsWith(`${folder}/`)).map((entry) => fileButton(entry.path, entry.path.slice(folder.length + 1), 1))}
            </div>;
          })}
          {rootFiles.map((entry) => fileButton(entry.path, entry.path, 0))}
        </div>
        <div className={styles.viewerBody}>
          <div className={styles.viewerTop}>
            <p className={styles.viewerPath}>/{file.path}</p>
            {/\.mdx?$/i.test(file.path) && <span className={styles.viewToggle}>
              <button type="button" data-active={!source} aria-label={ko ? "미리보기" : "Preview"} onClick={() => setSource(false)}><IconEye /></button>
              <button type="button" data-active={source} aria-label={ko ? "원문" : "Source"} onClick={() => setSource(true)}><IconCode size={15} /></button>
            </span>}
          </div>
          {/\.mdx?$/i.test(file.path) && !source
            ? <div className={styles.markdown}><Markdown text={stripFrontmatter(file.content)} messageId={`skill-${skill.pluginSlug}-${skill.name}-${file.path}`} /></div>
            : <pre className={styles.mono} style={{ whiteSpace: "pre-wrap", margin: 0, fontSize: 13, lineHeight: "20px" }}>{file.content}</pre>}
        </div>
      </div>}
  </div>;
}
