// 워킹 폴더 패널 — 채팅 우측의 collapsible/resizable splitter.
// Antigravity / VS Code의 "Explorer" 패널과 동일 패턴.
//   - 폴더 picker (열린 폴더가 없을 때)
//   - 트리 (lazy expand — 펼친 디렉터리만 children fetch)
//   - 파일 클릭 시 하단 미리보기 (텍스트 파일만)
//   - 좌측 가장자리 드래그로 너비 조절 (240px ~ 720px)
//   - 헤더 X 버튼으로 닫기 (열려있다는 상태는 부모가 관리)
"use client";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { useT } from "@/lib/i18n";
import type { DirListing, TextFilePreview, WorkspaceNode } from "@/lib/types";
import {
  IconChevronRight,
  IconClose,
  IconFolder,
  IconRefresh,
} from "./Icon";

const MIN_WIDTH = 240;
const MAX_WIDTH = 720;
const DEFAULT_WIDTH = 360;
const WIDTH_STORAGE_KEY = "agentlas.workspace.width";

interface Props {
  /** 스코프 id — 채팅이면 chatId, firm/agents 화면이면 그 화면의 식별자.
   *  null이면 패널을 렌더하지 않음. 이 값이 바뀌면 트리 상태가 초기화된다. */
  chatId: string | null;
  /** 닫기 버튼 콜백 */
  onClose: () => void;
  /** 선택한 폴더의 영속화 어댑터. 없으면 채팅 working_folder(IPC)에 저장한다.
   *  firm/agents 화면은 localStorage 기반 어댑터를 넘겨 채팅 없이도 폴더를 기억한다. */
  persistence?: {
    load: () => Promise<string | null>;
    save: (path: string | null) => Promise<void>;
  };
}

