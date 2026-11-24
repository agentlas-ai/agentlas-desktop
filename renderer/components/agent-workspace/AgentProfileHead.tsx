"use client";

// The profile head of Manage agents (Agentlas 2.0 F-D8): the big head on Timeline, the one-line head on the other tabs, the name + photo dialog.
// A line is drawn only when the host gave its value (no invented "Working in ..." place, no made-up counts).
import { useEffect, useRef, useState, type ReactNode } from "react";
import { IconCamera, IconClock, IconCloud, IconEdit, IconChat, IconChevronDown, IconClose, IconFolder, IconWand } from "@/components/Icon";
import { AgentAppearanceImage } from "./AgentAppearancePicker";
import { useAgentAppearance } from "@/lib/agent-appearance";
import { ipc } from "@/lib/ipc";
import { oneCharacterBaseId, oneCharacterSrcForId } from "@/lib/one-characters";
import { AGENT_APPEARANCE_CHARACTERS, type AgentAppearance, type AgentAppearanceView } from "@shared/agent-appearance";
import styles from "./AgentManage.module.css";

export function AgentFace({ agentId, name, size, className }: { agentId: string; name: string; size: number; className?: string }) {
  const appearance = useAgentAppearance(agentId);
  return <span className={className} style={{ width: size, height: size, display: "inline-grid", placeItems: "center", flex: "none" }}>
    {appearance ? <AgentAppearanceImage value={appearance} size={size} /> : <span style={{ width: size * 0.8, height: size * 0.8, borderRadius: "50%", background: "var(--paper-edge)", color: "var(--ink-soft)", display: "inline-grid", placeItems: "center", fontWeight: 650, fontSize: size * 0.34 }}>{(name.trim()[0] ?? "?").toUpperCase()}</span>}
  </span>;
}

export type HeadFacts = {
  /** "Working" only when a run holds the agent now. */
  working: boolean; builtAt: string | null; modelText: string | null; modelLogo: string | null; toSave: number | null;
  memories: number | null; skills: number | null; files: number | null;
};

export function AgentProfileHead({ agentId, name, slug, tagline, big, facts, ko, modelOpen, onModel, onFolder, onEdit, onChat, folderOpen, chatBusy, modelPopover, children }: {
  agentId: string; name: string; slug: string; tagline: string; big: boolean; facts: HeadFacts; ko: boolean;
  modelOpen: boolean; onModel: (() => void) | null; onFolder: () => void; onEdit: () => void; onChat: () => void; folderOpen: boolean; chatBusy: boolean; modelPopover?: ReactNode; children?: ReactNode;
}) {
  const actions = <div className={styles.headActions}>
    <button type="button" className={`${styles.ib} ${styles.ibBox}`} aria-label={ko ? "폴더" : "Folder"} aria-expanded={folderOpen} onClick={onFolder}><IconFolder size={16} /></button>
    <button type="button" className={styles.btn} onClick={onEdit}><IconEdit size={14} />{ko ? "편집" : "Edit"}</button>
    <button type="button" className={`${styles.btn} ${styles.btnPri}`} disabled={chatBusy} onClick={onChat}><IconChat size={14} />{ko ? "채팅" : "Chat"}</button>
  </div>;
  if (!big) return <header className={`${styles.head} ${styles.headSmall}`}>
    <AgentFace agentId={agentId} name={name} size={38} className={styles.faceSmall} />
    <b className={styles.nameSmall}>{name}</b><span className={styles.slug} style={{ fontSize: 13 }}>@{slug}</span>
    {facts.working && <span className={styles.statusSmall}><i className={styles.dot} />{ko ? "작업 중" : "Working"}</span>}
    {actions}{children}
  </header>;
  return <header className={`${styles.head} ${styles.headBig}`}>
    <div className={styles.headBigTop} />
    <div className={styles.headBigRow}>
      <div className={styles.faceBig}><AgentFace agentId={agentId} name={name} size={76} /></div>
      {actions}
    </div>
    <div className={styles.nameRow}><h1 className={styles.nameBig}>{name}</h1><span className={styles.slug}>@{slug}</span></div>
    {tagline && <p className={styles.tagline}>{tagline}</p>}
    <div className={styles.meta}>
      {facts.working && <span className={styles.metaItem}><i className={styles.dot} />{ko ? "작업 중" : "Working"}</span>}
      {facts.builtAt && <span className={styles.metaItem}><IconClock size={14} />{ko ? `생성일 ${facts.builtAt}` : `Built ${facts.builtAt}`}</span>}
      {facts.modelText && onModel && <span className={styles.modelAnchor}><button type="button" className={`${styles.metaItem} ${styles.metaBtn}`} aria-expanded={modelOpen} aria-haspopup="dialog" onClick={onModel}>{facts.modelText}<IconChevronDown size={13} /></button>{modelPopover}</span>}
      {facts.modelText && !onModel && <span className={styles.metaItem}>{facts.modelText}</span>}
      {facts.toSave !== null && facts.toSave > 0 && <span className={styles.metaItem}><IconCloud size={14} />{ko ? `미저장 변경 ${facts.toSave}개` : `${facts.toSave} to save`}</span>}
    </div>
    {(facts.memories !== null || facts.skills !== null || facts.files !== null) && <div className={styles.stats}>
      {facts.memories !== null && <span><b>{facts.memories}</b>{ko ? "기억" : "Memories"}</span>}
      {facts.skills !== null && <span><b>{facts.skills}</b>{ko ? "스킬" : "Skills"}</span>}
      {facts.files !== null && <span><b>{facts.files}</b>{ko ? "파일" : "Files"}</span>}
    </div>}
    {children}
  </header>;
}

