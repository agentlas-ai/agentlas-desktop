// 자동화 — 리스트. 영구 SQLite + 백그라운드 스케줄러(60초)로 실제 실행.
"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ipc } from "@/lib/ipc";
import { pickLocalized, useT } from "@/lib/i18n";
import { humanSchedule } from "@shared/graph-blueprint";
import type { Automation, InstalledAgent, InstalledFirm, RuntimeSelection } from "@/lib/types";
import { IconBolt, IconBuilding, IconPlus, IconTrash, IconEdit, IconPower, IconKey, IconChat, IconLayers, IconDownload } from "@/components/Icon";
import { GraphControl } from "@/components/automation/GraphControl";
import styles from "@/components/automation/GraphWorkspace.module.css";
import { DescribeAutomation } from "@/components/automation/DescribeAutomation";
import { OneAutomationTable } from "@/components/automation/OneAutomationTable";
import { LoadingEstimate } from "@/components/LoadingEstimate";

function runtimeSelectionLabel(selection: RuntimeSelection | null | undefined, locale: string): string {
  if (!selection) return locale === "en" ? "follows active runtime" : "활성 런타임 따라가기";
  const kindLabels: Record<string, string> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    antigravity: "Antigravity",
    kimi: "Kimi",
    grok: "Grok",
    cursor: "Cursor",
    byok: "BYOK",
    ollama: "Ollama",
    lmstudio: "LM Studio",
    mlx: "MLX",
    "agentlas-local": "Agentlas Local · On-device",
    acp: "ACP",
    agentlas: "Agentlas",
  };
  const kind = kindLabels[selection.kind] ?? selection.kind;
  const model = selection.model?.trim();
  return model ? `${kind} · ${model}` : kind;
}

