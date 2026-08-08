"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import {
  IconAtSign,
  IconBolt,
  IconCheck,
  IconKey,
  IconLayers,
  IconNetwork,
  IconPlus,
  IconRefresh,
  IconRoute,
  IconSettings,
  IconTrash,
  IconUsers,
} from "@/components/Icon";
import { classifyInstalledAgent } from "@/lib/agent-entity-kind";
import { buildAgentRoster, visibleRosterAgents } from "@/lib/agent-roster";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import type {
  InstalledAgent,
  InstalledFirm,
  TelegramConnectBinding,
  TelegramConnectStatus,
  TelegramConnectTargetKind,
} from "@/lib/types";

type TargetKind = "group" | "org" | "multi" | "single";
type SessionMode = "shared_chat" | "per_user";
type ConnectLogTone = "info" | "success" | "error";
type Translate = ReturnType<typeof useT>["t"];

interface ConnectTarget {
  id: string;
  targetKind: TelegramConnectTargetKind;
  targetId: string;
  kind: TargetKind;
  name: string;
  subtitle: string;
  description: string;
  source: string;
  routeHint: string;
  sessionMode: SessionMode;
  readiness: "ready" | "review";
}

interface ConnectLogRow {
  id: string;
  at: string;
  text: string;
  tone: ConnectLogTone;
}

function kindLabel(kind: TargetKind, t: Translate) {
  if (kind === "group") return t("connect.kind.group");
  if (kind === "org") return t("connect.kind.org");
  if (kind === "multi") return t("connect.kind.multi");
  return t("connect.kind.single");
}

function modeLabel(target: ConnectTarget | undefined, t: Translate) {
  if (!target) return t("connect.mode.choose");
  if (target.kind === "single") return t("connect.mode.single");
  return t("connect.mode.orchestrator");
}

function routeModeLabel(target: ConnectTarget, t: Translate) {
  if (target.kind === "single") return t("connect.route.single");
  return t("connect.route.orchestrator");
}

function statusLabel(status: TelegramConnectStatus, enabled: boolean, t: Translate) {
  if (!enabled) return t("connect.status.off");
  if (status === "waiting_for_chat") return t("connect.status.waiting");
  if (status === "chat_paired") return t("connect.status.chat_paired");
  if (status === "test_passed") return t("connect.status.test_passed");
  if (status === "running") return t("connect.status.running");
  if (status === "failed") return t("connect.status.failed");
  if (status === "bot_verified") return t("connect.status.bot_verified");
  return t("connect.status.draft");
}

function statusTone(status: TelegramConnectStatus, enabled: boolean) {
  if (!enabled || status === "disabled") return "off";
  if (status === "failed") return "failed";
  if (status === "running" || status === "test_passed") return "ready";
  if (status === "chat_paired") return "paired";
  return "waiting";
}

function sessionLabel(binding: TelegramConnectBinding, t: Translate) {
  if (!binding.enabled) return t("connect.session.off");
  if (!binding.hasToken) return t("connect.session.missing_token");
  if (binding.sessionRunning) return t("connect.session.on");
  if (binding.status === "failed") return t("connect.session.needs_restart");
  return t("connect.session.starting");
}

function sessionTone(binding: TelegramConnectBinding) {
  if (!binding.enabled || binding.status === "disabled") return "off";
  if (!binding.hasToken || binding.status === "failed") return "failed";
  if (binding.sessionRunning) return statusTone(binding.status, binding.enabled);
  return "waiting";
}

function sessionToggleLabel(binding: TelegramConnectBinding, t: Translate) {
  if (binding.enabled && binding.sessionRunning) return t("connect.toggle.stop");
  if (binding.enabled) return t("connect.toggle.restart");
  return t("connect.toggle.start");
}

function targetLivePolicy(target: ConnectTarget | undefined, t: Translate) {
  if (!target) return t("connect.policy.choose_first");
  if (target.readiness === "review") return t("connect.policy.review_group");
  if (target.kind === "single") return t("connect.policy.single_live");
  return t("connect.policy.orchestrator_live");
}

