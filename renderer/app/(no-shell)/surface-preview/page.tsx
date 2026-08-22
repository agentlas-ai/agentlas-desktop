"use client";
import { Suspense, useCallback, useEffect, useMemo, useState, type CSSProperties } from "react";
import { useSearchParams } from "next/navigation";
import { ipc } from "@/lib/ipc";
import type { AgentlasSurfaceAction, AgentlasSurfaceManifest, JsonObject } from "@/lib/types";
import type { OneTaskProjection } from "@/lib/one-task-adapter";
import { applySurfaceStatePatch } from "@/lib/surface-state";
import { OneAdaptiveResult } from "@/components/one/OneAdaptiveResult";
import { LiveOutputViewer, type LiveOutputKind } from "@/components/LiveOutputViewer";
import { WorkbenchPanel, type SurfaceStatePatchHandler, type WorkbenchSurface } from "@/components/WorkbenchPanel";
import type { OneSurfaceManifestV1 } from "@shared/one-surface";

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

function SurfacePreviewInner() {
  const searchParams = useSearchParams();
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
