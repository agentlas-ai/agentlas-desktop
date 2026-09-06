// Codex식 "프로젝트(폴더)에서 작업 vs 전역 대화" 선택 바.
// 컴포저 위에 칩으로 노출 — 현재 채팅의 워킹 폴더(있으면 그 폴더에서 에이전트가 작업 = cwd,
// 없으면 전역 대화로 파일 작업 안 함)를 한눈에 보여주고 바꾼다.
// 폴더 선택/해제는 working_folder(IPC, api.workspace.set/get)에 저장 → 러너 cwd로 직결(#4).
"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import { useDismissibleLayer } from "@/lib/use-dismissible-layer";
import type { FsPathGrant } from "@/lib/types";
import { IconClose, IconChevronDown, IconCheck, IconFolder } from "./Icon";

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
  const { t, locale } = useT();
  const [folder, setFolder] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const chatIdRef = useRef(chatId);
  const requestEpochRef = useRef(0);
  chatIdRef.current = chatId;

  // 현재 채팅의 워킹 폴더 로드
  useEffect(() => {
    const api = ipc();
    setBusy(false);
    setError(null);
    if (!api || !chatId) {
      setFolder(null);
      return;
    }
    const requestEpoch = ++requestEpochRef.current;
    let cancelled = false;
    void api.workspace.get(chatId).then((f) => {
      if (!cancelled && requestEpochRef.current === requestEpoch && chatIdRef.current === chatId) {
        setFolder(f ?? null);
        setError(null);
      }
    }).catch(() => {
      if (!cancelled && requestEpochRef.current === requestEpoch && chatIdRef.current === chatId) {
        setError(locale === "ko"
          ? "이 대화의 폴더 연결 상태를 불러오지 못했습니다. 다시 열어 확인해 주세요."
          : "The folder connection for this task could not be loaded. Reopen it and try again.");
      }
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, locale, reloadToken]);

  useDismissibleLayer({
    open,
    roots: [rootRef],
    restoreFocusRef: triggerRef,
    onDismiss: () => setOpen(false),
  });

  const apply = useCallback(
    async (next: FsPathGrant | null) => {
      const api = ipc();
      if (!api || !chatId || busy) return false;
      const targetChatId = chatId;
      const requestEpoch = ++requestEpochRef.current;
      const nextPath = next?.path ?? null;
      setBusy(true);
      setError(null);
      try {
        await api.workspace.set(targetChatId, next);
        const persistedPath = await api.workspace.get(targetChatId);
        if (persistedPath !== nextPath) throw new Error("workspace_receipt_mismatch");
        if (requestEpochRef.current !== requestEpoch || chatIdRef.current !== targetChatId) return false;
        setFolder(nextPath);
        onChanged?.(nextPath);
        setOpen(false);
        return true;
      } catch {
        if (requestEpochRef.current === requestEpoch && chatIdRef.current === targetChatId) {
          setError(locale === "ko"
            ? "폴더 변경 요청의 최종 상태를 확인하지 못했습니다. 화면은 바꾸지 않았습니다. 반복 적용하지 말고 이 대화를 다시 열어 확인해 주세요."
            : "The final folder state could not be verified. This screen was not changed. Do not repeat the action; reopen this task to check it.");
        }
        return false;
      } finally {
        if (requestEpochRef.current === requestEpoch && chatIdRef.current === targetChatId) setBusy(false);
      }
    },
    [busy, chatId, locale, onChanged],
  );

  const pick = useCallback(async () => {
    const api = ipc();
    if (!api || busy) return;
    try {
      const picked = await api.fs.pickDirectory();
      if (picked) await apply(picked);
    } catch {
      setError(locale === "ko"
        ? "폴더 선택 창을 열지 못했습니다. 다시 시도해 주세요."
        : "The folder picker could not be opened. Try again.");
    }
  }, [apply, busy, locale]);

  const inFolder = !!folder;

  return (
    <div ref={rootRef} style={{ position: "relative", display: "inline-flex" }} aria-busy={busy}>
      <button
        ref={triggerRef}
        data-project-folder-trigger="true"
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!chatId || busy}
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
        <IconFolder size={13} />
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
          {/* 폴더 미연결 상태 */}
          <MenuRow
            icon={<IconFolder size={14} />}
            title={t("workspace.bar.global")}
            sub={t("workspace.bar.global_sub")}
            active={!inFolder}
            disabled={busy}
            onClick={() => { void apply(null); }}
          />
          {/* 현재 폴더 (있을 때) */}
          {inFolder && (
            <MenuRow
              icon={<IconFolder size={14} />}
              title={basename(folder as string)}
              sub={t("workspace.bar.in_folder_sub")}
              active
              disabled={busy}
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
            disabled={busy}
            onClick={() => void pick()}
          />
          {inFolder && (
            <MenuRow
              icon={<IconClose size={14} />}
              title={t("workspace.bar.to_global")}
              disabled={busy}
              onClick={() => { void apply(null); }}
            />
          )}
        </div>
      )}
      {error && (
        <span
          role="alert"
          style={{
            position: "absolute", left: 0, top: "calc(100% + 4px)", zIndex: 45,
            width: 300, padding: "6px 8px", borderRadius: 7,
            border: "1px solid color-mix(in srgb, var(--danger) 35%, var(--paper-edge))",
            background: "var(--paper)", color: "var(--danger)", fontSize: 11, lineHeight: 1.35,
          }}
        >
          {error}
        </span>
      )}
    </div>
  );
}

function MenuRow({
  icon,
  title,
  sub,
  active,
  disabled,
  onClick,
}: {
  icon: React.ReactNode;
  title: string;
  sub?: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
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
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.55 : 1,
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
