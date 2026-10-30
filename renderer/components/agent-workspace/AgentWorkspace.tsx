"use client";

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import {
  IconAlertTriangle, IconBrain, IconCheck, IconChevronDown, IconChevronRight, IconClock, IconClose,
  IconFileText, IconFileUp, IconFolder, IconCloud, IconLayers, IconMonitor, IconMoreHorizontal, IconPlus, IconRefresh, IconSearch,
  IconSettings, IconShield, IconSidebar, IconTrash,
} from "@/components/Icon";
import { AgentAvatar } from "@/components/AgentAvatar";
import { ipc } from "@/lib/ipc";
import { agentWorkspaceFailure } from "@/lib/agent-workspace-error";
import type { AgentRuntimeOverride, InstalledAgent, InstalledAgentExactBinding, InstalledFirm, MemoryImportPreviewUi, ResolvedOrg, RuntimeStatus } from "@shared/types";
import type {
  AgentWorkspaceComparison, AgentWorkspaceDiff as WorkspaceDiff, AgentWorkspaceChangeSummary, AgentWorkspaceFile, AgentWorkspaceLearningCard, AgentWorkspaceMemoryCandidate, AgentWorkspaceRevisionOutcome,
  AgentWorkspaceExperience, AgentWorkspaceOutcomeCounts, AgentWorkspaceRevision, AgentWorkspaceWorkKind, AgentWorkspaceProposal, AgentWorkspaceReadFile, AgentWorkspaceRecovery, AgentWorkspaceSnapshot,
} from "@shared/agent-workspace";
import { AgentWorkspaceDiff } from "./AgentWorkspaceDiff";
import { AgentWorkspaceInspector } from "./AgentWorkspaceInspector";
import { AgentWorkspaceRecoveryReview } from "./AgentWorkspaceRecoveryReview";
import { AgentMemoryImportDialog } from "./AgentMemoryImportDialog";
import { PopupAction, PopupFacts, PopupFrame, PopupSteps } from "@/components/Popup";
import { confirmPopup } from "@/lib/popup";
import { isTechnicalEvidence, memoryKindLabel, plainMemoryText, plainMemoryTitle } from "@/lib/agent-memory-explain";
import styles from "./AgentWorkspace.module.css";
import { Select } from "@/components/Select";
import { shortcutLabel, useUiPlatform } from "@/lib/platform-copy";

export type AgentWorkspaceView = "files" | "memory" | "changes" | "sync" | "history";

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
    cloud_not_linked: ["이 에이전트를 Cloud에 먼저 저장하세요.", "Save this agent to Cloud first."],
    hub_not_linked: ["연결된 Hub 릴리스가 없습니다.", "No Hub release is connected."],
    remote_unavailable: ["원격 상태를 확인하지 못했습니다. 연결을 확인한 뒤 다시 조회하세요.", "Remote state could not be checked. Verify the connection and refresh."],
    common_ancestor_unverified: ["공통 변경 이력을 확인하지 못했습니다. 파일 차이를 검토하세요.", "A shared history is unverified. Review the file differences."],
    public_source_subset: ["Hub가 공개한 파일만 비교했습니다. 나머지 파일은 비교할 수 없습니다.", "Only source files shared by Hub are compared. Other files remain unknown."],
    verified_sync_base: ["확인된 동기화 기준과 비교했습니다.", "Compared with the verified sync baseline."],
    same_tree_different_history: ["파일 내용은 같고 변경 이력은 다릅니다.", "File contents match; revision histories differ."],
    reviewed_public_projection: ["공개용 파일 사본을 검토합니다.", "Review the public file copy."],
    public_projection_current: ["현재 공개용 파일 사본과 같습니다.", "The public file copy is current."],
    public_release_verified: ["공개 릴리스의 실제 파일을 확인했습니다.", "The published release files were verified."],
    cloud_publish_base_required: ["지금 로컬 버전을 Cloud에 먼저 저장한 뒤 Hub 공개를 검토하세요.", "Save the current local version to Cloud before reviewing Hub publication."],
    source_not_licensed: ["게시자가 소스 공유를 허용하지 않았습니다. Hub 원본의 소스 공개 여부를 확인하세요.", "The publisher has not shared source files. Check source availability on the Hub release."],
    publisher_required: ["이 Hub 릴리스의 게시 권한이 없습니다. 게시 권한이 있는 에이전트를 선택하세요.", "You do not have publishing rights for this Hub release. Choose an agent you can publish."],
    sign_in_required: ["Agentlas에 로그인한 뒤 원격 상태를 다시 조회하세요.", "Sign in to Agentlas, then refresh the remote state."],
    sync_outcome_pending: ["이전 동기화가 끝났는지 아직 알 수 없습니다. 원격 상태를 먼저 다시 조회하세요.", "The previous sync outcome is unconfirmed. Refresh remote state first."],
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

