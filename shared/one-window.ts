export interface OneWindowBounds { x: number; y: number; width: number; height: number }
export interface OneWindowState {
  role: "main" | "one";
  visible: boolean;
  alwaysOnTop: boolean;
  shortcut: { registered: boolean; errorCode?: string };
  tray: { visible: boolean; errorCode?: string };
  minWidth: number;
  minHeight: number;
  bounds: OneWindowBounds | null;
}
export interface OneWindowAPI {
  getState(): Promise<OneWindowState>;
  setAlwaysOnTop(input: { value: boolean }): Promise<OneWindowState>;
  showMain(input?: { route?: string }): Promise<OneWindowState>;
  open(input?: { taskId?: string }): Promise<OneWindowState>;
  hide(): Promise<OneWindowState>;
}
