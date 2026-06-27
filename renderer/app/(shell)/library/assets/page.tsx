// Agent-made asset packs registry.
// Shows reusable media/storyboard/export packs materialized from safe surface manifests.
"use client";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT } from "@/lib/i18n";
import type {
  InstalledAgent,
  Project,
  SurfaceAssetPackOperationKind,
  SurfaceAssetPackOperationRecord,
  SurfaceAssetPackRecord,
} from "@/lib/types";
import {
  IconCheck,
  IconChevronRight,
  IconClose,
  IconFileUp,
  IconImage,
  IconLayers,
  IconSparkles,
} from "@/components/Icon";

export default function LibraryAssetsPage() {
  const { t, locale } = useT();
  const [packs, setPacks] = useState<SurfaceAssetPackRecord[]>([]);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [operations, setOperations] = useState<SurfaceAssetPackOperationRecord[]>([]);
  const [busyAction, setBusyAction] = useState<SurfaceAssetPackOperationKind | null>(null);
  const [message, setMessage] = useState("");

  const selected = packs.find((pack) => pack.id === selectedId) ?? packs[0] ?? null;

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const [nextPacks, nextAgents, nextProjects] = await Promise.all([
      api.surfaceAssets.listPacks(),
      api.team.list(),
      api.projects.list(),
    ]);
    setPacks(nextPacks);
    setAgents(visibleAgents(nextAgents));
    setProjects(nextProjects);
    setSelectedId((cur) => (cur && nextPacks.some((pack) => pack.id === cur) ? cur : nextPacks[0]?.id ?? null));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const api = ipc();
    if (!api || !selected?.id) {
      setOperations([]);
      return;
    }
    let cancelled = false;
    void api.surfaceAssets.listOperations(selected.id).then((rows) => {
      if (!cancelled) setOperations(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const runAction = useCallback(
    async (kind: SurfaceAssetPackOperationKind) => {
      const api = ipc();
      if (!api || !selected) return;
      setBusyAction(kind);
      setMessage("");
      try {
        if (kind === "archive") {
          const op = await api.surfaceAssets.archive({ rootPath: selected.rootPath });
          const result = op.result && typeof op.result === "object" && !Array.isArray(op.result) ? op.result as Record<string, unknown> : {};
          setMessage(`Archived reversibly: ${String(result.archivePath ?? selected.rootPath)}`);
        } else if (kind === "restore") {
          const op = await api.surfaceAssets.restore({ rootPath: selected.rootPath });
          const result = op.result && typeof op.result === "object" && !Array.isArray(op.result) ? op.result as Record<string, unknown> : {};
          setMessage(String(result.summary ?? "Asset pack restored."));
        }
        if (kind === "archive" || kind === "restore") {
          await refresh();
          const latest = await api.surfaceAssets.getPack(selected.id);
          if (latest) {
            setSelectedId(latest.id);
            setOperations(await api.surfaceAssets.listOperations(latest.id));
          }
        }
      } catch (err: unknown) {
        setMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyAction(null);
      }
    },
    [refresh, selected],
  );

  const copyRoot = useCallback(() => {
    if (!selected) return;
    void navigator.clipboard.writeText(selected.rootPath);
    setMessage("Copied root path");
  }, [selected]);

  const openIndex = useCallback(() => {
    if (!selected || selected.status === "archived") return;
    window.open(selected.snapshot.fileUrl || encodeURI(`file://${selected.indexPath}`), "_blank", "noopener,noreferrer");
  }, [selected]);

  return (
    <div style={{ height: "100%", display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      <section style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "24px 32px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <p style={{ margin: 0, color: "var(--muted-deep)", fontSize: 13 }}>
            Reusable media, storyboard, prompt, and export packs generated from surfaces.
          </p>
          <span style={countPill}>
            <IconImage size={12} />
            {packs.length}
          </span>
        </div>

        {packs.length === 0 ? (
          <div style={emptyState}>
            <IconImage size={24} style={{ color: "var(--muted-deep)" }} />
            <strong style={{ color: "var(--ink)", fontSize: 14 }}>No generated asset packs yet</strong>
            <span style={{ fontSize: 12, color: "var(--muted-deep)" }}>
              Run a surface action with type materialize-asset-pack.
            </span>
            <Link href="/library/surfaces" style={{ color: "var(--accent)", fontWeight: 700, textDecoration: "none", marginTop: 4 }}>
              {t("sidebar.surfaces")} <IconChevronRight size={11} />
            </Link>
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
            {packs.map((pack) => {
              const active = pack.id === selected?.id;
              const agent = agentById.get(pack.agentId);
              const project = pack.projectId ? projectById.get(pack.projectId) : null;
              return (
                <li key={pack.id}>
                  <button
                    onClick={() => setSelectedId(pack.id)}
                    style={{
                      ...packRow,
                      borderColor: active ? "var(--accent)" : "var(--paper-edge)",
                      background: active ? "var(--fill-1)" : "var(--paper)",
                      opacity: pack.status === "archived" ? 0.58 : 1,
                    }}
                  >
                    <span style={packIcon(pack.status)}>
                      <IconImage size={15} />
                    </span>
                    <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 4, textAlign: "left" }}>
                      <strong style={ellipsis}>{pack.packName}</strong>
                      <span style={{ display: "flex", gap: 8, color: "var(--muted-deep)", fontSize: 11, minWidth: 0, flexWrap: "wrap" }}>
                        <span>{pack.domain}</span>
                        <span>{pack.status}</span>
                        {agent && <span>{pickLocalized(agent, locale).name}</span>}
                        {project && <span>{project.name}</span>}
                      </span>
                    </span>
                    <span style={metricPill}>
                      <IconFileUp size={11} />
                      {pack.snapshot.files.length}
                    </span>
                    <span style={metricPill}>
                      <IconLayers size={11} />
                      {pack.snapshot.remoteAssets.length}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <aside style={detailPane}>
        {selected ? (
          <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
            <div style={{ padding: "22px 22px 16px", borderBottom: "var(--hairline)", display: "grid", gap: 12 }}>
              <div style={{ display: "grid", gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={statusPill}>{selected.status}</span>
                  <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
                    Updated {shortDate(selected.updatedAt, locale)}
                  </span>
                </div>
                <h2 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 21, lineHeight: 1.1 }}>
                  {selected.packName}
                </h2>
                <p style={{ margin: 0, color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.5 }}>
                  {selected.domain} · {selected.snapshot.files.length} files · {selected.snapshot.remoteAssets.length} remote refs
                </p>
              </div>

              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                <MiniStat label="Local files" value={String(selected.snapshot.files.length)} />
                <MiniStat label="Remote refs" value={String(selected.snapshot.remoteAssets.length)} />
                <MiniStat label="Surface" value={selected.surfaceId.slice(0, 8)} />
                <MiniStat label="Created" value={shortDate(selected.createdAt, locale)} />
              </div>

              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
                <ActionButton onClick={openIndex} disabled={selected.status === "archived"} label="Open index" icon={<IconFileUp size={12} />} />
                <ActionButton onClick={copyRoot} label="Copy root" icon={<IconLayers size={12} />} />
                {selected.status === "archived" ? (
                  <ActionButton
                    onClick={() => void runAction("restore")}
                    disabled={busyAction === "restore"}
                    label="Restore"
                    icon={<IconCheck size={12} />}
                  />
                ) : (
                  <ActionButton
                    onClick={() => void runAction("archive")}
                    disabled={busyAction === "archive"}
                    label="Archive"
                    icon={<IconClose size={12} />}
                  />
                )}
                {busyAction && <span style={statusPill}>Running...</span>}
              </div>

              {message && (
                <div style={messageBox}>
                  <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{message}</span>
                  <button onClick={() => setMessage("")} aria-label="Close" style={plainIconButton}>
                    <IconClose size={12} />
                  </button>
                </div>
              )}
            </div>

            <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: 22, display: "grid", gap: 12 }}>
              <InfoBlock title="Summary" value={selected.snapshot.summary} />
              <InfoBlock title="Root" value={selected.rootPath} mono />
              <InfoBlock title="Index" value={selected.indexPath} mono />

              <section style={card}>
                <h3 style={sectionTitle}>Files</h3>
                <div style={listStack}>
                  {selected.snapshot.files.slice(0, 18).map((file) => (
                    <div key={file.path} style={fileRow}>
                      <span>{file.path}</span>
                      <small>{file.kind} · {file.bytes} bytes</small>
                    </div>
                  ))}
                </div>
              </section>

              <section style={card}>
                <h3 style={sectionTitle}>Operations</h3>
                <div style={listStack}>
                  {operations.length ? (
                    operations.map((op) => (
                      <div key={op.id} style={fileRow}>
                        <span>{op.operation}</span>
                        <small>{op.ok ? "ok" : "failed"} · {shortDate(op.createdAt, locale)}</small>
                      </div>
                    ))
                  ) : (
                    <div style={{ color: "var(--muted-deep)", fontSize: 12 }}>No operation history yet.</div>
                  )}
                </div>
              </section>
            </div>
          </div>
        ) : (
          <div style={{ color: "var(--muted-deep)", fontSize: 13 }}>No generated asset packs yet</div>
        )}
      </aside>
    </div>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={miniStat}>
      <span>{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}

function InfoBlock({ title, value, mono }: { title: string; value: string; mono?: boolean }) {
  return (
    <section style={card}>
      <h3 style={sectionTitle}>{title}</h3>
      <p style={{ margin: 0, color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.5, fontFamily: mono ? "ui-monospace, SFMono-Regular, Menlo, monospace" : undefined, overflowWrap: "anywhere" }}>
        {value}
      </p>
    </section>
  );
}

function ActionButton({
  label,
  icon,
  onClick,
  href,
  disabled,
}: {
  label: string;
  icon: ReactNode;
  onClick?: () => void;
  href?: string;
  disabled?: boolean;
}) {
  const style: CSSProperties = {
    ...actionButton,
    opacity: disabled ? 0.45 : 1,
    pointerEvents: disabled ? "none" : undefined,
  };
  if (href) {
    return (
      <Link href={href} style={style}>
        {icon}
        {label}
      </Link>
    );
  }
  return (
    <button onClick={onClick} style={style} disabled={disabled}>
      {icon}
      {label}
    </button>
  );
}

function shortDate(value: string, locale: string): string {
  try {
    return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
  } catch {
    return value;
  }
}

function packIcon(status: string): CSSProperties {
  return {
    width: 34,
    height: 34,
    borderRadius: 8,
    display: "grid",
    placeItems: "center",
    color: status === "archived" ? "var(--muted-deep)" : "var(--accent)",
    background: status === "archived" ? "var(--fill-1)" : "color-mix(in srgb, var(--accent) 12%, transparent)",
    flexShrink: 0,
  };
}

const countPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "5px 9px",
  borderRadius: 999,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--muted-deep)",
  fontSize: 12,
  fontWeight: 800,
};

const emptyState: CSSProperties = {
  minHeight: 220,
  display: "grid",
  placeItems: "center",
  alignContent: "center",
  gap: 8,
  border: "1px dashed var(--paper-edge)",
  borderRadius: 8,
  background: "var(--fill-1)",
  textAlign: "center",
};

const packRow: CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 12,
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  padding: 12,
  color: "var(--ink)",
  cursor: "pointer",
};

const ellipsis: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontSize: 13,
};

const metricPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  padding: "4px 7px",
  borderRadius: 999,
  background: "var(--fill-1)",
  color: "var(--muted-deep)",
  fontSize: 11,
  fontWeight: 700,
};

const detailPane: CSSProperties = {
  width: "min(560px, 48vw)",
  minWidth: 420,
  borderLeft: "var(--hairline)",
  background: "var(--paper)",
  overflow: "hidden",
};

const statusPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  borderRadius: 999,
  padding: "3px 8px",
  border: "1px solid var(--paper-edge)",
  background: "var(--fill-1)",
  color: "var(--muted-deep)",
  fontSize: 11,
  fontWeight: 800,
};

const miniStat: CSSProperties = {
  minWidth: 0,
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  padding: 10,
  display: "grid",
  gap: 4,
  background: "var(--fill-1)",
};

const actionButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink)",
  borderRadius: 8,
  padding: "7px 10px",
  fontSize: 12,
  fontWeight: 800,
  textDecoration: "none",
  cursor: "pointer",
};

const messageBox: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  padding: 10,
  background: "var(--fill-1)",
  color: "var(--muted-deep)",
  fontSize: 12,
  whiteSpace: "pre-wrap",
};

const plainIconButton: CSSProperties = {
  border: 0,
  background: "transparent",
  color: "var(--muted-deep)",
  padding: 2,
  cursor: "pointer",
  flexShrink: 0,
};

const card: CSSProperties = {
  border: "1px solid var(--paper-edge)",
  borderRadius: 8,
  padding: 14,
  background: "var(--fill-1)",
};

const sectionTitle: CSSProperties = {
  margin: "0 0 10px",
  fontSize: 12,
  color: "var(--ink)",
  fontWeight: 900,
  textTransform: "uppercase",
};

const listStack: CSSProperties = {
  display: "grid",
  gap: 7,
};

const fileRow: CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  gap: 10,
  borderBottom: "1px solid var(--paper-edge)",
  paddingBottom: 7,
  fontSize: 12,
  minWidth: 0,
};
