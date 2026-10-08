import { normalizeRuntimeSelectionInput } from "./runtime-selection";
import type { RuntimeSelection } from "./types";

export type OneRuntimePreference = (Omit<RuntimeSelection, "role" | "inherit"> & { role?: "orchestrator"; inherit?: false }) | null;
export const APP_OUTPUT_SECTIONS = ["files", "mcp", "agents", "processes", "computer", "sources"] as const;
export type AppOutputSection = (typeof APP_OUTPUT_SECTIONS)[number];

/** Persistent presentation preferences only. Permissions, credentials and execution records are excluded. */
export interface AppUiPreferences {
  oneRuntimeSelection: OneRuntimePreference;
  oneLeftRailCollapsed: boolean;
  oneRailMode: "organisation" | "sessions" | "mail";
  oneContextRailOpen: boolean;
  oneHomeHistoryOpen: boolean;
  oneContextRailWidth: number;
  outputCollapsedSections: AppOutputSection[];
  chatRightPanel: { open: boolean; tab: "file" | "agent" | "panel" | "memory" };
  chatRightPanelWidth: number;
  projectCollapsed: Record<string, boolean>;
  projectInspectorCollapsed: boolean;
  firmOrgWidth: number;
  firmSidebarCollapsed: boolean;
  automationFlowPanels: { left: boolean; right: boolean };
  documentCitationStyle: "APA" | "MLA" | "Chicago" | "IEEE" | "Harvard";
}
export type AppUiPreferenceName = keyof AppUiPreferences;
interface PreferenceDefinition<T> {
  storageKey: string;
  encoding: "json" | "text";
  defaultValue: T;
  description: string;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
}
export const appUiPreferenceDefinitions = {
  oneRuntimeSelection: { storageKey: "agentlas.one.runtime-selection.v1", encoding: "json", defaultValue: null, description: "Runtime override for the next personal One message. Null clears the override; active chat and Goal runtime bindings remain independently managed." },
  oneLeftRailCollapsed: { storageKey: "agentlas.one.left-rail-collapsed.v1", encoding: "json", defaultValue: false, description: "Collapse the One left rail." },
  oneRailMode: { storageKey: "agentlas.one.railMode", encoding: "text", defaultValue: "organisation", description: "One left rail tab. Mail requires an available mailbox." },
  oneContextRailOpen: { storageKey: "agentlas.one.context-rail-open.v2", encoding: "json", defaultValue: false, description: "Open the One output rail." },
  oneHomeHistoryOpen: { storageKey: "agentlas.one.home-history-open.v1", encoding: "json", defaultValue: false, description: "Open the One home history rail." },
  oneContextRailWidth: { storageKey: "agentlas.one.context-rail-width.v2", encoding: "json", defaultValue: 324, minimum: 200, maximum: 1280, description: "Preferred One output width, 200–1280 pixels; visible width is constrained by the window." },
  outputCollapsedSections: { storageKey: "agentlas.one.output-sections.v1", encoding: "json", defaultValue: [], maxItems: APP_OUTPUT_SECTIONS.length, description: "Collapsed output sections. Accepts files, mcp, agents, processes, computer, sources; duplicates are removed and IDs use canonical order." },
  chatRightPanel: { storageKey: "agentlas.chat.right_panel", encoding: "json", defaultValue: { open: false, tab: "agent" }, description: "Work chat output rail open state and selected tab." },
  chatRightPanelWidth: { storageKey: "agentlas.chat.right_panel_width", encoding: "json", defaultValue: 392, minimum: 320, maximum: 1280, description: "Preferred Work chat output width, 320–1280 pixels; visible width is constrained by the window." },
  projectCollapsed: { storageKey: "agentlas.project-sidebar.collapsed.v1", encoding: "json", defaultValue: {}, description: "Map of project IDs to collapsed chat-list states. Replaces the stored map." },
  projectInspectorCollapsed: { storageKey: "agentlas:project-inspector-collapsed", encoding: "json", defaultValue: false, description: "Collapse the project inspector." },
  firmOrgWidth: { storageKey: "agentlas.firm.orgWidth", encoding: "json", defaultValue: 300, minimum: 200, maximum: 500, description: "Organization sidebar width, 200–500 pixels." },
  firmSidebarCollapsed: { storageKey: "agentlas.firm.sidebarCollapsed", encoding: "json", defaultValue: false, description: "Collapse the organization sidebar in firm and agent-library views." },
  automationFlowPanels: { storageKey: "agentlas.automation.flow.panels", encoding: "json", defaultValue: { left: false, right: false }, description: "Open states of automation flow conversation and inspector panels." },
  documentCitationStyle: { storageKey: "agentlas.docstudio.style.v1", encoding: "text", defaultValue: "APA", description: "Document Studio citation style (independent from native document formatting styles)." },
} as const satisfies { [K in AppUiPreferenceName]: PreferenceDefinition<AppUiPreferences[K]> };

