"use client";
import { useState, useRef, useEffect } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { PawLogo } from "./PawLogo";
import {
  IconChevronDown, IconWand, IconSettings, IconBuilding,
  IconFileUp, IconStore, IconKey, IconLayers
} from "./Icon";
import { AccountChip } from "./AccountChip";
import { useT } from "@/lib/i18n";

type DropdownState = "agent_forge" | "hub" | "environment" | null;

export function TopNavbar() {
  const pathname = usePathname() ?? "/";
  const { t } = useT();
  const [activeDropdown, setActiveDropdown] = useState<DropdownState>(null);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const agentForgeActive =
    pathname.startsWith("/library/agents") ||
    pathname.startsWith("/build");
  const environmentActive =
    pathname.startsWith("/library") &&
    !pathname.startsWith("/library/agents");

  const handleMouseEnter = (menu: DropdownState) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    setActiveDropdown(menu);
  };

  const handleMouseLeave = () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    timeoutRef.current = setTimeout(() => {
      setActiveDropdown(null);
    }, 300);
  };

  const NavItem = ({ label, href, active, dropdown }: { label: string, href: string, active?: boolean, dropdown?: DropdownState }) => (
    <div 
      className="titlebar-nodrag"
      style={{ position: "relative", height: "100%", display: "flex", alignItems: "center" }}
      onMouseEnter={() => dropdown ? handleMouseEnter(dropdown) : handleMouseEnter(null)}
      onMouseLeave={handleMouseLeave}
    >
      <Link
        href={href}
        style={{
          display: "flex", alignItems: "center", gap: 4,
          padding: "6px 12px", borderRadius: 8,
          fontSize: 13, fontWeight: 600, color: active ? "var(--ink)" : "var(--muted-deep)",
          textDecoration: "none", transition: "all 0.15s",
          background: active ? "var(--fill-1)" : "transparent"
        }}
        className="top-nav-item"
      >
        {label}
        {dropdown && <IconChevronDown size={14} style={{ color: "var(--muted)", transform: activeDropdown === dropdown ? "rotate(180deg)" : "none", transition: "transform 0.2s" }} />}
      </Link>

      {/* Dropdown Panel - Wrap with an invisible padding box that perfectly connects to the header */}
      {dropdown && activeDropdown === dropdown && (
        <div 
          style={{ 
            position: "absolute", 
            top: "100%", 
            left: "50%", 
            transform: "translateX(-50%)", 
            paddingTop: 8, // Visual gap
            zIndex: 100,
            cursor: "default"
          }}
          onMouseEnter={() => handleMouseEnter(dropdown)}
          onMouseLeave={handleMouseLeave}
        >
          {/* An explicit invisible bridge to block Electron drag region mouseleave bug */}
          <div style={{ position: "absolute", top: 0, left: 0, right: 0, height: 16, background: "rgba(255,255,255,0.01)" }} />
          <div 
            style={{
              background: "var(--paper)", border: "1px solid var(--paper-edge)",
              borderRadius: 12,
              boxShadow: "0 8px 30px rgba(0,0,0,0.12)",
              padding: 6,
              minWidth: dropdown === "environment" ? 260 : 220,
              display: "flex", flexDirection: "column", gap: 2,
              animation: "slideDown 0.15s ease-out"
            }}
          >
            {dropdown === "agent_forge" && (
            <>
              <DropdownLink href="/build" icon={<IconBuilding size={14} />} label={t("nav.build")} sub={t("nav.top.build_sub")} />
              <DropdownLink href="/library/agents" icon={<IconWand size={14} />} label={t("nav.agent")} sub={t("nav.top.agent_sub")} />
            </>
          )}
          {dropdown === "hub" && (
            <>
              <DropdownLink href="/marketplace" icon={<IconStore size={14} />} label={t("nav.agent_hub")} sub={t("nav.top.agent_hub_sub")} />
              <DropdownLink href="/cloud" icon={<IconFileUp size={14} />} label={t("nav.publish")} sub={t("nav.top.publish_sub")} />
            </>
          )}
          {dropdown === "environment" && (
            <>
              <DropdownLink href="/library/env" icon={<IconKey size={14} />} label={t("nav.env_keys")} sub={t("nav.top.env_keys_sub")} />
              <DropdownLink href="/library/mcps" icon={<IconLayers size={14} />} label={t("nav.mcp_tools")} sub={t("nav.top.mcp_tools_sub")} />
            </>
          )}
          </div>
        </div>
      )}
    </div>
  );

  return (
    <header
      className="titlebar-drag"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        height: 52,
        padding: "0 16px 0 72px", // 72px for macOS traffic lights
        background: "var(--paper)",
        borderBottom: "1px solid var(--glass-border)",
        flexShrink: 0,
        zIndex: 50,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 24, height: "100%" }}>
        {/* Logo */}
        <Link href="/" className="titlebar-nodrag" style={{ display: "flex", alignItems: "center", gap: 8, textDecoration: "none", color: "var(--ink)" }}>
          <PawLogo size={20} />
          <span style={{ fontFamily: "var(--font-head)", fontSize: 14, fontWeight: 700, letterSpacing: 0 }}>Agentlas</span>
        </Link>

        {/* Navigation Tabs */}
        <nav className="titlebar-nodrag" style={{ display: "flex", alignItems: "center", gap: 4, height: "100%" }}>
          <NavItem label={t("nav.dashboard")} href="/dashboard" active={pathname.startsWith("/dashboard")} />
          <NavItem label={t("nav.workspace")} href="/workspace" active={pathname.startsWith("/workspace") || pathname.startsWith("/project")} />
          <NavItem label={t("nav.group.agent_forge")} href="/build" dropdown="agent_forge" active={agentForgeActive} />
          <NavItem label={t("nav.site")} href="/site" active={pathname.startsWith("/site")} />
          <NavItem label={t("nav.group.hub")} href="/marketplace" dropdown="hub" active={pathname.startsWith("/marketplace") || pathname.startsWith("/cloud")} />
          <NavItem label={t("nav.group.environment")} href="/library/env" dropdown="environment" active={environmentActive} />
        </nav>
      </div>

      <div className="titlebar-nodrag" style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Link href="/settings" style={{ color: pathname === "/settings" ? "var(--ink)" : "var(--muted-deep)", display: "flex", padding: 6, borderRadius: 6, transition: "all 0.15s" }} className="hover-bg-fill">
          <IconSettings size={16} />
        </Link>
        <div style={{ height: 20, width: 1, background: "var(--paper-edge)" }} />
        <AccountChip />
      </div>

      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes slideDown {
          from { opacity: 0; transform: translateY(-8px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .hover-bg-fill:hover {
          background: var(--fill-1);
        }
        .top-nav-item:hover {
          background: var(--fill-1);
          color: var(--ink) !important;
        }
      `}} />
    </header>
  );
}

function DropdownLink({ href, icon, label, sub }: { href: string, icon: React.ReactNode, label: string, sub: string }) {
  return (
    <Link 
      href={href}
      style={{
        display: "flex", alignItems: "center", gap: 12, padding: "8px 12px",
        borderRadius: 8, textDecoration: "none", transition: "background 0.15s"
      }}
      className="hover-bg-fill"
    >
      <div style={{ width: 28, height: 28, borderRadius: 6, background: "var(--fill-2)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--ink)", flexShrink: 0 }}>
        {icon}
      </div>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, color: "var(--ink)", lineHeight: 1.2 }}>{label}</div>
        <div style={{ fontSize: 11, color: "var(--muted-deep)", lineHeight: 1.3 }}>{sub}</div>
      </div>
    </Link>
  );
}
