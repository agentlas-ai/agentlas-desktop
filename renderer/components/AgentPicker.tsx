"use client";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { InstalledAgent } from "@/lib/types";
import { visibleAgents } from "@/lib/agent-visibility";
import { pickLocalized, useT } from "@/lib/i18n";
import { AgentAvatar } from "./AgentAvatar";
import { IconCheck, IconChevronDown, IconSearch } from "./Icon";

type Placement = "bottom" | "top";

interface AgentPickerProps {
  agents: InstalledAgent[];
  activeId: string;
  onChange: (id: string) => void;
  ariaLabel: string;
  placement?: Placement;
  maxButtonWidth?: number;
  activePrefix?: ReactNode;
  activeBadge?: ReactNode;
  buttonStyle?: CSSProperties;
}

export function AgentPicker({
  agents,
  activeId,
  onChange,
  ariaLabel,
  placement = "bottom",
  maxButtonWidth = 220,
  activePrefix,
  activeBadge,
  buttonStyle,
}: AgentPickerProps) {
  const { locale } = useT();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const displayAgents = useMemo(() => visibleAgents(agents), [agents]);
  const active = displayAgents.find((agent) => agent.id === activeId) ?? displayAgents[0] ?? null;
  const activeLoc = active ? pickLocalized(active, locale) : null;

  const filteredAgents = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return displayAgents;
    return displayAgents.filter((agent) => {
      const loc = pickLocalized(agent, locale);
      return `${loc.name} ${loc.tagline} ${agent.slug}`.toLowerCase().includes(q);
    });
  }, [displayAgents, locale, query]);

  useEffect(() => {
    if (!open) return;
    function onDoc(e: MouseEvent) {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setHoveredId(activeId);
    window.setTimeout(() => searchRef.current?.focus(), 0);
  }, [activeId, open]);

  function choose(id: string) {
    onChange(id);
    setOpen(false);
    setQuery("");
  }

  function moveHover(delta: number) {
    if (filteredAgents.length === 0) return;
    const index = filteredAgents.findIndex((agent) => agent.id === (hoveredId ?? activeId));
    const next =
      index < 0
        ? delta > 0
          ? 0
          : filteredAgents.length - 1
        : (index + delta + filteredAgents.length) % filteredAgents.length;
    setHoveredId(filteredAgents[next].id);
  }

  return (
    <div
      ref={rootRef}
      className="titlebar-nodrag"
      style={{ position: "relative", display: "inline-flex", minWidth: 0 }}
      onKeyDown={(e) => {
        if (!open && (e.key === "ArrowDown" || e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          setOpen(true);
          return;
        }
        if (!open) return;
        if (e.key === "Escape") {
          e.preventDefault();
          setOpen(false);
        } else if (e.key === "ArrowDown") {
          e.preventDefault();
          moveHover(1);
        } else if (e.key === "ArrowUp") {
          e.preventDefault();
          moveHover(-1);
        } else if (e.key === "Enter" && hoveredId) {
          e.preventDefault();
          choose(hoveredId);
        }
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={activeLoc?.tagline ?? ariaLabel}
        style={{
          display: "inline-flex",
          alignItems: "center",
          gap: 8,
          minWidth: 0,
          maxWidth: maxButtonWidth,
          padding: "4px 10px 4px 4px",
          borderRadius: 999,
          background: "var(--paper-2)",
          border: "1px solid var(--paper-edge)",
          color: "var(--ink)",
          boxShadow: "var(--shadow-1)",
          cursor: "pointer",
          ...buttonStyle,
        }}
      >
        {activePrefix ?? (activeLoc && <AgentAvatar name={activeLoc.name} tone={active?.tone} size={26} />)}
        <span
          style={{
            minWidth: 0,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            fontSize: 12,
            fontWeight: 650,
          }}
        >
          {activeLoc?.name ?? (locale === "en" ? "Pick an agent" : "에이전트 선택")}
        </span>
        {activeBadge}
        <IconChevronDown size={12} style={{ color: "var(--muted-deep)", flexShrink: 0 }} />
      </button>

      {open && (
        <div
          role="listbox"
          aria-label={ariaLabel}
          style={{
            position: "absolute",
            left: 0,
            [placement === "top" ? "bottom" : "top"]: "calc(100% + 8px)",
            width: 318,
            maxWidth: "min(318px, calc(100vw - 28px))",
            maxHeight: 326,
            display: "flex",
            flexDirection: "column",
            overflow: "hidden",
            padding: 6,
            borderRadius: 12,
            background: "var(--paper)",
            border: "1px solid var(--paper-edge)",
            boxShadow: "0 18px 48px rgba(11, 11, 15, 0.16), var(--shadow-2)",
            zIndex: 90,
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              height: 34,
              padding: "0 10px",
              color: "var(--muted-deep)",
              borderRadius: 9,
              background: "var(--paper)",
              border: "1px solid transparent",
              flexShrink: 0,
            }}
          >
            <IconSearch size={14} />
            <input
              ref={searchRef}
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setHoveredId(null);
              }}
              placeholder={locale === "en" ? "Search agents" : "에이전트 검색"}
              style={{
                width: "100%",
                border: 0,
                outline: 0,
                background: "transparent",
                color: "var(--ink)",
                fontSize: 12.5,
                minWidth: 0,
              }}
            />
          </div>
          <div
            style={{
              height: 1,
              background: "var(--paper-edge)",
              margin: "4px 4px 5px",
              flexShrink: 0,
            }}
          />
          <div
            style={{
              maxHeight: 264,
              overflowY: "auto",
              overscrollBehavior: "contain",
              paddingRight: 2,
            }}
          >
            {filteredAgents.length === 0 ? (
              <div style={{ padding: "18px 12px", color: "var(--muted-deep)", fontSize: 12 }}>
                {locale === "en" ? "No agents found" : "검색된 에이전트가 없습니다"}
              </div>
            ) : (
              filteredAgents.map((agent) => {
                const loc = pickLocalized(agent, locale);
                const selected = agent.id === activeId;
                const hovered = agent.id === hoveredId;
                return (
                  <button
                    key={agent.id}
                    type="button"
                    role="option"
                    aria-selected={selected}
                    onMouseEnter={() => setHoveredId(agent.id)}
                    onClick={() => choose(agent.id)}
                    style={{
                      width: "100%",
                      display: "grid",
                      gridTemplateColumns: "26px minmax(0, 1fr) 16px",
                      alignItems: "center",
                      gap: 9,
                      padding: "7px 8px",
                      borderRadius: 8,
                      background: selected || hovered ? "var(--paper-2)" : "transparent",
                      color: "var(--ink)",
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <AgentAvatar name={loc.name} tone={agent.tone} size={24} />
                    <span style={{ minWidth: 0 }}>
                      <span
                        style={{
                          display: "block",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          fontSize: 12.5,
                          fontWeight: selected ? 700 : 600,
                        }}
                      >
                        {loc.name}
                      </span>
                      <span
                        style={{
                          display: "block",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                          marginTop: 1,
                          color: "var(--muted-deep)",
                          fontSize: 11,
                        }}
                      >
                        {loc.tagline}
                      </span>
                    </span>
                    {selected && <IconCheck size={14} style={{ color: "var(--accent)" }} />}
                  </button>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
