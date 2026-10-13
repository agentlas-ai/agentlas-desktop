"use client";

// ChatGPT skill popup: a skill row inside a plugin opens this centred modal with the
// skill's description and its SKILL.md. "전체 보기" opens the Claude-style viewer.
import { useEffect, useId, useRef } from "react";
import { IconClose } from "@/components/Icon";
import { Markdown } from "@/components/Markdown";
import { GlyphSkill } from "./DetailParts";
import type { SkillRef } from "./toolsModel";
import styles from "./ToolsUi.module.css";

export function stripFrontmatter(text: string): string {
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function SkillModal({ ko, skill, onClose, onOpenFull }: { ko: boolean; skill: SkillRef; onClose: () => void; onOpenFull: () => void }) {
  const titleId = useId();
  const panel = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const main = skill.files.find((file) => /(^|\/)SKILL\.md$/i.test(file.path)) ?? skill.files.find((file) => /\.mdx?$/i.test(file.path));
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.focus();
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); } };
    document.addEventListener("keydown", onKey, true);
    return () => { document.removeEventListener("keydown", onKey, true); previous?.focus(); };
  }, []);
  return <div className={styles.scrim} role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <div ref={panel} tabIndex={-1} className={styles.skillModal} role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <button type="button" className={`${styles.iconButton} ${styles.modalClose}`} aria-label={ko ? "닫기" : "Close"} onClick={onClose}><IconClose size={16} /></button>
      <div className={styles.skillModalBody}>
        <span className={styles.skillModalIcon}><GlyphSkill size={20} /></span>
        <h2 id={titleId} className={styles.skillModalName}>{skill.name}</h2>
        {skill.description && <p className={styles.skillModalDesc}>{skill.description}</p>}
        {main && <>
          <h3 className={styles.skillModalHeading}>{ko ? "스킬" : "Skill"}</h3>
          <div className={`${styles.skillModalContent} ${styles.markdown}`}>
            <Markdown text={stripFrontmatter(main.content)} messageId={`skill-modal-${skill.pluginSlug}-${skill.name}`} />
          </div>
        </>}
      </div>
      <div className={styles.skillModalFoot}>
        {skill.files.length > 0 && <button type="button" className={styles.lightButton} onClick={onOpenFull}>{ko ? "전체 보기" : "Open full"}</button>}
        <button type="button" className={styles.darkButton} onClick={onClose}>{ko ? "닫기" : "Close"}</button>
      </div>
    </div>
  </div>;
}
