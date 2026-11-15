"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useT } from "@/lib/i18n";
import { usePersonalAgentIdentity } from "@/lib/personal-agent-identity";
import { OneAgentPortrait } from "./one/OneAgentPortrait";
import styles from "./PersonalAgentRow.module.css";

// Same address the old product switcher used for "One": the personal agent's own screen.
const PERSONAL_AGENT_ROUTE = "/one?personal=1";

/**
 * The personal agent row at the top-left of the app frame (Agentlas 2.0): face, the name the person chose, and the role.
 * Used by both left frames (SideNav, ProjectSidebar). Name and face come from the saved profile; until they are read, or when
 * the read fails, only the role label is drawn and the default face is used - the row is still a working link.
 */
export function PersonalAgentRow({ compact = false }: { compact?: boolean }) {
  const { t } = useT();
  const pathname = usePathname() ?? "";
  const identity = usePersonalAgentIdentity();
  const role = t("nav.personal_agent");
  const name = identity?.name || "";
  const title = name || role;
  return (
    <Link
      href={PERSONAL_AGENT_ROUTE}
      prefetch={false}
      className={`${styles.row} ${compact ? styles.compact : ""}`}
      data-personal-agent-row="true"
      data-active={pathname === "/one" || pathname.startsWith("/one/") ? "true" : "false"}
      aria-label={name ? `${name}, ${role}` : role}
      title={compact ? (name ? `${name} · ${role}` : role) : undefined}
    >
      <span className={styles.face}>
        <OneAgentPortrait
          label={title}
          status="quiet"
          size="small"
          tone={identity?.avatarIcon ?? "character:orange-dino"}
          revision={identity?.revision ?? undefined}
        />
      </span>
      {compact ? null : (
        <span className={styles.copy}>
          <span className={styles.name}>{title}</span>
          {name ? <span className={styles.role}>{role}</span> : null}
        </span>
      )}
    </Link>
  );
}
