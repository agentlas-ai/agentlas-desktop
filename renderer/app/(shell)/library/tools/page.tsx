// Agent-made Tools registry.
// Shows generated local tools that can be smoke-tested and installed as MCP servers.
"use client";
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from "react";
import Link from "next/link";
import { ipc } from "@/lib/ipc";
import { visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT } from "@/lib/i18n";
import type {
  InstalledAgent,
  Project,
  ToolFactoryOperationKind,
  ToolFactoryOperationRecord,
  ToolFactoryToolRecord,
  ToolFactoryToolStatus,
} from "@/lib/types";
import {
  IconBolt,
  IconCheck,
  IconChevronRight,
  IconClose,
  IconKey,
  IconLayers,
  IconSparkles,
  IconWand,
} from "@/components/Icon";

export default function LibraryToolsPage() {
  const { t, locale } = useT();
  const [tools, setTools] = useState<ToolFactoryToolRecord[]>([]);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [operations, setOperations] = useState<ToolFactoryOperationRecord[]>([]);
  const [busyAction, setBusyAction] = useState<ToolFactoryOperationKind | null>(null);
  const [message, setMessage] = useState("");

  const selected = tools.find((tool) => tool.id === selectedId) ?? tools[0] ?? null;

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const [nextTools, nextAgents, nextProjects] = await Promise.all([
      api.toolFactory.listTools(),
      api.team.list(),
      api.projects.list(),
    ]);
    setTools(nextTools);
    setAgents(visibleAgents(nextAgents));
    setProjects(nextProjects);
    setSelectedId((cur) => (cur && nextTools.some((tool) => tool.id === cur) ? cur : nextTools[0]?.id ?? null));
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
    void api.toolFactory.listOperations(selected.id).then((rows) => {
      if (!cancelled) setOperations(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [selected?.id]);

  const agentById = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents]);
  const projectById = useMemo(() => new Map(projects.map((project) => [project.id, project])), [projects]);

  const runAction = useCallback(
    async (kind: ToolFactoryOperationKind) => {
      const api = ipc();
      if (!api || !selected) return;
      setBusyAction(kind);
      setMessage("");
      try {
        if (kind === "run-smoke-test") {
          const result = await api.toolFactory.runSmoke({ rootPath: selected.rootPath });
          setMessage(
            result.ok
              ? locale === "ko" ? "검증을 통과했습니다. 통과한 MCP는 다음 턴부터 사용 가능할 수 있습니다." : "Check passed. A passing MCP may be available from the next turn."
              : locale === "ko" ? `검증에 실패했습니다. 파일은 바뀌지 않았습니다. exit ${result.exitCode ?? "unknown"}` : `Check failed. Files were not changed. exit ${result.exitCode ?? "unknown"}`,
          );
        } else if (kind === "install-mcp") {
          const result = await api.toolFactory.installMcp({ rootPath: selected.rootPath });
          setMessage(locale === "ko" ? `MCP를 설치했습니다: ${result.server.name}` : `MCP installed: ${result.server.name}`);
        } else if (kind === "archive") {
          const op = await api.toolFactory.archive({ rootPath: selected.rootPath });
          const result = op.result && typeof op.result === "object" && !Array.isArray(op.result) ? op.result as Record<string, unknown> : {};
          const mcpNote = result.removedServerId ? locale === "ko" ? ` · MCP 등록 해제: ${String(result.removedServerId)}` : ` · MCP unregistered: ${String(result.removedServerId)}` : "";
          setMessage((locale === "ko" ? "복원 가능한 보관으로 옮겼습니다: " : "Moved to a reversible archive: ") + `${String(result.archivePath ?? selected.rootPath)}${mcpNote}`);
        } else if (kind === "restore") {
          const op = await api.toolFactory.restore({ rootPath: selected.rootPath });
          const result = op.result && typeof op.result === "object" && !Array.isArray(op.result) ? op.result as Record<string, unknown> : {};
          setMessage(String(result.summary ?? "Generated tool restored."));
        }
        await refresh();
        const latest = await api.toolFactory.getTool(selected.id);
        if (latest) {
          setSelectedId(latest.id);
          setOperations(await api.toolFactory.listOperations(latest.id));
        }
      } catch (err: unknown) {
        setMessage(err instanceof Error ? err.message : String(err));
      } finally {
        setBusyAction(null);
      }
    },
    [locale, refresh, selected],
  );

  const copyRoot = useCallback(() => {
    if (!selected) return;
    void navigator.clipboard.writeText(selected.rootPath);
    setMessage("Copied root path");
  }, [selected]);

  return (
    <div style={{ height: "100%", display: "flex", minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      <section style={{ flex: 1, minWidth: 0, overflowY: "auto", padding: "24px 32px" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
          <p style={{ margin: 0, color: "var(--muted-deep)", fontSize: 13 }}>
            {t("library.tools.subtitle")}
          </p>
          <span style={countPill}>
            <IconWand size={12} />
            {tools.length}
          </span>
        </div>

        {tools.length === 0 ? (
          <div style={emptyState}>
            <IconWand size={24} style={{ color: "var(--muted-deep)" }} />
            <strong style={{ color: "var(--ink)", fontSize: 14 }}>{t("library.tools.empty")}</strong>
            <span style={{ fontSize: 12, color: "var(--muted-deep)" }}>{t("library.tools.empty_hint")}</span>
            <Link href="/" style={{ color: "var(--accent)", fontWeight: 700, textDecoration: "none", marginTop: 4 }}>
              {t("sidebar.new_chat")} <IconChevronRight size={11} />
            </Link>
          </div>
        ) : (
          <ul style={{ listStyle: "none", padding: 0, margin: 0, display: "grid", gap: 8 }}>
            {tools.map((tool) => {
              const active = tool.id === selected?.id;
              const agent = agentById.get(tool.agentId);
              const project = tool.projectId ? projectById.get(tool.projectId) : null;
              return (
                <li key={tool.id}>
                  <button
                    onClick={() => setSelectedId(tool.id)}
                    style={{
                      ...toolRow,
                      borderColor: active ? "var(--accent)" : "var(--paper-edge)",
                      background: active ? "var(--fill-1)" : "var(--paper)",
                    }}
                  >
                    <span style={toolIcon(tool.status)}>
                      <IconWand size={15} />
                    </span>
                    <span style={{ minWidth: 0, flex: 1, display: "grid", gap: 4, textAlign: "left" }}>
                      <span style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0 }}>
                        <strong style={ellipsis}>{tool.toolName}</strong>
                        <StatusPill status={tool.status} />
                      </span>
                      <span style={{ display: "flex", gap: 8, color: "var(--muted-deep)", fontSize: 11, minWidth: 0, flexWrap: "wrap" }}>
                        <span>{tool.domain}</span>
                        <span>{tool.kind}</span>
                        {agent && <span>{pickLocalized(agent, locale).name}</span>}
                        {project && <span>{project.name}</span>}
                      </span>
                    </span>
                    {tool.installedServerId && (
                      <span style={metricPill}>
                        <IconKey size={11} />
                        MCP
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <aside style={detailPane}>
        {selected ? (
          <ToolDetail
            tool={selected}
            agent={agentById.get(selected.agentId) ?? null}
            project={selected.projectId ? projectById.get(selected.projectId) ?? null : null}
            operations={operations}
            busyAction={busyAction}
            message={message}
            onCopyRoot={copyRoot}
            onInstallMcp={() => void runAction("install-mcp")}
            onRunSmoke={() => void runAction("run-smoke-test")}
            onArchive={() => void runAction("archive")}
            onRestore={() => void runAction("restore")}
            onClearMessage={() => setMessage("")}
          />
        ) : (
          <div style={{ color: "var(--muted-deep)", fontSize: 13 }}>{t("library.tools.empty")}</div>
        )}
      </aside>
    </div>
  );
}

function ToolDetail({
  tool,
  agent,
  project,
  operations,
  busyAction,
  message,
  onCopyRoot,
  onInstallMcp,
  onRunSmoke,
  onArchive,
  onRestore,
  onClearMessage,
}: {
  tool: ToolFactoryToolRecord;
  agent: InstalledAgent | null;
  project: Project | null;
  operations: ToolFactoryOperationRecord[];
  busyAction: ToolFactoryOperationKind | null;
  message: string;
  onCopyRoot: () => void;
  onInstallMcp: () => void;
  onRunSmoke: () => void;
  onArchive: () => void;
  onRestore: () => void;
  onClearMessage: () => void;
}) {
  const { t, locale } = useT();
  const files = [tool.rootPath, tool.configPath, tool.toolPath, tool.mcpPath, tool.smokePath];
  const parameters = Array.isArray(tool.scaffold.files) ? tool.scaffold.files.length : 0;

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", minHeight: 0 }}>
      <div style={{ padding: "22px 22px 16px", borderBottom: "var(--hairline)", display: "grid", gap: 12 }}>
        <div style={{ display: "grid", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <StatusPill status={tool.status} />
            <span style={{ fontSize: 11, color: "var(--muted-deep)" }}>
              {t("library.tools.updated", { date: shortDate(tool.updatedAt, locale) })}
            </span>
          </div>
          <h2 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 21, lineHeight: 1.1 }}>
            {tool.toolName}
          </h2>
          <p style={{ margin: 0, color: "var(--muted-deep)", fontSize: 12, lineHeight: 1.5 }}>
            {tool.scaffold.summary}
          </p>
        </div>

        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
          <MiniStat label="Domain" value={tool.domain} />
          <MiniStat label="Kind" value={tool.kind} />
          <MiniStat label="Agent" value={agent ? pickLocalized(agent, locale).name : tool.agentId} />
          <MiniStat label="Project" value={project?.name || "Local"} />
        </div>

        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          <ActionButton href={`/chat?id=${tool.chatId}`} label={t("library.tools.open_chat")} icon={<IconSparkles size={12} />} />
          <ActionButton onClick={onCopyRoot} label={t("library.tools.copy_path")} icon={<IconLayers size={12} />} />
          <ActionButton onClick={onInstallMcp} label={t("library.tools.install_mcp")} icon={<IconKey size={12} />} busy={busyAction === "install-mcp"} disabled={tool.status === "archived"} />
          <ActionButton onClick={onRunSmoke} label={t("library.tools.run_smoke")} icon={<IconBolt size={12} />} busy={busyAction === "run-smoke-test"} disabled={tool.status === "archived"} />
          {tool.status === "archived" ? (
            <ActionButton onClick={onRestore} label={t("library.tools.restore")} icon={<IconCheck size={12} />} busy={busyAction === "restore"} />
          ) : (
            <ActionButton onClick={onArchive} label={t("library.tools.archive")} icon={<IconClose size={12} />} busy={busyAction === "archive"} />
          )}
        </div>
        <div style={toolActionNote}>
          {locale === "ko"
            ? "주의: 검증이 통과하면 이 MCP가 다음 턴부터 사용 가능하도록 등록될 수 있습니다. 확인만 원했다면 결과를 본 뒤 보관하거나 비활성 상태를 확인하세요."
            : "Note: a passing check can register this MCP for use on the next turn. If you only wanted to inspect it, review the result and archive or disable it if needed."}
        </div>

        {message && (
          <div style={messageBox}>
            <span style={{ minWidth: 0, overflowWrap: "anywhere" }}>{message}</span>
            <button onClick={onClearMessage} aria-label={t("common.close")} style={plainIconButton}>
              <IconClose size={12} />
            </button>
          </div>
        )}
      </div>

      <div style={{ flex: 1, minHeight: 0, overflowY: "auto", padding: "18px 22px", display: "grid", gap: 18, alignContent: "start" }}>
        <DetailSection title={t("library.tools.contract")}>
          <div style={{ display: "grid", gap: 6 }}>
            <Line label="Requested" value={tool.requestedToolId} />
            <Line label="Generated" value={tool.toolId} />
            <Line label="Files" value={String(parameters)} />
            <Line label="Server" value={tool.installedServerId || "not installed"} />
          </div>
        </DetailSection>

        <DetailSection title={t("library.tools.operations")}>
          {operations.length ? (
            <div style={{ display: "grid", gap: 0, borderTop: "var(--hairline)" }}>
              {operations.map((op) => (
                <div key={op.id} style={operationRow}>
                  <span style={{ color: op.ok ? "var(--green-deep)" : "var(--danger, #b4533a)" }}>
                    {op.ok ? <IconCheck size={13} /> : <IconClose size={13} />}
                  </span>
                  <div style={{ minWidth: 0, display: "grid", gap: 2 }}>
                    <strong style={{ fontSize: 12 }}>{operationLabel(op.operation)}</strong>
                    <span style={{ color: "var(--muted-deep)", fontSize: 11 }}>{operationSummary(op)}</span>
                  </div>
                  <span style={{ fontSize: 10, color: "var(--muted)", whiteSpace: "nowrap" }}>{shortDate(op.createdAt, locale)}</span>
                </div>
              ))}
            </div>
          ) : (
            <MutedLine text={t("library.tools.no_operations")} />
          )}
        </DetailSection>

        <DetailSection title={t("library.tools.files")}>
          <div style={{ display: "grid", gap: 5 }}>
            {files.map((file) => (
              <code key={file} style={filePath}>
                {file}
              </code>
            ))}
          </div>
        </DetailSection>
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: ToolFactoryToolStatus }) {
  const { t } = useT();
  return (
    <span style={{ ...statusPill, ...statusColors(status) }}>
      {statusLabel(status, t)}
    </span>
  );
}

function MiniStat({ label, value }: { label: string; value: string }) {
  return (
    <div style={miniStat}>
      <span style={{ fontSize: 10, color: "var(--muted)", textTransform: "uppercase", fontWeight: 800 }}>{label}</span>
      <strong style={{ fontSize: 12, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{value}</strong>
    </div>
  );
}

function Line({ label, value }: { label: string; value: string }) {
  return (
    <div style={lineItem}>
      <span style={{ width: 82, flexShrink: 0, color: "var(--muted-deep)", fontSize: 11, fontWeight: 800 }}>{label}</span>
      <code style={{ color: "var(--ink-soft)", fontSize: 11, overflowWrap: "anywhere" }}>{value}</code>
    </div>
  );
}

function DetailSection({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: "grid", gap: 8 }}>
      <h3 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 12, letterSpacing: 0, color: "var(--ink)" }}>
        {title}
      </h3>
      {children}
    </section>
  );
}

function ActionButton({
  href,
  onClick,
  label,
  icon,
  busy,
  disabled,
}: {
  href?: string;
  onClick?: () => void;
  label: string;
  icon: ReactNode;
  busy?: boolean;
  disabled?: boolean;
}) {
  const content = (
    <>
      {icon}
      <span>{busy ? "..." : label}</span>
    </>
  );
  if (href) {
    return (
      <Link href={href} style={{ ...actionButton, textDecoration: "none" }}>
        {content}
      </Link>
    );
  }
  return (
    <button onClick={onClick} disabled={busy || disabled} style={{ ...actionButton, opacity: disabled ? 0.55 : 1 }}>
      {content}
    </button>
  );
}

function MutedLine({ text }: { text: string }) {
  return <div style={{ color: "var(--muted-deep)", fontSize: 12 }}>{text}</div>;
}

function statusLabel(status: ToolFactoryToolStatus, t: ReturnType<typeof useT>["t"]): string {
  switch (status) {
    case "mcp-installed":
      return t("library.tools.status.mcp-installed");
    case "restored":
      return t("library.tools.status.restored");
    case "smoke-passed":
      return t("library.tools.status.smoke-passed");
    case "smoke-failed":
      return t("library.tools.status.smoke-failed");
    case "archived":
      return t("library.tools.status.archived");
    case "scaffolded":
    default:
      return t("library.tools.status.scaffolded");
  }
}

function statusColors(status: ToolFactoryToolStatus): CSSProperties {
  if (status === "smoke-passed" || status === "mcp-installed" || status === "restored") {
    return { background: "rgba(99,154,118,0.16)", color: "var(--green-deep)" };
  }
  if (status === "smoke-failed") {
    return { background: "rgba(224,120,96,0.16)", color: "#b4533a" };
  }
  if (status === "archived") {
    return { background: "var(--paper-2)", color: "var(--muted)" };
  }
  return { background: "var(--paper-2)", color: "var(--muted-deep)" };
}

function toolIcon(status: ToolFactoryToolStatus): CSSProperties {
  return {
    width: 34,
    height: 34,
    borderRadius: 8,
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
    ...statusColors(status),
  };
}

function operationLabel(operation: ToolFactoryOperationKind): string {
  if (operation === "install-mcp") return "MCP install";
  if (operation === "run-smoke-test") return "Validation check";
  if (operation === "archive") return "Archive";
  if (operation === "restore") return "Restore";
  return "Scaffold";
}

function operationSummary(op: ToolFactoryOperationRecord): string {
  if (!op.result || typeof op.result !== "object" || Array.isArray(op.result)) {
    return op.ok ? "Completed" : "Failed";
  }
  const result = op.result as Record<string, unknown>;
  if (op.operation === "install-mcp") {
    const server = result.server && typeof result.server === "object" && !Array.isArray(result.server)
      ? (result.server as Record<string, unknown>).name
      : undefined;
    return String(server ?? "MCP installed");
  }
  if (op.operation === "run-smoke-test") {
    return `exit ${String(result.exitCode ?? "unknown")}`;
  }
  if (op.operation === "archive") {
    const removedServer = result.removedServerId ? ` · MCP removed ${String(result.removedServerId)}` : "";
    return `Reversible archive${removedServer}`;
  }
  if (op.operation === "restore") {
    const restoredServer = result.restoredServerId ? ` · MCP restored ${String(result.restoredServerId)}` : "";
    return `Restored${restoredServer}`;
  }
  return String(result.summary ?? "Scaffolded");
}

function shortDate(value: string, locale: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return value;
  return d.toLocaleString(locale === "en" ? "en-US" : "ko-KR", {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

const countPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "5px 9px",
  borderRadius: 999,
  border: "1px solid var(--paper-edge)",
  background: "var(--paper)",
  color: "var(--ink-soft)",
  fontSize: 12,
  fontWeight: 800,
};

const emptyState: CSSProperties = {
  minHeight: 260,
  border: "1.5px dashed var(--paper-edge)",
  borderRadius: "var(--radius-md)",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
  flexDirection: "column",
  gap: 8,
  textAlign: "center",
};

const toolRow: CSSProperties = {
  width: "100%",
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "10px 12px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  cursor: "pointer",
  minWidth: 0,
};

const ellipsis: CSSProperties = {
  minWidth: 0,
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  fontFamily: "var(--font-head)",
  fontSize: 14,
};

const statusPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  height: 20,
  padding: "0 7px",
  borderRadius: 999,
  fontSize: 10,
  fontWeight: 800,
  whiteSpace: "nowrap",
};

const metricPill: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  flexShrink: 0,
  padding: "4px 7px",
  borderRadius: 999,
  background: "var(--paper-2)",
  color: "var(--muted-deep)",
  fontSize: 11,
  fontWeight: 700,
};

const detailPane: CSSProperties = {
  width: 440,
  maxWidth: "46vw",
  minWidth: 340,
  borderLeft: "var(--hairline)",
  background: "var(--paper)",
  minHeight: 0,
  overflow: "hidden",
};

const miniStat: CSSProperties = {
  display: "grid",
  gap: 3,
  minWidth: 0,
  padding: "8px 9px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
};

const actionButton: CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 5,
  padding: "7px 10px",
  borderRadius: "var(--radius-md)",
  border: "1px solid var(--paper-edge)",
  background: "var(--paper-2)",
  color: "var(--ink-soft)",
  fontSize: 11,
  fontWeight: 800,
  cursor: "pointer",
};

const toolActionNote: CSSProperties = {
  border: "1px solid rgba(186,116,44,0.28)",
  background: "rgba(233,169,108,0.10)",
  color: "var(--muted-deep)",
  borderRadius: "var(--radius-md)",
  padding: "7px 9px",
  fontSize: 11,
  lineHeight: 1.45,
};

const messageBox: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 8,
  justifyContent: "space-between",
  padding: "8px 10px",
  borderRadius: "var(--radius-md)",
  background: "var(--fill-1)",
  color: "var(--ink-soft)",
  fontSize: 12,
};

const plainIconButton: CSSProperties = {
  width: 22,
  height: 22,
  display: "inline-flex",
  alignItems: "center",
  justifyContent: "center",
  background: "transparent",
  border: "none",
  color: "var(--muted-deep)",
  cursor: "pointer",
};

const lineItem: CSSProperties = {
  display: "flex",
  alignItems: "flex-start",
  gap: 8,
  padding: "8px 0",
  borderTop: "var(--hairline)",
};

const operationRow: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "18px minmax(0, 1fr) auto",
  alignItems: "center",
  gap: 8,
  padding: "9px 0",
  borderBottom: "var(--hairline)",
};

const filePath: CSSProperties = {
  display: "block",
  padding: "6px 8px",
  borderRadius: 6,
  background: "var(--paper-2)",
  color: "var(--ink-soft)",
  fontSize: 11,
  overflowWrap: "anywhere",
};
