"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  IconAlertTriangle, IconBrain, IconCheck, IconChevronDown, IconChevronRight, IconClose,
  IconFileText, IconFolder, IconLayers, IconMoreHorizontal, IconPlus, IconRefresh, IconSearch,
  IconShield, IconSidebar, IconTrash, IconSparkles, IconArrowLeft,
} from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { llmLogoSrc } from "@/lib/llm-logo";
import { navigate } from "@/lib/navigation";
import { agentWorkspaceFailure } from "@/lib/agent-workspace-error";
import { approveReviewedChange } from "@/lib/agent-workspace-review";
import type { AgentModelOrderView, InstalledAgent, MemoryImportPreviewUi, RuntimeStatus } from "@shared/types";
import type { DesktopMemoryListEntry } from "@shared/desktop-memory-inspector";
import type {
  AgentWorkspaceComparison, AgentWorkspaceDiff as WorkspaceDiff, AgentWorkspaceChangeSummary, AgentWorkspaceFile, AgentWorkspaceLearningCard, AgentWorkspaceRevisionOutcome,
  AgentWorkspaceProposal, AgentWorkspaceReadFile, AgentWorkspaceRecovery, AgentWorkspaceSnapshot,
} from "@shared/agent-workspace";
import { AgentWorkspaceDiff } from "./AgentWorkspaceDiff";
import { AgentModelPopover } from "./AgentModelRouting";
import { skillFiles } from "./AgentWorkspaceTabs";
import { AgentWorkspaceRecoveryReview } from "./AgentWorkspaceRecoveryReview";
import { AgentMemoryImportDialog } from "./AgentMemoryImportDialog";
import { AgentEditDialog, AgentProfileHead, type HeadFacts } from "./AgentProfileHead";
import { AgentTimeline } from "./AgentTimeline";
import { AgentMemoryTab, AgentSkillsTab, ForgetDialog } from "./AgentManageTabs";
import { AgentSyncTab } from "./AgentSyncTab";
import { AgentFolderNotes, AgentFolderPopover, useFolderStatus } from "./AgentFolder";
import { useAgentMemory, AGENT_MEMORY_FIRST_READ } from "./useAgentMemory";
import { IconHistoryClock } from "./agent-manage-icons";
import { effortLabel, lineLabels, shortDate, SCIENCE_AGENT_SLUG } from "./agent-manage-model";
import { PopupAction, PopupFacts, PopupFrame, PopupSteps } from "@/components/Popup";
import { confirmPopup } from "@/lib/popup";
import styles from "./AgentWorkspace.module.css";
import manage from "./AgentManage.module.css";
import { shortcutLabel, useUiPlatform } from "@/lib/platform-copy";

/** The five tabs of Manage agents (Timeline, Memory, Skills, Files, Sync) and "changes": the review of one change, opened from a Timeline / Skills / Sync post (it is not a tab). */
export type AgentWorkspaceView = "timeline" | "memory" | "skills" | "files" | "sync" | "changes";
type AgentTab = Exclude<AgentWorkspaceView, "changes">;

const KO_STATE: Record<string, string> = {
  eligible: "반영 가능", watching: "지켜보는 중", scope_review: "범위 확인 필요", needs_evidence: "근거 부족", proposed: "변경안 있음", applied: "반영됨",
  review_ready: "검토 대기", applying: "적용 중", rejected: "거절됨", stale: "원본 변경됨", recovery_required: "복구 필요",
  in_sync: "동일 리비전", content_equal: "내용 동일", local_ahead: "로컬 변경", cloud_ahead: "원격 변경",
  diverged: "양쪽 변경", unrelated: "기준 없음", unknown: "알 수 없음", unavailable: "연결 불가",
};
const EN_STATE: Record<string, string> = {
  eligible: "Ready for review", watching: "Watching", scope_review: "Check scope", needs_evidence: "Needs evidence", proposed: "Proposed", applied: "Applied",
  review_ready: "Review ready", applying: "Applying", rejected: "Rejected", stale: "Stale", recovery_required: "Recovery required",
  in_sync: "Same revision", content_equal: "Same content", local_ahead: "Local changes", cloud_ahead: "Remote changes",
  diverged: "Both changed", unrelated: "No common base", unknown: "Unknown", unavailable: "Unavailable",
};

