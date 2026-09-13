"use client";

import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useT } from "@/lib/i18n";
import { ipc } from "@/lib/ipc";
import {
  appendProjectPoolMember,
  buildProjectRosterSections,
  projectPoolMemberKey,
  type ProjectRosterCandidate,
  type ProjectRosterSection,
  type ProjectRosterSource,
} from "@/lib/project-agent-roster";
import type {
  HubAgentBookmark,
  InstalledAgent,
  InstalledAgentExactBinding,
  InstalledFirm,
  MarketplaceListing,
  ProjectAgentPoolMember,
} from "@/lib/types";
import { PixelCat } from "./PixelCat";
import styles from "./ProjectAgentPicker.module.css";

type CatalogState =
  | { status: "loading"; sections: null; failure: null }
  | { status: "ready"; sections: ProjectRosterSection[]; failure: null; failedSources: Array<"cloud" | "hub"> }
  | { status: "failed"; sections: null; failure: "bridge" | "request" };

const INITIAL_OPEN_SOURCES: Record<ProjectRosterSource, boolean> = {
  local: true,
  cloud: true,
  hub: false,
};

const CATALOG_REQUEST_TIMEOUT_MS = 15_000;

function withCatalogTimeout<T>(request: Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error("project_agent_catalog_timeout")), CATALOG_REQUEST_TIMEOUT_MS);
    request.then(
      (value) => { window.clearTimeout(timer); resolve(value); },
      (error) => { window.clearTimeout(timer); reject(error); },
    );
  });
}

function candidateCount(sections: ProjectRosterSection[]): number {
  return sections.reduce(
    (total, section) => total + section.standalone.length
      + section.firms.reduce((firmTotal, firm) => firmTotal + 1 + firm.members.length, 0),
    0,
  );
}

function matchesCandidate(candidate: ProjectRosterCandidate, query: string): boolean {
  return candidate.name.toLowerCase().includes(query)
    || candidate.member.targetId.toLowerCase().includes(query);
}

function focusRelativeCandidate(event: KeyboardEvent<HTMLButtonElement>) {
  if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
  const container = event.currentTarget.closest<HTMLElement>("[data-project-agent-catalog]");
  const candidates = Array.from(container?.querySelectorAll<HTMLButtonElement>("[data-picker-candidate]:not(:disabled)") ?? []);
  if (candidates.length === 0) return;
  event.preventDefault();
  const current = candidates.indexOf(event.currentTarget);
  const next = event.key === "Home"
    ? 0
    : event.key === "End"
      ? candidates.length - 1
      : event.key === "ArrowUp"
        ? Math.max(0, current - 1)
        : Math.min(candidates.length - 1, current + 1);
  candidates[next]?.focus();
}

function sourceName(source: ProjectRosterSource, ko: boolean): string {
  if (source === "cloud") return ko ? "내 에이전트" : "My agents";
  if (source === "hub") return "Hub";
  return ko ? "로컬" : "Local";
}

function memberIdentitySeed(member: ProjectAgentPoolMember): string {
  return `${member.source}:${member.entityKind}:${member.targetId}`;
}

function candidateMatchesMember(candidate: ProjectRosterCandidate, member: ProjectAgentPoolMember): boolean {
  if (candidate.source !== member.source || candidate.member.entityKind !== member.entityKind) return false;
  const target = member.targetId.trim().toLowerCase();
  return (candidate.identityAliases?.length ? candidate.identityAliases : [candidate.member.targetId])
    .some((alias) => alias.trim().toLowerCase() === target);
}

