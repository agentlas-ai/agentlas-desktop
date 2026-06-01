// 보관함 — archived 채팅 목록.
// 행 hover ⋯ → 보관 해제 / 삭제 (이름 변경도 그대로).
"use client";
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { visibleAgents } from "@/lib/agent-visibility";
import { useT } from "@/lib/i18n";
import type { Chat, InstalledAgent } from "@/lib/types";
import { ChatRow } from "@/components/ChatRow";
import { IconChevronRight } from "@/components/Icon";

export default function ArchivedChatsPage() {
  const { t } = useT();
  const [chats, setChats] = useState<Chat[]>([]);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const [c, a] = await Promise.all([api.chats.listArchived(), api.team.list()]);
    setChats(c);
    setAgents(visibleAgents(a));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <div style={{ flex: 1, overflowY: "auto", background: "transparent" }}>
      <header
        className="titlebar-drag glass-thin"
        style={{
          padding: "0 32px 0 90px",
          minHeight: 44,
          borderBottom: "1px solid var(--glass-border)",
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <Link
          href="/"
          className="titlebar-nodrag"
          style={{
            fontSize: 11,
            color: "var(--muted-deep)",
            textDecoration: "none",
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
          }}
        >
          <IconChevronRight size={12} style={{ transform: "rotate(180deg)" }} />
          {t("sidebar.chats")}
        </Link>
        <h1
          style={{
            margin: 0,
            fontFamily: "var(--font-head)",
            fontSize: 14,
            fontWeight: 600,
          }}
        >
          {t("sidebar.archive")}
        </h1>
      </header>

      <section
        className="titlebar-nodrag"
        style={{ maxWidth: 720, margin: "32px auto", padding: "0 24px" }}
      >
        {chats.length === 0 ? (
          <div
            className="glass-strong"
            style={{
              padding: "32px 24px",
              borderRadius: "var(--radius-md)",
              textAlign: "center",
              color: "var(--muted-deep)",
              fontSize: 13,
            }}
          >
            {t("archive.empty")}
          </div>
        ) : (
          <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
            {chats.map((c) => {
              const agent = agents.find((a) => a.id === c.agentId);
              return (
                <ChatRow
                  key={c.id}
                  chat={c}
                  agent={agent}
                  active={false}
                  archived
                  onChanged={refresh}
                />
              );
            })}
          </div>
        )}
      </section>
    </div>
  );
}
