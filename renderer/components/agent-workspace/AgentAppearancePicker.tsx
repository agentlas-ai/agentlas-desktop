"use client";
import { useEffect, useRef, useState } from "react";
import { AGENT_APPEARANCE_CHARACTERS, AGENT_APPEARANCE_GLYPHS, AGENT_APPEARANCE_COLORS, type AgentAppearance, type AgentAppearanceView } from "@shared/agent-appearance";
import { IconWand, IconFolder, IconBolt } from "@/components/Icon";
import { ipc, ipcEvents } from "@/lib/ipc";
import styles from "./AgentWorkspace.module.css";
const colors: Record<typeof AGENT_APPEARANCE_COLORS[number], string> = { red:"#c74444", slate:"#495566", amber:"#b18119", green:"#278348", blue:"#316fba", purple:"#8054b5", pink:"#bf438a", gray:"#6b7280" };
const glyphs = { wand: IconWand, folder: IconFolder, bolt: IconBolt };
export function AgentAppearanceImage({ value, size = 32 }: { value: AgentAppearance; size?: number }) {
  if (value.kind === "character") return <img src={`/brand/one-characters/${value.id}.png`} alt="" width={size} height={size} />;
  const Glyph = glyphs[value.id]; return <span style={{ color: colors[value.color], display: "inline-flex" }}><Glyph size={Math.max(12, size - 6)} /></span>;
}
export function AgentAppearanceEditor({ agentId, ko }: { agentId: string; ko: boolean }) {
  const [saved, setSaved] = useState<AgentAppearanceView | null>(null), [value, setValue] = useState<AgentAppearance | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const epoch = useRef(0), dirty = useRef(false);
  const currentSaved = saved?.agentId === agentId ? saved : null;
  const shownValue = currentSaved ? value : null;
  dirty.current = !!currentSaved && JSON.stringify(currentSaved.appearance) !== JSON.stringify(shownValue);
  useEffect(() => {
    let live = true;
    const load = () => {
      const n = ++epoch.current; setBusy(false); setSaved(null); setValue(null);
      const api = ipc()?.agentWorkspace?.getAppearance;
      if (!api) { setError(ko ? "이 버전에서는 아이콘 편집을 지원하지 않습니다." : "This version does not support icon editing."); return; }
      void api(agentId).then((v) => { if (live && n === epoch.current && v.agentId === agentId) { setSaved(v); setValue(v.appearance); setError(""); } })
        .catch(() => { if (live && n === epoch.current) setError(ko ? "아이콘을 읽지 못했습니다. 다시 여세요." : "Could not read the icon. Reopen this panel."); });
    };
    const offStore = ipcEvents()?.onStoreChanged?.((event) => { if (event.entity === "agent" && (!event.id || (event.id === agentId && !dirty.current))) load(); });
    const offAuth = ipc()?.auth.onSessionChanged?.(load); load();
    return () => { live = false; epoch.current++; offStore?.(); offAuth?.(); };
  }, [agentId, ko]);
  async function save() {
    if (!currentSaved) return; const n = epoch.current; setBusy(true); setError("");
    try { const api = ipc()?.agentWorkspace?.setAppearance; if (!api) throw Error("unsupported");
      const result = await api({ ...currentSaved, appearance: shownValue }); if (n !== epoch.current) return; setSaved(result); setValue(result.appearance);
    } catch { if (n === epoch.current) setError(ko ? "저장을 확인하지 못했습니다. 다시 열어 현재 값을 확인하세요." : "Save could not be confirmed. Reopen to check the current value."); }
    finally { if (n === epoch.current) setBusy(false); }
  }
  return <section className={styles.appearanceSection}><fieldset className={styles.appearancePicker} disabled={!currentSaved || busy}><legend>{ko ? "에이전트 아이콘" : "Agent icon"}</legend>
    <div className={styles.appearanceGrid} role="group" aria-label={ko ? "캐릭터" : "Characters"}>{AGENT_APPEARANCE_CHARACTERS.map(id => <button className={styles.appearanceChoice} key={id} type="button" aria-label={id} aria-pressed={shownValue?.kind === "character" && shownValue.id === id} onClick={() => setValue({ kind: "character", id })}><AgentAppearanceImage value={{ kind: "character", id }} /></button>)}</div>
    <div className={styles.appearanceGlyphs} role="group" aria-label={ko ? "기호" : "Symbols"}>{AGENT_APPEARANCE_GLYPHS.map(id => <button className={styles.appearanceChoice} key={id} type="button" aria-label={id} aria-pressed={shownValue?.kind === "glyph" && shownValue.id === id} onClick={() => setValue({ kind: "glyph", id, color: shownValue?.kind === "glyph" ? shownValue.color : "blue" })}><AgentAppearanceImage value={{ kind: "glyph", id, color: shownValue?.kind === "glyph" ? shownValue.color : "blue" }} /></button>)}</div>
    {shownValue?.kind === "glyph" && <label className={styles.field}>{ko ? "색" : "Color"}<select value={shownValue.color} onChange={e => setValue({ ...shownValue, color: e.target.value as typeof shownValue.color })}>{AGENT_APPEARANCE_COLORS.map(color => <option key={color}>{color}</option>)}</select></label>}
    <button className={styles.button} type="button" onClick={() => setValue(null)}>{ko ? "기본 이니셜" : "Default initials"}</button></fieldset>
    <button className={styles.button} type="button" disabled={!currentSaved || busy || JSON.stringify(currentSaved.appearance) === JSON.stringify(shownValue)} onClick={() => void save()}>{busy ? (ko ? "저장 중…" : "Saving…") : (ko ? "아이콘 저장" : "Save icon")}</button>{error && <p role="alert">{error}</p>}</section>;
}