function bindingPolicy(binding: TelegramConnectBinding, t: Translate) {
  if (binding.targetMissing) return t("connect.policy.deleted_action");
  if (!binding.chatSessionId) return t("connect.policy.new_session");
  return t("connect.policy.live_existing");
}

function bindingErrorLabel(binding: TelegramConnectBinding, t: Translate) {
  if (!binding.lastError) return "";
  if (
    /keychain/i.test(binding.lastError) ||
    binding.lastError.includes("비밀 금고") ||
    binding.lastError.includes("비밀문자")
  ) {
    return t("connect.error.missing_local_secret");
  }
  return binding.lastError;
}

function friendlyError(err: unknown) {
  const raw = err instanceof Error ? err.message : String(err);
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/i, "")
    .replace(/^Error:\s*/i, "");
}

function nowLabel(locale: string) {
  return new Date().toLocaleTimeString(locale === "ko" ? "ko-KR" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function logId() {
  return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

/**
 * ★진행 중 상태는 화면 밖에 산다 — 오너 지시(2026-08-08).
 *
 * Telegram 자동 연결은 사용자가 브라우저에서 로그인할 때까지 기다린다(분 단위).
 * 그동안 다른 메뉴로 갔다 오면 컴포넌트가 언마운트되며 busy/로그가 사라져,
 * 진행 중인 연결이 화면에서 통째로 없던 일이 됐다. Main의 작업은 계속 돌고 있다.
 * 그래서 이 둘만 모듈 스코프에 둔다(빌드·클라우드 업로드와 같은 방식).
 */
interface ConnectProgress {
  busy: string | null;
  logs: ConnectLogRow[];
}
let connectProgress: ConnectProgress = { busy: null, logs: [] };
let connectProgressSnapshot: ConnectProgress = connectProgress;
const connectProgressListeners = new Set<() => void>();

function emitConnectProgress(next: ConnectProgress): void {
  connectProgress = next;
  connectProgressSnapshot = next;
  for (const listener of connectProgressListeners) listener();
}

function subscribeConnectProgress(listener: () => void): () => void {
  connectProgressListeners.add(listener);
  return () => {
    connectProgressListeners.delete(listener);
  };
}

function getConnectProgress(): ConnectProgress {
  return connectProgressSnapshot;
}

function setConnectBusy(busy: string | null): void {
  emitConnectProgress({ ...connectProgress, busy });
}

function pushConnectLog(row: ConnectLogRow): void {
  emitConnectProgress({ ...connectProgress, logs: [row, ...connectProgress.logs].slice(0, 24) });
}

export default function ConnectPage() {
  const { locale, t } = useT();
  const tokenInputRef = useRef<HTMLInputElement | null>(null);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [bindings, setBindings] = useState<TelegramConnectBinding[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [botToken, setBotToken] = useState("");
  const [botName, setBotName] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");
  // busy/logs 는 모듈 스토어 소유 — 메뉴를 옮겨도 진행 중인 연결이 남는다.
  const progress = useSyncExternalStore(subscribeConnectProgress, getConnectProgress, getConnectProgress);
  const busy = progress.busy;
  const logs = progress.logs;
  const setBusy = setConnectBusy;

  const appendLog = useCallback(
    (text: string, tone: ConnectLogTone = "info") => {
      pushConnectLog({ id: logId(), at: nowLabel(locale), text, tone });
    },
    [locale],
  );

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) {
      setLoading(false);
      return;
    }
    setLoading(true);
    try {
      const [agentRows, firmRows, bindingRows] = await Promise.all([
        api.team.list(),
        api.firms.list(),
        api.telegram.listBindings(),
      ]);
      setAgents(visibleRosterAgents(agentRows));
      setFirms(firmRows);
      setBindings(bindingRows);
    } catch (err) {
      const message = friendlyError(err);
      setToast(message);
      appendLog(message, "error");
    } finally {
      setLoading(false);
    }
  }, [appendLog]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!toast) return;
    const timer = window.setTimeout(() => setToast(""), 3200);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const targets = useMemo<ConnectTarget[]>(() => {
    const rows: ConnectTarget[] = [];

    const roster = buildAgentRoster(agents, firms);

    for (const firm of firms) {
      const loc = pickLocalized(firm, locale);
      const single = roster.firmKindById.get(firm.id) === "single";
      rows.push({
        id: `org:${firm.id}`,
        targetKind: "firm",
        targetId: firm.id,
        // One-member orgs appear like single agents, while the binding still targets the firm.
        kind: single ? "single" : "org",
        name: loc.name,
        subtitle: single ? t("connect.target.single.subtitle") : t("connect.target.org.subtitle"),
        description:
          loc.tagline ||
          (single ? t("connect.target.single.description") : t("connect.target.org.description")),
        source: t("connect.target.org.source"),
        routeHint: single ? t("connect.target.single.route") : t("connect.target.org.route"),
        sessionMode: single ? "per_user" : "shared_chat",
        readiness: "ready",
      });
    }

    for (const agent of roster.standaloneAgents) {
      // Agents represented by a firm row stay out of the standalone list.
      const loc = pickLocalized(agent, locale);
      // Keep team/single classification aligned with the shared entity classifier.
      const isTeam = classifyInstalledAgent(agent) === "multi";
      rows.push({
        id: `agent:${agent.id}`,
        targetKind: "agent",
        targetId: agent.id,
        kind: isTeam ? "multi" : "single",
        name: loc.name,
        subtitle: isTeam ? t("connect.target.team.subtitle") : t("connect.target.single.subtitle"),
        description:
          loc.tagline ||
          (isTeam ? t("connect.target.team.description") : t("connect.target.single.description")),
        source:
          agent.localPath && agent.assetSource !== "agent-cloud" && agent.assetSource !== "hub"
            ? t("connect.target.imported")
            : t("connect.target.installed"),
        routeHint: isTeam ? t("connect.target.team.route") : t("connect.target.single.route"),
        sessionMode: isTeam ? "shared_chat" : "per_user",
        readiness: "ready",
      });
    }

    const order: Record<TargetKind, number> = { org: 0, group: 1, multi: 2, single: 3 };
    return rows.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  }, [agents, firms, locale, t]);

  useEffect(() => {
    if (!targets.length) {
      setSelectedId("");
      return;
    }
    if (!selectedId || !targets.some((target) => target.id === selectedId)) {
      const connectedTarget = targets.find((target) =>
        bindings.some((binding) => binding.targetKind === target.targetKind && binding.targetId === target.targetId),
      );
      setSelectedId(connectedTarget?.id ?? "");
    }
  }, [bindings, selectedId, targets]);

  const selected = targets.find((target) => target.id === selectedId);
  const visibleBindings = useMemo(
    () => [...bindings].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [bindings],
  );
  const orphanCount = useMemo(() => visibleBindings.filter((b) => b.targetMissing).length, [visibleBindings]);

  const targetSections = useMemo(() => {
    const labels: Array<{ key: TargetKind; label: string }> = [
      { key: "org", label: t("connect.section.org") },
      { key: "group", label: t("connect.section.group") },
      { key: "multi", label: t("connect.section.multi") },
      { key: "single", label: t("connect.section.single") },
    ];
    return labels
      .map((section) => ({ ...section, rows: targets.filter((target) => target.kind === section.key) }))
      .filter((section) => section.rows.length > 0);
  }, [t, targets]);

  const openManualToken = useCallback(() => {
    setManualOpen(true);
    window.setTimeout(() => tokenInputRef.current?.focus(), 0);
    setToast(t("connect.toast.advanced_open"));
  }, [t]);

  const handleAutoConnect = useCallback(async () => {
    const api = ipc();
    if (!api || !selected) return;
    setBusy("auto");
    appendLog(t("connect.log.auto_start", { name: selected.name }));
    appendLog(t("connect.log.telegram_login_hint"));
    try {
      const result = await api.telegram.autoConnect({
        targetKind: selected.targetKind,
        targetId: selected.targetId,
        botName: botName.trim() || undefined,
      });
      setToast(result.message);
      appendLog(result.message, "success");
      await refresh();
    } catch (err) {
      const message = friendlyError(err);
      setToast(message);
      appendLog(message, "error");
    } finally {
      setBusy(null);
    }
  }, [appendLog, botName, refresh, selected, t]);

  const handlePruneOrphans = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    const orphanCount = bindings.filter((b) => b.targetMissing).length;
    if (orphanCount === 0) {
      setToast(t("connect.prune.none"));
      return;
    }
    if (!window.confirm(t("connect.prune.confirm", { n: orphanCount }))) return;
    setBusy("prune");
    try {
      const result = await api.telegram.pruneOrphans();
      const message = t("connect.prune.done", { n: result.removed });
      setToast(message);
      appendLog(message, "success");
      await refresh();
    } catch (err) {
      const message = friendlyError(err);
      setToast(message);
      appendLog(message, "error");
    } finally {
      setBusy(null);
    }
  }, [appendLog, bindings, refresh, t]);

  const focusTokenInput = useCallback(() => {
    setManualOpen(true);
    tokenInputRef.current?.focus();
    setToast(t("connect.toast.manual_hint"));
  }, [t]);

  const handleStart = useCallback(async () => {
    const api = ipc();
    const token = botToken.trim();
    if (!api || !selected) return;
    if (!token) {
      focusTokenInput();
      return;
    }
    setBusy("start");
    appendLog(t("connect.log.manual_start", { name: selected.name }));
    try {
      const result = await api.telegram.start({
        targetKind: selected.targetKind,
        targetId: selected.targetId,
        botToken: token,
      });
      setBotToken("");
      setToast(result.message);
      appendLog(result.message, "success");
      await refresh();
    } catch (err) {
      const message = friendlyError(err);
      setToast(message);
      appendLog(message, "error");
    } finally {
      setBusy(null);
    }
  }, [appendLog, botToken, focusTokenInput, refresh, selected, t]);

  const handleBindingAction = useCallback(
    async (binding: TelegramConnectBinding, action: "open" | "test" | "settings" | "clone" | "reset" | "resume" | "stop" | "remove") => {
      const api = ipc();
      if (!api) return;
      if (action === "reset" && !window.confirm(t("connect.action.reset_confirm"))) return;
      let deleteBotInBotFather = false;
      if (action === "remove") {
        if (!window.confirm(t("connect.remove.confirm"))) return;
        if (binding.botUsername) {
          deleteBotInBotFather = window.confirm(
            t("connect.remove.delete_bot_confirm", { bot: binding.botUsername }),
          );
        }
      }
      setBusy(`${action}:${binding.id}`);
      try {
        if (action === "open") {
          const result = await api.telegram.openBot(binding.id);
          setToast(result.message);
          appendLog(result.message, "success");
        } else if (action === "test") {
          appendLog(t("connect.log.test_start", { name: binding.targetName }));
          const result = await api.telegram.sendTest(binding.id);
          setToast(result.message);
          appendLog(result.message, "success");
          await refresh();
        } else if (action === "settings") {
          appendLog(t("connect.msg.bot_settings_start", { name: binding.targetName }));
          const result = await api.telegram.configureBotSettings(binding.id);
          setToast(result.message);
          appendLog(result.message, result.ok ? "success" : "info");
          await refresh();
        } else if (action === "clone") {
          appendLog(t("connect.log.clone_start", { name: binding.targetName }));
          const result = await api.telegram.clone({ sourceBindingId: binding.id });
          setToast(result.message);
          appendLog(result.message, "success");
          await refresh();
        } else if (action === "reset") {
          const next = await api.telegram.resetConversation(binding.id);
          const message = t("connect.msg.conversation_reset", { name: next.targetName });
          setToast(message);
          appendLog(message, "success");
          await refresh();
        } else if (action === "resume") {
          const next = await api.telegram.resume(binding.id);
          const message = next.sessionRunning
            ? t("connect.msg.session_on")
            : t("connect.msg.session_starting");
          setToast(message);
          appendLog(message, next.sessionRunning ? "success" : "info");
          await refresh();
        } else if (action === "stop") {
          await api.telegram.stop(binding.id);
          const message = t("connect.msg.session_off");
          setToast(message);
          appendLog(message, "success");
          await refresh();
        } else {
          const result = await api.telegram.remove(binding.id, deleteBotInBotFather);
          const message = !deleteBotInBotFather
            ? t("connect.msg.port_removed")
            : result?.botDeleted
              ? t("connect.msg.port_and_bot_removed")
              : t("connect.msg.bot_delete_failed");
          setToast(message);
          appendLog(message, deleteBotInBotFather && !result?.botDeleted ? "info" : "success");
          await refresh();
        }
      } catch (err) {
        const message = friendlyError(err);
        setToast(message);
        appendLog(message, "error");
      } finally {
        setBusy(null);
      }
    },
    [appendLog, refresh, t],
  );

  return (
    <div className="connect-root rd" style={{ position: "relative", display: "flex", flexDirection: "column", height: "100%", minHeight: 0 }}>
      <div className="titlebar-drag" style={{ position: "absolute", top: 0, left: 0, right: 0, height: 38 }} />
      <div className="connect-scroll">
        <main className="connect-shell connect-shell-telegram">
          <section className="connect-topbar" aria-labelledby="connect-title">
            <div className="connect-topbar-main">
              <span className="connect-channel-pill">
                <IconAtSign size={16} />
                Telegram
              </span>
              <h1 id="connect-title">{t("connect.title")}</h1>
              <p>{t("connect.intro")}</p>
            </div>
            <button className="connect-btn" type="button" onClick={() => void refresh()} disabled={loading}>
              <IconRefresh size={16} />
              {t("connect.refresh")}
            </button>
          </section>

          <div className="connect-workbench">
            <section className="connect-directory" aria-labelledby="connect-directory-title">
              <div className="connect-section-head">
                <div>
                  <p className="connect-kicker">{t("connect.choose.kicker")}</p>
                  <h2 id="connect-directory-title">{t("connect.choose.title")}</h2>
                </div>
                <span>{loading ? t("connect.loading") : t("connect.count.targets", { n: targets.length })}</span>
              </div>

              <div className="connect-directory-list">
                {targetSections.map((section) => (
                  <div className="connect-directory-section" key={section.key}>
                    <h3>{section.label}</h3>
                    {section.rows.map((target) => (
                      <button
                        key={target.id}
                        type="button"
                        className="connect-target-row"
                        data-active={selected?.id === target.id ? "true" : "false"}
                        onClick={() => setSelectedId(target.id)}
                      >
                        <span className="connect-target-icon" data-kind={target.kind}>
                          {target.kind === "org" ? <IconNetwork size={18} /> : target.kind === "group" ? <IconLayers size={18} /> : <IconUsers size={18} />}
                        </span>
                        <span className="connect-target-copy">
                          <strong>{target.name}</strong>
                          <small>{target.description}</small>
                        </span>
                        <span className="connect-target-meta">
                          <span data-tone={target.readiness === "review" ? "warning" : undefined}>
                            {target.readiness === "review" ? t("connect.badge.review") : kindLabel(target.kind, t)}
                          </span>
                          <small>{routeModeLabel(target, t)}</small>
                        </span>
                        <span className="connect-row-action" aria-hidden="true">
                          {selected?.id === target.id ? <IconCheck size={14} /> : null}
                        </span>
                      </button>
                    ))}
                  </div>
                ))}
                {!loading && targets.length === 0 ? (
                  <div className="connect-empty">
                    <IconUsers size={22} />
                    <strong>{t("connect.empty.title")}</strong>
                    <span>{t("connect.empty.body")}</span>
                    <div className="connect-empty-actions">
                      <Link href="/library/agents">{t("connect.empty.create_agent")}</Link>
                    </div>
                  </div>
                ) : null}
              </div>
            </section>

            <aside className="connect-port-panel" aria-labelledby="connect-port-title">
              <div className="connect-section-head">
                <div>
                  <p className="connect-kicker">{t("connect.ports.kicker")}</p>
                  <h2 id="connect-port-title">{t("connect.ports.title")}</h2>
                </div>
                <span>{t("connect.count.ports", { n: visibleBindings.length })}</span>
              </div>

              <div className="connect-port-setup">
                <div className="connect-selected-strip" data-empty={selected ? undefined : "true"}>
                  <div className="connect-selected-main">
                    <span>{t("connect.selected.label")}</span>
                    <strong>{selected?.name ?? t("connect.mode.choose")}</strong>
                  </div>
                  <p>{selected ? `${modeLabel(selected, t)} · ${targetLivePolicy(selected, t)}` : targetLivePolicy(selected, t)}</p>
                </div>

                {selected ? (
                  <label className="connect-secret-box">
                    <span>{t("connect.bot_name.label")}</span>
                    <input
                      value={botName}
                      onChange={(event) => setBotName(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      maxLength={62}
                      placeholder={t("connect.bot_name.placeholder")}
                    />
                    <small>{t("connect.bot_name.help")}</small>
                  </label>
                ) : null}

                <button
                className="connect-btn primary connect-port-create"
                type="button"
                onClick={() => void handleAutoConnect()}
                disabled={!selected || selected.readiness === "review" || busy === "auto"}
              >
                  <IconBolt size={15} />
                  {busy === "auto" ? t("connect.action.auto_busy") : t("connect.action.create_port")}
                </button>
              </div>

              {busy === "auto" ? (
                <div className="connect-login-wait">
                  <IconKey size={16} />
                  <div>
                    <strong>{t("connect.login_wait.title")}</strong>
                    <span>{t("connect.login_wait.body")}</span>
                  </div>
                </div>
              ) : null}

              {orphanCount > 0 ? (
                <div className="connect-orphan-strip">
                  <span>{t("connect.badge.deleted_title")}</span>
                  <button type="button" onClick={() => void handlePruneOrphans()} disabled={busy === "prune"}>
                    <IconTrash size={13} />
                    {t("connect.prune.button")} ({orphanCount})
                  </button>
                </div>
              ) : null}

              <div className="connect-port-list">
                {visibleBindings.map((binding) => {
                  const missing = binding.targetMissing;
                  return (
                    <div
                      className="connect-port-row"
                      data-status={missing ? "off" : sessionTone(binding)}
                      data-missing={missing ? "true" : undefined}
                      key={binding.id}
                    >
                      <div className="connect-port-head">
                        <span className="connect-port-bot">
                          <IconAtSign size={14} />
                          {binding.botUsername ? `@${binding.botUsername}` : binding.hasToken ? t("connect.bot.ready") : t("connect.bot.needs")}
                        </span>
                        <span className="connect-port-arrow" aria-hidden="true">
                          <IconRoute size={14} />
                        </span>
                        <strong className="connect-port-target" title={binding.targetName}>
                          {binding.targetName}
                        </strong>
                        {missing ? (
                          <span className="connect-port-badge deleted" title={t("connect.badge.deleted_title")}>
                            {t("connect.badge.deleted")}
                          </span>
                        ) : (
                          <span className="connect-port-badge" data-tone={sessionTone(binding)}>
                            {statusLabel(binding.status, binding.enabled, t)}
                          </span>
                        )}
                      </div>
                      <div className="connect-port-sub">
                        <span className="connect-port-chat">{binding.telegramChatTitle || t("connect.chat.waiting")}</span>
                        {!missing ? <span className="connect-port-dot">·</span> : null}
                        {!missing ? <span>{sessionLabel(binding, t)}</span> : null}
                        {binding.automationReportEnabled ? (
                          <>
                            <span className="connect-port-dot">·</span>
                            <span>{t("connect.meta.automation_report")}</span>
                          </>
                        ) : null}
                      </div>
                      <p className="connect-port-policy">{bindingPolicy(binding, t)}</p>
                      <div className="connect-port-actions">
                        {missing ? (
                          <button
                            type="button"
                            className="danger"
                            onClick={() => void handleBindingAction(binding, "remove")}
                            disabled={busy === `remove:${binding.id}`}
                          >
                            <IconTrash size={13} />
                            {t("connect.action.remove_port")}
                          </button>
                        ) : (
                          <>
                            <div className="connect-port-primary-actions">
                              <button type="button" onClick={() => void handleBindingAction(binding, "open")} disabled={!binding.botUsername || busy === `open:${binding.id}`}>
                                {t("connect.action.open")}
                              </button>
                              <button type="button" onClick={() => void handleBindingAction(binding, "test")} disabled={!binding.telegramChatId || busy === `test:${binding.id}`}>
                                {t("connect.action.test")}
                              </button>
                              <button
                                type="button"
                                onClick={() => void handleBindingAction(binding, binding.enabled && binding.sessionRunning ? "stop" : "resume")}
                                disabled={busy === `resume:${binding.id}` || busy === `stop:${binding.id}`}
                              >
                                {sessionToggleLabel(binding, t)}
                              </button>
                            </div>
                            <div className="connect-port-secondary-actions">
                              <button
                                type="button"
                                title={t("connect.action.reset_title")}
                                aria-label={t("connect.action.reset_conversation")}
                                onClick={() => void handleBindingAction(binding, "reset")}
                                disabled={!binding.chatSessionId || busy === `reset:${binding.id}`}
                              >
                                <IconRefresh size={13} />
                              </button>
                              <button
                                type="button"
                                title={t("connect.action.clone_title")}
                                aria-label={t("connect.action.clone")}
                                onClick={() => void handleBindingAction(binding, "clone")}
                                disabled={!binding.hasToken || busy === `clone:${binding.id}`}
                              >
                                <IconPlus size={13} />
                              </button>
                              <button
                                type="button"
                                title={t("connect.bot_settings.button_title")}
                                aria-label={t("connect.action.bot_settings")}
                                onClick={() => void handleBindingAction(binding, "settings")}
                                disabled={!binding.botUsername || busy === `settings:${binding.id}`}
                              >
                                <IconSettings size={13} />
                              </button>
                              <button
                                type="button"
                                className="ghost-icon"
                                onClick={() => void handleBindingAction(binding, "remove")}
                                disabled={busy === `remove:${binding.id}`}
                                aria-label={t("connect.action.remove_port")}
                                title={t("connect.action.remove_port")}
                              >
                                <IconTrash size={13} />
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                      {bindingErrorLabel(binding, t) && !missing ? <p className="connect-binding-error">{bindingErrorLabel(binding, t)}</p> : null}
                    </div>
                  );
                })}
                {!loading && visibleBindings.length === 0 ? (
                  <div className="connect-port-empty">
                    <IconAtSign size={20} />
                    <strong>{t("connect.port_empty.title")}</strong>
                    <span>{t("connect.port_empty.body")}</span>
                  </div>
                ) : null}
              </div>

              <button className="connect-manual-toggle" type="button" onClick={manualOpen ? () => setManualOpen(false) : openManualToken}>
                {manualOpen ? t("connect.manual.hide") : t("connect.manual.show")}
              </button>

              {manualOpen ? (
                <>
                  <label className="connect-secret-box">
                    <span>{t("connect.secret.label")}</span>
                    <input
                      ref={tokenInputRef}
                      type="password"
                      value={botToken}
                      onChange={(event) => setBotToken(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={t("connect.secret.placeholder")}
                    />
                    <small>{t("connect.secret.help")}</small>
                  </label>

                  <button
                    className="connect-btn wide"
                    type="button"
                    onClick={() => void handleStart()}
                    disabled={!selected || !botToken.trim() || busy === "start"}
                  >
                    <IconKey size={16} />
                    {busy === "start" ? t("connect.action.checking_bot") : t("connect.action.connect_token")}
                  </button>
                </>
              ) : null}
            </aside>
          </div>

          <section className="connect-log-panel" aria-labelledby="connect-log-title">
            <div className="connect-section-head">
              <div>
                <p className="connect-kicker">{t("connect.log.kicker")}</p>
                <h2 id="connect-log-title">{t("connect.log.title")}</h2>
              </div>
            </div>
            <div className="connect-log-list" role="log" aria-live="polite">
              {logs.length > 0 ? (
                logs.map((row) => (
                  <div className="connect-log-row" data-tone={row.tone} key={row.id}>
                    <time>{row.at}</time>
                    <span>{row.text}</span>
                  </div>
                ))
              ) : (
                <div className="connect-log-empty">
                  <IconCheck size={16} />
                  <span>{t("connect.log.empty")}</span>
                </div>
              )}
            </div>
          </section>
        </main>
      </div>
      {toast ? <div className="connect-toast">{toast}</div> : null}
    </div>
  );
}