export function WorkspacePanel({ chatId, onClose, persistence }: Props) {
  const { t } = useT();
  // persistence를 ref로 들고 effect 의존성을 [chatId]로 유지 (인라인 객체 재생성으로 인한 루프 방지).
  const persistRef = useRef(persistence);
  persistRef.current = persistence;
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const widthRef = useRef<number>(DEFAULT_WIDTH);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [rootListing, setRootListing] = useState<DirListing | null>(null);
  const [expanded, setExpanded] = useState<Map<string, DirListing>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<TextFilePreview | null>(null);
  const dragStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // 너비 영구 저장
  useEffect(() => {
    try {
      const stored = window.localStorage.getItem(WIDTH_STORAGE_KEY);
      const n = stored ? parseInt(stored, 10) : NaN;
      if (Number.isFinite(n) && n >= MIN_WIDTH && n <= MAX_WIDTH) setWidth(n);
    } catch {
      // ignore
    }
  }, []);

  // chatId 바뀌면 저장된 working folder 복원
  useEffect(() => {
    const api = ipc();
    if (!api || !chatId) {
      setRootPath(null);
      setRootListing(null);
      setExpanded(new Map());
      setSelected(null);
      setPreview(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      const folder = persistRef.current
        ? await persistRef.current.load()
        : await api.workspace.get(chatId);
      if (cancelled) return;
      if (folder) {
        setRootPath(folder);
        const listing = await api.fs.listDirectory(folder);
        if (!cancelled) setRootListing(listing);
      } else {
        setRootPath(null);
        setRootListing(null);
      }
      setExpanded(new Map());
      setSelected(null);
      setPreview(null);
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  const pickFolder = useCallback(async () => {
    const api = ipc();
    if (!api || !chatId) return;
    const picked = await api.fs.pickDirectory();
    if (!picked) return;
    setRootPath(picked);
    const listing = await api.fs.listDirectory(picked);
    setRootListing(listing);
    setExpanded(new Map());
    setSelected(null);
    setPreview(null);
    if (persistRef.current) await persistRef.current.save(picked);
    else await api.workspace.set(chatId, picked);
  }, [chatId]);

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api || !rootPath) return;
    const listing = await api.fs.listDirectory(rootPath);
    setRootListing(listing);
    // 펼쳐진 디렉터리들도 재요청
    const next = new Map<string, DirListing>();
    for (const [p] of expanded) {
      try {
        next.set(p, await api.fs.listDirectory(p));
      } catch {
        // ignore
      }
    }
    setExpanded(next);
  }, [rootPath, expanded]);

  const toggleDir = useCallback(
    async (node: WorkspaceNode) => {
      if (node.kind !== "dir") return;
      const api = ipc();
      if (!api) return;
      if (expanded.has(node.path)) {
        const next = new Map(expanded);
        next.delete(node.path);
        setExpanded(next);
        return;
      }
      const listing = await api.fs.listDirectory(node.path);
      const next = new Map(expanded);
      next.set(node.path, listing);
      setExpanded(next);
    },
    [expanded],
  );

  const openFile = useCallback(async (node: WorkspaceNode) => {
    const api = ipc();
    if (!api) return;
    setSelected(node.path);
    if (!node.isTextLike) {
      setPreview({ path: node.path, content: "", truncated: false, size: node.size, reason: "binary" });
      return;
    }
    const text = await api.fs.readTextFile(node.path);
    setPreview(text);
  }, []);

  // 좌측 가장자리 드래그 핸들
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      dragStateRef.current = { startX: e.clientX, startWidth: width };
      function onMove(ev: MouseEvent) {
        if (!dragStateRef.current) return;
        // 우측 패널이라 왼쪽으로 드래그하면 폭이 늘어남
        const dx = dragStateRef.current.startX - ev.clientX;
        const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, dragStateRef.current.startWidth + dx));
        widthRef.current = next;
        setWidth(next);
      }
      function onUp() {
        if (dragStateRef.current) {
          try {
            window.localStorage.setItem(WIDTH_STORAGE_KEY, String(widthRef.current));
          } catch {
            // ignore
          }
        }
        dragStateRef.current = null;
        window.removeEventListener("mousemove", onMove);
        window.removeEventListener("mouseup", onUp);
      }
      window.addEventListener("mousemove", onMove);
      window.addEventListener("mouseup", onUp);
      e.preventDefault();
    },
    [width],
  );
  // width 변경 시 localStorage 동기화는 디바운스 — 드래그 종료 시점에만 저장하면 충분
  useEffect(() => {
    widthRef.current = width;
    if (dragStateRef.current) return; // 드래그 중에는 저장 X
    try {
      window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
    } catch {
      // ignore
    }
  }, [width]);

  return (
    <aside
      style={{
        position: "relative",
        width,
        maxWidth: "45vw",
        flexShrink: 1, // 좁은 창/다중 패널에서 줄어들어 화면 안에 맞춤
        height: "100%",
        background: "var(--paper)",
        borderLeft: "1px solid var(--paper-edge)",
        display: "flex",
        flexDirection: "column",
        minWidth: 0,
      }}
    >
      {/* 좌측 가장자리 드래그 핸들 */}
      <div
        role="separator"
        aria-label={t("workspace.resize")}
        onMouseDown={onResizeStart}
        style={{
          position: "absolute",
          left: -3,
          top: 0,
          bottom: 0,
          width: 6,
          cursor: "ew-resize",
          zIndex: 2,
        }}
      />

      {/* 헤더 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 12px",
          borderBottom: "var(--hairline)",
          background: "var(--paper-2)",
        }}
      >
        <IconFolder size={14} style={{ color: "var(--accent)", flexShrink: 0 }} />
        <span
          style={{
            flex: 1,
            minWidth: 0,
            fontSize: 12,
            fontWeight: 600,
            color: "var(--ink)",
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
          }}
          title={rootPath ?? t("workspace.title")}
        >
          {rootPath ? basename(rootPath) : t("workspace.title")}
        </span>
        {rootPath && (
          <>
            <button
              onClick={() => void refresh()}
              aria-label={t("workspace.refresh")}
              title={t("workspace.refresh")}
              style={iconBtn()}
            >
              <IconRefresh size={13} />
            </button>
            <button
              onClick={() => void pickFolder()}
              style={{
                ...iconBtn(),
                fontSize: 11,
                width: "auto",
                padding: "0 8px",
              }}
              title={t("workspace.change_folder")}
            >
              {t("workspace.change_folder")}
            </button>
          </>
        )}
        <button onClick={onClose} aria-label={t("workspace.close_panel")} title={t("workspace.close_panel")} style={iconBtn()}>
          <IconClose size={14} />
        </button>
      </div>

      {/* 본문 — 빈 상태 / 트리 */}
      {!rootPath ? (
        <EmptyState onPick={() => void pickFolder()} t={t} />
      ) : (
        <>
          <div style={{ flex: 1, overflow: "auto", padding: "6px 4px 12px", minHeight: 0 }}>
            <TreeList
              entries={rootListing?.entries ?? []}
              depth={0}
              expanded={expanded}
              onToggle={(n) => void toggleDir(n)}
              onOpenFile={(n) => void openFile(n)}
              selected={selected}
            />
            {rootListing && rootListing.entries.length === 0 && (
              <div style={{ padding: 12, fontSize: 12, color: "var(--muted-deep)" }}>
                {t("workspace.empty.folder")}
              </div>
            )}
          </div>
          {preview && <PreviewPane preview={preview} t={t} />}
        </>
      )}
    </aside>
  );
}

