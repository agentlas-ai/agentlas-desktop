"use client";

// Settings -> Privacy and data -> "Always allowed" (item 6, decision). The tools the owner answered "always
// allow" for on a delete / sending-out card, grouped by the project the answer covers (a conversation without a project is its own
// group), each with a switch-off. Read only while this tab is shown, and again when the stored answers change; nothing is polled.
// Money is never in this list: a payment is asked every time and nothing is stored for it.
import { useCallback, useEffect, useState } from "react";
import { ipc, ipcEvents } from "@/lib/ipc";
import { IconTrash } from "@/components/Icon";
import { parseApprovalScopeIdentity } from "@shared/approval-card";
import styles from "./ArchivePanel.module.css";

interface AllowedRow { id: number; tool: string; server: string | null; createdAt: string }
interface AllowedGroup { key: string; label: string; rows: AllowedRow[] }

function toolParts(capability: string): { tool: string; server: string | null } {
  const name = capability.slice("tool:".length);
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  return { tool: (mcp ? mcp[2] : name).replace(/_+/g, " ").trim() || name, server: mcp ? mcp[1] : null };
}

function dayLabel(iso: string, locale: string): string {
  const time = Date.parse(iso);
  if (!Number.isFinite(time)) return "";
  return new Intl.DateTimeFormat(locale === "ko" ? "ko-KR" : "en-US", { year: "numeric", month: "numeric", day: "numeric" }).format(time);
}

export function AlwaysAllowedPanel({ locale, active }: { locale: string; active: boolean }) {
  const ko = locale === "ko";
  const [groups, setGroups] = useState<AllowedGroup[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api?.listCapabilityGrants) return;
    try {
      const grants = (await api.listCapabilityGrants()).filter((row) => row.decision === "allow" && row.capability.startsWith("tool:") && row.source !== "one-delegation");
      const scopes = grants.map((row) => parseApprovalScopeIdentity(row.binding?.workspaceIdentity));
      // Names are read only for what the list shows: the project list once, and one read per conversation-scoped answer.
      const projects = scopes.some((scope) => scope?.kind === "project") ? await api.projects.list().catch(() => []) : [];
      const chatIds = [...new Set(scopes.filter((scope) => scope?.kind === "chat").map((scope) => scope!.id))];
      const chats = new Map<string, string>();
      for (const id of chatIds) { try { const chat = await api.chats.get(id); if (chat?.title) chats.set(id, chat.title); } catch { /* shown without a title */ } }
      const byKey = new Map<string, AllowedGroup>();
      grants.forEach((row, index) => {
        const scope = scopes[index];
        const key = scope ? `${scope.kind}:${scope.id}` : "other";
        const label = scope?.kind === "project"
          ? (projects.find((project) => project.id === scope.id)?.name ?? (ko ? "지워진 프로젝트" : "A deleted project"))
          : scope?.kind === "chat"
            ? `${ko ? "대화" : "Conversation"} · ${chats.get(scope.id) ?? (ko ? "제목 없음" : "untitled")}`
            : (ko ? "그 밖 (정확히 같은 호출 하나, 또는 이전에 저장된 것)" : "Other (one exact call, or saved earlier)");
        const group = byKey.get(key) ?? { key, label, rows: [] };
        group.rows.push({ id: row.id, createdAt: row.createdAt, ...toolParts(row.capability) });
        byKey.set(key, group);
      });
      setGroups([...byKey.values()]);
    } catch { /* the panel keeps its last view */ }
  }, [ko]);

  useEffect(() => {
    if (!active) return;
    void refresh();
    return ipcEvents()?.onStoreChanged?.((change) => { if (change.entity === "capability-grant" || change.entity === "project") void refresh(); });
  }, [active, refresh]);

  const turnOff = async (id: number) => {
    if (busy !== null) return;
    setBusy(id);
    try { await ipc()?.revokeCapabilityGrant?.(id); } catch { /* the list is re-read below either way */ }
    await refresh();
    setBusy(null);
  };

  return (
    <section className={styles.panel} aria-labelledby="always-allowed-title" data-always-allowed-panel>
      <h2 id="always-allowed-title" className={styles.title}>{ko ? "항상 허용한 것" : "Always allowed"}</h2>
      <div className={styles.card}>
        <div className={styles.switchLabel}>
          {ko
            ? "삭제·외부 전송 칩에서 \"항상 허용\"한 도구입니다. 그 프로젝트 안에서는 다시 묻지 않습니다. 끄면 다음에 다시 묻습니다. 결제·송금은 항상 묻습니다."
            : "Tools you answered \"always allow\" for on a delete or sending-out card. They are not asked again inside that project. Turn one off to be asked next time. Payments and transfers are always asked."}
        </div>
        {groups === null ? <div className={styles.empty} /> : groups.length === 0
          ? <div className={styles.empty} data-always-allowed-empty>{ko ? "항상 허용한 도구가 없습니다." : "Nothing is always allowed."}</div>
          : groups.map((group) => (
            <div key={group.key} className={styles.list} data-always-allowed-group={group.key}>
              <div className={styles.switchLabel} style={{ fontWeight: 600 }}>{group.label}</div>
              {group.rows.map((row) => (
                <div key={row.id} className={styles.row} data-always-allowed-row={row.id}>
                  <span className={styles.name} title={row.server ? `${row.tool} · ${row.server}` : row.tool}>{row.tool}{row.server ? ` · ${row.server}` : ""}</span>
                  <span className={styles.when}>{dayLabel(row.createdAt, locale)}</span>
                  <button
                    type="button"
                    className={styles.restore}
                    data-always-allowed-off={row.id}
                    aria-label={ko ? `${row.tool} 항상 허용 끄기` : `Turn off always allow for ${row.tool}`}
                    title={ko ? "끄기 (다음에 다시 묻기)" : "Turn off (ask next time)"}
                    disabled={busy !== null}
                    onClick={() => void turnOff(row.id)}
                  ><IconTrash size={15} /></button>
                </div>
              ))}
            </div>
          ))}
      </div>
    </section>
  );
}
