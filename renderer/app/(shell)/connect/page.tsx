"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  IconAtSign,
  IconBolt,
  IconCheck,
  IconKey,
  IconLayers,
  IconNetwork,
  IconRefresh,
  IconRoute,
  IconTrash,
  IconUsers,
} from "@/components/Icon";
import { visibleAgents } from "@/lib/agent-visibility";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import type {
  AgentGroupResolved,
  InstalledAgent,
  InstalledFirm,
  TelegramConnectBinding,
  TelegramConnectStatus,
  TelegramConnectTargetKind,
} from "@/lib/types";

type TargetKind = "group" | "org" | "multi" | "single";
type SessionMode = "shared_chat" | "per_user";
type ConnectLogTone = "info" | "success" | "error";

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

function kindLabel(kind: TargetKind, ko: boolean) {
  if (kind === "group") return ko ? "저장한 조합" : "Saved group";
  if (kind === "org") return ko ? "조직도" : "Organization";
  if (kind === "multi") return ko ? "팀 에이전트" : "Team agent";
  return ko ? "개별 에이전트" : "Single agent";
}

function modeLabel(target: ConnectTarget | undefined, ko: boolean) {
  if (!target) return ko ? "대상을 고르세요" : "Choose a target";
  if (target.kind === "single") return ko ? "이 에이전트 전용 봇 포트" : "Dedicated bot port";
  return ko ? "오케스트레이터 봇 포트" : "Orchestrator bot port";
}

function routeModeLabel(target: ConnectTarget, ko: boolean) {
  if (target.kind === "single") return ko ? "전용 봇" : "Dedicated bot";
  return ko ? "오케스트레이터" : "Orchestrator";
}

function statusLabel(status: TelegramConnectStatus, enabled: boolean, ko: boolean) {
  if (!enabled) return ko ? "꺼짐" : "Off";
  if (status === "waiting_for_chat") return ko ? "Telegram 방 기다림" : "Waiting for chat";
  if (status === "chat_paired") return ko ? "방 연결됨" : "Chat paired";
  if (status === "test_passed") return ko ? "테스트 통과" : "Test passed";
  if (status === "running") return ko ? "켜짐" : "Running";
  if (status === "failed") return ko ? "확인 필요" : "Needs attention";
  if (status === "bot_verified") return ko ? "봇 확인됨" : "Bot verified";
  return ko ? "준비 중" : "Draft";
}

function statusTone(status: TelegramConnectStatus, enabled: boolean) {
  if (!enabled || status === "disabled") return "off";
  if (status === "failed") return "failed";
  if (status === "running" || status === "test_passed") return "ready";
  if (status === "chat_paired") return "paired";
  return "waiting";
}

function sessionLabel(binding: TelegramConnectBinding, ko: boolean) {
  if (!binding.enabled) return ko ? "세션 꺼짐" : "Session off";
  if (!binding.hasToken) return ko ? "비밀문자 없음" : "Missing token";
  if (binding.sessionRunning) return ko ? "세션 켜짐" : "Session on";
  if (binding.status === "failed") return ko ? "복구 필요" : "Needs restart";
  return ko ? "세션 준비 중" : "Starting";
}

function sessionTone(binding: TelegramConnectBinding) {
  if (!binding.enabled || binding.status === "disabled") return "off";
  if (!binding.hasToken || binding.status === "failed") return "failed";
  if (binding.sessionRunning) return statusTone(binding.status, binding.enabled);
  return "waiting";
}