// ── 빈 상태 ─────────────────────────────────────────────
function EmptyState({ onPick, t }: { onPick: () => void; t: ReturnType<typeof useT>["t"] }) {
  return (
    <div
      style={{
        flex: 1,
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 12,
        padding: 24,
        textAlign: "center",
      }}
    >
      <IconFolder size={28} style={{ color: "var(--muted)" }} />
      <div style={{ fontSize: 13, color: "var(--ink-soft)", lineHeight: 1.55, whiteSpace: "pre-line" }}>
        {t("workspace.empty.body")}
      </div>
      <button
        onClick={onPick}
        style={{
          padding: "8px 14px",
          borderRadius: 999,
          background: "var(--paper)",
          color: "var(--ink)",
          fontSize: 12.5,
          fontWeight: 600,
          border: "1px solid var(--paper-edge)",
          boxShadow: "var(--neu-raised)",
          cursor: "pointer",
        }}
      >
        {t("workspace.empty.pick")}
      </button>
    </div>
  );
}

// ── 트리 ─────────────────────────────────────────────────
interface TreeListProps {
  entries: WorkspaceNode[];
  depth: number;
  expanded: Map<string, DirListing>;
  onToggle: (n: WorkspaceNode) => void;
  onOpenFile: (n: WorkspaceNode) => void;
  selected: string | null;
}

function TreeList({ entries, depth, expanded, onToggle, onOpenFile, selected }: TreeListProps) {
  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {entries.map((entry) => (
        <TreeNode
          key={entry.path}
          node={entry}
          depth={depth}
          expanded={expanded}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
          selected={selected}
        />
      ))}
    </ul>
  );
}

interface TreeNodeProps {
  node: WorkspaceNode;
  depth: number;
  expanded: Map<string, DirListing>;
  onToggle: (n: WorkspaceNode) => void;
  onOpenFile: (n: WorkspaceNode) => void;
  selected: string | null;
}

