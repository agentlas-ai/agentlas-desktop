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
import type { DirListing, FsReadScope, TextFilePreview, WorkspaceNode } from "@/lib/types";
import { viewerKindForChatFile } from "@/lib/chat-files";
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
  onClose?: () => void;
  /** 선택한 폴더의 영속화 어댑터. 없으면 채팅 working_folder(IPC)에 저장한다.
   *  firm/agents 화면은 localStorage 기반 어댑터를 넘겨 채팅 없이도 폴더를 기억한다. */
  persistence?: {
    load: () => Promise<string | null>;
    save: (path: string | null) => Promise<void>;
  };
  /** Render inside a parent rail instead of as its own resizable side panel. */
  embedded?: boolean;
  /** Notify a parent viewer panel when a file is selected. */
  onOpenFilePreview?: (preview: WorkspaceFilePreview) => void;
  /** Main-owned project source that can restore an older task's missing folder binding. */
  projectFolder?: { projectId: string; projectName: string } | null;
}

export interface WorkspaceFilePreview {
  path: string;
  name: string;
  size: number;
  viewerKind: "markdown" | "json" | "text" | "browser" | "image" | "video" | "audio" | "pdf" | "document" | "spreadsheet" | "presentation" | "archive" | "binary";
  fileUrl: string;
  mimeType?: string;
  browserUrl?: string;
  openTargets?: string[];
  content?: string;
  truncated?: boolean;
  reason?: TextFilePreview["reason"];
  /** Main-observed file revision while this preview is open. */
  revision?: number;
  live?: boolean;
  available?: boolean;
}