export default function AutomationListPage() {
  const { t, locale } = useT();
  const router = useRouter();
  const [items, setItems] = useState<Automation[]>([]);
  const [agents, setAgents] = useState<InstalledAgent[]>([]);
  const [firms, setFirms] = useState<InstalledFirm[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("");
  /* Hub에서 받기 — 올리는 길과 받는 길이 둘 다 메인 프로세스에만 있었다. */
  const [hubSlug, setHubSlug] = useState("");
  const [installing, setInstalling] = useState(false);
  /* ★결정을 기다리는 자동화를 목록에서 알아볼 수 없었다(실렌더 2026-08-09).
     이 목록이 첫 화면인데, 승인 대기로 멈춘 그래프가 정상인 것과 똑같이 보여서
     사용자는 [지금 실행]을 눌렀고 — 그것은 같은 자리에서 또 멈춘다. */
  const [waiting, setWaiting] = useState<Record<string, string>>({});
  /* 캔버스에서 만든 그래프와 One 이 대화에서 만든 job 은 사는 곳도 고치는 길도 다르다.
     가르는 기준은 monitor.originChatId — 이 값이 있어야 "어느 대화" 열을 채울 수 있으므로
     탭 구분자와 표의 열이 같은 사실 위에 선다. */
  const [tab, setTab] = useState<"graph" | "one">("graph");
  const oneItems = items.filter((a) => a.monitor?.originChatId);
  const graphItems = items.filter((a) => !a.monitor?.originChatId);

  async function refresh() {
    const api = ipc();
    setLoading(true);
    setMessage("");
    if (!api) {
      setLoading(false);
      setMessage(locale === "en" ? "Automations are only available in the desktop app." : "자동화는 데스크톱 앱에서만 사용할 수 있습니다.");
      return;
    }
    try {
      const [list, ag, fm] = await Promise.all([
        api.automations.list(),
        api.team.list(),
        api.firms.list(),
      ]);
      setItems(list);
      // 라벨 해석은 전체 목록으로 — 오케스트레이터 등 시스템 에이전트를 타깃으로 한 자동화가
      // "(삭제된 에이전트)"로 잘못 표시되던 버그(visibleAgents는 픽커용 필터).
      setAgents(ag);
      setFirms(fm);
      // 각 자동화의 마지막 실행에서 "사람이 결정해야 끝나는 실패"만 추린다.
      // 실패해도 목록은 그대로 뜬다 — 배지가 없다고 목록을 못 보면 더 나쁘다.
      // (승인 대기 배지는 승인 게이트 폐지(2026-08-10)로 제거 — EVAL_STUCK 은 승인이
      //  아니라 사람의 판정 교정이 필요한 상태라 남는다.)
      void Promise.all(list.map(async (automation) => {
        const snap = await api.automations.latestRun(automation.id).catch(() => null);
        const failure = Object.values(snap?.nodeFailures ?? {})
          .find((f) => f?.code === "EVAL_STUCK");
        return failure ? ([automation.id, failure.code] as const) : null;
      })).then((rows) => {
        setWaiting(Object.fromEntries(rows.filter(Boolean) as (readonly [string, string])[]));
      }).catch(() => undefined);
    } catch {
      setMessage(locale === "en" ? "Automations could not be loaded. Existing schedules were not changed." : "자동화를 불러오지 못했습니다. 기존 예약은 그대로 둡니다.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
  }, []);

  async function installFromHub() {
    const api = ipc();
    if (!api || !hubSlug.trim() || installing) return;
    setInstalling(true);
    setMessage(locale === "en" ? "Fetching it from the Hub…" : "Hub에서 받는 중입니다…");
    try {
      const res = await api.automations.installGraphFromHub(hubSlug.trim());
      if (!res.ok) { setMessage(res.reason); return; }
      setHubSlug("");
      await refresh();
      // 받아온 것은 꺼진 채로 들어온다 — 그 사실을 말해 주지 않으면 안 도는 이유를 모른다.
      setMessage(locale === "en"
        ? `Installed "${res.name}". It is switched off — look it over, then turn it on.`
        : `"${res.name}"을(를) 받았습니다. 꺼진 상태이니 살펴본 뒤 켜 주세요.`);
    } catch (error) {
      setMessage(error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, "")
        : (locale === "en" ? "Could not install it." : "받지 못했습니다."));
    } finally {
      setInstalling(false);
    }
  }

  async function toggle(id: string, enabled: boolean) {
    const api = ipc();
    if (!api) return;
    // ★누르면 먼저 반응한다 — 켜기 게이트(연결 검사)가 도는 몇 초 동안 버튼이
    //   그대로면 사람은 "안 눌렸나?" 하고 다시 누른다(플로우 화면에서 고친 병의
    //   목록 화면 쌍둥이, 실측 2026-08-06).
    setMessage(enabled
      ? (locale === "en" ? "Turning it on — checking what it needs…" : "켜는 중입니다 — 필요한 연결을 확인합니다…")
      : (locale === "en" ? "Turning it off…" : "끄는 중입니다…"));
    try {
      await api.automations.toggle(id, enabled);
      setMessage("");
      await refresh();
    } catch (error) {
      // 거절에는 사유가 실려 온다 — 버리지 않는다(runNow와 같은 규칙).
      const reason = error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, "")
        : "";
      setMessage(reason || (locale === "en" ? "Status did not change." : "상태를 바꾸지 못했습니다."));
    }
  }

  // "지금 실행" — 스케줄 무관 즉시 1회 테스트 실행을 발사하고, 캔버스로 이동해 라이브로 지켜본다.
  // 실행 완료를 여기서 기다리지 않는다(수 분 걸릴 수 있음) — 진행/실패는 캔버스 오버레이가 보여준다.
  function runNow(id: string) {
    const api = ipc();
    if (!api) return;
    setMessage(locale === "en" ? "Starting the run. Opening the live flow..." : "실행을 시작하고 라이브 플로우를 엽니다...");
    api.automations.runNow(id).catch((error: unknown) => {
      // ★거절에는 언제나 사유가 실려 온다 — 그것을 버리고 "시작하지 못했습니다"만
      //   말하면, 무엇을 고쳐야 하는지 아는 쪽은 제품인데 모르는 쪽은 사람이 된다.
      const reason = error instanceof Error
        ? error.message.replace(/^Error invoking remote method '[^']+':\s*Error:\s*/, "")
        : "";
      setMessage(reason || (locale === "en" ? "Test run did not start." : "테스트 실행을 시작하지 못했습니다."));
    });
    router.push(`/automation/flow?id=${encodeURIComponent(id)}`);
  }

  async function remove(id: string) {
    const api = ipc();
    if (!api) return;
    const automation = items.find((item) => item.id === id);
    const name = automation?.name ?? (locale === "en" ? "this automation" : "이 자동화");
    const message =
      locale === "en"
        ? `Delete '${name}'?\n\nThis also deletes its session transcript.`
        : `'${name}' 자동화를 삭제할까요?\n\n이 자동화의 세션 대화도 같이 삭제됩니다.`;
    if (!confirm(message)) return;
    try {
      await api.automations.remove(id);
      window.dispatchEvent(new CustomEvent("agentlas:automation-changed", { detail: { id } }));
      await refresh();
    } catch {
      setMessage(locale === "en" ? "Automation was not deleted." : "자동화를 삭제하지 못했습니다.");
    }
  }

  function targetLabel(a: Automation): { icon: React.ReactNode; name: string } {
    if (a.targetType === "firm") {
      const f = firms.find((x) => x.id === a.targetId);
      return {
        icon: <IconBuilding size={11} style={{ color: "var(--accent)" }} />,
        name: f ? pickLocalized(f, locale).name : locale === "en" ? "(removed firm)" : "(삭제된 회사)",
      };
    }
    if (a.targetType === "hub") {
      return {
        icon: <IconBolt size={11} style={{ color: "var(--accent)" }} />,
        name: `Hub · ${a.targetId}`,
      };
    }
    const ag = agents.find((x) => x.id === a.targetId);
    return {
      icon: <IconBolt size={11} style={{ color: "var(--muted-deep)" }} />,
      name: ag ? pickLocalized(ag, locale).name : locale === "en" ? "(removed agent)" : "(삭제된 에이전트)",
    };
  }

  return (
    <div style={{ flex: 1, background: "var(--paper-2)", overflowY: "auto" }}>
      <header
        className="titlebar-drag"
        style={{
          padding: "16px 32px",
          borderBottom: "var(--hairline)",
          background: "var(--paper)",
          minHeight: 56,
          display: "flex",
          alignItems: "center",
          gap: 12,
        }}
      >
        <h1 style={{ margin: 0, fontFamily: "var(--font-head)", fontSize: 17, fontWeight: 700, flex: 1 }}>
          {t("auto.title")}
        </h1>
        <Link
          href="/automation/new"
          className="titlebar-nodrag"
          data-tour-id="automation.new"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "8px 14px",
            borderRadius: "var(--radius-md)",
            background: "var(--paper)",
            color: "var(--ink)",
            fontWeight: 600,
            fontSize: 13,
            border: "1px solid var(--paper-edge)",
            boxShadow: "var(--neu-raised)",
            textDecoration: "none",
          }}
        >
          <IconPlus size={14} />
          <span aria-label={t("auto.new")} title={t("auto.new")}/>
        </Link>
      </header>

      <section className={styles.list} data-tour-id="automation.list">
        <div className={styles.listTools}>
          <GraphControl label={locale === "en" ? "Graphs" : "그래프"} icon={<IconLayers size={17}/>} aria-pressed={tab === "graph"} onClick={()=>setTab("graph")}/>
          <GraphControl label={locale === "en" ? "One automations" : "One 자동화"} icon={<IconChat size={17}/>} aria-pressed={tab === "one"} onClick={()=>setTab("one")}/>
          <details className={styles.menu}><summary title={locale === "en" ? "Describe a graph" : "말로 만들기"} aria-label={locale === "en" ? "Describe a graph" : "말로 만들기"}><IconPlus size={17}/></summary><div className={styles.menuContent} style={{left:0,right:"auto",width:420,maxWidth:"80vw"}}><DescribeAutomation locale={locale} onCreated={()=>void refresh()}/></div></details>
          <details className={styles.menu}><summary title={locale === "en" ? "Install from Hub" : "Hub에서 받기"} aria-label={locale === "en" ? "Install from Hub" : "Hub에서 받기"}><IconDownload size={17}/></summary><div className={styles.menuContent} style={{left:0,right:"auto"}}>
            <input value={hubSlug} onChange={e=>setHubSlug(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")void installFromHub();}} placeholder={locale === "en" ? "Graph name" : "그래프 이름"} aria-label={locale === "en" ? "Graph name" : "그래프 이름"}/>
            <button disabled={installing || !hubSlug.trim()} onClick={()=>void installFromHub()}>{locale === "en" ? "Install" : "받기"}</button>
          </div></details>
        </div>
        {message ? <div role="status">{message}</div> : null}
        {loading ? <LoadingEstimate locale={locale} operationKey="automation-list" expectedSeconds={[1,8]} compact/> : tab === "one" ? <OneAutomationTable items={oneItems} locale={locale} onToggle={(id,enabled)=>void toggle(id,enabled)} onRemove={id=>void remove(id)}/> : graphItems.length===0 ? <div>{t("auto.empty")}</div> : <ul style={{listStyle:"none",padding:0,margin:0}}>
          {graphItems.map(a=><li className={styles.row} key={a.id}>
            <span className={styles.state} data-active={a.enabled} title={a.enabled ? (locale === "en" ? "Enabled" : "켜짐") : (locale === "en" ? "Paused" : "정지")}/>
            <Link className={styles.rowTitle} href={`/automation/flow?id=${encodeURIComponent(a.id)}`} title={`${humanSchedule(a.scheduleHuman,locale)} · ${targetLabel(a).name} · ${runtimeSelectionLabel(a.runtimeSelection,locale)}`}>{a.name}</Link>
            <span className={styles.miniGraph} aria-hidden="true"><IconBolt size={16}/><i/><IconBuilding size={16}/><i/><IconLayers size={16}/></span>
            {waiting[a.id] ? <GraphControl data-testid={`automation-waiting-${a.id}`} primary label={locale === "en" ? "Needs your call" : "내가 정해야 함"} icon={<IconKey size={16}/>} onClick={()=>router.push(`/automation/flow?id=${encodeURIComponent(a.id)}`)}/> : <GraphControl label={t("auto.list.run")} icon={<IconBolt size={16}/>} onClick={()=>runNow(a.id)}/>}
            {!a.enabled && a.scheduleSpec?.kind==="once" && a.nextRunAt==null ? <span title={locale === "en" ? "Ended" : "종료됨"}>—</span> : <GraphControl label={a.enabled ? t("auto.action.disable") : t("auto.action.enable")} icon={<IconPower size={16}/>} aria-pressed={a.enabled} onClick={()=>void toggle(a.id,!a.enabled)}/>}
            <GraphControl label={t("auto.list.edit")} icon={<IconEdit size={16}/>} onClick={()=>router.push(`/automation/new?id=${encodeURIComponent(a.id)}`)}/>
            <GraphControl label={t("common.delete")} icon={<IconTrash size={16}/>} onClick={()=>void remove(a.id)}/>
          </li>)}
        </ul>}
      </section>
    </div>
  );
}
