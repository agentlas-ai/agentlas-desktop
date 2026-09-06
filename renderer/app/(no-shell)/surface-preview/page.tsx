"use client";
import { Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { notFound, useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import type { AgentlasSurfaceAction, AgentlasSurfaceManifest, JsonObject } from "@/lib/types";
import type { OneTaskProjection } from "@/lib/one-task-adapter";
import { applySurfaceStatePatch } from "@/lib/surface-state";
import { OneAdaptiveResult } from "@/components/one/OneAdaptiveResult";
import { OneTurnWork } from "@/components/one/OneTurnWork";
import { ChatStream, type StreamMessage } from "@/components/ChatStream";
import { LiveOutputViewer, type LiveOutputKind } from "@/components/LiveOutputViewer";
import { WorkbenchPanel, type SurfaceStatePatchHandler, type WorkbenchSurface } from "@/components/WorkbenchPanel";
import type { OneSurfaceManifestV1 } from "@shared/one-surface";
import type { OneActivityState } from "@/lib/one-activity";

const LIVE_OUTPUT_KINDS = new Set<LiveOutputKind>([
  "image", "video", "audio", "pdf", "document", "spreadsheet", "presentation", "archive", "data",
]);

function parseLiveOutputKind(value: string | null): LiveOutputKind | null {
  return value && LIVE_OUTPUT_KINDS.has(value as LiveOutputKind) ? value as LiveOutputKind : null;
}

function asObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSurfaceManifest(input: string): AgentlasSurfaceManifest {
  const parsed: unknown = JSON.parse(input);
  if (!asObject(parsed)) throw new Error("Manifest must be a JSON object.");
  if (parsed.kind !== "surface") throw new Error('Manifest kind must be "surface".');
  if (typeof parsed.title !== "string" || !parsed.title.trim()) {
    throw new Error("Manifest title is required.");
  }
  if (typeof parsed.domain !== "string" || !parsed.domain.trim()) {
    throw new Error("Manifest domain is required.");
  }
  if (typeof parsed.layout !== "string" || !parsed.layout.trim()) {
    throw new Error("Manifest layout is required.");
  }
  if (!asObject(parsed.data)) throw new Error("Manifest data must be an object.");
  if (!Array.isArray(parsed.widgets)) throw new Error("Manifest widgets must be an array.");
  return parsed as unknown as AgentlasSurfaceManifest;
}

function parsePreviewManifest(input: string):
  | { kind: "work"; manifest: AgentlasSurfaceManifest }
  | { kind: "one"; manifest: OneSurfaceManifestV1 } {
  const parsed: unknown = JSON.parse(input);
  if (asObject(parsed) && parsed.contractVersion === "1.0.0" && Array.isArray(parsed.blocks)) {
    return { kind: "one", manifest: parsed as unknown as OneSurfaceManifestV1 };
  }
  return { kind: "work", manifest: parseSurfaceManifest(input) };
}

function developerPreviewProjection(manifest: OneSurfaceManifestV1): OneTaskProjection {
  return {
    contractVersion: "1.0.0",
    taskId: manifest.taskId,
    canonicalVersion: 1,
    oneId: "one:developer-preview",
    projectionSurface: "one",
    projectionMode: "detailed",
    display: { title: manifest.title, summary: manifest.summary },
    status: { value: "completed", source: "authoritative_event", asOf: manifest.surfaceState.lastSyncedAt ?? new Date(0).toISOString() },
    sync: {
      connection: "online",
      lastSyncedAt: manifest.surfaceState.lastSyncedAt ?? null,
      authoritativeHostRef: "developer-preview",
      executionAuthorityAvailable: false,
      mutationMode: "read_only",
      queuedOperationCount: 0,
    },
    truth: { mayStartExecution: false, mayClaimNewCompletion: false },
    references: { manifestId: manifest.manifestId, decisionIds: [], artifactIds: [], receiptIds: [] },
    availableActions: [],
    pendingOperations: [],
    canonicalStatus: "completed",
    chatId: null,
    chat: null,
    latestReceipt: null,
  };
}

function ProcessLogPreview() {
  const startedAt = useMemo(() => Date.now() - 42_000, []);
  const observedAt = useMemo(() => new Date(startedAt).toISOString(), [startedAt]);
  const oneState = useMemo<OneActivityState>(() => ({
    items: [
      { id: "thought:1", kind: "reasoning", status: "completed", observedAt, durationMs: 4_100, agentName: "One", text: "현재 렌더러 위치와 상태 모델을 확인했습니다." },
      { id: "tool:read", kind: "tool", status: "completed", observedAt, agentName: "One", tool: { id: "read", name: "Read", args: JSON.stringify({ file_path: "/workspace/renderer/components/one/OneTurnWork.tsx" }), result: "ok" } },
      { id: "tool:shell", kind: "tool", status: "completed", observedAt, agentName: "UI Worker", tool: { id: "shell", name: "Bash", args: JSON.stringify({ command: "npm run typecheck && npm run test:one-turn-work" }), result: "> typecheck\n✓ renderer types\n✓ One turn work contract\n\n2 checks passed" } },
      { id: "tool:edit", kind: "tool", status: "completed", observedAt, agentName: "UI Worker", tool: { id: "edit", name: "Edit", args: JSON.stringify({ file_path: "/workspace/renderer/components/ChatStream.tsx", old_string: "status dashboard", new_string: "compact disclosure" }), result: "updated" } },
      { id: "thought:live", kind: "reasoning", status: "running", observedAt, agentName: "One", text: "검증 상태를 확인하는 중" },
    ],
    artifacts: [],
    sources: [],
    handoffs: [],
    tokens: 2_480,
    lastSequence: 5,
    activeReasoningId: "thought:live",
    cwd: "/workspace",
  }), [observedAt]);
  const workerMessages = useMemo<StreamMessage[]>(() => [{
    id: "qa-worker-turn",
    role: "agent",
    text: "",
    busy: true,
    streaming: false,
    startedAt,
    liveTokens: 1_240,
    status: "구현 구조를 확인하는 중",
    steps: [
      { id: "worker-step-1", kind: "thinking", text: "작업 범위와 기존 렌더러를 확인했습니다.", agentName: "One", role: "오케스트레이터", createdAt: startedAt + 1_000 },
      { id: "worker-step-2", kind: "tool", text: "OneTurnWork.tsx 읽기", tool: "Read", args: JSON.stringify({ file_path: "/workspace/renderer/components/one/OneTurnWork.tsx" }), result: "ok", agentName: "UI Worker", role: "Frontend", createdAt: startedAt + 8_000 },
      { id: "worker-step-3", kind: "thinking", text: "One과 Worker의 진행 행을 같은 밀도로 맞추고 있습니다.", agentName: "UI Worker", role: "Frontend", createdAt: startedAt + 18_000 },
      { id: "worker-step-4", kind: "tool", text: "렌더러 검증", tool: "Bash", args: JSON.stringify({ command: "npm run typecheck" }), agentName: "QA Worker", role: "Verification", createdAt: startedAt + 35_000 },
    ],
  }], [startedAt]);

  return (
    <main data-testid="process-log-preview" style={processPreviewPage}>
      <header style={processPreviewHeader}>
        <span>Agentlas renderer QA</span>
        <h1>One / Worker process grammar</h1>
        <p>Codex처럼 본문 안에서 조용히 열리고, 완료되면 한 줄로 접힙니다.</p>
      </header>
      <div style={processPreviewGrid}>
        <section data-testid="process-log-one" style={processPreviewCard}>
          <small style={processPreviewEyebrow}>ONE</small>
          <p style={processPreviewPrompt}>진행 과정을 간결하게 보여줘.</p>
          <OneTurnWork state={oneState} busy startedAt={startedAt} locale="ko" workspacePath="/workspace" />
          <p style={processPreviewAnswer}>구조를 유지하면서 진행 행, 명령 카드, 파일 변경 목록의 위계를 정리했습니다.</p>
        </section>
        <section data-testid="process-log-worker" style={{ ...processPreviewCard, minHeight: 430 }}>
          <small style={processPreviewEyebrow}>WORK · PARALLEL WORKERS</small>
          <div style={{ minHeight: 360, display: "flex" }}>
            <ChatStream messages={workerMessages} agentName="One" agentTone="green" workspaceRoot="/workspace" />
          </div>
        </section>
      </div>
    </main>
  );
}

function SurfacePreviewInner() {
  const searchParams = useSearchParams();
  const processLogPreview = searchParams.get("processLog") === "1";
  const requestedSurfaceId = searchParams.get("surfaceId") || searchParams.get("id") || "";
  const requestedAppId = searchParams.get("appId") || "";
  const encodedManifest = searchParams.get("manifest") || "";
  const outputKind = parseLiveOutputKind(searchParams.get("outputKind"));
  const outputSource = searchParams.get("outputSource") || "";
  const outputName = searchParams.get("outputName") || "Live output";
  const outputMime = searchParams.get("outputMime") || undefined;
  const [surface, setSurface] = useState<WorkbenchSurface | null>(null);
  const [oneSurface, setOneSurface] = useState<OneSurfaceManifestV1 | null>(null);
  const [manifestText, setManifestText] = useState("");
  const [message, setMessage] = useState("No surface loaded.");
  const [lastAction, setLastAction] = useState<string | null>(null);
  const [open, setOpen] = useState(true);

  const status = useMemo(() => {
    if (outputKind && outputSource) return `Live output · ${outputKind}`;
    if (oneSurface) return `One · ${oneSurface.layoutProfile}`;
    if (!surface) return "idle";
    return `${surface.manifest.domain} · ${surface.manifest.layout}`;
  }, [oneSurface, outputKind, outputSource, surface]);
  const oneProjection = useMemo(
    () => oneSurface ? developerPreviewProjection(oneSurface) : null,
    [oneSurface],
  );

  useEffect(() => {
    if (!encodedManifest) return;
    try {
      const preview = parsePreviewManifest(encodedManifest);
      if (preview.kind === "one") {
        setOneSurface(preview.manifest);
        setSurface(null);
      } else {
        setSurface({ id: `preview-${Date.now().toString(36)}`, manifest: preview.manifest, ...(requestedAppId ? { liveAppId: requestedAppId } : {}) });
        setOneSurface(null);
      }
      setManifestText(JSON.stringify(preview.manifest, null, 2));
      setMessage("Loaded developer preview manifest from URL.");
      setOpen(true);
    } catch (err: unknown) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, [encodedManifest, requestedAppId]);

  useEffect(() => {
    if (!requestedSurfaceId) return;
    const api = ipc();
    if (!api) {
      setMessage("Surface registry is unavailable in this browser context.");
      return;
    }
    let cancelled = false;
    void api.surfaces
      .getSurface(requestedSurfaceId)
      .then((record) => {
        if (cancelled) return;
        if (!record) {
          setMessage(`Surface not found: ${requestedSurfaceId}`);
          return;
        }
        setSurface({
          id: record.id,
          manifest: record.manifest,
          state: record.state,
          jobSummary: record.jobSummary,
          ...(requestedAppId ? { liveAppId: requestedAppId } : {}),
        });
        setOneSurface(null);
        setManifestText(JSON.stringify(record.manifest, null, 2));
        setMessage("Loaded surface from registry.");
        setOpen(true);
      })
      .catch((err: unknown) => {
        if (!cancelled) setMessage(err instanceof Error ? err.message : String(err));
      });
    return () => {
      cancelled = true;
    };
  }, [requestedAppId, requestedSurfaceId]);

  const loadFromText = useCallback(() => {
    try {
      const preview = parsePreviewManifest(manifestText);
      if (preview.kind === "one") {
        setOneSurface(preview.manifest);
        setSurface(null);
      } else {
        setSurface({ id: `preview-${Date.now().toString(36)}`, manifest: preview.manifest, ...(requestedAppId ? { liveAppId: requestedAppId } : {}) });
        setOneSurface(null);
      }
      setMessage("Manifest rendered.");
      setLastAction(null);
      setOpen(true);
    } catch (err: unknown) {
      setMessage(err instanceof Error ? err.message : String(err));
    }
  }, [manifestText, requestedAppId]);

  const clearSurface = useCallback(() => {
    setSurface(null);
    setOneSurface(null);
    setManifestText("");
    setLastAction(null);
    setMessage("No surface loaded.");
  }, []);

  const handleSurfaceAction = useCallback((activeSurface: WorkbenchSurface, action: AgentlasSurfaceAction) => {
    if (action.type === "external-link" && action.url) {
      window.open(action.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (action.type === "copy") {
      void navigator.clipboard.writeText(action.prompt || JSON.stringify(activeSurface.manifest, null, 2));
      setMessage("Copied action payload.");
      return;
    }
    setLastAction(`${action.label} (${action.type})`);
    setMessage("Preview recorded the action. Execute app/tool/asset actions from Library > Generated surfaces.");
  }, []);

  const handleSurfaceStatePatch = useCallback<SurfaceStatePatchHandler>((activeSurface, patch) => {
    const api = ipc();
    if (api && !activeSurface.id.startsWith("preview-")) {
      void api.surfaces
        .updateState({ surfaceId: activeSurface.id, ...patch, actor: patch.actor || "user" })
        .then((record) => {
          setSurface({
            id: record.id,
            manifest: record.manifest,
            state: record.state,
            jobSummary: record.jobSummary,
            ...(requestedAppId ? { liveAppId: requestedAppId } : {}),
          });
          setMessage(`Saved state: ${patch.label || patch.path}`);
        })
        .catch((err: unknown) => setMessage(err instanceof Error ? err.message : String(err)));
      return;
    }

    setSurface((cur) =>
      cur?.id === activeSurface.id
        ? {
            ...cur,
            state: applySurfaceStatePatch(cur.state, patch.path, patch.value),
          }
        : cur,
    );
    setMessage(`Preview state patched: ${patch.label || patch.path}`);
  }, [requestedAppId]);

  if (processLogPreview) return <ProcessLogPreview />;

  return (
    <main className="agentlas-surface-preview-page" style={page}>
      <style>{`
        @media (max-width: 900px) {
          .agentlas-surface-preview-page {
            flex-direction: column !important;
            overflow: auto !important;
          }
          .agentlas-surface-preview-control {
            width: 100% !important;
            max-height: none !important;
            border-right: none !important;
            border-bottom: 1px solid var(--paper-edge) !important;
          }
          .agentlas-surface-preview-stage {
            min-height: 680px !important;
          }
          .agentlas-surface-preview-stage .agentlas-workbench-panel {
            width: 100% !important;
            min-width: 0 !important;
            border-left: none !important;
          }
        }
      `}</style>
      <section className="agentlas-surface-preview-control" style={controlPane}>
        <div style={headerBlock}>
          <div style={eyebrow}>Agentlas Developer Preview</div>
          <h1 style={title}>Surface renderer</h1>
          <div style={statusPill}>{status}</div>
        </div>

        <textarea
          value={manifestText}
          onChange={(event) => setManifestText(event.currentTarget.value)}
          spellCheck={false}
          placeholder='Paste a Work Surface (kind: "surface") or One Surface (contractVersion: "1.0.0").'
          style={editor}
        />

        <div style={buttonRow}>
          <button onClick={loadFromText} style={primaryButton}>
            Render
          </button>
          <button onClick={() => setOpen(true)} disabled={!surface && !oneSurface} style={secondaryButton}>
            Open
          </button>
          <button onClick={clearSurface} style={secondaryButton}>
            Clear
          </button>
        </div>

        <div style={messageBox}>
          <strong>Status</strong>
          <span>{message}</span>
          {lastAction && <code style={codePill}>{lastAction}</code>}
        </div>
      </section>

      <section className="agentlas-surface-preview-stage" style={stage}>
        {outputKind && outputSource ? (
          <div style={liveOutputPreviewStage} data-testid="live-output-preview-stage">
            <LiveOutputViewer
              source={outputSource}
              name={outputName}
              kind={outputKind}
              mimeType={outputMime}
              locale="ko"
            />
          </div>
        ) : oneSurface && oneProjection && open ? (
          <div style={onePreviewStage}>
            <OneAdaptiveResult
              manifest={oneSurface}
              projection={oneProjection}
              receipt={null}
              locale="ko"
            />
          </div>
        ) : surface && open ? (
          <WorkbenchPanel
            artifact={null}
            surface={surface}
            onSurfaceAction={handleSurfaceAction}
            onSurfaceStatePatch={handleSurfaceStatePatch}
            onClose={() => setOpen(false)}
          />
        ) : (
          <div style={emptyStage}>
            <strong>No rendered surface</strong>
            <span>Open a saved surface or render a manifest.</span>
          </div>
        )}
      </section>
    </main>
  );
}

export default function SurfacePreviewPage() {
  // This route is a renderer QA harness, not a customer surface. Development keeps
  // it convenient; production QA must opt in at build time so the shipped app cannot
  // expose the raw manifest editor through a manually entered URL.
  if (process.env.NODE_ENV === "production" && process.env.NEXT_PUBLIC_AGENTLAS_QA_SURFACES !== "1") {
    notFound();
  }
  return (
    <Suspense fallback={null}>
      <SurfacePreviewInner />
    </Suspense>
  );
}

const page = {
  height: "100vh",
  display: "flex",
  minWidth: 0,
  background: "var(--paper-2)",
  color: "var(--ink)",
  overflow: "hidden",
} satisfies CSSProperties;

const processPreviewPage = {
  minHeight: "100vh",
  padding: "36px clamp(24px, 5vw, 72px) 56px",
  background: "var(--paper-2)",
  color: "var(--ink)",
  overflow: "auto",
} satisfies CSSProperties;

const processPreviewHeader = {
  width: "min(1180px, 100%)",
  margin: "0 auto 24px",
  display: "grid",
  gap: 5,
} satisfies CSSProperties;

const processPreviewGrid = {
  width: "min(1180px, 100%)",
  margin: "0 auto",
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(min(100%, 500px), 1fr))",
  gap: 18,
  alignItems: "start",
} satisfies CSSProperties;

const processPreviewCard = {
  minWidth: 0,
  minHeight: 430,
  padding: "24px 26px",
  border: "1px solid var(--paper-edge)",
  borderRadius: 14,
  background: "var(--paper)",
  boxShadow: "0 8px 24px rgba(32, 36, 33, .035)",
  overflow: "hidden",
} satisfies CSSProperties;

const processPreviewEyebrow = {
  display: "block",
  marginBottom: 20,
  color: "var(--muted-deep)",
  font: "650 10px/1.2 var(--font-mono)",
  letterSpacing: ".08em",
} satisfies CSSProperties;

const processPreviewPrompt = {
  width: "fit-content",
  maxWidth: "78%",
  margin: "0 0 20px auto",
  padding: "9px 13px",
  borderRadius: 12,
  background: "var(--paper-3)",
  color: "var(--ink)",
  fontSize: 13.5,
  lineHeight: 1.55,
} satisfies CSSProperties;

const processPreviewAnswer = {
  margin: "14px 0 0",
  color: "var(--ink)",
  fontSize: 13.5,
  lineHeight: 1.65,
} satisfies CSSProperties;

const controlPane = {
  width: 360,
  maxWidth: "100%",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  padding: 18,
  borderRight: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  overflow: "auto",
} satisfies CSSProperties;

const headerBlock = {
  display: "grid",
  gap: 7,
} satisfies CSSProperties;

const eyebrow = {
  fontSize: 10,
  fontWeight: 800,
  color: "var(--accent)",
  textTransform: "uppercase",
} satisfies CSSProperties;

const title = {
  margin: 0,
  fontSize: 24,
  lineHeight: 1.1,
  fontFamily: "var(--font-head)",
} satisfies CSSProperties;

const statusPill = {
  width: "fit-content",
  maxWidth: "100%",
  padding: "5px 8px",
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  color: "var(--muted-deep)",
  fontSize: 11,
  fontWeight: 800,
  overflowWrap: "anywhere",
} satisfies CSSProperties;

const editor = {
  minHeight: 360,
  flex: 1,
  resize: "vertical",
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  color: "var(--ink)",
  padding: 12,
  fontFamily: "var(--font-mono)",
  fontSize: 12,
  lineHeight: 1.5,
  outline: "none",
} satisfies CSSProperties;

const buttonRow = {
  display: "flex",
  gap: 8,
  flexWrap: "wrap",
} satisfies CSSProperties;

const primaryButton = {
  minHeight: 34,
  padding: "0 12px",
  borderRadius: 8,
  border: "1px solid var(--accent-soft)",
  background: "var(--fill-1)",
  color: "var(--ink)",
  fontWeight: 800,
  cursor: "pointer",
} satisfies CSSProperties;

const secondaryButton = {
  minHeight: 34,
  padding: "0 12px",
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  color: "var(--ink-soft)",
  fontWeight: 800,
  cursor: "pointer",
} satisfies CSSProperties;

const messageBox = {
  display: "grid",
  gap: 6,
  padding: 10,
  borderRadius: 8,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  color: "var(--ink-soft)",
  fontSize: 12,
  overflowWrap: "anywhere",
} satisfies CSSProperties;

const codePill = {
  display: "block",
  padding: "5px 7px",
  borderRadius: 6,
  background: "var(--paper)",
  color: "var(--muted-deep)",
  fontSize: 11,
  whiteSpace: "normal",
} satisfies CSSProperties;

const stage = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  display: "flex",
  justifyContent: "flex-end",
} satisfies CSSProperties;

const emptyStage = {
  flex: 1,
  minWidth: 0,
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  justifyContent: "center",
  gap: 8,
  color: "var(--muted-deep)",
  textAlign: "center",
  padding: 24,
} satisfies CSSProperties;

const onePreviewStage = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: "auto",
  padding: 24,
  background: "var(--paper-2)",
} satisfies CSSProperties;

const liveOutputPreviewStage = {
  flex: 1,
  minWidth: 0,
  minHeight: 0,
  overflow: "auto",
  padding: 24,
  background: "var(--paper-2)",
} satisfies CSSProperties;