export function WorkspacePanel({ chatId, onClose, persistence, embedded = false, onOpenFilePreview, projectFolder = null }: Props) {
  const { t } = useT();
  // persistence를 ref로 들고 effect 의존성을 [chatId]로 유지 (인라인 객체 재생성으로 인한 루프 방지).
  const persistRef = useRef(persistence);
  persistRef.current = persistence;
  const [width, setWidth] = useState<number>(DEFAULT_WIDTH);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [readScope, setReadScope] = useState<FsReadScope | null>(null);
  const [rootListing, setRootListing] = useState<DirListing | null>(null);
  const [expanded, setExpanded] = useState<Map<string, DirListing>>(new Map());
  const [selected, setSelected] = useState<string | null>(null);
  const [preview, setPreview] = useState<TextFilePreview | null>(null);
  const [recoveryPending, setRecoveryPending] = useState(false);
  const dragStateRef = useRef<{ startX: number; startWidth: number; currentWidth: number } | null>(null);
  const requestBridgeRecovery = useCallback((_scope: string) => {
    setRecoveryPending(true);
  }, []);
  const markRecoveryPending = useCallback(() => setRecoveryPending(true), []);

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
      if (chatId && !api) requestBridgeRecovery("workspace-load");
      setRootPath(null);
      setReadScope(null);
      setRootListing(null);
      setExpanded(new Map());
      setSelected(null);
      setPreview(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        setRecoveryPending(false);
        const folder = persistRef.current
          ? await persistRef.current.load()
          : await api.workspace.get(chatId);
        if (cancelled) return;
        if (folder) {
          const scope: FsReadScope = { kind: "chat-workspace", chatId };
          setRootPath(folder);
          setReadScope(scope);
          const listing = await api.fs.listDirectory(folder, scope, false);
          if (!cancelled) setRootListing(listing);
        } else {
          setRootPath(null);
          setReadScope(null);
          setRootListing(null);
        }
        setExpanded(new Map());
        setSelected(null);
        setPreview(null);
      } catch {
        if (!cancelled) {
          setRootListing(null);
          markRecoveryPending();
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chatId, markRecoveryPending, requestBridgeRecovery]);

  const pickFolder = useCallback(async () => {
    const api = ipc();
    if (!api || !chatId) {
      if (chatId && !api) requestBridgeRecovery("workspace-pick-folder");
      return;
    }
    try {
      setRecoveryPending(false);
      const picked = await api.fs.pickDirectory();
      if (!picked) return;
      setRootPath(picked.path);
      setReadScope(picked.scope);
      const listing = await api.fs.listDirectory(picked.path, picked.scope, false);
      setRootListing(listing);
      setExpanded(new Map());
      setSelected(null);
      setPreview(null);
      if (persistRef.current) await persistRef.current.save(picked.path);
      else await api.workspace.set(chatId, picked);
    } catch {
      markRecoveryPending();
    }
  }, [chatId, markRecoveryPending, requestBridgeRecovery]);

  const useProjectFolder = useCallback(async () => {
    const api = ipc();
    if (!api || !chatId || !projectFolder) {
      if (!api) requestBridgeRecovery("workspace-project-folder");
      return;
    }
    try {
      setRecoveryPending(false);
      await api.workspace.setFromProject(chatId, projectFolder.projectId);
      const folder = await api.workspace.get(chatId);
      if (!folder) {
        throw new Error("Project folder binding was not persisted");
      }
      const scope: FsReadScope = { kind: "chat-workspace", chatId };
      const listing = await api.fs.listDirectory(folder, scope, false);
      setRootPath(folder);
      setReadScope(scope);
      setRootListing(listing);
      setExpanded(new Map());
      setSelected(null);
      setPreview(null);
    } catch {
      markRecoveryPending();
    }
  }, [chatId, markRecoveryPending, projectFolder, requestBridgeRecovery]);

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api || !rootPath || !readScope) {
      if (!api) requestBridgeRecovery("workspace-refresh");
      return;
    }
    try {
      setRecoveryPending(false);
      const listing = await api.fs.listDirectory(rootPath, readScope, false);
      setRootListing(listing);
      // 펼쳐진 디렉터리들도 재요청
      const next = new Map<string, DirListing>();
      for (const [p] of expanded) {
        try {
          next.set(p, await api.fs.listDirectory(p, readScope, false));
        } catch {
          // ignore stale expanded folders while keeping the root visible.
        }
      }
      setExpanded(next);
    } catch {
      markRecoveryPending();
    }
  }, [rootPath, readScope, expanded, markRecoveryPending, requestBridgeRecovery]);

  const toggleDir = useCallback(
    async (node: WorkspaceNode) => {
      if (node.kind !== "dir") return;
      const api = ipc();
      if (!api || !readScope) {
        if (!api) requestBridgeRecovery("workspace-open-folder");
        return;
      }
      if (expanded.has(node.path)) {
        const next = new Map(expanded);
        next.delete(node.path);
        setExpanded(next);
        return;
      }
      try {
        setRecoveryPending(false);
        const listing = await api.fs.listDirectory(node.path, readScope, false);
        const next = new Map(expanded);
        next.set(node.path, listing);
        setExpanded(next);
      } catch {
        markRecoveryPending();
      }
    },
    [expanded, markRecoveryPending, readScope, requestBridgeRecovery],
  );

  const openFile = useCallback(async (node: WorkspaceNode) => {
    const api = ipc();
    if (!api || !readScope) {
      if (!api) requestBridgeRecovery("workspace-open-file");
      return;
    }
    setSelected(node.path);
    setRecoveryPending(false);
    if (!node.isTextLike) {
      const binaryPreview: TextFilePreview = { path: node.path, content: "", truncated: false, size: node.size, reason: "binary" };
      setPreview(binaryPreview);
      onOpenFilePreview?.(toWorkspaceFilePreview(node, binaryPreview));
      return;
    }
    try {
      const text = await api.fs.readTextFile(node.path, readScope);
      setPreview(text);
      onOpenFilePreview?.(toWorkspaceFilePreview(node, text));
    } catch {
      markRecoveryPending();
    }
  }, [markRecoveryPending, onOpenFilePreview, readScope, requestBridgeRecovery]);

  // 좌측 가장자리 드래그 핸들
  const onResizeStart = useCallback(
    (e: React.MouseEvent) => {
      dragStateRef.current = { startX: e.clientX, startWidth: width, currentWidth: width };
      function onMove(ev: MouseEvent) {
        if (!dragStateRef.current) return;
        // 우측 패널이라 왼쪽으로 드래그하면 폭이 늘어남
        const dx = dragStateRef.current.startX - ev.clientX;
        const next = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, dragStateRef.current.startWidth + dx));
        dragStateRef.current.currentWidth = next;
        setWidth(next);
      }
      function onUp() {
        if (dragStateRef.current) {
          try {
            window.localStorage.setItem(WIDTH_STORAGE_KEY, String(dragStateRef.current.currentWidth));
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
    if (dragStateRef.current) return; // 드래그 중에는 저장 X
    try {
      window.localStorage.setItem(WIDTH_STORAGE_KEY, String(width));
    } catch {
      // ignore
    }
  }, [width]);

  const resizeByKeyboard = useCallback((e: React.KeyboardEvent<HTMLDivElement>) => {
    let next: number | null = null;
    if (e.key === "ArrowLeft") next = Math.min(MAX_WIDTH, width + 24);
    else if (e.key === "ArrowRight") next = Math.max(MIN_WIDTH, width - 24);
    else if (e.key === "Home") next = MIN_WIDTH;
    else if (e.key === "End") next = MAX_WIDTH;
    if (next === null) return;
    e.preventDefault();
    setWidth(next);
    try {
      window.localStorage.setItem(WIDTH_STORAGE_KEY, String(next));
    } catch {
      // ignore
    }
  }, [width]);

  return (
    <aside
      className={embedded ? "workspace-panel workspace-panel-embedded" : "workspace-panel"}
      style={{
        position: "relative",
        width: embedded ? "100%" : width,
        maxWidth: embedded ? "none" : "45vw",
        flex: embedded ? 1 : undefined,
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
      {!embedded && (
        <div
          role="separator"
          tabIndex={0}
          aria-orientation="vertical"
          aria-valuemin={MIN_WIDTH}
          aria-valuemax={MAX_WIDTH}
          aria-valuenow={width}
          aria-label={t("workspace.resize")}
          onMouseDown={onResizeStart}
          onKeyDown={resizeByKeyboard}
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
      )}

      {/* 헤더 */}
      <div
        className="workspace-panel-header"
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
        {onClose && (
          <button onClick={onClose} aria-label={t("workspace.close_panel")} title={t("workspace.close_panel")} style={iconBtn()}>
            <IconClose size={14} />
          </button>
        )}
      </div>

      {/* 본문 — 빈 상태 / 트리 */}
      {recoveryPending && <div role="alert" style={{ margin: "8px 10px", padding: "9px 10px", borderRadius: 8, border: "1px solid var(--paper-edge)", background: "var(--paper-2)", color: "var(--muted-deep)", fontSize: 11.5, lineHeight: 1.45 }}>{t("workspace.load_failed")}</div>}
      {!rootPath ? (
        <EmptyState
          onPick={() => void pickFolder()}
          projectName={projectFolder?.projectName ?? null}
          onUseProjectFolder={projectFolder ? () => void useProjectFolder() : null}
          t={t}
        />
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
function EmptyState({
  onPick,
  onUseProjectFolder,
  projectName,
  t,
}: {
  onPick: () => void;
  onUseProjectFolder: (() => void) | null;
  projectName: string | null;
  t: ReturnType<typeof useT>["t"];
}) {
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
        {projectName
          ? (t("workspace.project_folder_available", { name: projectName }))
          : t("workspace.empty.body")}
      </div>
      {onUseProjectFolder && (
        <button
          type="button"
          data-workspace-use-project-folder
          onClick={onUseProjectFolder}
          style={{
            padding: "8px 14px",
            borderRadius: 999,
            background: "var(--accent)",
            color: "white",
            fontSize: 12.5,
            fontWeight: 700,
            border: "1px solid var(--accent)",
            cursor: "pointer",
          }}
        >
          {t("workspace.use_project_folder")}
        </button>
      )}
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
        {projectName ? t("workspace.choose_other_folder") : t("workspace.empty.pick")}
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
    <ul
      role={depth === 0 ? "tree" : "group"}
      aria-label={depth === 0 ? "Workspace files" : undefined}
      style={{ listStyle: "none", padding: 0, margin: 0 }}
    >
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
    <li role="none">
      <button
        role="treeitem"
        aria-expanded={node.kind === "dir" ? isOpen : undefined}
        aria-selected={node.kind === "file" ? isSelected : undefined}
        aria-current={isSelected ? "true" : undefined}
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

function toWorkspaceFilePreview(node: WorkspaceNode, preview: TextFilePreview): WorkspaceFilePreview {
  const viewerKind = viewerKindForFile(node.name || node.path, preview);
  return {
    path: node.path,
    name: node.name || basename(node.path),
    size: preview.size || node.size,
    viewerKind,
    fileUrl: fileUrlForPath(node.path, viewerKind),
    browserUrl: browserUrlForPreview(node.name || node.path, preview.content),
    content: preview.content,
    truncated: preview.truncated,
    reason: preview.reason,
  };
}

function viewerKindForFile(name: string, preview: TextFilePreview): WorkspaceFilePreview["viewerKind"] {
  const classified = viewerKindForChatFile(name, "file");
  if (classified !== "binary") return classified;
  if (!preview.reason) return "text";
  return "binary";
}

function extensionOf(name: string): string {
  const base = basename(name).toLowerCase();
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot) : "";
}

function fileUrlForPath(absPath: string, viewerKind?: WorkspaceFilePreview["viewerKind"]): string {
  if (["image", "video", "audio", "pdf", "document", "spreadsheet", "presentation", "archive"].includes(viewerKind ?? "")) {
    // pdf 도 같은 경로로 서빙한다 — `file://` 은 webSecurity 에 막혀 빈 iframe 이 된다.
    return `agentlas://localfile/?p=${encodeURIComponent(absPath)}`;
  }
  const normalized = absPath.replace(/\\/g, "/");
  const withSlash = normalized.startsWith("/") ? normalized : `/${normalized}`;
  return `file://${encodeURI(withSlash).replace(/#/g, "%23").replace(/\?/g, "%3F")}`;
}

function browserUrlForPreview(name: string, content: string | undefined): string | undefined {
  if (!content) return undefined;
  const ext = extensionOf(name);
  if (![".url", ".webloc"].includes(ext)) return undefined;
  const direct = content.match(/https?:\/\/[^\s"'<>]+/i)?.[0];
  if (!direct) return undefined;
  try {
    return new URL(direct).toString();
  } catch {
    return undefined;
  }
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
