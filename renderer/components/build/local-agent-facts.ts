// What the gallery's detail pane shows about an agent on this computer: the same three numbers and the skill list the agent page (AgentWorkspace) shows.
// Same IPC (agentWorkspace.getWorkspace + oneMemory.inspector.query) and same counting (skillFiles / file-kind files / active memory total); one read, no timer.
import { ipc } from "@/lib/ipc";
import { skillFiles } from "../agent-workspace/AgentWorkspaceTabs";

export interface LocalAgentFacts { skills: { name: string; description: string }[]; files: number; memories: number }

/** One-line `description:` of a SKILL.md frontmatter ("" when none); handles quotes and `>` / `|` block values. */
export function skillMdDescription(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  if (lines[0]?.trim() !== "---") return "";
  const end = lines.indexOf("---", 1);
  const head = lines.slice(1, end < 0 ? lines.length : end);
  const index = head.findIndex(line => /^description\s*:/.test(line));
  if (index < 0) return "";
  const first = head[index].replace(/^description\s*:\s*/, "").trim();
  const parts: string[] = [];
  if (!first || /^[>|][+-]?$/.test(first)) {
    for (const line of head.slice(index + 1)) { if (line.trim() && !/^\s/.test(line)) break; if (line.trim()) parts.push(line.trim()); }
  } else parts.push(first);
  return parts.join(" ").replace(/^(["'])(.*)\1$/, "$2").trim();
}

export async function readLocalAgentFacts(agentId: string): Promise<LocalAgentFacts> {
  const api = ipc();
  if (!api?.agentWorkspace) throw new Error("unavailable");
  const snapshot = await api.agentWorkspace.getWorkspace(agentId);
  const skills = skillFiles(snapshot.files);
  const files = snapshot.files.filter(file => file.kind === "file").length;
  const memory = await api.oneMemory?.inspector?.query({ actorId: agentId, limit: 1, status: "active" }).catch(() => null);
  const memories = memory && memory.schemaVersion === "agentlas.desktop-memory-inspector.v1" ? memory.total : 0;
  const described = await Promise.all(skills.map(async skill => {
    const read = await api.agentWorkspace!.readFile(agentId, skill.path).catch(() => null);
    return { name: skill.name, description: read && !read.binary ? skillMdDescription(read.content) : "" };
  }));
  return { skills: described, files, memories };
}