const REVISION_OPERATION_KO: Record<string, string> = { baseline: "처음 상태", external_edit: "직접 수정", apply: "변경 적용", sync: "동기화", rollback: "되돌림" };
const REVISION_OPERATION_EN: Record<string, string> = { baseline: "Initial state", external_edit: "Edited outside", apply: "Change applied", sync: "Synced", rollback: "Rolled back" };
function revisionOperationLabel(operation: string, ko: boolean): string { return (ko ? REVISION_OPERATION_KO : REVISION_OPERATION_EN)[operation] ?? ""; }
export function AgentWorkspace({ agent, name, locale, initialView = "files", onToggleRoster, projectControl,
  firm, org, binding, runtimes, overrides, onRename, onRemove, onOverridesChange, onDirtyChange, onMemoryCountChange,
}: {
  agent: InstalledAgent; name: string; locale: string; initialView?: AgentWorkspaceView;
  onToggleRoster: () => void; projectControl?: ReactNode; firm?: InstalledFirm | null; org?: ResolvedOrg | null;
  binding?: InstalledAgentExactBinding | null; runtimes: RuntimeStatus[]; overrides: AgentRuntimeOverride[];
  onRename: (value: string) => Promise<void>; onRemove: () => Promise<void>; onOverridesChange: (overrides: AgentRuntimeOverride[]) => void;
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
  const [inspector, setInspector] = useState(false);
  const [treeWidth, setTreeWidth] = useState(210);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState("");
  const [newPathDialog, setNewPathDialog] = useState(false);
  const [newPath, setNewPath] = useState("");
  const [renamePathDialog, setRenamePathDialog] = useState(false);
  const [fileMenu, setFileMenu] = useState(false);
  const [memoryQuery, setMemoryQuery] = useState("");
  const [memoryState, setMemoryState] = useState("all");
  const [memorySelection, setMemorySelection] = useState(new Set<string>());
  const [memoryId, setMemoryId] = useState("");
  const [openGroups, setOpenGroups] = useState(new Set<string>());
  const [memoryImportPreview, setMemoryImportPreview] = useState<MemoryImportPreviewUi | null>(null);
  const [targetPath, setTargetPath] = useState("");
  const [review, setReview] = useState<WorkspaceDiff | null>(null);
  const [reviewLoading, setReviewLoading] = useState(false);
  const [reviewPath, setReviewPath] = useState<string | null>(null);
  const [recovery, setRecovery] = useState<AgentWorkspaceRecovery | null>(null);
  const [syncTarget, setSyncTarget] = useState<"cloud" | "hub">("cloud");
  const [syncDirection, setSyncDirection] = useState<"receive" | "send">("receive");
  const [comparison, setComparison] = useState<AgentWorkspaceComparison | null>(null);
  const [compareLoading, setCompareLoading] = useState(false);
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
    if (!bridge) throw new Error(ko ? "Agent Workspace 브리지를 사용할 수 없습니다. 앱을 업데이트한 뒤 다시 열어 주세요." : "Agent Workspace bridge is unavailable. Update and reopen the app.");
    return bridge;
  };
  const refresh = useCallback(async () => {
    const generation = ++workspaceGeneration.current;
    const bridge = ipc()?.agentWorkspace;
    if (!bridge) throw new Error(ko ? "Agent Workspace 브리지를 사용할 수 없습니다." : "Agent Workspace bridge is unavailable.");
    const next = await bridge.getWorkspace(agent.id);
    if (workspaceGeneration.current !== generation) return next;
    setSnapshot(next); setFiles(next.files);
    onMemoryCountChange?.(agent.id, next.memoryCandidates.filter(candidate => candidate.state === "eligible").length);
    setMemorySelection((previous) => new Set([...previous].filter((id) => next.memoryCandidates.some((candidate) => candidate.id === id && candidate.state === "eligible"))));
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
      if (event.key === "\\") { event.preventDefault(); setInspector((current) => !current); }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [view, quickOpen, newPathDialog, renamePathDialog, memoryImportPreview]);
  const compare = useCallback(async () => {
    const generation = ++comparisonGeneration.current;
    setCompareLoading(true); setComparison(null);
    try {
      const bridge = ipc()?.agentWorkspace;
      if (!bridge) throw new Error(ko ? "브리지를 사용할 수 없습니다." : "Bridge unavailable.");
      const result = await bridge.compare({ agentId: agent.id, target: syncTarget, direction: syncDirection });
      if (comparisonGeneration.current === generation) setComparison(result);
    } catch (failure) { if (comparisonGeneration.current === generation) setError(agentWorkspaceFailure(failure, ko)); }
    finally { if (comparisonGeneration.current === generation) setCompareLoading(false); }
  }, [agent.id, syncTarget, syncDirection, ko]);
  useEffect(() => { if (view === "sync") void compare(); }, [view, compare]);
  const verifyApplied = async (proposal: AgentWorkspaceProposal) => {
    const next = await refresh();
    if (proposal.status !== "applied") { await openReview(proposal.id); return; }
    if (next.treeDigest !== proposal.proposedTreeDigest) throw new Error(ko ? "적용 후 파일 트리가 다시 변경되었습니다. 현재 파일을 새로 검토하세요." : "The file tree changed after apply. Review the current files again.");
    for (const change of proposal.changes) {
      if (change.operation === "delete") {
        if (next.files.some((file) => file.path === change.path)) throw new Error(ko ? "삭제 후 파일 확인이 일치하지 않습니다." : "Deleted-file verification does not match.");
      } else {
        const readback = await api().readFile(agent.id, change.path);
        if (readback.blobHash !== change.afterHash) throw new Error(ko ? "적용 후 파일 해시가 검토한 변경과 일치하지 않습니다." : "The applied file hash differs from the reviewed change.");
      }
    }
    setReview({ ...proposal, reviewedHash: proposal.proposalDigest });
    if (path && proposal.changes.some((change) => change.path === path && change.operation !== "delete")) await openFile(path, true);
    else if (proposal.changes.some((change) => change.path === path && change.operation === "delete")) { setPath(""); setFileRead(null); setContent(""); }
    setNotice(ko ? "실제 파일 확인 완료 · 다음 실행부터 적용" : "Actual files verified · Used from the next run");
  };
  const approve = () => run("apply", async () => {
    if (!review?.reviewToken || review.status !== "review_ready") return;
    const result = await api().approveAndApply({ proposalId: review.id, reviewedHash: review.reviewedHash, reviewToken: review.reviewToken });
    await verifyApplied(result);
  });
  const memoryCandidates = useMemo(() => (snapshot?.memoryCandidates ?? []).filter((candidate) => {
    return (memoryState === "all" || candidate.state === memoryState) && (!memoryQuery.trim() || [candidate.title, candidate.content, candidate.contentNative ?? ""].some((text) => text.toLocaleLowerCase().includes(memoryQuery.trim().toLocaleLowerCase())));
  }), [snapshot?.memoryCandidates, memoryState, memoryQuery]);
  // Near-duplicate learnings arrive with a shared groupId from the service; the list shows one lesson per group.
  const memoryGroups = useMemo(() => {
    const groups = new Map<string, AgentWorkspaceMemoryCandidate[]>();
    for (const candidate of memoryCandidates) { const key = candidate.groupId ?? candidate.id; groups.set(key, [...(groups.get(key) ?? []), candidate]); }
    return [...groups.values()];
  }, [memoryCandidates]);
  const selectedMemory = snapshot?.memoryCandidates.find((candidate) => candidate.id === memoryId) ?? memoryCandidates[0];
  const selectedGroup = selectedMemory ? (snapshot?.memoryCandidates ?? []).filter((candidate) => (candidate.groupId ?? candidate.id) === (selectedMemory.groupId ?? selectedMemory.id)) : [];
  const rows = useMemo(() => treeEntries(files, expanded), [files, expanded]);
  const lineCount = Math.max(1, content.split("\n").length);
  const instructionFiles = files.filter((file) => file.kind === "file" && ["instruction", "skill", "knowledge"].includes(file.role));
  // The footer prepares a change from lessons that are "Ready for review". With none (or on an agent that cannot be written) its button could never be pressed.
  const canPrepare = Boolean(snapshot?.writable);
  const showPrepare = canPrepare && (snapshot?.memoryCandidates ?? []).some((candidate) => candidate.state === "eligible");
  // The entry file unless the owner picked another; the picker only appears when there is another file to pick.
  const prepareTarget = instructionFiles.some((file) => file.path === targetPath) ? targetPath : snapshot?.canonicalEntry ?? instructionFiles[0]?.path ?? "";
  const pendingCount = snapshot?.proposals.filter((proposal) => proposal.status === "review_ready").length ?? 0;
  const eligibleCount = new Set((snapshot?.memoryCandidates ?? []).filter((candidate) => candidate.state === "eligible" || candidate.state === "proposed").map((candidate) => candidate.groupId ?? candidate.id)).size;
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
  const renderMemory = () => <>
    <aside className={styles.listPane}>
      <div className={styles.paneHeader}><IconBrain size={14} /><strong>{ko ? "배운 것" : "Learned"}</strong><span title={ko ? `기록 ${snapshot?.memoryCandidates.length ?? 0}건` : `${snapshot?.memoryCandidates.length ?? 0} records`}>{new Set((snapshot?.memoryCandidates ?? []).map((candidate) => candidate.groupId ?? candidate.id)).size}</span><button className={styles.iconButton} disabled={Boolean(busy)} aria-label={ko ? "기존 메모리 가져오기" : "Import existing memory"} title={ko ? "기존 메모리 가져오기" : "Import existing memory"} onClick={() => void run("memory-import-preview", async () => { const memory = ipc()?.agentMemory; if (!memory) throw new Error(ko ? "메모리 브리지를 사용할 수 없습니다." : "Memory bridge unavailable."); setMemoryImportPreview(await memory.importPreview(agent.id)); })}><IconFileUp size={13} /></button></div>
      <div className={styles.search}><IconSearch size={13} /><input aria-label={ko ? "메모리 검색" : "Search memories"} placeholder={ko ? "메모리 검색" : "Search memories"} value={memoryQuery} onChange={(event) => setMemoryQuery(event.target.value)} /></div>
      <div className={styles.rosterFilters}><Select aria-label={ko ? "반영 상태" : "Status"} value={memoryState} onChange={(event) => setMemoryState(event.target.value)} className={styles.button}><option value="all">{ko ? "전체" : "All"}</option>{["eligible", "watching", "scope_review", "needs_evidence", "proposed", "applied"].map((state) => <option value={state} key={state}>{stateLabel(state, ko)}</option>)}</Select></div>
      <div className={styles.listRows}>
        {memoryGroups.map((group) => { const lead = group[0], key = lead.groupId ?? lead.id, eligible = group.filter((member) => member.state === "eligible"), open = openGroups.has(key);
          const picked = eligible.length > 0 && eligible.every((member) => memorySelection.has(member.id));
          return <div key={key}>
            <div className={styles.checkRow}>
              <input type="checkbox" aria-label={`${ko ? "지침에 반영할 학습 선택" : "Select learning to add"}: ${plainMemoryTitle(lead.contentNative || lead.content || lead.title, ko)}`} checked={picked} disabled={!eligible.length || !snapshot?.writable || Boolean(busy)} onChange={(event) => setMemorySelection((previous) => { const next = new Set(previous); for (const member of eligible) { if (event.target.checked) next.add(member.id); else next.delete(member.id); } return next; })} />
              <button className={`${styles.listItem} ${group.some((member) => member.id === selectedMemory?.id) ? styles.selected : ""}`} onClick={() => setMemoryId(lead.id)}><span className={styles.listItemTitle}><span>{plainMemoryTitle(lead.contentNative || lead.content || lead.title, ko)}</span></span><span className={styles.listItemSub}><State value={lead.state} ko={ko} /><span>{memoryKindLabel(lead.kind, ko)}</span>{group.length > 1 && <span className={styles.groupCount}>{ko ? `비슷한 기록 ${group.length}건` : `${group.length} similar records`}</span>}</span></button>
              {group.length > 1 && <button className={styles.iconButton} aria-expanded={open} aria-label={ko ? "묶인 기록 보기" : "Show grouped records"} title={ko ? "묶인 기록 보기" : "Show grouped records"} onClick={() => setOpenGroups((previous) => { const next = new Set(previous); if (next.has(key)) next.delete(key); else next.add(key); return next; })}>{open ? <IconChevronDown size={13} /> : <IconChevronRight size={13} />}</button>}
            </div>
            {open && group.slice(1).map((member) => <button key={member.id} className={`${styles.listItem} ${styles.groupMember} ${selectedMemory?.id === member.id ? styles.selected : ""}`} onClick={() => setMemoryId(member.id)}><span className={styles.listItemTitle}><span>{plainMemoryTitle(member.contentNative || member.content || member.title, ko)}</span></span><span className={styles.listItemSub}><State value={member.state} ko={ko} /></span></button>)}
          </div>; })}
        {!memoryCandidates.length && <div className={styles.empty}>{ko ? "메모리 없음" : "No memories"}</div>}
      </div>
      {showPrepare && <div className={styles.footerActions}>
        {instructionFiles.length > 1 && <Select value={prepareTarget} aria-label={ko ? "반영할 파일" : "File to update"} onChange={(event) => setTargetPath(event.target.value)}>{instructionFiles.map((file) => <option value={file.path} key={file.path}>{file.path}</option>)}</Select>}
        <button className={`${styles.button} ${styles.primary}`} disabled={!memorySelection.size || !snapshot?.writable || Boolean(busy) || snapshot.activation === "recovery_required"} onClick={() => void run("prepare-memory", async () => { let proposal; try { proposal = await api().prepareFromMemory({ agentId: agent.id, memoryEntryIds: [...memorySelection], ...(prepareTarget ? { targetPath: prepareTarget } : {}) }); } catch (failure) { setMemorySelection(new Set()); await refresh().catch(() => undefined); throw failure; } await refresh(); setMemorySelection(new Set()); await openReview(proposal.id); })}>{busy === "prepare-memory" && <span className={styles.loading} />}{ko ? `변경안 만들기${memorySelection.size ? ` (${memorySelection.size})` : ""}` : `Prepare change${memorySelection.size ? ` (${memorySelection.size})` : ""}`}</button>
      </div>}
    </aside>
    {selectedMemory ? <MemoryDetail candidate={selectedMemory} group={selectedGroup} locale={locale} agentName={name} agentRole={agent.tagline} canPrepare={canPrepare} proposal={(snapshot?.proposals ?? []).find((proposal) => proposal.memoryEntryIds.includes(selectedMemory.id))} onOpenProposal={(id) => void openReview(id)} /> : <div className={styles.empty}><IconBrain size={35} /><strong>{ko ? "에이전트가 일하며 배운 내용이 여기에 쌓입니다" : "What the agent learns while working collects here"}</strong></div>}
  </>;
  const renderChanges = () => <>
    <aside className={styles.listPane}><div className={styles.paneHeader}><IconLayers size={14} /><strong>{ko ? "변경" : "Changes"}</strong><span>{snapshot?.proposals.length ?? 0}</span></div><div className={styles.listRows}>
      {(snapshot?.proposals ?? []).map((proposal) => <div className={styles.checkRow} key={proposal.id}><button className={`${styles.listItem} ${review?.id === proposal.id ? styles.selected : ""}`} onClick={() => void openReview(proposal.id)}><span className={styles.listItemTitle}><span>{proposal.summary}</span></span><span className={styles.listItemSub}><State value={proposal.status} ko={ko} /><span>{proposal.changes.length}{ko ? "개 파일" : " files"}</span></span><span className={styles.listItemSub}>{timeLabel(proposal.createdAt, locale)}</span></button>{["review_ready", "stale"].includes(proposal.status) && <button className={styles.iconButton} style={{ marginTop: 8 }} title={ko ? "변경안 거절" : "Reject proposal"} aria-label={`${ko ? "변경안 거절" : "Reject proposal"}: ${proposal.summary}`} disabled={Boolean(busy)} onClick={() => void run("reject", async () => { const result = await api().reject({ proposalId: proposal.id }); if (review?.id === proposal.id) setReview({ ...result, reviewedHash: result.proposalDigest }); await refresh(); })}><IconClose size={13} /></button>}</div>)}
      {!snapshot?.proposals.length && <div className={styles.empty}>{ko ? "변경안 없음" : "No proposals"}</div>}
    </div></aside>
    <div className={styles.reviewPane}>{reviewLoading ? <div className={styles.empty}><span className={styles.loading} />{ko ? "변경 파일 확인 중" : "Reading proposed files"}</div> : review ? <>
      <div className={styles.reviewSummary}><IconLayers size={16} /><div><strong>{review.summary}</strong><div className={styles.meta}><State value={review.status} ko={ko} /><span>{review.changes.length}{ko ? "개 파일" : " files"}</span></div></div><button className={styles.iconButton} disabled={Boolean(busy)} onClick={() => void openReview(review.id)} title={ko ? "변경 다시 확인" : "Reload diff"} aria-label={ko ? "변경 다시 확인" : "Reload diff"}><IconRefresh size={14} /></button></div>
      {review.lastError && <div className={`${styles.banner} ${styles.error}`}>{review.lastError}</div>}
      {review.status === "stale" && <div className={styles.banner}><span>{ko ? "원본이 바뀌었습니다. 새 원본에서 변경안을 다시 만들어야 합니다." : "The source changed. Prepare a new proposal against the current files."}</span>{review.memoryEntryIds.length > 0 && <button className={styles.button} disabled={Boolean(busy) || dirty} onClick={() => void run("reprepare-memory", async () => { const next = await api().prepareFromMemory({ agentId: agent.id, memoryEntryIds: review.memoryEntryIds }); await refresh(); await openReview(next.id); })}>{ko ? "다시 만들기" : "Prepare again"}</button>}</div>}
      {alwaysOnSentence(review.alwaysOn, ko) && <div className={`${styles.banner} ${review.alwaysOn?.overHard ? styles.error : ""}`}>{alwaysOnSentence(review.alwaysOn, ko)}</div>}
      {review.card && <LearningCardView card={review.card} ko={ko} />}
      <ChangeSummaryView changes={review.changeSummary} ko={ko} />
      {review.status === "applied" && <AppliedRecord revision={snapshot?.history.find((revision) => revision.id === review.appliedRevisionId)} ko={ko} />}
      {review.status === "review_ready" && review.memoryEntryIds.length > 0 && <Baseline revision={snapshot?.history.find((revision) => revision.id === review.baseRevisionId)} ko={ko} />}
      <AgentWorkspaceDiff files={review.changes} locale={locale} activePath={reviewPath} onPathChange={setReviewPath} />
      <div className={styles.reviewFooter}><span>{ko ? "전체 파일 변경 · 다음 실행부터 적용" : "Whole file changes · Used from the next run"}</span>
        {review.status === "review_ready" && <><button className={styles.button} disabled={Boolean(busy)} onClick={() => void run("reject", async () => { const result = await api().reject({ proposalId: review.id }); setReview({ ...result, reviewedHash: result.proposalDigest }); await refresh(); })}>{ko ? "거절" : "Reject"}</button><button className={`${styles.button} ${styles.primary}`} disabled={Boolean(busy) || !snapshot?.writable || !review.reviewToken || dirty || snapshot.activation === "recovery_required"} onClick={() => void approve()}>{busy === "apply" ? <span className={styles.loading} /> : <IconCheck size={13} />}{ko ? "승인·적용" : "Approve and apply"}</button></>}
      </div>
      {dirty && <div className={styles.banner}>{ko ? "파일 초안을 변경안으로 저장하거나 버린 뒤 승인하세요." : "Save or discard your open file draft before approving."}</div>}
    </> : <div className={styles.empty}><IconLayers size={35} /><strong>{ko ? "검토할 변경을 선택하세요" : "Select a change to review"}</strong></div>}</div>
  </>;
  // 해시·리비전 ID 같은 기록은 사람에게 보이지 않고 로그로만 남긴다.
  useEffect(() => {
    if (snapshot) console.info("[agent-workspace] snapshot", { agentId: agent.id, revision: snapshot.currentRevisionId, treeDigest: snapshot.treeDigest });
  }, [agent.id, snapshot?.currentRevisionId, snapshot?.treeDigest]); // eslint-disable-line react-hooks/exhaustive-deps
  const renderSync = () => {
    const canSync = comparison && comparison.agentId === agent.id && comparison.target === syncTarget && comparison.direction === syncDirection && (syncDirection === "send" ? comparison.canSend : comparison.canReceive) && Boolean(comparison.reviewedHash && comparison.reviewToken);
    const diff = syncDirection === "send" ? comparison?.outgoingChanges ?? comparison?.changes.map((change) => ({ ...change, operation: change.operation === "create" ? "delete" as const : change.operation === "delete" ? "create" as const : "modify" as const, beforeContent: change.afterContent, afterContent: change.beforeContent, beforeHash: change.afterHash, afterHash: change.beforeHash, beforeExecutable: change.afterExecutable, afterExecutable: change.beforeExecutable })) ?? [] : comparison?.changes ?? [];
    return <div className={styles.sync}>
      <div className={styles.syncControls}><strong>{ko ? "버전 비교 · 동기화" : "Compare · Sync"}</strong><Select value={syncTarget} aria-label={ko ? "비교 위치" : "Compare target"} onChange={(event) => { setSyncTarget(event.target.value as "cloud" | "hub"); setSyncDirection("receive"); }}><option value="cloud">Cloud</option><option value="hub">Hub</option></Select><Select value={syncDirection} aria-label={ko ? "동기화 방향" : "Sync direction"} onChange={(event) => setSyncDirection(event.target.value as "receive" | "send")}><option value="receive">{ko ? "로컬로 받기" : "Receive locally"}</option><option value="send">{syncTarget === "cloud" ? (ko ? "Cloud에 저장" : "Save to Cloud") : (ko ? "Hub 공개 검토" : "Review Hub publication")}</option></Select><button className={styles.iconButton} disabled={compareLoading || Boolean(busy)} onClick={() => void compare()} title={ko ? "원격 상태 조회" : "Refresh remote state"} aria-label={ko ? "원격 상태 조회" : "Refresh remote state"}><IconRefresh size={15} /></button></div>
      <div className={styles.syncGraph}><div className={styles.syncNode}><IconMonitor size={23} /><span>Local</span></div><div className={styles.syncEdge}>{compareLoading ? <span className={styles.loading} /> : <State value={comparison?.state ?? "unknown"} ko={ko} />}<svg viewBox="0 0 90 15" aria-hidden="true"><path d="M0 7.5H90" /></svg></div><div className={styles.syncNode}>{syncTarget === "hub" ? <IconCloud size={23} /> : <IconLayers size={23} />}<span>{syncTarget === "hub" ? "Hub" : "Cloud"}</span></div></div>
      {comparison?.reason && <div className={styles.banner}><IconAlertTriangle size={13} /><span>{comparisonReason(comparison.reason, ko)}</span>{["cloud_not_linked", "hub_not_linked"].includes(comparison.reason) && <Link className={styles.button} href={firm ? `/cloud?team=${encodeURIComponent(firm.id)}` : `/cloud?agent=${encodeURIComponent(agent.parentTeamId || agent.id)}`}>{syncTarget === "cloud" ? (ko ? "Cloud에 처음 저장…" : "First Cloud save…") : (ko ? "Hub에 처음 게시…" : "First Hub publication…")}</Link>}{comparison.reason === "cloud_publish_base_required" && <button className={styles.button} onClick={() => { setSyncTarget("cloud"); setSyncDirection("send"); }}>{ko ? "Cloud 저장 검토" : "Review Cloud save"}</button>}{comparison.reason === "sign_in_required" && <button className={styles.button} disabled={Boolean(busy)} onClick={() => void run("sign-in", async () => { const bridge = ipc(); if (!bridge) throw new Error(ko ? "로그인 브리지를 사용할 수 없습니다." : "Sign-in bridge unavailable."); await bridge.auth.signInWithGoogle(); await compare(); })}>{ko ? "로그인" : "Sign in"}</button>}{comparison.reason === "sync_outcome_pending" && <button className={styles.button} disabled={compareLoading || Boolean(busy)} onClick={() => void compare()}>{ko ? "원격 상태 다시 확인" : "Recheck remote state"}</button>}</div>}
      {diff.length ? <AgentWorkspaceDiff files={diff} locale={locale} beforeLabel={syncDirection === "send" ? `${syncTarget === "hub" ? "Hub" : "Cloud"} · ${ko ? "현재" : "Current"}` : `Local · ${ko ? "현재" : "Current"}`} afterLabel={syncDirection === "send" ? (ko ? "전송 후" : "After transfer") : (ko ? "로컬 적용 후" : "After local apply")} /> : <div className={styles.empty}>{compareLoading ? (ko ? "원격 파일 비교 중" : "Comparing remote files") : stateLabel(comparison?.state ?? "unknown", ko)}</div>}
      <div className={styles.reviewFooter}><span>{syncTarget === "hub" && syncDirection === "send" ? (ko ? "검토한 공개용 파일만 게시합니다." : "Publish only the reviewed public files.") : (ko ? "검토한 파일만 동기화합니다." : "Sync only the reviewed files.")}</span>{comparison?.proposalId && <button className={styles.button} onClick={() => void openReview(comparison.proposalId!)}>{ko ? "변경안 검토" : "Review proposal"}</button>}<button className={`${styles.button} ${styles.primary}`} disabled={!canSync || Boolean(busy) || dirty || (syncDirection === "receive" && !snapshot?.writable) || snapshot?.activation === "recovery_required"} onClick={() => void run("sync", async () => {
        if (!comparison?.reviewToken || !comparison.reviewedHash) return;
        const result = await api().sync({ agentId: agent.id, target: syncTarget, direction: syncDirection, reviewedHash: comparison.reviewedHash, reviewToken: comparison.reviewToken });
        if ("status" in result) await verifyApplied(result);
        else { await refresh(); setComparison(result); if (result.state === "in_sync" || result.state === "content_equal") setNotice(ko ? "원격 파일 확인 완료" : "Remote files verified"); }
        await compare();
      })}>{busy === "sync" && <span className={styles.loading} />}{syncDirection === "send" ? syncTarget === "hub" ? (ko ? "승인·Hub 공개" : "Approve · Publish to Hub") : (ko ? "승인·Cloud 저장" : "Approve · Save to Cloud") : (ko ? "승인·로컬 적용" : "Approve · Apply locally")}</button></div>
      {dirty && <div className={styles.banner}>{ko ? "열린 파일 초안을 먼저 변경안으로 저장하세요." : "Save the open file draft as a proposal first."}</div>}
    </div>;
  };
  const renderHistory = () => {
    const history = [...(snapshot?.history ?? [])].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return <div className={styles.history}><div className={styles.paneHeader}><IconClock size={14} /><strong>{ko ? "파일 변경 이력" : "File revision history"}</strong><span>{history.length}</span></div>{history.map((revision, index) => {
      const linked = revision.parentRevisionIds.includes(history[index + 1]?.id);
      return <div className={styles.historyRow} key={revision.id}><div className={styles.revisionGraph}><svg viewBox="0 0 25 80" aria-hidden="true">{linked && <path d="M12.5 14V80" />}<circle cx="12.5" cy="14" r="4" /></svg></div><div className={styles.revisionBody}><div className={styles.revisionTitle}><strong>{revision.summary}</strong>{snapshot?.currentRevisionId === revision.id && <span className={styles.state}>HEAD</span>}{revision.proposalId && <button className={styles.button} onClick={() => void openReview(revision.proposalId!)}>{ko ? "변경 보기" : "View change"}</button>}{snapshot?.currentRevisionId !== revision.id && <button className={styles.button} disabled={Boolean(busy) || dirty || !snapshot?.writable} onClick={() => void run("prepare-rollback", async () => { const proposal = await api().prepareRollback({ agentId: agent.id, revisionId: revision.id }); await refresh(); await openReview(proposal.id); })}>{ko ? "되돌리기 검토" : "Review rollback"}</button>}</div><div className={styles.meta}><span>{revisionOperationLabel(revision.operation, ko)}</span><span>{timeLabel(revision.createdAt, locale)}</span></div>{outcomeSentence(revision.outcome, ko) && <div className={styles.meta}><span>{outcomeSentence(revision.outcome, ko)}</span></div>}</div></div>;
    })}{!history.length && <div className={styles.empty}>{ko ? "파일 이력 없음" : "No file revisions"}</div>}</div>;
  };
  const navigation: Array<{ key: AgentWorkspaceView; label: string; icon: ReactNode; count?: number }> = [
    { key: "files", label: ko ? "파일" : "Files", icon: <IconFolder size={21} /> },
    { key: "memory", label: ko ? "메모리" : "Memory", icon: <IconBrain size={21} />, count: eligibleCount },
    { key: "changes", label: ko ? "변경" : "Changes", icon: <IconLayers size={21} />, count: pendingCount },
    { key: "sync", label: ko ? "동기화" : "Sync", icon: <IconRefresh size={21} /> },
    { key: "history", label: ko ? "이력" : "History", icon: <IconClock size={21} /> },
  ];
  return <section ref={root} className={styles.workspace} aria-label={`${name} Agent Workspace`} data-testid="agent-workspace" style={{ "--workspace-tree-width": `${treeWidth}px` } as CSSProperties}>
    <header className={styles.toolbar}>
      <button className={styles.iconButton} aria-label={ko ? "에이전트 목록 접기/펴기" : "Toggle agent roster"} title={ko ? "에이전트 목록" : "Agent roster"} onClick={onToggleRoster}><IconSidebar size={17} /></button>
      <div className={styles.agentTitle}><AgentAvatar name={name} size={25} /><strong>{name}</strong>{agent.sourceMissingSince && <IconAlertTriangle size={13} />}</div>
      <div className={styles.locations}><button className={`${styles.location} ${snapshot ? styles.locationConnected : ""}`} title={ko ? "이 설치의 로컬 파일" : "Local files for this installation"} onClick={() => setView("files")}><IconMonitor size={12} />Local</button>{snapshot?.cloudId && <button className={`${styles.location} ${styles.locationConnected}`} title={ko ? "연결된 Cloud 버전 비교" : "Compare the linked Cloud version"} onClick={() => { setSyncTarget("cloud"); setView("sync"); }}><IconLayers size={12} />Cloud</button>}{snapshot?.hubRef && <button className={`${styles.location} ${styles.locationConnected}`} title={ko ? "연결된 Hub 릴리스 비교" : "Compare the linked Hub release"} onClick={() => { setSyncTarget("hub"); setSyncDirection("receive"); setView("sync"); }}><IconCloud size={12} />Hub</button>}</div>
      {projectControl}<button className={styles.iconButton} disabled={loading || Boolean(busy)} aria-label={ko ? "파일 새로고침" : "Refresh workspace"} title={ko ? "파일 새로고침" : "Refresh workspace"} onClick={() => void run("refresh", async () => { await refresh(); if (path && !dirty) await openFile(path, true); })}><IconRefresh size={15} /></button><button className={`${styles.iconButton} ${inspector ? styles.selected : ""}`} onClick={() => setInspector((current) => !current)} title={ko ? "속성" : "Inspector"} aria-label={ko ? "속성" : "Inspector"} aria-pressed={inspector}><IconSettings size={17} /></button>
    </header>
    {error && <div className={`${styles.banner} ${styles.error}`} role="alert"><IconAlertTriangle size={14} /><span>{error}</span><button className={styles.iconButton} aria-label={ko ? "오류 닫기" : "Dismiss error"} onClick={() => setError("")}><IconClose size={13} /></button></div>}
    {notice && <div className={`${styles.banner} ${styles.notice}`} role="status"><IconCheck size={14} /><span>{notice}</span><button className={styles.iconButton} aria-label={ko ? "알림 닫기" : "Dismiss notice"} onClick={() => setNotice("")}><IconClose size={13} /></button></div>}
    {agent.sourceMissingSince && <div className={styles.banner}><IconAlertTriangle size={14} /><span>{ko ? "원본 폴더 연결이 끊어졌습니다." : "The source folder is disconnected."}</span></div>}
    {snapshot && !snapshot.writable && <div className={styles.banner}><IconShield size={13} /><span>{ko ? "읽기 전용 에이전트" : "Read-only agent"}</span></div>}
    {snapshot?.activation === "recovery_required" && <div className={styles.banner}><IconAlertTriangle size={13} /><span>{ko ? "파일 복구가 필요합니다. 새 변경 적용이 잠겨 있습니다." : "File recovery is required. New changes are locked."}</span><button className={styles.button} disabled={Boolean(busy)} onClick={() => void run("recovery-diff", async () => { const actual = await api().getRecoveryDiff(agent.id); initialReviewAttempted.current = true; setReview(null); setRecovery(actual); setView("changes"); })}>{ko ? "복구 검토" : "Review recovery"}</button></div>}
    <div className={styles.body}>
      <nav className={styles.rail} aria-label={ko ? "워크스페이스 도구" : "Workspace tools"}>{navigation.map((item) => <button className={`${styles.railButton} ${view === item.key ? styles.railActive : ""}`} key={item.key} title={item.label} aria-label={item.label} aria-pressed={view === item.key} onClick={() => setView(item.key)}>{item.icon}{Boolean(item.count) && <span className={styles.badge}>{item.count}</span>}</button>)}</nav>
      <main className={styles.content}>
        {loading ? <div className={styles.empty}><span className={styles.loading} />{ko ? "에이전트 파일 읽는 중" : "Reading agent files"}</div> : !snapshot ? <div className={styles.empty}><IconFolder size={35} /><strong>{ko ? "파일을 확인할 수 없습니다" : "Files could not be read"}</strong><button className={styles.button} onClick={() => void run("refresh", async () => { await refresh(); })}>{ko ? "다시 읽기" : "Retry"}</button></div> : view === "files" ? <>
          <aside className={styles.tree}><div className={styles.paneHeader}><strong>{ko ? "파일" : "Files"}</strong><button className={styles.iconButton} title={ko ? `파일 찾기 ${shortcutLabel("P", uiOs)}` : `Find file ${shortcutLabel("P", uiOs)}`} aria-label={ko ? "파일 찾기" : "Find file"} onClick={() => { setQuickOpen(true); setQuickQuery(""); }}><IconSearch size={13} /></button><button className={styles.iconButton} disabled={!snapshot.writable || Boolean(busy) || snapshot.activation === "recovery_required"} title={ko ? "새 파일 초안" : "New file draft"} aria-label={ko ? "새 파일 초안" : "New file draft"} onClick={() => { setNewPathDialog(true); setNewPath(""); }}><IconPlus size={13} /></button></div>
            <div className={styles.treeRows} role="tree" aria-label={ko ? "에이전트 파일 트리" : "Agent file tree"}>
              {rows.map((entry) => <button className={`${styles.treeRow} ${entry.path === path ? styles.selected : ""}`} key={entry.path} role="treeitem" aria-level={entry.depth + 1} aria-selected={entry.path === path} aria-expanded={entry.kind === "directory" ? expanded.has(entry.path) : undefined} style={{ paddingLeft: 8 + entry.depth * 13 }} onClick={() => entry.kind === "directory" ? void toggleDirectory(entry) : void openFile(entry.path)} onKeyDown={(event) => {
                if (event.key === "ArrowRight" && entry.kind === "directory" && !expanded.has(entry.path)) { event.preventDefault(); void toggleDirectory(entry); }
                if (event.key === "ArrowLeft" && entry.kind === "directory" && expanded.has(entry.path)) { event.preventDefault(); void toggleDirectory(entry); }
                if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); const row = event.currentTarget; if (event.key === "ArrowDown") (row.nextElementSibling as HTMLElement | null)?.focus(); else (row.previousElementSibling as HTMLElement | null)?.focus(); }
              }}>{entry.kind === "directory" ? (expanded.has(entry.path) ? <IconChevronDown size={11} /> : <IconChevronRight size={11} />) : <span style={{ width: 11 }} />}{entry.kind === "directory" ? <IconFolder size={13} /> : <IconFileText size={13} />}<span className={styles.treeName}>{entry.name}</span>{entry.role === "instruction" && <span className={styles.treeRole}>rule</span>}</button>)}
              {!rows.length && <div className={styles.empty}>{ko ? "파일 없음" : "No files"}</div>}
            </div>
          </aside><button className={styles.resizeHandle} aria-label={ko ? "파일 트리 너비" : "Resize file tree"} onPointerDown={startResize} onKeyDown={(event) => { if (event.key === "ArrowLeft") setTreeWidth((width) => Math.max(160, width - 10)); if (event.key === "ArrowRight") setTreeWidth((width) => Math.min(300, width + 10)); }} />
          <div className={styles.editor}>{path ? <><div className={styles.fileToolbar}><IconFileText size={14} /><span className={styles.filePath} title={path}>{path}{dirty ? " ●" : ""}</span><span className={styles.fileRole}>{newFile ? (ko ? "새 파일 초안" : "New draft") : files.find((file) => file.path === path)?.role}</span>{!newFile && files.some((file) => file.path === path) && <button className={styles.iconButton} data-agent-file-actions aria-label={ko ? "파일 작업" : "File actions"} title={ko ? "파일 작업" : "File actions"} aria-expanded={fileMenu} disabled={Boolean(busy) || !snapshot.writable || snapshot.activation === "recovery_required"} onClick={() => setFileMenu((current) => !current)}><IconMoreHorizontal size={16} /></button>}<button className={`${styles.button} ${styles.primary}`} disabled={!dirty || Boolean(busy) || !snapshot.writable || snapshot.activation === "recovery_required" || !fileRead || fileRead.binary || fileRead.truncated} onClick={() => void prepareFile()}>{busy === "prepare-file" && <span className={styles.loading} />}{ko ? "변경 검토" : "Review change"}</button></div>{fileMenu && <div className={styles.fileMenu} data-agent-file-menu role="menu"><button role="menuitem" onClick={() => { setFileMenu(false); setRenamePathDialog(true); setNewPath(path); }}><IconFileText size={16} />{ko ? "이름 변경 검토…" : "Review rename…"}</button><button role="menuitem" className={styles.danger} onClick={() => { setFileMenu(false); void run("prepare-delete", async () => { if (!snapshot.writable || snapshot.activation === "recovery_required" || !await mayLeaveFile()) return; const proposal = await api().prepareFileOperation({ agentId: agent.id, operation: "delete", path }); setContent(fileRead?.content ?? ""); await refresh(); await openReview(proposal.id); }); }}><IconTrash size={16} />{ko ? "삭제 검토…" : "Review deletion…"}</button></div>}
            {fileLoading ? <div className={styles.empty}><span className={styles.loading} /></div> : fileRead?.binary ? <div className={styles.empty}><IconFileText size={28} />{ko ? "바이너리 파일 · 텍스트 편집 불가" : "Binary file · Text editing unavailable"}<span>{fileRead.byteLength.toLocaleString()} bytes</span></div> : fileRead ? <>{fileRead.truncated && <div className={styles.banner}>{ko ? "파일이 커서 일부만 표시합니다. 편집은 잠겨 있습니다." : "Partial preview of a large file. Editing is locked."}</div>}<div className={styles.codeEditor}><pre className={styles.editorGutter} ref={codeGutter} aria-hidden="true">{Array.from({ length: lineCount }, (_, index) => index + 1).join("\n")}</pre><textarea ref={codeInput} className={styles.codeInput} value={content} spellCheck={false} autoCapitalize="off" autoCorrect="off" aria-label={`${path} ${ko ? "파일 내용" : "file content"}`} readOnly={!snapshot.writable || snapshot.activation === "recovery_required" || fileRead.truncated || Boolean(busy)} onChange={(event) => setContent(editorContent(event.target.value, fileRead.content))} onScroll={(event) => { if (codeGutter.current) codeGutter.current.scrollTop = event.currentTarget.scrollTop; }} onKeyDown={(event) => {
              if (event.key === "Tab" && !event.currentTarget.readOnly) { event.preventDefault(); const element = event.currentTarget; const start = element.selectionStart; const end = element.selectionEnd; setContent(editorContent(element.value.slice(0, start) + "  " + element.value.slice(end), fileRead.content)); requestAnimationFrame(() => { element.selectionStart = element.selectionEnd = start + 2; }); }
            }} /></div></> : <div className={styles.empty}>{ko ? "파일 읽기 실패" : "Could not read the file"}</div>}</> : <div className={styles.empty}><IconFolder size={35} /><strong>{ko ? "파일을 선택하세요" : "Select a file"}</strong></div>}</div>
        </> : view === "memory" ? renderMemory() : view === "changes" ? recovery ? <AgentWorkspaceRecoveryReview recovery={recovery} locale={locale} busy={Boolean(busy)} dirty={dirty} onClose={() => setRecovery(null)} onRetain={() => void run("recovery-acknowledge", async () => { if (!recovery.reviewToken) return; const next = await api().acknowledgeRecovery({ agentId: agent.id, reviewedHash: recovery.reviewedHash, reviewToken: recovery.reviewToken }); if (next.treeDigest !== recovery.currentTreeDigest || next.activation === "recovery_required") throw new Error(ko ? "현재 파일 확인과 복구 결과가 일치하지 않습니다. 다시 검토하세요." : "Recovery differs from the reviewed files. Review again."); setSnapshot(next); setFiles(next.files); setRecovery(null); setView("files"); if (path && next.files.some((file) => file.path === path)) await openFile(path, true); else { setPath(""); setFileRead(null); setContent(""); setNewFile(false); } setNotice(ko ? "현재 파일 확인 완료 · 실행 잠금 해제" : "Current files verified · Execution unlocked"); })} /> : renderChanges() : view === "sync" ? renderSync() : renderHistory()}
      </main>
      {inspector && <><button className={`${styles.scrim} ${styles.inspectorScrim}`} aria-label={ko ? "속성 닫기" : "Close inspector"} onClick={() => setInspector(false)} /><AgentWorkspaceInspector agent={agent} name={name} locale={locale} snapshot={snapshot} firm={firm} org={org} binding={binding} runtimes={runtimes} overrides={overrides} onClose={() => setInspector(false)} onRename={onRename} onRemove={onRemove} onOverridesChange={onOverridesChange} onNotice={setNotice} /></>}
    </div>
    <footer className={styles.statusbar}><span>{busy ? (ko ? "처리 중…" : "Working…") : dirty ? (ko ? "저장 전 파일 초안" : "Unsaved file draft") : snapshot?.activation === "run_active" ? (ko ? "실행 중 · 새 변경은 다음 실행부터" : "Run active · Changes apply to the next run") : snapshot ? (ko ? "로컬 파일 확인됨" : "Local files read") : (ko ? "파일 상태 알 수 없음" : "File state unknown")}</span><span>{path ? `${lineCount} ${ko ? "줄" : "lines"}` : ""}</span></footer>
    {quickOpen && <PopupFrame title={ko ? "파일 찾기" : "Find file"} icon={<IconSearch size={20} />} closeLabel={ko ? "닫기" : "Close"} onClose={() => setQuickOpen(false)} busy={Boolean(busy)}>
      <div className={styles.popupSearch}><IconSearch size={17} /><input autoFocus value={quickQuery} aria-label={ko ? "파일 이름" : "File name"} placeholder={ko ? "이름 또는 경로" : "Name or path"} onChange={(event) => setQuickQuery(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { const first = files.find((file) => file.kind === "file" && file.path.toLowerCase().includes(quickQuery.toLowerCase())); if (first) void openFile(first.path).then((opened) => { if (opened) { setQuickOpen(false); setView("files"); } }); } }} /><kbd>↵</kbd></div>
      <div className={styles.popupFiles}>{files.filter((file) => file.kind === "file" && file.path.toLowerCase().includes(quickQuery.toLowerCase())).map((file) => <button className={styles.popupFile} key={file.path} onClick={() => void openFile(file.path).then((opened) => { if (opened) { setQuickOpen(false); setView("files"); } })}><IconFileText size={18} /><span><strong>{file.path.split("/").at(-1)}</strong><small>{file.path}</small></span></button>)}{!files.some((file) => file.kind === "file" && file.path.toLowerCase().includes(quickQuery.toLowerCase())) && <div className={styles.empty}><IconSearch size={24} />{ko ? "일치하는 파일 없음" : "No matching files"}</div>}</div>
    </PopupFrame>}
    {newPathDialog && <PopupFrame title={ko ? "새 파일 초안" : "New file draft"} icon={<IconPlus size={20} />} closeLabel={ko ? "닫기" : "Close"} onClose={() => setNewPathDialog(false)} busy={Boolean(busy)} footer={<><PopupAction onClick={() => setNewPathDialog(false)} disabled={Boolean(busy)}>{ko ? "취소" : "Cancel"}</PopupAction><PopupAction primary icon={<IconFileText size={16} />} disabled={Boolean(busy) || !validNewPath || !snapshot?.writable || snapshot.activation === "recovery_required"} onClick={() => void openDraft()}>{ko ? "초안 열기" : "Open draft"}</PopupAction></>}>
      <label className={styles.popupPath}>{ko ? "폴더 내 경로" : "Path inside folder"}<input autoFocus value={newPath} placeholder="skills/my-skill/SKILL.md" onChange={(event) => setNewPath(event.target.value)} /></label>
      <PopupSteps steps={[{label: ko ? "초안" : "Draft", icon:<IconFileText size={18} />,active:true},{label: ko ? "변경 검토" : "Review diff",icon:<IconLayers size={18} />},{label: ko ? "승인·저장" : "Approve & save",icon:<IconCheck size={18} />}]} />
      <p className={styles.popupNote}><IconShield size={15} />{ko ? "승인 전 실제 파일은 바뀌지 않습니다." : "Actual files change only after approval."}</p>
    </PopupFrame>}
    {renamePathDialog && <PopupFrame title={ko ? "이름 변경 검토" : "Review rename"} icon={<IconFileText size={20} />} closeLabel={ko ? "닫기" : "Close"} onClose={() => setRenamePathDialog(false)} busy={Boolean(busy)} footer={<><PopupAction disabled={Boolean(busy)} onClick={() => setRenamePathDialog(false)}>{ko ? "취소" : "Cancel"}</PopupAction><PopupAction primary icon={busy ? <span className={styles.loading} /> : <IconLayers size={16} />} disabled={Boolean(busy) || !validNewPath || newPath.trim() === path || !snapshot?.writable || snapshot.activation === "recovery_required"} onClick={() => void run("prepare-rename", async () => { if (!validNewPath || !await mayLeaveFile()) return; const proposal = await api().prepareFileOperation({ agentId: agent.id, operation: "rename", path, newPath: newPath.trim() }); setRenamePathDialog(false); setContent(fileRead?.content ?? ""); await refresh(); await openReview(proposal.id); })}>{ko ? "변경 검토" : "Review change"}</PopupAction></>}>
      <PopupFacts items={[{label:ko ? "현재 파일" : "Current file",value:<code>{path}</code>,icon:<IconFileText size={17} />}]}/>
      <label className={styles.popupPath}>{ko ? "새 경로" : "New path"}<input autoFocus value={newPath} placeholder="skills/my-skill/SKILL.md" onChange={(event) => setNewPath(event.target.value)} /></label>
      <p className={styles.popupNote}><IconShield size={15} />{ko ? "변경안을 먼저 검토합니다. 승인 후 이름이 바뀝니다." : "Review the proposal first. Rename happens after approval."}</p>
    </PopupFrame>}
    {memoryImportPreview && <AgentMemoryImportDialog preview={memoryImportPreview} agentId={agent.id} locale={locale} onClose={() => setMemoryImportPreview(null)} onImported={async (count, remainingFiles) => { await refresh(); setNotice(ko ? `메모리 ${count}건을 가져왔습니다.${remainingFiles > 0 ? ` 파일 ${remainingFiles}개가 남아 있어 다시 가져오면 이어집니다.` : ""}` : `Imported ${count} memories.${remainingFiles > 0 ? ` ${remainingFiles} more files remain; import again to continue.` : ""}`); }} />}
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
  return <div className={styles.changeSummary}><h3>{ko ? "바뀌는 것" : "What changes"}</h3><ul>{changes.map((change) => <li key={change.path}><code>{change.path}</code> · {changeLine(change, ko)}</li>)}</ul></div>;
}
function outcomeSentence(outcome: AgentWorkspaceRevisionOutcome | undefined, ko: boolean): string | null {
  if (!outcome?.runs) return null;
  return ko ? `실행 ${outcome.runs}회 · 완료 ${outcome.completed} · 실패 ${outcome.failed} · 도구 오류 ${outcome.errors} · 중간 정정 ${outcome.steering}`
    : `${outcome.runs} runs · ${outcome.completed} completed · ${outcome.failed} failed · ${outcome.errors} tool errors · ${outcome.steering} mid-run corrections`;
}
const WORK_KIND_LABEL: Record<AgentWorkspaceWorkKind, [string, string]> = {
  task: ["작업", "Tasks"], conversation: ["대화", "Conversations"], automation: ["자동화", "Automations"], other: ["종류 기록 없음", "Kind not recorded"],
};
/** One kind of work in one revision, as the host counted it; rates are per run. */
function countsLine(counts: AgentWorkspaceOutcomeCounts, ko: boolean): string {
  const per = (value: number) => (value / counts.runs).toFixed(2);
  return ko ? `실행 ${counts.runs} · 실패 ${counts.failed} · 도구 오류 ${counts.errors} (${per(counts.errors)}/회) · 중간 정정 ${counts.steering} (${per(counts.steering)}/회) · 도구 호출 ${per(counts.toolCalls)}/회 · 산출물 기록 ${counts.withOutput}`
    : `${counts.runs} runs · ${counts.failed} failed · ${counts.errors} tool errors (${per(counts.errors)}/run) · ${counts.steering} corrections (${per(counts.steering)}/run) · ${per(counts.toolCalls)} tool calls/run · ${counts.withOutput} with output`;
}
const LIMIT_LABEL: Record<NonNullable<NonNullable<AgentWorkspaceRevision["comparison"]>["rows"][number]["limit"]>, [string, string]> = {
  no_runs_before: ["반영 전 실행 없음", "No runs before"], no_runs_after: ["반영 후 실행 없음", "No runs after yet"], single_run: ["한쪽 실행 1회 — 비교 불가", "One run on a side — not comparable"],
};
/**
 * The revision a change replaced next to the one it produced, per kind of work, counted by the host. No verdict: being
 * approved is not the same as helping, and the runs before and after were different requests. The owner reads the numbers.
 */
