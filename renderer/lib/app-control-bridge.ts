"use client";

import type { AppControlRendererBridge, AppControlRendererOperation, AppControlRendererState } from "@shared/app-control";

declare global {
  interface Window { agentlasAppControl?: AppControlRendererBridge }
}

export const SIDENAV_COLLAPSE_KEY = "agentlas.sidenav.collapsed";

export function setAppSidebarCollapsed(collapsed: boolean): void {
  const next = collapsed ? "1" : "0";
  window.localStorage.setItem(SIDENAV_COLLAPSE_KEY, next);
  window.dispatchEvent(new StorageEvent("storage", { key: SIDENAV_COLLAPSE_KEY, newValue: next }));
}

/** Resolve only after the live renderer observes the requested state. A sent event alone is not application. */
export function installAppControlRenderer(input: {
  read(): AppControlRendererState;
  apply(operation: AppControlRendererOperation, args: Record<string, unknown>): void | Partial<AppControlRendererState> | Promise<void | Partial<AppControlRendererState>>;
}): () => void {
  let alive = true;
  // Keep mutations ordered so a second setting change cannot make an earlier one look applied.
  let tail: Promise<unknown> = Promise.resolve();
  const bridge: AppControlRendererBridge = {
    request(operation, args) {
      const run = async () => {
        if (!alive) return { ok: false, operation, code: "renderer-unavailable", message: "The app view changed before this operation." };
        if (operation === "app.getState" || operation === "app.getUiPreferences") return { ok: true, operation, state: input.read() };
        let expected: void | Partial<AppControlRendererState>;
        try { expected = await input.apply(operation, args); }
        catch (error) { return { ok: false, operation, code: "renderer-operation-refused", message: error instanceof Error ? error.message : "UI operation refused." }; }
        const deadline = Date.now() + 5_000;
        while (alive && Date.now() < deadline) {
          // React has to render the provider state before acknowledging it, including asynchronous OS locale resolution.
          await new Promise<void>((resolve) => setTimeout(resolve, 20));
          const state = input.read();
          const applied = operation === "app.navigate" ? state.route === args.route
            : operation === "app.setLanguage" ? state.localePreference === args.locale
              && state.locale === (expected?.locale ?? args.locale)
            : operation === "app.setTheme" ? state.themePreference === args.theme
            : operation === "app.setSidebar" ? (args.collapsed === undefined || state.sidebarCollapsed === args.collapsed)
              && (args.width === undefined || Math.abs(state.sidebarWidth - Number(args.width)) <= 1)
            : operation === "app.setMediaDisplay" ? state.media[args.kind as keyof typeof state.media] === args.visible
            : operation === "app.setUiPreference" ? JSON.stringify(state.uiPreferences[args.name as keyof typeof state.uiPreferences])
              === JSON.stringify(expected?.uiPreferences?.[args.name as keyof typeof state.uiPreferences])
            : false;
          if (applied) return { ok: true, operation, state };
        }
        return { ok: false, operation, code: "renderer-application-unconfirmed", message: "The requested UI state was not observed." };
      };
      const result = tail.then(run, run);
      tail = result;
      return result;
    },
  };
  window.agentlasAppControl = bridge;
  return () => { alive = false; if (window.agentlasAppControl === bridge) delete window.agentlasAppControl; };
}
