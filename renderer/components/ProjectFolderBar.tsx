// Codex식 "프로젝트(폴더)에서 작업 vs 전역 대화" 선택 바.
// 컴포저 위에 칩으로 노출 — 현재 채팅의 워킹 폴더(있으면 그 폴더에서 에이전트가 작업 = cwd,
// 없으면 전역 대화로 파일 작업 안 함)를 한눈에 보여주고 바꾼다.
// 폴더 선택/해제는 working_folder(IPC, api.workspace.set/get)에 저장 → 러너 cwd로 직결(#4).
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { FsPathGrant } from "@/lib/types";
import { IconChat, IconChevronDown, IconCheck, IconFolder } from "./Icon";

function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  return i < 0 ? p : p.slice(i + 1) || p;
}

interface Props {
  chatId: string | null;
  /** 폴더가 바뀔 때 부모에 알림 (null = 전역 대화) */
  onChanged?: (folder: string | null) => void;
  /** 파일 트리 패널 열기 */
  onOpenPanel?: () => void;
  /** 값이 바뀌면 워킹 폴더를 다시 읽는다 (슬래시 /folder·/global 후 동기화용). */
  reloadToken?: number;
}

export function ProjectFolderBar({ chatId, onChanged, onOpenPanel, reloadToken }: Props) {
  const { t } = useT();
  const [folder, setFolder] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  // 현재 채팅의 워킹 폴더 로드
  useEffect(() => {
    const api = ipc();
    if (!api || !chatId) {
      setFolder(null);
      return;
    }
    let cancelled = false;
    void api.workspace.get(chatId).then((f) => {
      if (!cancelled) setFolder(f ?? null);
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, reloadToken]);

  // 바깥 클릭 시 메뉴 닫기
  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const apply = useCallback(
    async (next: FsPathGrant | null) => {
      const api = ipc();
      if (!api || !chatId) return;
      await api.workspace.set(chatId, next);
      const nextPath = next?.path ?? null;
      setFolder(nextPath);
      onChanged?.(nextPath);
    },
    [chatId, onChanged],
  );

  const pick = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const picked = await api.fs.pickDirectory();
    if (picked) await apply(picked);
    setOpen(false);
  }, [apply]);

  const inFolder = !!folder;

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!chatId}
        title={folder ?? t("workspace.bar.global")}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 6,
          maxWidth: 280,
          padding: "4px 8px",
          borderRadius: 8,
          border: "1px solid var(--paper-edge)",
          background: inFolder ? "var(--fill-1)" : "transparent",
          color: inFolder ? "var(--accent)" : "var(--muted-deep)",
          fontSize: 12,
          fontWeight: 600,
          cursor: chatId ? "pointer" : "default",
        }}
      >
        {inFolder ? <IconFolder size={13} /> : <IconChat size={13} />}
        <span
          style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
        >
          {inFolder ? basename(folder as string) : t("workspace.bar.global")}
        </span>
        <IconChevronDown size={12} style={{ flexShrink: 0, opacity: 0.7 }} />
      </button>

      {open && (
        <div
          role="menu"
          style={{
            position: "absolute",
            bottom: "calc(100% + 6px)",
            left: 0,
            minWidth: 248,
            background: "var(--paper)",
            border: "1px solid var(--paper-edge)",
            borderRadius: "var(--radius-md)",
            boxShadow: "var(--shadow-2)",
            padding: 6,
            zIndex: 40,
          }}
        >
          {/* 전역 대화 */}
          <MenuRow
            icon={<IconChat size={14} />}
            title={t("workspace.bar.global")}
            sub={t("workspace.bar.global_sub")}
            active={!inFolder}
            onClick={() => {
              void apply(null);
              setOpen(false);
            }}
          />
          {/* 현재 폴더 (있을 때) */}
          {inFolder && (
            <MenuRow
              icon={<IconFolder size={14} />}
              title={basename(folder as string)}
              sub={t("workspace.bar.in_folder_sub")}
              active
              onClick={() => {
                onOpenPanel?.();
                setOpen(false);
              }}
            />
          )}
          <div style={{ height: 1, background: "var(--paper-edge)", margin: "6px 4px" }} />
          {/* 폴더 선택/변경 */}
          <MenuRow
            icon={<IconFolder size={14} />}
            title={inFolder ? t("workspace.bar.change") : t("workspace.bar.pick")}
            onClick={() => void pick()}
          />
          {inFolder && (
            <MenuRow
              icon={<IconChat size={14} />}
              title={t("workspace.bar.to_global")}
              onClick={() => {
                void apply(null);
                setOpen(false);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
}

function MenuRow({
  icon,
  title,
  sub,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  sub?: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 10,
        width: "100%",
        padding: "8px 10px",
        border: "none",
        background: "transparent",
        borderRadius: 8,
        cursor: "pointer",
        textAlign: "left",
        color: "var(--ink)",
      }}
      onMouseEnter={(e) => (e.currentTarget.style.background = "var(--paper-2)")}
      onMouseLeave={(e) => (e.currentTarget.style.background = "transparent")}
    >
      <span style={{ color: "var(--muted-deep)", flexShrink: 0, display: "inline-flex" }}>{icon}</span>
      <span style={{ flex: 1, minWidth: 0 }}>
        <span
          style={{
            display: "block",
            fontSize: 12.5,
            fontWeight: 600,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {title}
        </span>
        {sub && (
          <span style={{ display: "block", fontSize: 11, color: "var(--muted-deep)", marginTop: 1 }}>
            {sub}
          </span>
        )}
      </span>
      {active && <IconCheck size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />}
    </button>
  );
}