function OutcomeComparison({ revision, ko }: { revision?: AgentWorkspaceRevision; ko: boolean }) {
  const rows = revision?.comparison?.rows ?? [];
  if (!rows.some((row) => row.after)) return <div className={styles.banner}>{ko ? "반영 뒤 실행이 아직 없습니다. 실행이 쌓이면 같은 종류의 일끼리 반영 전과 숫자로 비교합니다." : "No runs since the change yet. Once runs accumulate, each kind of work is compared with the runs before it."}</div>;
  return <><table className={styles.outcomeTable}><thead><tr><th>{ko ? "일의 종류" : "Kind of work"}</th><th>{ko ? "반영 전" : "Before"}</th><th>{ko ? "반영 후" : "After"}</th></tr></thead>
    <tbody>{rows.map((row) => <tr key={row.kind}><th>{WORK_KIND_LABEL[row.kind][ko ? 0 : 1]}{row.limit && <div className={styles.meta}><span>{LIMIT_LABEL[row.limit][ko ? 0 : 1]}</span></div>}</th>
      <td>{row.before ? countsLine(row.before, ko) : "—"}</td><td>{row.after ? countsLine(row.after, ko) : "—"}</td></tr>)}</tbody></table>
    <div className={styles.meta}><span>{ko ? "앱이 기록한 숫자입니다. 전후 실행은 서로 다른 요청이라 효과를 판정하지 않습니다." : "Numbers the app recorded. Runs before and after were different requests, so no effect is judged."}</span></div></>;
}
/** An applied learning: its record (when it names its runs) and how runs went before and after. */
function AppliedRecord({ revision, ko }: { revision?: AgentWorkspaceRevision; ko: boolean }) {
  return <>{revision?.experience && <ExperienceView experience={revision.experience} ko={ko} />}<OutcomeComparison revision={revision} ko={ko} /></>;
}
/** Before approving a learning: what the current version's runs look like, and how the change that made it went, if any. */
function Baseline({ revision, ko }: { revision?: AgentWorkspaceRevision; ko: boolean }) {
  const kinds = Object.entries(revision?.outcome?.byKind ?? {}) as Array<[AgentWorkspaceWorkKind, AgentWorkspaceOutcomeCounts]>;
  return <div className={styles.changeSummary}><h3>{ko ? "지금 버전의 실제 실행" : "Runs on the current version"}</h3>
    {kinds.length ? <ul>{kinds.map(([kind, counts]) => <li key={kind}>{WORK_KIND_LABEL[kind][ko ? 0 : 1]} · {countsLine(counts, ko)}</li>)}</ul>
      : <p className={styles.meta}>{ko ? "지금 버전으로 돈 실행이 아직 없습니다." : "No runs on the current version yet."}</p>}
    <p className={styles.meta}>{ko ? "승인하면 이 숫자가 반영 전 기준이 됩니다." : "If you approve, these are the numbers the change is compared against."}</p>
    {revision?.experience && <><h3>{ko ? "직전 변경의 전후" : "The previous change, before and after"}</h3><OutcomeComparison revision={revision} ko={ko} /></>}</div>;
}
function ExperienceView({ experience, ko }: { experience: AgentWorkspaceExperience; ko: boolean }) {
  const rows: Array<[string, string]> = [
    ...(experience.cue ? [[ko ? "언제" : "When", experience.cue] as [string, string]] : []),
    ...(experience.lesson ? [[ko ? "교훈" : "Lesson", experience.lesson] as [string, string]] : []),
    [ko ? "바뀐 것" : "Changed", experience.changed.map((change) => changeLine(change, ko)).join(" · ") || "—"],
    [ko ? "근거 실행" : "From runs", ko ? `${experience.evidence.length}개 실행` : `${experience.evidence.length} runs`],
  ];
  return <dl className={styles.learningCard}>{rows.map(([label, text]) => <div key={label}><dt>{label}</dt><dd>{text}</dd></div>)}</dl>;
}
function alwaysOnSentence(change: AgentWorkspaceProposal["alwaysOn"], ko: boolean): string | null {
  if (!change) return null;
  const delta = change.after.bytes - change.before.bytes, sign = delta > 0 ? "+" : "";
  const head = ko ? `매번 읽히는 지침(${change.path}) ${change.before.lines}줄 → ${change.after.lines}줄, ${sign}${delta}바이트` : `Always-on instructions (${change.path}) ${change.before.lines} → ${change.after.lines} lines, ${sign}${delta} bytes`;
  const warn = change.overHard ? (ko ? ` · 일부 실행기가 읽는 한도(${change.hardBytes}바이트)를 넘습니다` : ` · over the ${change.hardBytes}-byte limit some runtimes read`)
    : change.overSoft ? (ko ? ` · 권장 ${change.softLines}줄을 넘습니다` : ` · over the recommended ${change.softLines} lines`) : "";
  return head + warn;
}
function supportSentence(group: AgentWorkspaceMemoryCandidate[], ko: boolean): string {
  const sum = (pick: (support: NonNullable<AgentWorkspaceMemoryCandidate["support"]>) => number) => group.reduce((total, member) => total + (member.support ? pick(member.support) : 0), 0);
  const records = sum((support) => support.records), absorbed = sum((support) => support.absorbed);
  const promotion = group.find((member) => member.promotion)?.promotion;
  const parts = ko
    ? [promotion ? `서로 다른 실행 ${promotion.runs}회에서 나왔습니다.` : "", group.length > 1 ? `비슷한 기록 ${group.length}건이 이 교훈으로 묶였습니다.` : "", records ? `근거 기록 ${records}건.` : "", absorbed ? `이전에 합쳐진 학습 ${absorbed}건 포함.` : "",
      promotion?.ownerCorrections ? `그 실행들에서 사용자가 일하는 도중 방향을 바로잡은 적이 ${promotion.ownerCorrections}번 있습니다.` : "", promotion?.failures ? `같은 실행들에서 도구 오류·실패가 ${promotion.failures}건 기록됐습니다(이 교훈 때문이라는 뜻은 아닙니다).` : ""]
    : [promotion ? `Came from ${promotion.runs} separate runs.` : "", group.length > 1 ? `${group.length} similar records are grouped as this lesson.` : "", records ? `${records} evidence records.` : "", absorbed ? `Includes ${absorbed} earlier learnings merged into it.` : "",
      promotion?.ownerCorrections ? `You corrected course ${promotion.ownerCorrections} time(s) while those runs worked.` : "", promotion?.failures ? `${promotion.failures} tool errors or failures were recorded in the same runs (not necessarily because of this lesson).` : ""];
  return parts.filter(Boolean).join(" ");
}
function MemoryDetail({ candidate, group, locale, agentName, agentRole, canPrepare, proposal, onOpenProposal }: { candidate: AgentWorkspaceMemoryCandidate; group: AgentWorkspaceMemoryCandidate[]; locale: string; agentName: string; agentRole?: string; canPrepare: boolean; proposal?: AgentWorkspaceProposal; onOpenProposal: (id: string) => void }) {
  const ko = locale === "ko";
  const learned = plainMemoryText(candidate.contentNative || candidate.content, ko);
  const technical = candidate.evidence.filter(isTechnicalEvidence);
  useEffect(() => { if (technical.length) console.info("[agent-workspace] memory technical evidence", { memoryId: candidate.id, technical }); }, [candidate.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const readable = candidate.evidence.filter((line) => !isTechnicalEvidence(line)).map((line) => plainMemoryText(line, ko));
  const role = (agentRole ?? "").trim();
  return <article className={styles.detail}><h2>{plainMemoryTitle(candidate.contentNative || candidate.content || candidate.title, ko, 90)}</h2><div className={styles.meta}><State value={candidate.state} ko={ko} /><span>{memoryKindLabel(candidate.kind, ko)}</span></div>
    {candidate.state === "scope_review" && <div className={styles.banner} style={{ marginTop: 16 }}>{ko ? "특정 프로젝트에서 얻은 내용입니다. 다른 일에도 써도 되는지 먼저 확인하세요." : "This came from one project. Check that it is safe to reuse elsewhere first."}</div>}
    {candidate.state === "watching" && candidate.promotion && <div className={styles.banner} style={{ marginTop: 16 }}>{ko ? `같은 교훈이 서로 다른 실행 ${candidate.promotion.runs}회에서 나왔습니다. ${candidate.promotion.needRuns}회가 되면 변경안을 만듭니다. 한 번의 일에서 나온 메모를 지침으로 올리지 않기 위해서입니다.` : `This lesson has come from ${candidate.promotion.runs} separate runs. A change is prepared at ${candidate.promotion.needRuns}, so one task's note is not promoted into instructions.`}</div>}
    {candidate.state === "needs_evidence" && <div className={styles.banner} style={{ marginTop: 16 }}>{ko ? "뒷받침하는 기록이 부족해 아직 반영할 수 없습니다." : "There is not enough supporting record to add this yet."}</div>}
    <h3>{ko ? "이 에이전트는 원래" : "What this agent does"}</h3>
    <p className={styles.detailContent}>{role && role !== "One Team teammate" ? `${agentName} — ${role}` : agentName}</p>
    <h3>{ko ? "일하면서 배운 것" : "What it learned"}</h3>
    <p className={styles.detailContent}>{learned}</p>
    {(proposal?.card || (canPrepare && candidate.state === "eligible")) && <><h3>{ko ? "지침에 반영하면" : "If you add it to its instructions"}</h3>
    {proposal?.card ? <LearningCardView card={proposal.card} ko={ko} /> : <p className={styles.detailContent}>{ko ? "변경안을 만들면 실제 기록을 바탕으로, 어떤 상황에서 지금과 무엇이 달라지는지 보여 드립니다. 근거가 부족하면 아무것도 바꾸지 않는 것이 정상 결과입니다. 승인하기 전에는 아무것도 바뀌지 않습니다." : "Prepare a change to see, from the actual records, when it applies and what changes from today. When the records do not support a change, no change is the normal result. Nothing changes until you approve."}</p>}</>}
    {(group.length > 1 || candidate.support) && <><h3>{ko ? "얼마나 반복됐나" : "How often it came up"}</h3>
      <p className={styles.detailContent}>{supportSentence(group, ko)}</p>
      {group.length > 1 && <ul className={styles.evidence}>{group.filter((member) => member.id !== candidate.id).map((member) => <li key={member.id}>{plainMemoryTitle(member.contentNative || member.content || member.title, ko, 120)}</li>)}</ul>}</>}
    {readable.length > 0 && <><h3>{ko ? "이렇게 알게 됐어요" : "How it found out"}</h3><ul className={styles.evidence}>{readable.map((line, index) => <li key={index}>{line}</li>)}</ul></>}
    {proposal && <><h3>{ko ? "연결된 변경안" : "Linked proposal"}</h3><button className={styles.button} onClick={() => onOpenProposal(proposal.id)}><IconLayers size={13} />{proposal.summary}</button></>}
  </article>;
}