export function isAppUiPreferenceName(name: unknown): name is AppUiPreferenceName {
  return typeof name === "string" && Object.hasOwn(appUiPreferenceDefinitions, name);
}

/** Shared by Main and renderer; never accepts arbitrary storage keys or execution permissions. */
export function normalizeAppUiPreference<K extends AppUiPreferenceName>(name: K, value: unknown): AppUiPreferences[K] {
  if (!isAppUiPreferenceName(name)) throw new TypeError("app_ui_preference_unknown");
  const refuse = (): never => { throw new TypeError(`app_ui_preference_invalid:${name}`); };
  if (name === "oneRuntimeSelection") {
    return (value === null ? null : {
      ...normalizeRuntimeSelectionInput(value, { roles: ["orchestrator"], allowInherit: false }),
      role: "orchestrator", inherit: false,
    }) as AppUiPreferences[K];
  }
  const definition = appUiPreferenceDefinitions[name];
  if (typeof definition.defaultValue === "boolean") {
    if (typeof value !== "boolean") return refuse();
  } else if (typeof definition.defaultValue === "number") {
    if (!("minimum" in definition) || !("maximum" in definition)) return refuse();
    const { minimum: min, maximum: max } = definition;
    if (typeof value !== "number" || !Number.isFinite(value) || value < min || value > max) return refuse();
    value = Math.round(value);
  } else if (name === "oneRailMode") {
    if (!["organisation", "sessions", "mail"].includes(value as string)) return refuse();
  } else if (name === "documentCitationStyle") {
    if (!["APA", "MLA", "Chicago", "IEEE", "Harvard"].includes(value as string)) return refuse();
  } else if (name === "outputCollapsedSections") {
    if (!Array.isArray(value) || value.length > appUiPreferenceDefinitions.outputCollapsedSections.maxItems
      || value.some((section) => !APP_OUTPUT_SECTIONS.includes(section))) return refuse();
    const selected = new Set(value);
    value = APP_OUTPUT_SECTIONS.filter((section) => selected.has(section));
  } else {
    if (!value || typeof value !== "object" || Array.isArray(value)) return refuse();
    const record = value as Record<string, unknown>;
    if (name === "projectCollapsed") {
      if (Object.keys(record).length > 10_000 || Object.entries(record).some(([key, flag]) => !key || key.length > 512 || ["__proto__", "constructor", "prototype"].includes(key) || typeof flag !== "boolean")) return refuse();
      value = { ...record };
    } else if (name === "chatRightPanel") {
      if (Object.keys(record).some((key) => key !== "open" && key !== "tab") || typeof record.open !== "boolean" || !["file", "agent", "panel", "memory"].includes(record.tab as string)) return refuse();
      value = { open: record.open, tab: record.tab };
    } else if (name === "automationFlowPanels") {
      if (Object.keys(record).some((key) => key !== "left" && key !== "right") || typeof record.left !== "boolean" || typeof record.right !== "boolean") return refuse();
      value = { left: record.left, right: record.right };
    }
  }
  return value as AppUiPreferences[K];
}
