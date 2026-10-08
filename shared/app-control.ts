import type { AppUiPreferences } from "./app-ui-preferences";

/** Main may ask the renderer to perform these UI operations through its existing setters. */
export interface AppControlRendererState {
  route: string;
  localePreference: "ko" | "en" | "system";
  locale: "ko" | "en";
  themePreference: "light" | "dark" | "system";
  theme: "light" | "dark";
  darkThemeAvailable: boolean;
  sidebarCollapsed: boolean;
  sidebarWidth: number;
  media: { image: boolean; video: boolean; audio: boolean };
  uiPreferences: AppUiPreferences;
}

export type AppControlRendererOperation = "app.getState" | "app.navigate" | "app.setLanguage"
  | "app.setTheme" | "app.setSidebar" | "app.setMediaDisplay" | "app.getUiPreferences" | "app.setUiPreference";

export interface AppControlRendererReply {
  ok: boolean;
  operation: AppControlRendererOperation;
  state?: AppControlRendererState;
  code?: string;
  message?: string;
}

export interface AppControlRendererBridge {
  request(operation: AppControlRendererOperation, args: Record<string, unknown>): Promise<AppControlRendererReply>;
}