function stateLabel(state: string, ko: boolean): string { return (ko ? KO_STATE : EN_STATE)[state] ?? state; }
function timeLabel(value: string, locale: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString(locale === "ko" ? "ko-KR" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}
function editorContent(value: string, baseline: string): string {
  const usesCrLf = baseline.includes("\r\n") && !baseline.replace(/\r\n/g, "").includes("\n");
  return usesCrLf ? value.replace(/\r?\n/g, "\r\n") : value;
}
function comparisonReason(reason: string, ko: boolean): string {
  const copy: Record<string, [string, string]> = {
    cloud_not_linked: ["이 에이전트를 Cloud에 먼저 저장해 주세요.", "Save this agent to Cloud first."],
    hub_not_linked: ["연결된 Hub 릴리스가 없어요.", "No Hub release is connected."],
    remote_unavailable: ["원격 상태를 확인하지 못했어요. 연결을 확인한 뒤 다시 시도해 주세요.", "Remote state could not be checked. Verify the connection and refresh."],
    common_ancestor_unverified: ["변경 이력을 확인하지 못했어요. 파일 차이를 검토해 주세요.", "A shared history is unverified. Review the file differences."],
    public_source_subset: ["Hub가 공개한 파일만 비교했어요. 나머지 파일은 비교할 수 없어요.", "Only source files shared by Hub are compared. Other files remain unknown."],
    verified_sync_base: ["확인된 동기화 기준과 비교했어요.", "Compared with the verified sync baseline."],
    same_tree_different_history: ["파일 내용은 같고 변경 이력은 다릅니다.", "File contents match; revision histories differ."],
    reviewed_public_projection: ["공개용 파일 사본을 검토해요.", "Review the public file copy."],
    public_projection_current: ["현재 공개용 파일 사본과 같아요.", "The public file copy is current."],
    public_release_verified: ["공개 릴리스의 실제 파일을 확인했어요.", "The published release files were verified."],
    cloud_publish_base_required: ["지금 로컬 버전을 Cloud에 먼저 저장한 뒤 Hub 공개를 검토해 주세요.", "Save the current local version to Cloud before reviewing Hub publication."],
    source_not_licensed: ["게시자가 소스 공유를 허용하지 않았어요. Hub 원본의 소스 공개 여부를 확인해 주세요.", "The publisher has not shared source files. Check source availability on the Hub release."],
    publisher_required: ["이 Hub 릴리스의 게시 권한이 없어요. 게시 권한이 있는 에이전트를 선택해 주세요.", "You do not have publishing rights for this Hub release. Choose an agent you can publish."],
    sign_in_required: ["Agentlas에 로그인한 뒤 다시 시도해 주세요.", "Sign in to Agentlas, then refresh the remote state."],
    sync_outcome_pending: ["이전 동기화 완료 여부를 알 수 없어요. 원격 상태를 먼저 다시 확인해 주세요.", "The previous sync outcome is unconfirmed. Refresh remote state first."],
  };
  return (copy[reason] ?? copy.remote_unavailable)[ko ? 0 : 1];
}
function State({ value, ko }: { value: string; ko: boolean }) { return <span className={`${styles.state} ${styles[value] ?? ""}`}>{value === "eligible" || value === "applied" ? <IconCheck size={10} /> : null}{stateLabel(value, ko)}</span>; }

type TreeEntry = { path: string; name: string; kind: "file" | "directory"; role?: AgentWorkspaceFile["role"]; depth: number };
function treeEntries(files: AgentWorkspaceFile[], expanded: Set<string>): TreeEntry[] {
  const nodes = new Map<string, Omit<TreeEntry, "depth">>();
  for (const file of files) {
    const segments = file.path.split("/").filter(Boolean);
    segments.forEach((name, index) => {
      const path = segments.slice(0, index + 1).join("/");
      const own = index === segments.length - 1;
      nodes.set(path, { path, name, kind: own ? file.kind : "directory", role: own ? file.role : undefined });
    });
  }
  const children = new Map<string, Array<Omit<TreeEntry, "depth">>>();
  for (const node of nodes.values()) {
    const parent = node.path.includes("/") ? node.path.slice(0, node.path.lastIndexOf("/")) : "";
    children.set(parent, [...(children.get(parent) ?? []), node]);
  }
  const result: TreeEntry[] = [];
  const visit = (parent: string, depth: number) => {
    const rows = children.get(parent) ?? [];
    rows.sort((a, b) => a.kind !== b.kind ? (a.kind === "directory" ? -1 : 1) : a.name.localeCompare(b.name));
    for (const row of rows) { result.push({ ...row, depth }); if (row.kind === "directory" && expanded.has(row.path)) visit(row.path, depth + 1); }
  };
  visit("", 0);
  return result;
}

/** The written name of a file's role (the value itself stays). */
const FILE_ROLE_WORDS: Record<string, [string, string]> = { instruction: ["지침", "Instruction"], skill: ["스킬", "Skill"], knowledge: ["지식", "Knowledge"], manifest: ["설명서", "Manifest"], tool: ["도구", "Tool"], asset: ["자료", "Asset"] };
function fileRoleLabel(role: string | undefined, ko: boolean): string { return role ? (FILE_ROLE_WORDS[role]?.[ko ? 0 : 1] ?? role) : ""; }

export function AgentWorkspace({ agent, name, locale, initialView = "timeline", onToggleRoster, runtimes, onRename, onDirtyChange, onMemoryCountChange,
}: {
  agent: InstalledAgent; name: string; locale: string; initialView?: AgentWorkspaceView;
  onToggleRoster: () => void; runtimes: RuntimeStatus[];
  onRename: (value: string) => Promise<void>;
  onDirtyChange?: (dirty: boolean) => void;
  onMemoryCountChange?: (agentId: string, count: number) => void;
}) {
  const ko = locale === "ko";
  const uiOs = useUiPlatform();
  const [view, setView] = useState<AgentWorkspaceView>(initialView);
  const [snapshot, setSnapshot] = useState<AgentWorkspaceSnapshot | null>(null);
  const [files, setFiles] = useState<AgentWorkspaceFile[]>([]);
  const [expanded, setExpanded] = useState(new Set<string>());
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [path, setPath] = useState("");
  const [fileRead, setFileRead] = useState<AgentWorkspaceReadFile | null>(null);
  const [content, setContent] = useState("");
  const [fileLoading, setFileLoading] = useState(false);
  const [newFile, setNewFile] = useState(false);
  const [treeWidth, setTreeWidth] = useState(210);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [newPathDialog, setNewPathDialog] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [renamePathDialog, setRenamePathDialog] = useState(false);
  const [fileMenu, setFileMenu] = useState(false);
  const [memoryImportPreview, setMemoryImportPreview] = useState<MemoryImportPreviewUi | null>(null);
  const [review, setReview] = useState<WorkspaceDiff | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewPath, setReviewPath] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<AgentWorkspaceRecovery | null>(null);
  const [syncTarget, setSyncTarget] = useState<"cloud" | "hub">("cloud");
  const [syncDirection, setSyncDirection] = useState<"receive" | "send">("send");
  const [comparison, setComparison] = useState<AgentWorkspaceComparison | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
  const [compareFailed, setCompareFailed] = useState(false);
  const fileGeneration = useRef(0);
  const workspaceGeneration = useRef(0);
  const reviewGeneration = useRef(0);
  const comparisonGeneration = useRef(0);
  const initialReviewAttempted = useRef(false);
  const codeGutter = useRef<HTMLPreElement>(null);
  const codeInput = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLElement>(null);
  const currentDraft = useRef({ agentId: agent.id, path, content, newFile });
  currentDraft.current = { agentId: agent.id, path, content, newFile };
  const discardPending = useRef(false);
  const dirty = Boolean(fileRead && (content !== fileRead.content || newFile));
  const api = () => {
    const bridge = ipc()?.agentWorkspace;
    if (!bridge) throw new Error(ko ? "에이전트 작업 공간을 열 수 없어요. 앱을 업데이트해 주세요." : "Agent Workspace is unavailable. Update the app.");
    return bridge;
  };
  const refresh = useCallback(async () => {
    const generation = ++workspaceGeneration.current;
    const bridge = ipc()?.agentWorkspace;
    if (!bridge) throw new Error(ko ? "에이전트 작업 공간을 열 수 없어요." : "Agent Workspace is unavailable.");
    const next = await bridge.getWorkspace(agent.id);
    if (workspaceGeneration.current !== generation) return next;
    setSnapshot(next); setFiles(next.files);
    onMemoryCountChange?.(agent.id, next.memoryCandidates.filter(candidate => candidate.state === "eligible").length);
    return next;
  }, [agent.id, ko, onMemoryCountChange]);
  useEffect(() => { setView(initialView); }, [initialView]);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void refresh().catch((failure) => { if (!cancelled) setError(agentWorkspaceFailure(failure, ko)); }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; workspaceGeneration.current++; fileGeneration.current++; reviewGeneration.current++; comparisonGeneration.current++; };
  }, [refresh]);
  useEffect(() => { onDirtyChange?.(dirty); return () => onDirtyChange?.(false); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!fileMenu) return;
    const close = (event: PointerEvent) => { if (event.target instanceof Element && !event.target.closest("[data-agent-file-menu],[data-agent-file-actions]")) setFileMenu(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") setFileMenu(false); };
    document.addEventListener("pointerdown", close); document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", close); document.removeEventListener("keydown", escape); };
  }, [fileMenu]);
  useEffect(() => {
    if (!dirty) return;
    const handle = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", handle);
    return () => window.removeEventListener("beforeunload", handle);
  }, [dirty]);
  const mayLeaveFile = async () => {
    if (!dirty) return true;
    if (discardPending.current) return false;
    const draft = currentDraft.current;
    const generation = fileGeneration.current;
    discardPending.current = true;
    try {
      const accepted = await confirmPopup(ko ? "변경안으로 저장하지 않은 초안이 사라집니다." : "The draft has not been saved as a proposal and will be lost.", {
        locale: ko ? "ko" : "en", title: ko ? "초안을 버릴까요?" : "Discard draft?",
        confirmLabel: ko ? "초안 버리기" : "Discard draft", tone: "warning", detail: draft.path,
      });
      const current = currentDraft.current;
      return accepted && generation === fileGeneration.current && draft.agentId === current.agentId
        && draft.path === current.path && draft.content === current.content && draft.newFile === current.newFile;
    } finally { discardPending.current = false; }
  };
  const openFile = async (nextPath: string, force = false) => {
    if (!force && nextPath === path && fileRead) return true;
    if (!force && (busy || !await mayLeaveFile())) return false;
    const generation = ++fileGeneration.current;
    setPath(nextPath); setFileRead(null); setContent(""); setNewFile(false); setFileLoading(true); setError("");
    try {
      const result = await api().readFile(agent.id, nextPath);
      if (fileGeneration.current !== generation) return;
      setFileRead(result); setContent(result.content);
      const parts = nextPath.split("/");
      setExpanded((previous) => new Set([...previous, ...parts.slice(0, -1).map((_, index) => parts.slice(0, index + 1).join("/"))]));
      return true;
    } catch (failure) { if (fileGeneration.current === generation) setError(agentWorkspaceFailure(failure, ko)); }
    finally { if (fileGeneration.current === generation) setFileLoading(false); }
  };
  const openFileRef = useRef(openFile);
  openFileRef.current = openFile;
  useEffect(() => {
    if (!snapshot || path) return;
    const first = snapshot.canonicalEntry ?? snapshot.files.find((file) => file.kind === "file")?.path;
    if (first) void openFileRef.current(first, true);
  }, [snapshot, path]);
  const openReview = async (proposalId: string) => {
    initialReviewAttempted.current = true;
    setRecovery(null);
    const generation = ++reviewGeneration.current;
    setView("changes"); setReviewLoading(true); setReview(null); setReviewPath(null); setError("");
    try { const result = await api().getDiff(proposalId); if (reviewGeneration.current === generation) { setReview(result); setReviewPath(result.changes[0]?.path ?? null); if (result.status === "stale" || result.status === "recovery_required") await refresh(); } }
    catch (failure) { if (reviewGeneration.current === generation) setError(agentWorkspaceFailure(failure, ko)); }
    finally { if (reviewGeneration.current === generation) setReviewLoading(false); }
  };
  const openReviewRef = useRef(openReview);
  openReviewRef.current = openReview;
  useEffect(() => {
    if (view !== "changes" || review || reviewLoading || initialReviewAttempted.current) return;
    const pending = snapshot?.proposals.find((proposal) => proposal.status === "review_ready") ?? snapshot?.proposals[0];
    if (pending) void openReviewRef.current(pending.id);
  }, [view, snapshot, review, reviewLoading]);
  const run = async (label: string, task: () => Promise<void>) => {
    if (busy) return;
    setBusy(label); setError(""); setNotice("");
    try { await task(); } catch (failure) { setError(agentWorkspaceFailure(failure, ko)); } finally { setBusy(""); }
  };
  const draftPath = newPath.trim();
  const validNewPath = Boolean(draftPath) && !draftPath.startsWith("/") && !draftPath.split("/").includes("..") && !files.some((file) => file.path === draftPath);
  const openDraft = async () => {
    if (busy || !validNewPath || !snapshot?.writable || snapshot.activation === "recovery_required" || !await mayLeaveFile()) return;
    fileGeneration.current++;
    setPath(draftPath); setFileRead({ path: draftPath, content: "", blobHash: "", byteLength: 0, binary: false, truncated: false });
    setContent(""); setNewFile(true); setFileLoading(false); setNewPathDialog(false); setView("files");
  };
  const prepareFile = () => run("prepare-file", async () => {
    if (!fileRead || !snapshot?.writable || snapshot.activation === "recovery_required" || fileRead.binary || fileRead.truncated || !dirty) return;
    const proposal = await api().prepareFileChange({ agentId: agent.id, targetPath: path, currentContent: fileRead.content, proposedContent: content });
    setContent(fileRead.content); setNewFile(false);
    await refresh(); await openReview(proposal.id);
  });
  const prepareFileRef = useRef(prepareFile);
  prepareFileRef.current = prepareFile;
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey)) return;
      if (quickOpen || newPathDialog || renamePathDialog || memoryImportPreview || document.querySelector('[aria-modal="true"]')) { if (["p", "s"].includes(event.key.toLowerCase())) event.preventDefault(); return; }
      if (event.key.toLowerCase() === "p") { event.preventDefault(); setQuickOpen(true); setQuickQuery(""); }
      if (event.key.toLowerCase() === "s") { event.preventDefault(); if (view === "files") void prepareFileRef.current(); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [view, quickOpen, newPathDialog, renamePathDialog, memoryImportPreview]);
  const compare = useCallback(async () => {
    const generation = ++comparisonGeneration.current;
    setCompareLoading(true); setComparison(null); setCompareFailed(false);
    try {
      const bridge = ipc()?.agentWorkspace;
      if (!bridge) throw new Error(ko ? "사용할 수 없어요." : "Unavailable.");
      const result = await bridge.compare({ agentId: agent.id, target: syncTarget, direction: syncDirection });
      if (comparisonGeneration.current === generation) setComparison(result);
    } catch (failure) { if (comparisonGeneration.current === generation) { setCompareFailed(true); setError(agentWorkspaceFailure(failure, ko)); } }
    finally { if (comparisonGeneration.current === generation) setCompareLoading(false); }
  }, [agent.id, syncTarget, syncDirection, ko]);
  // The head says how many changes wait to be saved to Cloud, so a linked agent compares once when it opens (and again when the owner changes the direction), not on a timer.
  useEffect(() => { if (view === "sync" || snapshot?.cloudId) void compare(); }, [view, compare, snapshot?.cloudId]);
  const verifyApplied = async (proposal: AgentWorkspaceProposal) => {
    const next = await refresh();
    if (proposal.status !== "applied") { await openReview(proposal.id); return; }
    if (next.treeDigest !== proposal.proposedTreeDigest) throw new Error(ko ? "적용 뒤 파일이 다시 변경됐어요. 현재 파일을 다시 검토해 주세요." : "The file tree changed after apply. Review the current files again.");
    for (const change of proposal.changes) {
      if (change.operation === "delete") {
        if (next.files.some((file) => file.path === change.path)) throw new Error(ko ? "삭제 결과가 검토한 내용과 달라요." : "Deleted-file verification does not match.");
      } else {
        const readback = await api().readFile(agent.id, change.path);
        if (readback.blobHash !== change.afterHash) throw new Error(ko ? "적용 후 파일이 검토한 변경과 달라요." : "The applied file differs from the reviewed change.");
      }
    }
    setReview({ ...proposal, reviewedHash: proposal.proposalDigest });
    if (path && proposal.changes.some((change) => change.path === path && change.operation !== "delete")) await openFile(path, true);
    else if (proposal.changes.some((change) => change.path === path && change.operation === "delete")) { setPath(""); setFileRead(null); setContent(""); }
    setNotice(ko ? "실제 파일 확인 완료 · 다음 실행부터 적용" : "Actual files verified · Used from the next run");
  };
  const applyReviewed = async (review: WorkspaceDiff) => {
    if (!review.reviewToken || review.status !== "review_ready") return;
    // A review pass that ran out while the owner was away asks Main for the same diff again (agent-workspace-review.ts).
    const result = await approveReviewedChange(api(), review);
    if (result.kind === "changed") {
      setReview(result.review); setReviewPath(result.review.changes[0]?.path ?? null);
      setView("changes");
      setNotice(ko ? "변경안이 바뀌었어요. 새 내용을 확인한 뒤 다시 승인해 주세요." : "The change moved meanwhile, so the new one is shown. Review it and approve again.");
      return;
    }
    if (result.proposal.applyWhenIdle) {
      // A run holds this agent's files; Main keeps the approval for this exact change and applies it when the run ends.
      await openReview(result.proposal.id);
      setNotice(ko ? "실행 중인 작업이 끝나면 자동으로 적용해요." : "A run is using this agent. This change will be applied automatically when it ends; your approval is kept.");
      return;
    }
    await verifyApplied(result.proposal);
  };
  const approve = () => run("apply", async () => { if (review) await applyReviewed(review); });
  const addSkill = (proposal: AgentWorkspaceProposal) => run("apply", async () => {
    const diff = await api().getDiff(proposal.id);
    if (diff.status !== "review_ready" || !diff.reviewToken) { await openReview(proposal.id); return; }
    await applyReviewed(diff);
  });
  const dismissProposal = (proposal: AgentWorkspaceProposal) => run("reject", async () => { await api().reject({ proposalId: proposal.id }); await refresh(); });
  const undoChange = (revisionId: string) => run("prepare-rollback", async () => { const proposal = await api().prepareRollback({ agentId: agent.id, revisionId }); await refresh(); await openReview(proposal.id); });
  const readDiff = useCallback((proposalId: string): Promise<WorkspaceDiff> => { const bridge = ipc()?.agentWorkspace; return bridge ? bridge.getDiff(proposalId) : Promise.reject(new Error("bridge")); }, []);
  const rows = useMemo(() => treeEntries(files, expanded), [files, expanded]);
  const lineCount = Math.max(1, content.split("\n").length);
  const pendingCount = snapshot?.proposals.filter((proposal) => proposal.status === "review_ready").length ?? 0;
  const toggleDirectory = async (entry: TreeEntry) => {
    const isExpanded = expanded.has(entry.path);
    setExpanded((previous) => { const next = new Set(previous); if (isExpanded) next.delete(entry.path); else next.add(entry.path); return next; });
    if (isExpanded) return;
    try { const children = await api().listFiles(agent.id, entry.path); setFiles((previous) => [...new Map([...previous, ...children].map((file) => [file.path, file])).values()]); }
    catch (failure) { setError(agentWorkspaceFailure(failure, ko)); }
  };
  const startResize = (event: React.PointerEvent<HTMLButtonElement>) => {
    const start = event.clientX; const width = treeWidth;
    event.currentTarget.setPointerCapture(event.pointerId);
    const move = (next: PointerEvent) => setTreeWidth(Math.max(160, Math.min(300, width + next.clientX - start)));
    const end = () => { window.removeEventListener("pointermove", move); window.removeEventListener("pointerup", end); };
    window.addEventListener("pointermove", move); window.addEventListener("pointerup", end, { once: true });
  };
  const [order, setOrder] = useState<AgentModelOrderView | null>(null);
  const [modelOpen, setModelOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [folderOpen, setFolderOpen] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [forgetEntries, setForgetEntries] = useState<DesktopMemoryListEntry[] | null>(null);
  const [forgetAll, setForgetAll] = useState(false);
  const [forgetBusy, setForgetBusy] = useState(false);
  const [forgetFailed, setForgetFailed] = useState(false);
  const lastTab = useRef<AgentTab>("timeline");
  useEffect(() => { if (view !== "changes") lastTab.current = view; }, [view]);
  const memory = useAgentMemory(agent.id, view === "timeline" || view === "memory");
  const folder = useFolderStatus(agent.id);
  const isScience = agent.slug === SCIENCE_AGENT_SLUG;
  // The model order is read when an agent opens; a Science agent has none to choose (it picks its own model).
  useEffect(() => {
    setOrder(null); setModelOpen(false);
    if (isScience) return;
    let alive = true;
    void Promise.resolve(ipc()?.agentModelOrder?.get(agent.id)).then((answer) => { if (alive && answer?.ok) setOrder(answer.order); }).catch(() => undefined);
    return () => { alive = false; };
  }, [agent.id, isScience]);
  const localeKey: "ko" | "en" = ko ? "ko" : "en";
  const modelText = (() => {
    const first = order?.effective.first;
    if (!first) return null;
    const names = lineLabels(first, runtimes, localeKey);
    const effort = effortLabel(first, runtimes, localeKey);
    return effort ? `${names.model} · ${effort}` : names.model;
  })();
  const skillCount = skillFiles(files).length;
  const sendCompare = comparison && comparison.agentId === agent.id && comparison.target === "cloud" && comparison.direction === "send" ? comparison : null;
  const toSave = snapshot?.cloudId && sendCompare ? (sendCompare.outgoingChanges?.length ?? 0) : null;
  const waitingCount = (snapshot?.proposals ?? []).filter((proposal) => proposal.status === "review_ready").length;
  const facts: HeadFacts = {
    working: snapshot?.activation === "run_active", builtAt: agent.installedAt ? shortDate(agent.installedAt) || null : null, modelText, modelLogo: order?.effective.first ? llmLogoSrc({ model: order.effective.first.model, backend: order.effective.first.backend, kind: order.effective.first.kind }) : null, toSave,
    memories: memory.result ? memory.result.total : null, skills: snapshot ? skillCount : null, files: snapshot ? files.filter((file) => file.kind === "file").length : null,
  };
  const chat = async () => {
    const create = ipc()?.chats?.createAgentChat;
    if (!create || chatBusy) return;
    setChatBusy(true); setError("");
    try { const receipt = await create({ agentIds: [agent.id] }); navigate(`/workspace?open=${encodeURIComponent(receipt.chat.id)}`); }
    catch (failure) { setError(agentWorkspaceFailure(failure, ko)); } finally { setChatBusy(false); }
  };
  const confirmForget = async () => {
    if (!forgetEntries) return;
    setForgetBusy(true); setForgetFailed(false);
    try {
      let result = await memory.forget(forgetEntries);
      // "Forget all" with a list cut at the newest lines: read the next lines and go on while the count falls (a round that forgot nothing stops it).
      for (let round = 0; forgetAll && !result.failed && result.remaining > 0 && result.forgotten > 0 && round < 40; round++) {
        const next = await ipc()?.oneMemory?.inspector?.query({ actorId: agent.id, limit: AGENT_MEMORY_FIRST_READ, status: "active" }).catch(() => null);
        if (!next || next.entries.length === 0) break;
        result = await memory.forget(next.entries);
      }
      if (result.failed || (forgetAll && result.remaining > 0)) { setForgetFailed(true); return; }
      setForgetEntries(null); setForgetAll(false);
      setNotice(ko ? "기억에서 지웠어요." : "Removed from memory.");
    } finally { setForgetBusy(false); }
  };
  const canSync = comparison && comparison.agentId === agent.id && comparison.target === syncTarget && comparison.direction === syncDirection && (syncDirection === "send" ? comparison.canSend : comparison.canReceive) && Boolean(comparison.reviewedHash && comparison.reviewToken);
  const comparisonText = comparison?.reason ? comparisonReason(comparison.reason, ko) : null;
  // Learnings that are ready but have no change prepared yet (a lesson that is not a skill): the Skills tab offers to prepare the change.
  const unpreparedLessons = useMemo(() => {
    const prepared = new Set((snapshot?.proposals ?? []).filter((proposal) => proposal.status === "review_ready").flatMap((proposal) => proposal.memoryEntryIds));
    const groups = new Map<string, string[]>();
    for (const candidate of snapshot?.memoryCandidates ?? []) {
      if (candidate.state !== "eligible" || prepared.has(candidate.id)) continue;
      const key = candidate.groupId ?? candidate.id;
      groups.set(key, [...(groups.get(key) ?? []), candidate.id]);
    }
    return [...groups.entries()].map(([key, ids]) => { const lead = (snapshot?.memoryCandidates ?? []).find((candidate) => candidate.id === ids[0]); return { key, ids, text: lead?.contentNative || lead?.content || "" }; });
  }, [snapshot]);
  const prepareLesson = (ids: string[]) => run("prepare-memory", async () => {
    let proposal;
    try { proposal = await api().prepareFromMemory({ agentId: agent.id, memoryEntryIds: ids }); } catch (failure) { await refresh().catch(() => undefined); throw failure; }
    await refresh(); await openReview(proposal.id);
  });
  const renderFiles = (snapshot: AgentWorkspaceSnapshot) => <>
          <aside className={styles.tree}><div className={styles.paneHeader}><strong>{ko ? "파일" : "Files"}</strong><button className={styles.iconButton} title={ko ? `파일 찾기 ${shortcutLabel("P", uiOs)}` : `Find file ${shortcutLabel("P", uiOs)}`} aria-label={ko ? "파일 찾기" : "Find file"} onClick={() => { setQuickOpen(true); setQuickQuery(""); }}><IconSearch size={13} /></button><button className={styles.iconButton} disabled={!snapshot.writable || Boolean(busy) || snapshot.activation === "recovery_required"} title={ko ? "새 파일 초안" : "New file draft"} aria-label={ko ? "새 파일 초안" : "New file draft"} onClick={() => { setNewPathDialog(true); setNewPath(""); }}><IconPlus size={13} /></button></div>
            <div className={styles.treeRows} role="tree" aria-label={ko ? "에이전트 파일 트리" : "Agent file tree"}>
              {rows.map((entry) => <button className={`${styles.treeRow} ${entry.path === path ? styles.selected : ""}`} key={entry.path} role="treeitem" aria-level={entry.depth + 1} aria-selected={entry.path === path} aria-expanded={entry.kind === "directory" ? expanded.has(entry.path) : undefined} style={{ paddingLeft: 8 + entry.depth * 13 }} onClick={() => entry.kind === "directory" ? void toggleDirectory(entry) : void openFile(entry.path)} onKeyDown={(event) => {
                if (event.key === "ArrowRight" && entry.kind === "directory" && !expanded.has(entry.path)) { event.preventDefault(); void toggleDirectory(entry); }
                if (event.key === "ArrowLeft" && entry.kind === "directory" && expanded.has(entry.path)) { event.preventDefault(); void toggleDirectory(entry); }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const row = event.currentTarget; if (event.key === "ArrowDown") (row.nextElementSibling as HTMLElement | null)?.focus(); else (row.previousElementSibling as HTMLElement | null)?.focus(); }
              }}>{entry.kind === "directory" ? (expanded.has(entry.path) ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />) : <span style={{ width: 11 }} />}{entry.kind === "directory" ? <IconFolder size={13} /> : <IconFileText size={13} />}<span className={styles.treeName}>{entry.name}</span>{entry.role === "instruction" && <span className={styles.treeRole}>{ko ? "규칙" : "rule"}</span>}</button>)}
              {!rows.length && <div className={styles.empty}>{ko ? "파일 없음" : "No files"}</div>}
            </div>
          </aside><button className={styles.resizeHandle} aria-label={ko ? "파일 트리 너비" : "Resize file tree"} onPointerDown={startResize} onKeyDown={(event) => { if (event.key === "ArrowLeft") setTreeWidth((width) => Math.max(160, width - 10)); if (event.key === "ArrowRight") setTreeWidth((width) => Math.min(300, width + 10)); }} />
          <div className={styles.editor}>{path ? <><div className={styles.fileToolbar}><IconFileText size={14} /><span className={styles.filePath} title={path}>{path}{dirty ? " ●" : ""}</span><span className={styles.fileRole}>{newFile ? (ko ? "새 파일 초안" : "New draft") : fileRoleLabel(files.find((file) => file.path === path)?.role, ko)}</span>{!newFile && files.some((file) => file.path === path) && <button className={styles.iconButton} data-agent-file-actions aria-label={ko ? "파일 작업" : "File actions"} title={ko ? "파일 작업" : "File actions"} aria-expanded={fileMenu} disabled={Boolean(busy) || !snapshot.writable || snapshot.activation === "recovery_required"} onClick={() => setFileMenu((current) => !current)}><IconMoreHorizontal size={16} /></button>}<button className={`${styles.button} ${styles.primary}`} disabled={!dirty || Boolean(busy) || !snapshot.writable || snapshot.activation === "recovery_required" || !fileRead || fileRead.binary || fileRead.truncated} onClick={() => void prepareFile()}>{busy === "prepare-file" && <span className={styles.loading} />}{ko ? "변경 검토" : "Review change"}</button></div>{fileMenu && <div className={styles.fileMenu} data-agent-file-menu role="menu"><button role="menuitem" onClick={() => { setFileMenu(false); setRenamePathDialog(true); setNewPath(path); }}><IconFileText size={16} />{ko ? "이름 변경 검토…" : "Review rename…"}</button><button role="menuitem" className={styles.danger} onClick={() => { setFileMenu(false); void run("prepare-delete", async () => { if (!snapshot.writable || snapshot.activation === "recovery_required" || !await mayLeaveFile()) return; const proposal = await api().prepareFileOperation({ agentId: agent.id, operation: "delete", path }); setContent(fileRead?.content ?? ""); await refresh(); await openReview(proposal.id); }); }}><IconTrash size={16} />{ko ? "삭제 검토…" : "Review deletion…"}</button></div>}
            {fileLoading ? <div className={styles.empty}><span className={styles.loading} /></div> : fileRead?.binary ? <div className={styles.empty}><IconFileText size={28} />{ko ? "바이너리 파일 · 텍스트 편집 불가" : "Binary file · Text editing unavailable"}<span>{fileRead.byteLength.toLocaleString()} bytes</span></div> : fileRead ? <>{fileRead.truncated && <div className={styles.banner}>{ko ? "파일이 커서 일부만 표시합니다. 편집은 잠겨 있습니다." : "Partial preview of a large file. Editing is locked."}</div>}<div className={styles.codeEditor}><pre className={styles.editorGutter} ref={codeGutter} aria-hidden="true">{Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")}</pre><textarea ref={codeInput} className={styles.codeInput} value={content} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label={`${path} ${ko ? "파일 내용" : "file content"}`} readOnly={!snapshot.writable || snapshot.activation === "recovery_required" || fileRead.truncated || Boolean(busy)} onChange={(event) => setContent(editorContent(event.target.value, fileRead.content))} onScroll={(event) => { if (codeGutter.current) codeGutter.current.scrollTop = event.currentTarget.scrollTop; }} onKeyDown={(event) => {
              if (event.key === "Tab" && !event.currentTarget.readOnly) { event.preventDefault(); const element = event.currentTarget; const start = element.selectionStart; const end = element.selectionEnd; setContent(editorContent(element.value.slice(0, start) + "  " + element.value.slice(end), fileRead.content)); requestAnimationFrame(() => { element.selectionStart = element.selectionEnd = start + 2; }); }
            }} /></div></> : <div className={styles.empty}>{ko ? "파일 읽기 실패" : "Could not read the file"}</div>}</> : <div className={styles.empty}><IconFolder size={35} /><strong>{ko ? "파일을 선택하세요" : "Select a file"}</strong></div>}</div>
  </>;
  const renderChanges = () => <>
    <aside className={styles.listPane}><div className={styles.paneHeader}><IconLayers size={14} /><strong>{ko ? "변경" : "Changes"}</strong><span>{snapshot?.proposals.length ?? 0}</span></div><div className={styles.listRows}>
      {(snapshot?.proposals ?? []).map((proposal) => <div className={styles.checkRow} key={proposal.id}><button className={`${styles.listItem} ${review?.id === proposal.id ? styles.selected : ""}`} onClick={() => void openReview(proposal.id)}><span className={styles.listItemTitle}><span>{proposal.summary}</span></span><span className={styles.listItemSub}><State value={proposal.status} ko={ko} /><span>{proposal.changes.length}{ko ? "개 파일" : " files"}</span></span><span className={styles.listItemSub}>{timeLabel(proposal.createdAt, locale)}</span></button>{["review_ready", "stale"].includes(proposal.status) && <button className={styles.iconButton} style={{ marginTop: 8 }} title={ko ? "변경안 거절" : "Reject proposal"} aria-label={`${ko ? "변경안 거절" : "Reject proposal"}: ${proposal.summary}`} disabled={Boolean(busy)} onClick={() => void run("reject", async () => { const result = await api().reject({ proposalId: proposal.id }); if (review?.id === proposal.id) setReview({ ...result, reviewedHash: result.proposalDigest }); await refresh(); })}><IconClose size={13} /></button>}</div>)}
      {!snapshot?.proposals.length && <div className={styles.empty}>{ko ? "변경안 없음" : "No proposals"}</div>}
    </div></aside>
    <div className={styles.reviewPane}>{reviewLoading ? <div className={styles.empty}><span className={styles.loading} />{ko ? "변경 파일 확인 중" : "Reading proposed files"}</div> : review ? <>
      <div className={styles.reviewScroll} data-testid="review-scroll">
      <div className={styles.reviewSummary}><IconLayers size={16} /><div><strong>{review.summary}</strong><div className={styles.meta}><State value={review.status} ko={ko} /><span>{review.changes.length}{ko ? "개 파일" : " files"}</span></div></div><button className={styles.iconButton} disabled={Boolean(busy)} onClick={() => void openReview(review.id)} title={ko ? "변경 다시 확인" : "Reload diff"} aria-label={ko ? "변경 다시 확인" : "Reload diff"}><IconRefresh size={14} /></button></div>
      {review.lastError && <div className={`${styles.banner} ${styles.error}`}>{review.lastError}</div>}
      {review.status === "stale" && <div className={styles.banner}><span>{ko ? "원본이 바뀌었어요. 변경안을 다시 만들어 주세요." : "The source changed. Prepare a new proposal against the current files."}</span>{review.memoryEntryIds.length > 0 && <button className={styles.button} disabled={Boolean(busy) || dirty} onClick={() => void run("reprepare-memory", async () => { const next = await api().prepareFromMemory({ agentId: agent.id, memoryEntryIds: review.memoryEntryIds }); await refresh(); await openReview(next.id); })}>{ko ? "다시 만들기" : "Prepare again"}</button>}</div>}
      {alwaysOnSentence(review.alwaysOn, ko) && <div className={`${styles.banner} ${review.alwaysOn?.overHard ? styles.error : ""}`}>{alwaysOnSentence(review.alwaysOn, ko)}</div>}
      {review.card && <LearningCardView card={review.card} ko={ko} />}
      <ChangeSummaryView changes={review.changeSummary} ko={ko} />
      {review.status === "applied" && <OutcomeComparison before={snapshot?.history.find((revision) => revision.id === review.baseRevisionId)?.outcome} after={snapshot?.history.find((revision) => revision.id === review.appliedRevisionId)?.outcome} ko={ko} />}
      <AgentWorkspaceDiff files={review.changes} locale={locale} activePath={reviewPath} onPathChange={setReviewPath} />
      </div>
      {dirty && <div className={styles.banner}>{ko ? "파일 초안을 변경안으로 저장하거나 버린 뒤 승인해 주세요." : "Save or discard your open file draft before approving."}</div>}
      <div className={styles.reviewFooter}><span>{ko ? "전체 파일 변경 · 다음 실행부터 적용" : "Whole file changes · Used from the next run"}</span>
        {review.status === "review_ready" && <><button className={styles.button} disabled={Boolean(busy)} onClick={() => void run("reject", async () => { const result = await api().reject({ proposalId: review.id }); setReview({ ...result, reviewedHash: result.proposalDigest }); await refresh(); })}>{ko ? "거절" : "Reject"}</button><button className={`${styles.button} ${styles.primary}`} disabled={Boolean(busy) || !snapshot?.writable || !review.reviewToken || dirty || snapshot.activation === "recovery_required"} onClick={() => void approve()}>{busy === "apply" ? <span className={styles.loading} /> : <IconCheck size={13} />}{ko ? "승인·적용" : "Approve and apply"}</button></>}
      </div>
    </> : <div className={styles.empty}><IconLayers size={35} /><strong>{ko ? "검토할 변경을 선택하세요" : "Select a change to review"}</strong></div>}</div>
  </>;
  const tabs: Array<{ key: AgentTab; label: string; icon: JSX.Element; count?: number | null }> = [
    { key: "timeline", label: ko ? "타임라인" : "Timeline", icon: <IconHistoryClock size={15} /> },
    { key: "memory", label: ko ? "기억" : "Memory", icon: <IconBrain size={15} />, count: memory.result ? memory.result.total : null },
    { key: "skills", label: ko ? "스킬" : "Skills", icon: <IconSparkles size={15} />, count: waitingCount + unpreparedLessons.length || null },
    { key: "files", label: ko ? "파일" : "Files", icon: <IconFolder size={15} /> },
    { key: "sync", label: ko ? "동기화" : "Sync", icon: <IconRefresh size={15} />, count: toSave || null },
  ];
  const body = () => {
    if (loading) return <div className={styles.empty}><span className={styles.loading} />{ko ? "에이전트 파일 읽는 중" : "Reading agent files"}</div>;
    if (!snapshot) return <div className={styles.empty}><IconFolder size={35} /><strong>{ko ? "파일을 확인할 수 없어요" : "Files could not be read"}</strong><button className={styles.button} onClick={() => void run("refresh", async () => { await refresh(); })}>{ko ? "다시 읽기" : "Retry"}</button></div>;
    if (view === "timeline") return <AgentTimeline agentId={agent.id} name={name} slug={agent.slug} ko={ko} snapshot={snapshot} memory={memory.entries} memoryFailed={memory.failed} onRetryMemory={() => void memory.reload()} busy={Boolean(busy)} canWrite={snapshot.writable && snapshot.activation !== "recovery_required"} readDiff={readDiff}
      onAddSkill={(proposal) => void addSkill(proposal)} onDismiss={(proposal) => void dismissProposal(proposal)} onReview={(proposal) => void openReview(proposal.id)} onOpenMemory={() => setView("memory")} onForget={(entries) => { setForgetFailed(false); setForgetEntries(entries); }} onUndo={(revisionId) => void undoChange(revisionId)} />;
    if (view === "memory") return <AgentMemoryTab ko={ko} result={memory.result} failed={memory.failed} skipped={memory.skipped} onForget={(entries, all) => { setForgetFailed(false); setForgetAll(Boolean(all)); setForgetEntries(entries); }} onRetry={() => void memory.reload()}
      onImport={() => void run("memory-import-preview", async () => { const bridge = ipc()?.agentMemory; if (!bridge) throw new Error(ko ? "기억을 사용할 수 없어요." : "Memory is unavailable."); setMemoryImportPreview(await bridge.importPreview(agent.id)); })} />;
    if (view === "skills") return <AgentSkillsTab ko={ko} files={files} proposals={snapshot.proposals} writable={snapshot.writable && snapshot.activation !== "recovery_required"} busy={Boolean(busy)} cloudLinked={Boolean(snapshot.cloudId)} readDiff={readDiff}
      onAddSkill={(proposal) => void addSkill(proposal)} onDismiss={(proposal) => void dismissProposal(proposal)} onReview={(proposal) => void openReview(proposal.id)} onOpenFile={(skillPath) => { setView("files"); void openFile(skillPath); }}
      lessons={unpreparedLessons} onPrepare={(ids) => void prepareLesson(ids)}
      autoEvolution={snapshot.autoEvolution} onAutoEvolution={(enabled) => void run("auto-evolution", async () => { await api().setAutoEvolution({ agentId: agent.id, enabled }); await refresh(); })} />;
    if (view === "files") return renderFiles(snapshot);
    if (view === "sync") return <AgentSyncTab ko={ko} locale={locale} agentId={agent.id} parentId={agent.parentTeamId ?? ""} snapshot={snapshot} comparison={comparison} loading={compareLoading} compareFailed={compareFailed} target={syncTarget} direction={syncDirection}
      onTarget={(value) => { setSyncTarget(value); }} onDirection={setSyncDirection} files={files.filter((file) => file.kind === "file").length} skills={skillCount} memoryTotal={memory.result ? memory.result.total : null} busy={Boolean(busy)} dirty={dirty}
      canApprove={Boolean(canSync)} comparisonReason={comparisonText} onRefresh={() => void compare()} onOpenProposal={(id) => void openReview(id)}
      onSignIn={() => void run("sign-in", async () => { const bridge = ipc(); if (!bridge) throw new Error(ko ? "로그인할 수 없어요." : "Sign-in is unavailable."); await bridge.auth.signInWithGoogle(); await compare(); })}
      onApprove={() => void run("sync", async () => {
        if (!comparison?.reviewToken || !comparison.reviewedHash) return;
        const result = await api().sync({ agentId: agent.id, target: syncTarget, direction: syncDirection, reviewedHash: comparison.reviewedHash, reviewToken: comparison.reviewToken });
        if ("status" in result) await verifyApplied(result);
        else { await refresh(); setComparison(result); if (result.state === "in_sync" || result.state === "content_equal") setNotice(ko ? "원격 파일 확인 완료" : "Remote files verified"); }
        await compare();
      })} />;
    return <div className={manage.changesWrap}>
      <div className={manage.backBar}><button type="button" className={manage.btn} onClick={() => setView(lastTab.current)}><IconArrowLeft size={14} />{ko ? "돌아가기" : "Back"}</button></div>
      <div className={manage.changesBody}>{recovery ? <AgentWorkspaceRecoveryReview recovery={recovery} locale={locale} busy={Boolean(busy)} dirty={dirty} onClose={() => setRecovery(null)} onRetain={() => void run("recovery-acknowledge", async () => { if (!recovery.reviewToken) return; const next = await api().acknowledgeRecovery({ agentId: agent.id, reviewedHash: recovery.reviewedHash, reviewToken: recovery.reviewToken }); if (next.treeDigest !== recovery.currentTreeDigest || next.activation === "recovery_required") throw new Error(ko ? "복구 결과가 현재 파일과 달라요. 다시 검토해 주세요." : "Recovery differs from the reviewed files. Review again."); setSnapshot(next); setFiles(next.files); setRecovery(null); setView("files"); if (path && next.files.some((file) => file.path === path)) await openFile(path, true); else { setPath(""); setFileRead(null); setContent(""); setNewFile(false); } setNotice(ko ? "현재 파일 확인 완료 · 실행 잠금 해제" : "Current files verified · Execution unlocked"); })} /> : renderChanges()}</div>
    </div>;
  };
  return <section ref={root} className={styles.workspace} aria-label={`${name} Agent Workspace`} data-testid="agent-workspace" style={{ "--workspace-tree-width": `${treeWidth}px` } as CSSProperties}>
    <AgentProfileHead agentId={agent.id} name={name} slug={agent.slug} tagline={ko ? agent.tagline : (agent.taglineEn || agent.tagline)} big={view === "timeline"} facts={facts} ko={ko} modelOpen={modelOpen}
      onModel={isScience || !order ? null : () => setModelOpen((value) => !value)} onFolder={() => setFolderOpen((value) => !value)} onEdit={() => setEditOpen(true)} onChat={() => void chat()} folderOpen={folderOpen} chatBusy={chatBusy}
      modelPopover={modelOpen && order ? <AgentModelPopover agentId={agent.id} locale={localeKey} runtimes={runtimes} order={order} onOrder={setOrder} onClose={() => setModelOpen(false)} /> : null}>
      {folderOpen && <AgentFolderPopover agentName={name} ko={ko} status={folder.status} working={snapshot?.activation === "run_active"} onClose={() => setFolderOpen(false)}
        onReveal={(target) => void ipc()?.fs.showItemInFolder?.(target)} onChanged={() => void folder.reload()} />}
    </AgentProfileHead>
    <nav className={manage.tabs} aria-label={ko ? "에이전트 탭" : "Agent tabs"}>
      <button type="button" className={`${manage.ib} ${manage.rosterToggle}`} aria-label={ko ? "에이전트 목록 접기/펴기" : "Toggle agent roster"} onClick={onToggleRoster}><IconSidebar size={16} /></button>
      {tabs.map((tab) => <button key={tab.key} type="button" className={`${manage.tab} ${view === tab.key ? manage.tabOn : ""}`} aria-pressed={view === tab.key} onClick={() => setView(tab.key)}>{tab.icon}{tab.label}{typeof tab.count === "number" && <span className={tab.key === "memory" ? `${manage.count} ${manage.countPlain}` : manage.count}>{tab.count}</span>}</button>)}
    </nav>
    <AgentFolderNotes agentId={agent.id} agentName={name} ko={ko} status={folder.status} reload={folder.reload} working={snapshot?.activation === "run_active"} />
    {error && <div className={`${styles.banner} ${styles.error}`} role="alert"><IconAlertTriangle size={14} /><span>{error}</span><button className={styles.iconButton} aria-label={ko ? "오류 닫기" : "Dismiss error"} onClick={() => setError("")}><IconClose size={13} /></button></div>}
    {notice && <div className={`${styles.banner} ${styles.notice}`} role="status"><IconCheck size={14} /><span>{notice}</span><button className={styles.iconButton} aria-label={ko ? "알림 닫기" : "Dismiss notice"} onClick={() => setNotice("")}><IconClose size={13} /></button></div>}
    {agent.sourceMissingSince && <div className={styles.banner}><IconAlertTriangle size={14} /><span>{ko ? "원본 폴더 연결이 끊어졌어요." : "The source folder is disconnected."}</span></div>}
    {snapshot && !snapshot.writable && <div className={styles.banner}><IconShield size={13} /><span>{ko ? "읽기 전용 에이전트" : "Read-only agent"}</span></div>}
    {snapshot?.activation === "recovery_required" && <div className={styles.banner}><IconAlertTriangle size={13} /><span>{ko ? "파일 복구 필요 · 새 변경 적용 잠김" : "File recovery is required. New changes are locked."}</span><button className={styles.button} disabled={Boolean(busy)} onClick={() => void run("recovery-diff", async () => { const actual = await api().getRecoveryDiff(agent.id); initialReviewAttempted.current = true; setReview(null); setRecovery(actual); setView("changes"); })}>{ko ? "복구 검토" : "Review recovery"}</button></div>}
    <div className={styles.body}>
      <main className={styles.content}>{body()}</main>
    </div>
    {quickOpen && <PopupFrame title={ko ? "파일 찾기" : "Find file"} icon={<IconSearch size={20} />} closeLabel={ko ? "닫기" : "Close"} onClose={() => setQuickOpen(false)} busy={Boolean(busy)}>
      <div className={styles.popupSearch}><IconSearch size={17} /><input autoFocus value={quickQuery} aria-label={ko ? "파일 이름" : "File name"} placeholder={ko ? "이름 또는 경로" : "Name or path"} onChange={(event) => setQuickQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { const first = files.find((file) => file.kind === "file" && file.path.toLowerCase().includes(quickQuery.toLowerCase())); if (first) void openFile(first.path).then((opened) => { if (opened) { setQuickOpen(false); setView("files"); } }); } }} /><kbd>↵</kbd></div>
      <div className={styles.popupFiles}>{files.filter((file) => file.kind === "file" && file.path.toLowerCase().includes(quickQuery.toLowerCase())).map((file) => <button className={styles.popupFile} key={file.path} onClick={() => void openFile(file.path).then((opened) => { if (opened) { setQuickOpen(false); setView("files"); } })}><IconFileText size={18} /><span><strong>{file.path.split("/").at(-1)}</strong><small>{file.path}</small></span></button>)}{!files.some((file) => file.kind === "file" && file.path.toLowerCase().includes(quickQuery.toLowerCase())) && <div className={styles.empty}><IconSearch size={24} />{ko ? "일치하는 파일 없음" : "No matching files"}</div>}</div>
    </PopupFrame>}
    {newPathDialog && <PopupFrame title={ko ? "새 파일 초안" : "New file draft"} icon={<IconPlus size={20} />} closeLabel={ko ? "닫기" : "Close"} onClose={() => setNewPathDialog(false)} busy={Boolean(busy)} footer={<><PopupAction onClick={() => setNewPathDialog(false)} disabled={Boolean(busy)}>{ko ? "취소" : "Cancel"}</PopupAction><PopupAction primary icon={<IconFileText size={16} />} disabled={Boolean(busy) || !validNewPath || !snapshot?.writable || snapshot.activation === "recovery_required"} onClick={() => void openDraft()}>{ko ? "초안 열기" : "Open draft"}</PopupAction></>}>
      <label className={styles.popupPath}>{ko ? "폴더 내 경로" : "Path inside folder"}<input autoFocus value={newPath} placeholder="skills/my-skill/SKILL.md" onChange={(event) => setNewPath(event.target.value)} /></label>
      <PopupSteps steps={[{label: ko ? "초안" : "Draft", icon:<IconFileText size={18} />,active:true},{label: ko ? "변경 검토" : "Review diff",icon:<IconLayers size={18} />},{label: ko ? "승인·저장" : "Approve & save",icon:<IconCheck size={18} />}]} />
      <p className={styles.popupNote}><IconShield size={15} />{ko ? "승인 전 실제 파일은 바뀌지 않아요." : "Actual files change only after approval."}</p>
    </PopupFrame>}
    {renamePathDialog && <PopupFrame title={ko ? "이름 변경 검토" : "Review rename"} icon={<IconFileText size={20} />} closeLabel={ko ? "닫기" : "Close"} onClose={() => setRenamePathDialog(false)} busy={Boolean(busy)} footer={<><PopupAction disabled={Boolean(busy)} onClick={() => setRenamePathDialog(false)}>{ko ? "취소" : "Cancel"}</PopupAction><PopupAction primary icon={busy ? <span className={styles.loading} /> : <IconLayers size={16} />} disabled={Boolean(busy) || !validNewPath || newPath.trim() === path || !snapshot?.writable || snapshot.activation === "recovery_required"} onClick={() => void run("prepare-rename", async () => { if (!validNewPath || !await mayLeaveFile()) return; const proposal = await api().prepareFileOperation({ agentId: agent.id, operation: "rename", path, newPath: newPath.trim() }); setRenamePathDialog(false); setContent(fileRead?.content ?? ""); await refresh(); await openReview(proposal.id); })}>{ko ? "변경 검토" : "Review change"}</PopupAction></>}>
      <PopupFacts items={[{label:ko ? "현재 파일" : "Current file",value:<code>{path}</code>,icon:<IconFileText size={17} />}]}/>
      <label className={styles.popupPath}>{ko ? "새 경로" : "New path"}<input autoFocus value={newPath} placeholder="skills/my-skill/SKILL.md" onChange={(event) => setNewPath(event.target.value)} /></label>
      <p className={styles.popupNote}><IconShield size={15} />{ko ? "승인 후 이름이 변경돼요." : "Review the proposal first. Rename happens after approval."}</p>
    </PopupFrame>}
    {memoryImportPreview && <AgentMemoryImportDialog preview={memoryImportPreview} agentId={agent.id} locale={locale} onClose={() => setMemoryImportPreview(null)} onImported={async (count, remainingFiles) => { await refresh(); void memory.reload(); setNotice(ko ? `메모리 ${count}건을 가져왔습니다.${remainingFiles > 0 ? ` 파일 ${remainingFiles}개가 남아 있어 다시 가져오면 이어집니다.` : ""}` : `Imported ${count} memories.${remainingFiles > 0 ? ` ${remainingFiles} more files remain; import again to continue.` : ""}`); }} />}
    {editOpen && <AgentEditDialog agentId={agent.id} name={name} ko={ko} onRename={onRename} onClose={() => setEditOpen(false)} onSaved={() => setNotice(ko ? "저장했어요." : "Saved.")} />}
    {forgetEntries && <ForgetDialog ko={ko} agentName={name} entries={forgetEntries} total={forgetAll ? memory.result?.total : undefined} busy={forgetBusy} failed={forgetFailed} onCancel={() => { setForgetEntries(null); setForgetAll(false); }} onConfirm={() => void confirmForget()} />}
  </section>;
}