function sessionToggleLabel(binding: TelegramConnectBinding, ko: boolean) {
  if (binding.enabled && binding.sessionRunning) return ko ? "끄기" : "Stop";
  if (binding.enabled) return ko ? "다시 켜기" : "Restart";
  return ko ? "켜기" : "Start";
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

export default function ConnectPage() {
  const { locale } = useT();
  const ko = locale === "ko";
  const tokenInputRef = useRef<HTMLInputElement | null>(null);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [groups, setGroups] = useState<AgentGroupResolved[]>([]);
  const [bindings, setBindings] = useState<TelegramConnectBinding[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [botToken, setBotToken] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState("");
  const [logs, setLogs] = useState<ConnectLogRow[]>([]);

  const appendLog = useCallback(
    (text: string, tone: ConnectLogTone = "info") => {
      setLogs((rows) => [{ id: logId(), at: nowLabel(locale), text, tone }, ...rows].slice(0, 24));
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
      const [agentRows, firmRows, groupRows, bindingRows] = await Promise.all([
        api.team.list(),
        api.firms.list(),
        api.agentGroups.listResolved(),
        api.telegram.listBindings(),
      ]);
      setAgents(visibleAgents(agentRows));
      setFirms(firmRows);
      setGroups(groupRows);
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

    for (const group of groups) {
      rows.push({
        id: `group:${group.id}`,
        targetKind: "group",
        targetId: group.id,
        kind: "group",
        name: group.name,
        subtitle: ko ? "이미 묶어둔 에이전트 조합" : "Saved agent group",
        description:
          group.description ||
          (ko
            ? "한 Telegram 방에서 여러 에이전트가 역할을 나눠 답합니다."
            : "Several agents share one Telegram room and split the work."),
        source: ko ? "저장한 조합" : "Saved group",
        routeHint: ko ? "대표 봇 하나가 메시지를 받고 팀 안에서 알아서 나눕니다." : "One bot receives messages and the group routes them internally.",
        sessionMode: "shared_chat",
        readiness: group.warningCount > 0 ? "review" : "ready",
      });
    }

    for (const firm of firms) {
      const loc = pickLocalized(firm, locale);
      rows.push({
        id: `org:${firm.id}`,
        targetKind: "firm",
        targetId: firm.id,
        kind: "org",
        name: loc.name,
        subtitle: ko ? "대시보드 조직도 그대로 연결" : "Connect the dashboard org chart",
        description:
          loc.tagline ||
          (ko
            ? "회사처럼 나뉜 역할을 Telegram 방 하나에 연결합니다."
            : "Connect a company-style team to one Telegram room."),
        source: ko ? "조직도" : "Organization",
        routeHint: ko ? "오케스트레이터가 먼저 보고 필요한 에이전트에게 넘깁니다." : "The orchestrator receives first, then hands off to the right agent.",
        sessionMode: "shared_chat",
        readiness: "ready",
      });
    }

    const firmAgentIds = new Set(firms.flatMap((firm) => firm.orgChart.map((node) => node.agentId)));
    for (const agent of agents) {
      if (firmAgentIds.has(agent.id)) continue;
      const loc = pickLocalized(agent, locale);
      const isTeam = agent.kind === "team";
      rows.push({
        id: `agent:${agent.id}`,
        targetKind: "agent",
        targetId: agent.id,
        kind: isTeam ? "multi" : "single",
        name: loc.name,
        subtitle: isTeam ? (ko ? "에이전트 팀" : "Agent team") : (ko ? "에이전트 하나" : "One agent"),
        description:
          loc.tagline ||
          (isTeam
            ? ko
              ? "이 팀을 Telegram 방에 연결합니다."
              : "Connect this team to a Telegram room."
            : ko
              ? "이 에이전트만 답하는 Telegram 봇을 만듭니다."
              : "Create a Telegram bot that only routes to this agent."),
        source: agent.localPath ? (ko ? "가져온 에이전트" : "Imported") : (ko ? "내 에이전트" : "Installed"),
        routeHint: isTeam
          ? ko
            ? "팀 안에서 알아서 역할을 나눕니다."
            : "The team splits the work internally."
          : ko
            ? "모든 메시지가 이 에이전트에게 갑니다."
            : "Every message goes to this agent.",
        sessionMode: isTeam ? "shared_chat" : "per_user",
        readiness: "ready",
      });
    }

    const order: Record<TargetKind, number> = { org: 0, group: 1, multi: 2, single: 3 };
    return rows.sort((a, b) => order[a.kind] - order[b.kind] || a.name.localeCompare(b.name));
  }, [agents, firms, groups, ko, locale]);

  useEffect(() => {
    if (!targets.length) {
      setSelectedId("");
      return;
    }
    if (!selectedId || !targets.some((target) => target.id === selectedId)) {
      const connectedTarget = targets.find((target) =>
        bindings.some((binding) => binding.targetKind === target.targetKind && binding.targetId === target.targetId),
      );
      setSelectedId((connectedTarget ?? targets[0]).id);
    }
  }, [bindings, selectedId, targets]);

  const selected = targets.find((target) => target.id === selectedId) ?? targets[0];
  const visibleBindings = useMemo(
    () => [...bindings].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [bindings],
  );

  const targetSections = useMemo(() => {
    const labels: Array<{ key: TargetKind; label: string }> = [
      { key: "org", label: ko ? "조직도" : "Organizations" },
      { key: "group", label: ko ? "저장한 조합" : "Saved groups" },
      { key: "multi", label: ko ? "팀 에이전트" : "Team agents" },
      { key: "single", label: ko ? "개별 에이전트" : "Single agents" },
    ];
    return labels
      .map((section) => ({ ...section, rows: targets.filter((target) => target.kind === section.key) }))
      .filter((section) => section.rows.length > 0);
  }, [ko, targets]);

  const openManualToken = useCallback(() => {
    setManualOpen(true);
    window.setTimeout(() => tokenInputRef.current?.focus(), 0);
    setToast(ko ? "고급 입력을 열었습니다. 보통은 자동 연결만 누르면 됩니다." : "Advanced input opened. Auto connect is usually enough.");
  }, [ko]);

  const handleAutoConnect = useCallback(async () => {
    const api = ipc();
    if (!api || !selected) return;
    setBusy("auto");
    appendLog(ko ? `${selected.name} Telegram 자동 연결을 시작했습니다.` : `Started Telegram auto-connect for ${selected.name}.`);
    try {
      const result = await api.telegram.autoConnect({
        targetKind: selected.targetKind,
        targetId: selected.targetId,
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
  }, [appendLog, ko, refresh, selected]);

  const focusTokenInput = useCallback(() => {
    setManualOpen(true);
    tokenInputRef.current?.focus();
    setToast(
      ko
        ? "대상을 고르고 BotFather 비밀문자를 붙여넣으면 바로 연결됩니다."
        : "Choose a target, paste the BotFather token, and Agentlas will connect it.",
    );
  }, [ko]);

  const handleStart = useCallback(async () => {
    const api = ipc();
    const token = botToken.trim();
    if (!api || !selected) return;
    if (!token) {
      focusTokenInput();
      return;
    }
    setBusy("start");
    appendLog(ko ? `${selected.name}에 비밀문자 직접 연결을 시작했습니다.` : `Started token setup for ${selected.name}.`);
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
  }, [appendLog, botToken, focusTokenInput, ko, refresh, selected]);

  const handleBindingAction = useCallback(
    async (binding: TelegramConnectBinding, action: "open" | "test" | "resume" | "stop" | "remove") => {
      const api = ipc();
      if (!api) return;
      setBusy(`${action}:${binding.id}`);
      try {
        if (action === "open") {
          const result = await api.telegram.openBot(binding.id);
          setToast(result.message);
          appendLog(result.message, "success");
        } else if (action === "test") {
          appendLog(ko ? `${binding.targetName} 포트로 테스트 메시지를 보냅니다.` : `Sending a test through ${binding.targetName}.`);
          const result = await api.telegram.sendTest(binding.id);
          setToast(result.message);
          appendLog(result.message, "success");
          await refresh();
        } else if (action === "resume") {
          const next = await api.telegram.resume(binding.id);
          const message = next.sessionRunning
            ? ko
              ? "Telegram 세션을 켰습니다. 이제 들어오는 메시지를 받을 수 있습니다."
              : "Telegram session is on. Incoming messages can now be received."
            : ko
              ? "Telegram 세션을 켜려고 했지만 아직 준비 중입니다. 잠시 후 새로고침해보세요."
              : "Telegram session is starting. Refresh in a moment.";
          setToast(message);
          appendLog(message, next.sessionRunning ? "success" : "info");
          await refresh();
        } else if (action === "stop") {
          await api.telegram.stop(binding.id);
          const message = ko ? "이 Telegram 세션을 껐습니다." : "Telegram session turned off.";
          setToast(message);
          appendLog(message, "success");
          await refresh();
        } else {
          await api.telegram.remove(binding.id);
          const message = ko ? "이 Telegram 포트를 삭제했습니다." : "Telegram port removed.";
          setToast(message);
          appendLog(message, "success");
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
    [appendLog, ko, refresh],
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
              <h1 id="connect-title">{ko ? "Telegram 연결" : "Telegram Connect"}</h1>
              <p>
                {ko
                  ? "왼쪽에서 에이전트나 조직도를 고르면 오른쪽에 Telegram 봇 포트가 생깁니다. 로그인과 승인만 하면 나머지는 Agentlas가 처리합니다."
                  : "Choose an agent or org chart on the left, then create a Telegram bot port on the right. You only log in and approve."}
              </p>
            </div>
            <button className="connect-btn" type="button" onClick={() => void refresh()} disabled={loading}>
              <IconRefresh size={16} />
              {ko ? "새로고침" : "Refresh"}
            </button>
          </section>

          <div className="connect-workbench">
            <section className="connect-directory" aria-labelledby="connect-directory-title">
              <div className="connect-section-head">
                <div>
                  <p className="connect-kicker">{ko ? "선택" : "Choose"}</p>
                  <h2 id="connect-directory-title">{ko ? "연결할 에이전트/조직도" : "Agents and org charts"}</h2>
                </div>
                <span>{loading ? (ko ? "불러오는 중" : "Loading") : ko ? `${targets.length}개` : `${targets.length} targets`}</span>
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
                        <span className="connect-row-meta">
                          <span>{kindLabel(target.kind, ko)}</span>
                          <span>{routeModeLabel(target, ko)}</span>
                        </span>
                        <span className="connect-row-action">{selected?.id === target.id ? (ko ? "선택됨" : "Selected") : ko ? "선택" : "Choose"}</span>
                      </button>
                    ))}
                  </div>
                ))}
                {!loading && targets.length === 0 ? (
                  <div className="connect-empty">
                    <IconUsers size={22} />
                    <strong>{ko ? "연결할 에이전트가 아직 없습니다." : "No connectable agents yet."}</strong>
                    <span>{ko ? "먼저 Agent 화면에서 에이전트나 조합을 만들어주세요." : "Create an agent or group from the Agent page first."}</span>
                  </div>
                ) : null}
              </div>
            </section>

            <aside className="connect-port-panel" aria-labelledby="connect-port-title">
              <div className="connect-section-head">
                <div>
                  <p className="connect-kicker">{ko ? "포트" : "Ports"}</p>
                  <h2 id="connect-port-title">{ko ? "연결된 Telegram 포트" : "Connected Telegram ports"}</h2>
                </div>
                <span>{ko ? `${visibleBindings.length}개` : `${visibleBindings.length} ports`}</span>
              </div>

              <div className="connect-selected-strip">
                <span>{ko ? "지금 선택" : "Selected"}</span>
                <strong>{selected?.name ?? (ko ? "대상을 고르세요" : "Choose a target")}</strong>
                <small>{selected ? `${modeLabel(selected, ko)} · ${selected.routeHint}` : modeLabel(selected, ko)}</small>
              </div>

              <button
                className="connect-btn primary wide"
                type="button"
                onClick={() => void handleAutoConnect()}
                disabled={!selected || busy === "auto"}
              >
                <IconBolt size={16} />
                {busy === "auto" ? (ko ? "자동 연결 중" : "Auto-connecting") : ko ? "선택한 대상으로 봇 포트 만들기" : "Create bot port for selected target"}
              </button>

              <div className="connect-port-list">
                {visibleBindings.map((binding) => (
                  <div className="connect-port-row" data-status={sessionTone(binding)} key={binding.id}>
                    <div className="connect-port-route">
                      <span className="connect-port-bot">
                        <IconAtSign size={15} />
                        {binding.botUsername ? `@${binding.botUsername}` : binding.hasToken ? (ko ? "봇 준비됨" : "Bot ready") : (ko ? "봇 준비 필요" : "Needs bot")}
                      </span>
                      <IconRoute size={16} />
                      <strong>{binding.targetName}</strong>
                    </div>
                    <div className="connect-port-meta">
                      <span>{sessionLabel(binding, ko)}</span>
                      <span>{statusLabel(binding.status, binding.enabled, ko)}</span>
                      <span>{binding.telegramChatTitle || (ko ? "Telegram 방 대기 중" : "Waiting for Telegram chat")}</span>
                    </div>
                    <div className="connect-port-actions">
                      <button type="button" onClick={() => void handleBindingAction(binding, "open")} disabled={!binding.botUsername || busy === `open:${binding.id}`}>
                        {ko ? "열기" : "Open"}
                      </button>
                      <button type="button" onClick={() => void handleBindingAction(binding, "test")} disabled={!binding.telegramChatId || busy === `test:${binding.id}`}>
                        {ko ? "테스트" : "Test"}
                      </button>
                      <button
                        type="button"
                        onClick={() => void handleBindingAction(binding, binding.enabled && binding.sessionRunning ? "stop" : "resume")}
                        disabled={busy === `resume:${binding.id}` || busy === `stop:${binding.id}`}
                      >
                        {sessionToggleLabel(binding, ko)}
                      </button>
                      <button type="button" onClick={() => void handleBindingAction(binding, "remove")} disabled={busy === `remove:${binding.id}`} aria-label={ko ? "포트 삭제" : "Remove port"}>
                        <IconTrash size={13} />
                      </button>
                    </div>
                    {binding.lastError ? <p className="connect-binding-error">{binding.lastError}</p> : null}
                  </div>
                ))}
                {!loading && visibleBindings.length === 0 ? (
                  <div className="connect-port-empty">
                    <IconAtSign size={20} />
                    <strong>{ko ? "아직 Telegram 포트가 없습니다." : "No Telegram ports yet."}</strong>
                    <span>{ko ? "왼쪽에서 하나 고르고 위 버튼을 누르면 여기에 포트가 생깁니다." : "Choose one on the left and press the button above."}</span>
                  </div>
                ) : null}
              </div>

              <button className="connect-manual-toggle" type="button" onClick={manualOpen ? () => setManualOpen(false) : openManualToken}>
                {manualOpen ? (ko ? "고급 입력 닫기" : "Hide advanced input") : ko ? "고급: BotFather 비밀문자로 직접 연결" : "Advanced: connect with BotFather token"}
              </button>

              {manualOpen ? (
                <>
                  <label className="connect-secret-box">
                    <span>{ko ? "BotFather 비밀문자" : "BotFather token"}</span>
                    <input
                      ref={tokenInputRef}
                      type="password"
                      value={botToken}
                      onChange={(event) => setBotToken(event.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={ko ? "비밀문자를 붙여넣기" : "Paste token"}
                    />
                    <small>
                      {ko
                        ? "자동 연결이 막힐 때만 쓰는 고급 입력입니다. 저장 후 다시 보여주지 않습니다."
                        : "Advanced fallback only. Agentlas stores it securely and does not show it again."}
                    </small>
                  </label>

                  <button
                    className="connect-btn wide"
                    type="button"
                    onClick={() => void handleStart()}
                    disabled={!selected || !botToken.trim() || busy === "start"}
                  >
                    <IconKey size={16} />
                    {busy === "start" ? (ko ? "봇 확인 중" : "Checking bot") : ko ? "비밀문자로 연결" : "Connect with token"}
                  </button>
                </>
              ) : null}
            </aside>
          </div>

          <section className="connect-log-panel" aria-labelledby="connect-log-title">
            <div className="connect-section-head">
              <div>
                <p className="connect-kicker">{ko ? "진행 상황" : "Progress"}</p>
                <h2 id="connect-log-title">{ko ? "연결 로그" : "Connection log"}</h2>
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
                  <span>
                    {ko
                      ? "자동 연결을 누르면 Telegram 창 열기, 로그인 확인, 테스트 전송 결과가 여기에 쌓입니다."
                      : "Press auto-connect to see Telegram opening, login checks, and test-send results here."}
                  </span>
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