/** Name + photo (picture agents-v6-timeline-edit). Saves the name through `onRename` and the photo through the appearance calls, then closes. */
export function AgentEditDialog({ agentId, name, ko, onRename, onClose, onSaved }: { agentId: string; name: string; ko: boolean; onRename: (value: string) => Promise<void>; onClose: () => void; onSaved: () => void }) {
  const stored = useAgentAppearance(agentId);
  const [value, setValue] = useState(name);
  const [picked, setPicked] = useState<AgentAppearance | null | undefined>(undefined); // undefined = untouched
  const [upload, setUpload] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => { const key = (event: KeyboardEvent) => { if (event.key === "Escape" && !busy) onClose(); }; window.addEventListener("keydown", key); return () => window.removeEventListener("keydown", key); }, [busy, onClose]);
  const shown = picked === undefined ? stored : picked;
  const isChar = (id: string) => shown?.kind === "character" && oneCharacterBaseId(shown.id) === id && !upload;
  const save = async () => {
    setBusy(true); setError("");
    try {
      const trimmed = value.trim();
      if (trimmed && trimmed !== name) await onRename(trimmed);
      if (upload) {
        const root = (ipc() as unknown as { agentRoot?: { avatarSet?: (input: { agentId: string; dataUrl: string }) => Promise<{ ok: boolean; code?: string }> } } | null)?.agentRoot;
        const answer = await root?.avatarSet?.({ agentId, dataUrl: upload });
        if (!answer?.ok) throw new Error(answer?.code ?? "image_invalid");
      } else if (picked !== undefined) {
        const api = ipc()?.agentWorkspace;
        if (!api?.getAppearance || !api.setAppearance) throw new Error("unsupported");
        const view: AgentAppearanceView = await api.getAppearance(agentId);
        await api.setAppearance({ ...view, appearance: picked });
      }
      onSaved(); onClose();
    } catch (failure) {
      const code = failure instanceof Error ? failure.message : "";
      setError(/image_invalid/.test(code) ? (ko ? "이 사진은 사용할 수 없어요. 다른 사진을 선택해 주세요." : "This photo can't be used. Pick another one.") : (ko ? "저장하지 못했어요. 다시 시도해 주세요." : "Couldn't save. Try again."));
    } finally { setBusy(false); }
  };
  const readFile = (target: File | undefined) => {
    if (!target) return;
    const reader = new FileReader();
    reader.onload = () => { if (typeof reader.result === "string") setUpload(reader.result); };
    reader.readAsDataURL(target);
  };
  return <div className={styles.scrim} onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <div className={styles.dialog} role="dialog" aria-modal="true" aria-label={ko ? "에이전트 편집" : "Edit agent"}>
      <button type="button" className={`${styles.ib} ${styles.dialogX}`} aria-label={ko ? "닫기" : "Close"} disabled={busy} onClick={onClose}><IconClose size={16} /></button>
      <div className={styles.editTop}>
        <div className={styles.editFace}>{upload ? <img src={upload} alt="" style={{ width: 96, height: 96, objectFit: "cover", borderRadius: 18 }} /> : shown ? <AgentAppearanceImage value={shown} size={84} /> : <span style={{ fontSize: 40, fontWeight: 650, color: "var(--ink-soft)" }}>{(name.trim()[0] ?? "?").toUpperCase()}</span>}</div>
        <label style={{ flex: 1, minWidth: 0, paddingTop: 26 }}><span className={styles.fieldLab}>{ko ? "이름" : "Name"}</span><input className={styles.input} value={value} maxLength={160} onChange={(event) => setValue(event.target.value)} aria-label={ko ? "이름" : "Name"} /></label>
      </div>
      <div style={{ marginTop: 22 }}><span className={styles.fieldLab}>{ko ? "사진" : "Photo"}</span>
        <div className={styles.photoGrid} role="group" aria-label={ko ? "사진" : "Photo"}>
          {AGENT_APPEARANCE_CHARACTERS.filter((id) => !id.endsWith("-2d")).map((id) => <button key={id} type="button" className={styles.photo} aria-label={id} aria-pressed={isChar(id)} onClick={() => { setUpload(null); setPicked({ kind: "character", id }); }}><img src={oneCharacterSrcForId(id) ?? ""} alt="" /></button>)}
          <button type="button" className={styles.photo} aria-label={ko ? "사진 올리기" : "Upload a photo"} aria-pressed={Boolean(upload)} onClick={() => file.current?.click()}><IconCamera size={24} /></button>
          <button type="button" className={styles.photo} aria-label={ko ? "기본 아이콘" : "Default icon"} aria-pressed={!upload && shown?.kind === "glyph"} onClick={() => { setUpload(null); setPicked({ kind: "glyph", id: "wand", color: "blue" }); }}><IconWand size={24} /></button>
        </div>
        <input ref={file} type="file" accept="image/png,image/jpeg,image/webp" hidden onChange={(event) => { readFile(event.target.files?.[0]); event.target.value = ""; }} />
      </div>
      {error && <p className={styles.dialogErr} role="alert">{error}</p>}
      <div className={styles.dialogActs}><button type="button" className={styles.btn} disabled={busy} onClick={onClose}>{ko ? "취소" : "Cancel"}</button><button type="button" className={`${styles.btn} ${styles.btnPri}`} disabled={busy || !value.trim()} onClick={() => void save()}>{ko ? "저장" : "Save"}</button></div>
    </div>
  </div>;
}
