// 사이드바 채팅 행 — hover 시 ⋯ 메뉴 (이름 변경 / 보관 / 삭제).
// Codex / Claude Desktop의 사이드바 패턴 동일.
"use client";
import { memo, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { dropChatViewSnapshot } from "@/lib/chat-view-cache";
import { pickLocalized, useT } from "@/lib/i18n";
import type { Chat, InstalledAgent } from "@/lib/types";
import { IconMoreHorizontal } from "./Icon";

// React.memo: 사이드바 채팅 행. props 동일 시 리렌더 스킵(agent는 Sidebar의 Map으로 안정 참조).
// onChanged(triggerRefresh)는 부모에서 매 렌더 재생성되어 효과가 제한적일 수 있으나 부작용은 없다.
export const ChatRow = memo(function ChatRow({
  chat,
  agent,
  targetLabel,
  active,
  archived,
  running,
  onChanged,
}: {
  chat: Chat;
  agent?: InstalledAgent;
  targetLabel?: string | null;
  active: boolean;
  /** 이 행이 보관함에서 렌더된 거면 메뉴가 '보관 해제'로 바뀜 */
  archived?: boolean;
  /** 이 채팅에서 에이전트 실행이 진행 중이면 펄스 점 표시 (백그라운드 멀티세션) */
  running?: boolean;
  /** 변경(이름/보관/삭제) 후 사이드바 데이터 리프레시 */
  onChanged: () => void;
}) {
  const router = useRouter();
  const { t, locale } = useT();
  const agentName = agent ? pickLocalized(agent, locale).name : null;
  const displayTarget = targetLabel || agentName;
  const titleDisplay = chat.title.trim() || t("chat.untitled");
  const [hovered, setHovered] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [titleDraft, setTitleDraft] = useState(chat.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.focus();
  }, [renaming]);

  // 외부 클릭 시 메뉴 닫기
  useEffect(() => {
    if (!menuOpen) return;
    function onDown(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [menuOpen]);

  async function saveRename() {
    const api = ipc();
    if (!api) return;
    const next = titleDraft.trim() || chat.title;
    if (next !== chat.title) {
      await api.chats.rename(chat.id, next);
    }
    setRenaming(false);
    onChanged();
  }

  async function handleArchive() {
    const api = ipc();
    if (!api) return;
    setMenuOpen(false);
    if (archived) await api.chats.unarchive(chat.id);
    else await api.chats.archive(chat.id);
    onChanged();
  }

  async function handleDelete() {
    const api = ipc();
    if (!api) return;
    setMenuOpen(false);
    if (!confirm(t("chat.confirm_delete"))) return;
    dropChatViewSnapshot(chat.id);
    window.dispatchEvent(new CustomEvent("agentlas:chat-removed", { detail: { id: chat.id } }));
    await api.chats.remove(chat.id);
    onChanged();
    // 현재 보고 있던 채팅이 삭제됐으면 홈으로
    if (active) router.replace("/");
  }

  return (
    <div
      style={{
        position: "relative",
        margin: "0 4px",
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => {
        setHovered(false);
        if (!menuOpen) {
          // menu 닫혀있을 때만 hover 해제로 즉시 사라지게
        }
      }}
    >
      {renaming ? (
        <input
          ref={inputRef}
          value={titleDraft}
          onChange={(e) => setTitleDraft(e.target.value)}
          onBlur={() => void saveRename()}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing || e.keyCode === 229) return;
            if (e.key === "Enter") void saveRename();
            if (e.key === "Escape") {
              setTitleDraft(chat.title);
              setRenaming(false);
            }
          }}
          style={{
            width: "100%",
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid var(--accent-soft)",
            background: "var(--paper)",
            fontSize: 12.5,
            color: "var(--ink)",
            outline: "none",
          }}
        />
      ) : (
        <Link
          href={`/chat?id=${chat.id}`}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 8,
            padding: "6px 10px",
            paddingRight: hovered || menuOpen ? 32 : 10,
            borderRadius: 8,
            fontSize: 12.5,
            color: active ? "var(--ink)" : "var(--ink-soft)",
            background: active ? "var(--fill-2)" : menuOpen ? "var(--fill-1)" : "transparent",
            textDecoration: "none",
            fontWeight: active ? 600 : 500,
            transition: "background 0.12s",
            opacity: archived ? 0.7 : 1,
          }}
        >
          {running && (
            <span
              aria-label={t("chat.running")}
              title={t("chat.running")}
              style={{
                flexShrink: 0,
                width: 7,
                height: 7,
                borderRadius: "50%",
                background: "var(--green-deep)",
                boxShadow: "0 0 0 3px color-mix(in srgb, var(--green-deep) 12%, transparent)",
              }}
            />
          )}
          <span
            style={{
              flex: 1,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
            }}
          >
            {titleDisplay}
          </span>
          {displayTarget && (
            <span
              style={{
                fontSize: 10,
                color: "var(--muted)",
                whiteSpace: "nowrap",
                flexShrink: 0,
              }}
            >
              {displayTarget.split(" ")[0]}
            </span>
          )}
        </Link>
      )}

      {/* hover 시 ⋯ 버튼 */}
      {!renaming && (hovered || menuOpen) && (
        <button
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
            setMenuOpen((v) => !v);
          }}
          aria-label={t("generic.chat_menu")}
          style={{
            position: "absolute",
            right: 6,
            top: "50%",
            transform: "translateY(-50%)",
            width: 22,
            height: 22,
            borderRadius: 6,
            background: menuOpen ? "var(--paper-2)" : "transparent",
            color: "var(--muted-deep)",
            border: "none",
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
          }}
        >
          <IconMoreHorizontal size={13} />
        </button>
      )}

      {menuOpen && (
        <div
          ref={menuRef}
          className="glass-lift"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            right: 0,
            minWidth: 140,
            borderRadius: 10,
            padding: 4,
            zIndex: 50,
            fontSize: 12,
          }}
        >
          <MenuBtn
            onClick={() => {
              setMenuOpen(false);
              setTitleDraft(chat.title);
              setRenaming(true);
            }}
          >
            {t("chat.action.rename")}
          </MenuBtn>
          <MenuBtn onClick={handleArchive}>
            {archived ? t("chat.action.unarchive") : t("chat.action.archive")}
          </MenuBtn>
          <MenuBtn onClick={handleDelete} danger>
            {t("chat.action.delete")}
          </MenuBtn>
        </div>
      )}
    </div>
  );
});
ChatRow.displayName = "ChatRow";

function MenuBtn({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      style={{
        display: "block",
        width: "100%",
        textAlign: "left",
        padding: "7px 10px",
        borderRadius: 6,
        background: "transparent",
        color: danger ? "var(--red-deep)" : "var(--ink)",
        fontSize: 12,
        fontWeight: 500,
        border: "none",
        cursor: "pointer",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = danger ? "rgba(201,58,58,0.08)" : "var(--fill-1)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}