function TreeNode({ node, depth, expanded, onToggle, onOpenFile, selected }: TreeNodeProps) {
  const isOpen = node.kind === "dir" && expanded.has(node.path);
  const isSelected = selected === node.path;
  const indent = 10 + depth * 12;
  return (
    <li>
      <button
        onClick={() => {
          if (node.kind === "dir") onToggle(node);
          else onOpenFile(node);
        }}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 4,
          width: "100%",
          padding: `4px ${10}px 4px ${indent}px`,
          background: isSelected ? "var(--fill-1)" : "transparent",
          border: "none",
          textAlign: "left",
          fontSize: 12.5,
          color: "var(--ink)",
          cursor: "pointer",
          borderRadius: 4,
        }}
        onMouseEnter={(e) => {
          if (!isSelected) e.currentTarget.style.background = "var(--paper-2)";
        }}
        onMouseLeave={(e) => {
          if (!isSelected) e.currentTarget.style.background = "transparent";
        }}
      >
        {node.kind === "dir" ? (
          <span
            aria-hidden
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              width: 12,
              color: "var(--muted-deep)",
              transition: "transform 0.12s",
              transform: isOpen ? "rotate(90deg)" : "rotate(0deg)",
              flexShrink: 0,
            }}
          >
            <IconChevronRight size={10} />
          </span>
        ) : (
          <span style={{ width: 12, flexShrink: 0 }} />
        )}
        <span
          style={{
            flex: 1,
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            fontFamily: node.kind === "file" ? "var(--font-mono)" : undefined,
            fontWeight: node.kind === "dir" ? 600 : 400,
            color: node.kind === "dir" ? "var(--ink)" : "var(--ink-soft)",
          }}
        >
          {node.name}
        </span>
      </button>
      {isOpen && (
        <TreeList
          entries={expanded.get(node.path)?.entries ?? []}
          depth={depth + 1}
          expanded={expanded}
          onToggle={onToggle}
          onOpenFile={onOpenFile}
          selected={selected}
        />
      )}
    </li>
  );
}

// ── 파일 미리보기 ────────────────────────────────────────
function PreviewPane({ preview, t }: { preview: TextFilePreview; t: ReturnType<typeof useT>["t"] }) {
  const fileName = basename(preview.path);
  return (
    <div
      style={{
        borderTop: "1px solid var(--paper-edge)",
        background: "var(--paper-2)",
        display: "flex",
        flexDirection: "column",
        maxHeight: "45%",
        minHeight: 120,
      }}
    >
      <div
        style={{
          padding: "6px 12px",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: "var(--muted-deep)",
          display: "flex",
          alignItems: "center",
          gap: 8,
          borderBottom: "1px solid var(--paper-edge)",
        }}
      >
        <span
          style={{
            flex: 1,
            minWidth: 0,
            whiteSpace: "nowrap",
            overflow: "hidden",
            textOverflow: "ellipsis",
            color: "var(--ink)",
            fontWeight: 600,
          }}
          title={preview.path}
        >
          {fileName}
        </span>
        <span>{formatSize(preview.size)}</span>
        {preview.truncated && (
          <span style={{ color: "var(--amber-deep)", fontWeight: 700 }}>· {t("workspace.preview.truncated")}</span>
        )}
      </div>
      <div style={{ overflow: "auto", flex: 1, minHeight: 0 }}>
        {preview.reason === "binary" || preview.reason === "not-text-ext" ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--muted-deep)" }}>
            {t("workspace.preview.binary")} ({preview.reason})
          </div>
        ) : preview.reason === "too-large" ? (
          <div style={{ padding: 16, fontSize: 12, color: "var(--muted-deep)" }}>
            {t("workspace.preview.too_large")} ({formatSize(preview.size)})
          </div>
        ) : (
          <pre
            style={{
              margin: 0,
              padding: "10px 12px",
              fontSize: 11.5,
              fontFamily: "var(--font-mono)",
              color: "var(--ink)",
              whiteSpace: "pre",
              lineHeight: 1.5,
            }}
          >
            {preview.content}
          </pre>
        )}
      </div>
    </div>
  );
}

/** path.basename 간단 폴리필 — POSIX/Win 양쪽 separator 처리. */
function basename(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"));
  if (i < 0) return p;
  return p.slice(i + 1) || p;
}

function formatSize(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function iconBtn(): React.CSSProperties {
  return {
    width: 24,
    height: 24,
    flexShrink: 0,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    border: "none",
    background: "transparent",
    color: "var(--muted-deep)",
    borderRadius: 6,
    cursor: "pointer",
  };
}