function LearningCardView({ card, ko }: { card: AgentWorkspaceLearningCard; ko: boolean }) {
  const rows: Array<[string, string]> = [
    [ko ? "언제" : "When", card.situation], [ko ? "있었던 일" : "What happened", card.observed],
    [ko ? "지금은" : "Today", card.before], [ko ? "반영하면" : "With this change", card.after], [ko ? "적용하지 않을 때" : "Does not apply", card.limits],
  ];
  return <dl className={styles.learningCard}>{rows.map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl>;
}
/** What each changed file is, in a line, so the owner knows what the diff below contains before reading it. */
function changeLine(change: AgentWorkspaceChangeSummary, ko: boolean): string {
  const size = ko ? `+${change.addedLines}줄 −${change.removedLines}줄` : `+${change.addedLines} −${change.removedLines} lines`;
  if (change.skill) {
    const what = change.operation === "create" ? (ko ? "새 스킬" : "New skill") : (ko ? "스킬 수정" : "Skill edited");
    return `${what} “${change.skill.name}” — ${change.skill.description}`;
  }
  if (change.operation === "create") return ko ? `새 파일 ${change.path} (${size})` : `New file ${change.path} (${size})`;
  if (change.operation === "delete") return ko ? `파일 삭제 ${change.path}` : `Deleted ${change.path}`;
  return ko ? `${change.path} 수정 (${size})` : `${change.path} edited (${size})`;
}
function ChangeSummaryView({ changes, ko }: { changes: AgentWorkspaceChangeSummary[] | undefined; ko: boolean }) {
  if (!changes?.length) return null;
  return <div className={styles.changeSummary}><h3>{ko ? "변경 내용" : "What changes"}</h3><ul>{changes.map((change) => <li key={change.path}><code>{change.path}</code> · {changeLine(change, ko)}</li>)}</ul></div>;
}
/** Side-by-side numbers for the revision a change replaced and the one it produced. No verdict: the owner judges. */
function OutcomeComparison({ before, after, ko }: { before?: AgentWorkspaceRevisionOutcome; after?: AgentWorkspaceRevisionOutcome; ko: boolean }) {
  if (!before?.runs || !after?.runs) return <div className={styles.banner}>{ko ? "반영 전후를 비교할 실행 기록이 아직 없어요." : "There are no runs to compare yet. Once runs accumulate after the change, they are compared here."}</div>;
  const per = (outcome: AgentWorkspaceRevisionOutcome, value: number) => (value / outcome.runs).toFixed(2);
  const rows: Array<[string, (o: AgentWorkspaceRevisionOutcome) => string]> = [
    [ko ? "실행" : "Runs", (o) => String(o.runs)], [ko ? "실패" : "Failed", (o) => `${o.failed} (${per(o, o.failed)}${ko ? "/회" : "/run"})`],
    [ko ? "도구 오류" : "Tool errors", (o) => `${o.errors} (${per(o, o.errors)}${ko ? "/회" : "/run"})`], [ko ? "중간 정정" : "Mid-run corrections", (o) => `${o.steering} (${per(o, o.steering)}${ko ? "/회" : "/run"})`],
  ];
  return <table className={styles.outcomeTable}><thead><tr><th /><th>{ko ? "반영 전" : "Before"}</th><th>{ko ? "반영 후" : "After"}</th></tr></thead>
    <tbody>{rows.map(([label, cell]) => <tr key={label}><th>{label}</th><td>{cell(before)}</td><td>{cell(after)}</td></tr>)}</tbody></table>;
}
function alwaysOnSentence(change: AgentWorkspaceProposal["alwaysOn"], ko: boolean): string | null {
  if (!change) return null;
  const delta = change.after.bytes - change.before.bytes, sign = delta > 0 ? "+" : "";
  const head = ko ? `매번 읽히는 지침(${change.path}) ${change.before.lines}줄 → ${change.after.lines}줄, ${sign}${delta}바이트` : `Always-on instructions (${change.path}) ${change.before.lines} → ${change.after.lines} lines, ${sign}${delta} bytes`;
  const warn = change.overHard ? (ko ? ` · 일부 실행기가 읽는 한도(${change.hardBytes}바이트)를 넘습니다` : ` · over the ${change.hardBytes}-byte limit some runtimes read`)
    : change.overSoft ? (ko ? ` · 권장 ${change.softLines}줄을 넘습니다` : ` · over the recommended ${change.softLines} lines`) : "";
  return head + warn;
}