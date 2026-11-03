/** Owner-local presentation only. Never part of an agent prompt or executable package. */
export const AGENT_APPEARANCE_CHARACTERS = ["orange-dino", "blue-wave-2d", "green-cloud-2d", "purple-beacon-2d", "amber-pod-2d", "orange-sprout-2d", "red-triangle-2d", "blue-wave", "green-cloud", "purple-beacon", "amber-pod", "orange-sprout", "red-triangle"] as const;
export const AGENT_APPEARANCE_GLYPHS = ["wand", "folder", "bolt"] as const;
export const AGENT_APPEARANCE_COLORS = ["red", "slate", "amber", "green", "blue", "purple", "pink", "gray"] as const;
export type AgentAppearance = {kind:"character";id:typeof AGENT_APPEARANCE_CHARACTERS[number]} | {kind:"glyph";id:typeof AGENT_APPEARANCE_GLYPHS[number];color:typeof AGENT_APPEARANCE_COLORS[number]};
export interface AgentAppearanceView { agentId: string; installation: string; revision: number; appearance: AgentAppearance | null; editToken: string; }
export interface AgentAppearanceUpdate { agentId: string; installation: string; revision: number; appearance: AgentAppearance | null; editToken: string; }
export function parseAgentAppearance(value:unknown):AgentAppearance|null {
  if(value===null)return null;
  if(!value||typeof value!=="object"||Array.isArray(value))throw Error("invalid_agent_appearance");
  const v=value as Record<string,unknown>,keys=Object.keys(v).sort().join(",");
  if(v.kind==="character"&&keys==="id,kind"&&(AGENT_APPEARANCE_CHARACTERS as readonly unknown[]).includes(v.id))return {kind:"character",id:v.id as typeof AGENT_APPEARANCE_CHARACTERS[number]};
  if(v.kind==="glyph"&&keys==="color,id,kind"&&(AGENT_APPEARANCE_GLYPHS as readonly unknown[]).includes(v.id)&&(AGENT_APPEARANCE_COLORS as readonly unknown[]).includes(v.color))return {kind:"glyph",id:v.id as typeof AGENT_APPEARANCE_GLYPHS[number],color:v.color as typeof AGENT_APPEARANCE_COLORS[number]};
  throw Error("invalid_agent_appearance");
}