export function ProjectAgentPicker({
  value,
  onChange,
  disabled = false,
}: {
  value: ProjectAgentPoolMember[];
  onChange: (next: ProjectAgentPoolMember[]) => void;
  disabled?: boolean;
}) {
  const { locale } = useT();
  const ko = locale === "ko";
  const pickerId = useId().replace(/:/g, "");
  const requestRef = useRef(0);
  const selectedListRef = useRef<HTMLDivElement>(null);
  const catalogRef = useRef<HTMLElement>(null);
  const [catalog, setCatalog] = useState<CatalogState>({ status: "loading", sections: null, failure: null });
  const [query, setQuery] = useState("");
  const [openSources, setOpenSources] = useState<Record<ProjectRosterSource, boolean>>(INITIAL_OPEN_SOURCES);
  const [openFirms, setOpenFirms] = useState<Record<string, boolean>>({});
  const [feedback, setFeedback] = useState("");

  const loadCatalog = useCallback(async () => {
    const requestId = ++requestRef.current;
    setCatalog({ status: "loading", sections: null, failure: null });
    const api = ipc();
    if (!api) {
      if (requestRef.current === requestId) setCatalog({ status: "failed", sections: null, failure: "bridge" });
      return;
    }
    try {
      // Installed rows, firms, and exact bindings form one identity gate. Cloud
      // and Hub shelves may fail independently without erasing known installed
      // rows, but their failure must never be presented as zero availability.
      const [localData, remoteResults] = await Promise.all([
        Promise.all([
          withCatalogTimeout(api.team.list()),
          withCatalogTimeout(api.firms.list()),
          withCatalogTimeout(api.agents.exactBindings()),
        ] as [
          Promise<InstalledAgent[]>,
          Promise<InstalledFirm[]>,
          Promise<InstalledAgentExactBinding[]>,
        ]),
        Promise.allSettled([
          withCatalogTimeout(api.marketplace.listMine()),
          withCatalogTimeout(api.marketplace.bookmarks()),
        ] as [Promise<MarketplaceListing[]>, Promise<HubAgentBookmark[]>]),
      ]);
      if (requestRef.current !== requestId) return;
      const [agents, firms, exactBindings] = localData;
      const [cloudResult, hubResult] = remoteResults;
      const cloudListings = cloudResult.status === "fulfilled" ? cloudResult.value : [];
      const hubBookmarks = hubResult.status === "fulfilled" ? hubResult.value : [];
      const failedSources: Array<"cloud" | "hub"> = [];
      if (cloudResult.status === "rejected") failedSources.push("cloud");
      if (hubResult.status === "rejected") failedSources.push("hub");
      setCatalog({
        status: "ready",
        sections: buildProjectRosterSections(agents, firms, cloudListings, hubBookmarks, locale, exactBindings),
        failure: null,
        failedSources,
      });
    } catch {
      if (requestRef.current === requestId) setCatalog({ status: "failed", sections: null, failure: "request" });
    }
  }, [locale]);

  useEffect(() => {
    void loadCatalog();
    return () => { requestRef.current += 1; };
  }, [loadCatalog]);

  const catalogCandidates = useMemo(() => catalog.status === "ready"
    ? catalog.sections.flatMap((item) => [
      ...item.firms.flatMap((firm) => [firm.team, ...firm.members]),
      ...item.standalone,
    ])
    : [], [catalog]);
  const filterActive = query.trim().length > 0;
  const visibleSections = useMemo(() => {
    if (catalog.status !== "ready") return [];
    const normalized = query.trim().toLowerCase();
    if (!normalized) return catalog.sections;
    return catalog.sections
      .map((section) => ({
        ...section,
        firms: section.firms
          .map((firm) => ({ ...firm, members: firm.members.filter((candidate) => matchesCandidate(candidate, normalized)) }))
          .filter((firm) => matchesCandidate(firm.team, normalized) || firm.members.length > 0),
        standalone: section.standalone.filter((candidate) => matchesCandidate(candidate, normalized)),
      }))
      .filter((section) => section.firms.length > 0
        || section.standalone.length > 0
        || catalog.failedSources.includes(section.source as "cloud" | "hub"));
  }, [catalog, query]);
  const totalCount = catalog.status === "ready" && catalog.failedSources.length === 0
    ? candidateCount(catalog.sections)
    : null;

  function addCandidate(candidate: ProjectRosterCandidate) {
    if (disabled || !candidate.callable) return;
    const result = appendProjectPoolMember(value, candidate);
    if (result.status === "added") {
      setFeedback(ko ? `${candidate.name}을(를) 연결했습니다.` : `Added ${candidate.name}.`);
      onChange(result.members);
    } else if (result.status === "duplicate") {
      setFeedback(ko ? "이미 연결된 팀 또는 에이전트입니다." : "That team or agent is already connected.");
    } else {
      setFeedback(ko ? "프로젝트에는 최대 32개 항목을 연결할 수 있습니다." : "A project can connect up to 32 items.");
    }
  }

  function memberUnavailable(member: ProjectAgentPoolMember): boolean {
    if (catalog.status !== "ready" || catalog.failedSources.includes(member.source as "cloud" | "hub")) return false;
    return !catalogCandidates.some((candidate) => candidateMatchesMember(candidate, member));
  }

  function removeMember(member: ProjectAgentPoolMember, trigger: HTMLButtonElement) {
    if (disabled) return;
    const key = projectPoolMemberKey(member);
    const buttons = Array.from(selectedListRef.current?.querySelectorAll<HTMLButtonElement>("[data-remove-project-agent]") ?? []);
    const index = Math.max(0, buttons.indexOf(trigger));
    onChange(value.filter((item) => projectPoolMemberKey(item) !== key));
    setFeedback(ko ? `${member.nameSnapshot}을(를) 제거했습니다.` : `Removed ${member.nameSnapshot}.`);
    window.requestAnimationFrame(() => {
      const remaining = Array.from(selectedListRef.current?.querySelectorAll<HTMLButtonElement>("[data-remove-project-agent]") ?? []);
      (remaining[Math.min(index, remaining.length - 1)] ?? catalogRef.current?.querySelector<HTMLInputElement>('input[type="search"]'))?.focus();
    });
  }

  function renderCandidate(candidate: ProjectRosterCandidate) {
    const selected = value.some((member) => candidateMatchesMember(candidate, member));
    const candidateDisabled = disabled || selected || !candidate.callable;
    const helper = selected
      ? (ko ? "프로젝트에 연결됨" : "Connected to project")
      : candidate.callable
        ? candidate.tagline
        : candidate.blockedReason ?? (ko ? "호출할 수 없는 항목" : "Not callable");
    return (
      <button
        className={styles.candidate}
        data-picker-candidate
        data-selected={selected}
        disabled={candidateDisabled}
        key={candidate.key}
        type="button"
        title={helper}
        onClick={() => addCandidate(candidate)}
        onKeyDown={focusRelativeCandidate}
      >
        <PixelCat seed={memberIdentitySeed(candidate.member)} size={28} />
        <span className={styles.candidateCopy}>
          <strong>{candidate.name}</strong>
          <small>{helper}</small>
        </span>
        <span className={styles.kind}>{candidate.kind === "team" ? (ko ? "팀" : "Team") : candidate.source}</span>
      </button>
    );
  }

  return (
    <section className={styles.picker} aria-label={ko ? "프로젝트 팀과 에이전트 선택" : "Choose project teams and agents"}>
      <div className={styles.panel} data-empty={value.length === 0}>
        <div className={styles.panelHead}>
          <div><strong>{ko ? "선택한 팀과 에이전트" : "Selected teams and agents"}</strong><small>{ko ? "프로젝트 도구" : "Project tools"}</small></div>
          <span aria-label={ko ? `선택 ${value.length}개` : `${value.length} selected`}>{value.length}</span>
        </div>
        {value.length === 0 ? (
          <div className={styles.emptySelection}>
            <PixelCat seed="project-auto-staffing" size={54} />
            <strong>{ko ? "선택 사항" : "Optional"}</strong>
            <span className={styles.defaultLabel}>{ko ? "나중에 연결해도 괜찮아요" : "You can connect them later"}</span>
            <p>{ko ? "에이전트 없이 프로젝트를 먼저 만들 수 있어요." : "You can create the project first without agents."}</p>
          </div>
        ) : (
          <div className={styles.selectedList} ref={selectedListRef}>
            {value.map((member) => {
              const key = projectPoolMemberKey(member);
              const unavailable = memberUnavailable(member);
              return (
                <div className={styles.selectedRow} data-unavailable={unavailable} key={key}>
                  <PixelCat seed={memberIdentitySeed(member)} size={34} />
                  <span className={styles.selectedCopy}>
                    <strong>{member.nameSnapshot}</strong>
                    <small>{sourceName(member.source, ko)} · {member.entityKind === "team" ? (ko ? "팀" : "Team") : (ko ? "에이전트" : "Agent")}</small>
                    {unavailable ? <small className={styles.unavailable}>{ko ? "현재 목록에서 찾을 수 없음" : "No longer present in this catalog"}</small> : null}
                  </span>
                  <button type="button" data-remove-project-agent disabled={disabled} onClick={(event) => removeMember(member, event.currentTarget)} aria-label={ko ? `${member.nameSnapshot} 제거` : `Remove ${member.nameSnapshot}`}>
                    {ko ? "제거" : "Remove"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <aside className={styles.panel} ref={catalogRef} data-project-agent-catalog aria-label={ko ? "팀과 에이전트 목록" : "Team and agent catalog"}>
        <div className={styles.catalogHead}>
          <div className={styles.panelHead}>
            <div><strong>{ko ? "팀과 에이전트" : "Teams and agents"}</strong><small>{ko ? "소스별 목록" : "Grouped by source"}</small></div>
            <span aria-label={totalCount === null ? (ko ? "목록 수 확인되지 않음" : "Catalog count unknown") : (ko ? `목록 ${totalCount}개` : `${totalCount} catalog items`)}>{totalCount ?? "—"}</span>
          </div>
          <label className={styles.search}>
            <span>{ko ? "에이전트 검색" : "Search agents"}</span>
            <input
              type="search"
              value={query}
              disabled={catalog.status !== "ready"}
              placeholder={ko ? "이름 또는 ID 검색" : "Search name or ID"}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape" && query) {
                  event.preventDefault();
                  setQuery("");
                }
              }}
            />
          </label>
        </div>

        <div className={styles.catalogBody} aria-busy={catalog.status === "loading"}>
          {catalog.status === "loading" ? (
            <div className={styles.state} role="status"><span className={styles.spinner} aria-hidden="true" />{ko ? "팀과 에이전트를 불러오는 중…" : "Loading teams and agents…"}</div>
          ) : catalog.status === "failed" ? (
            <div className={styles.state} role="alert">
              <strong>{ko ? "목록을 불러오지 못했습니다" : "Could not load the catalog"}</strong>
              <p>{catalog.failure === "bridge"
                ? (ko ? "Desktop 연결을 확인한 뒤 다시 시도해 주세요. 사용 가능 수는 아직 확인되지 않았습니다." : "Check the Desktop connection and retry. Availability is not yet known.")
                : (ko ? "설치 목록 또는 정확한 식별 정보를 확인하지 못했습니다. 사용 가능 수는 아직 확인되지 않았습니다." : "Installed inventory or exact identity data could not be confirmed. Availability is not yet known.")}</p>
              <button type="button" disabled={disabled} onClick={() => void loadCatalog()}>{ko ? "다시 시도" : "Retry"}</button>
            </div>
          ) : visibleSections.length === 0 ? (
            <div className={styles.state} role="status">
              {filterActive
                ? (ko ? "일치하는 팀이나 에이전트가 없습니다." : "No matching teams or agents.")
                : (ko ? "표시할 수 있는 팀이나 에이전트가 없습니다." : "No teams or agents are available to display.")}
            </div>
          ) : visibleSections.map((section, sectionIndex) => {
            const sectionCount = candidateCount([section]);
            const sourceFailed = catalog.failedSources.includes(section.source as "cloud" | "hub");
            const sourceOpen = filterActive || sourceFailed || openSources[section.source];
            const sourcePanelId = `${pickerId}-source-${section.source}`;
            return (
              <div className={styles.source} key={section.source}>
                <button
                  className={styles.sourceToggle}
                  data-failed={sourceFailed}
                  type="button"
                  disabled={sourceFailed}
                  aria-expanded={sourceOpen}
                  aria-controls={sourceOpen ? sourcePanelId : undefined}
                  onClick={() => setOpenSources((current) => ({ ...current, [section.source]: !sourceOpen }))}
                >
                  <span aria-hidden="true">{sourceOpen ? "▾" : "›"}</span>
                  <strong>{ko ? section.labelKo : section.labelEn}</strong>
                  <small aria-label={sourceFailed ? (ko ? "소스 목록 수 미확인" : "Source count unknown") : undefined}>{sourceFailed ? "—" : sectionCount}</small>
                </button>
                {sourceOpen ? (
                  <div id={sourcePanelId}>
                    {sourceFailed ? (
                      <div className={styles.sourceFailure} role="status">
                        <span>{section.source === "cloud"
                          ? (ko ? "Cloud 목록을 불러오지 못했습니다. 이미 설치된 항목만 표시될 수 있습니다." : "The Cloud catalog failed to load. Only known installed items may be shown.")
                          : (ko ? "Hub 목록을 불러오지 못했습니다. 이미 설치된 항목만 표시될 수 있습니다." : "The Hub catalog failed to load. Only known installed items may be shown.")}</span>
                        <button type="button" disabled={disabled} onClick={() => void loadCatalog()}>{ko ? "다시 시도" : "Retry"}</button>
                      </div>
                    ) : null}
                    {section.firms.map((firm, firmIndex) => {
                      const firmOpen = filterActive || openFirms[firm.id] === true;
                      const firmPanelId = `${pickerId}-firm-${sectionIndex}-${firmIndex}`;
                      const teamSelected = value.some((member) => candidateMatchesMember(firm.team, member));
                      return (
                        <div className={styles.firm} key={firm.id}>
                          <div className={styles.firmRow}>
                            {firm.selfReferential ? <span className={styles.chevronSpacer} aria-hidden="true" /> : (
                              <button className={styles.chevron} type="button" aria-expanded={firmOpen} aria-controls={firmOpen ? firmPanelId : undefined} onClick={() => setOpenFirms((current) => ({ ...current, [firm.id]: !firmOpen }))} aria-label={ko ? `${firm.name} 구성원 ${firmOpen ? "접기" : "펼치기"}` : `${firmOpen ? "Collapse" : "Expand"} ${firm.name} members`}>
                                <span aria-hidden="true">{firmOpen ? "▾" : "›"}</span>
                              </button>
                            )}
                            <PixelCat seed={memberIdentitySeed(firm.team.member)} size={26} />
                            <span className={styles.firmCopy}><strong>{firm.name}</strong>{firm.selfReferential ? null : <small>{ko ? `구성원 ${firm.members.length}명` : `${firm.members.length} members`}</small>}</span>
                            <button className={styles.addTeam} type="button" disabled={disabled || teamSelected || !firm.team.callable} onClick={() => addCandidate(firm.team)} title={!firm.team.callable ? firm.team.blockedReason : undefined}>
                              {teamSelected ? (ko ? "연결됨" : "Added") : (ko ? "팀 추가" : "Add team")}
                            </button>
                          </div>
                          {firmOpen && !firm.selfReferential ? <div className={styles.children} id={firmPanelId}>{firm.members.map(renderCandidate)}</div> : null}
                        </div>
                      );
                    })}
                    {section.standalone.length > 0 ? (
                      <div className={styles.standalone}>
                        {section.firms.length > 0 ? <span className={styles.standaloneLabel}>{ko ? "단일 에이전트" : "Standalone agents"}</span> : null}
                        {section.standalone.map(renderCandidate)}
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
        <span className={styles.feedback} role="status" aria-live="polite">{feedback}</span>
      </aside>
    </section>
  );
}
