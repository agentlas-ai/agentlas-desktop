// Wording rules shared by the menu readers of every platform: which menus are the owner's own data, and when two captions are the same.

// Menus whose contents are the owner's own data rather than the app's features: the system menu (user name, recent apps and files), the
// window list (document titles) and "recent items" submenus (file names). They are never descended into, never stored.
const WINDOW_MENU = /^(window|windows|윈도우|창|ウインドウ|ウィンドウ|窗口|視窗|fenster|fenêtre|ventana|finestra|janela|окно)$/i;
const RECENT_MENU = /(recent|최근|最近|zuletzt|récent|reciente|recent[ei])/i;

export function isPersonalMenu(label: string, depth: number, index: number): boolean {
  if (depth === 0 && index === 0 && label === "Apple") return true;
  if (depth === 0 && WINDOW_MENU.test(label.trim())) return true;
  return RECENT_MENU.test(label);
}

// A caption written with three dots and the same caption written with the ellipsis character are one caption; so are two that differ by padding.
export const sameLabel = (a: string, b: string): boolean => a.trim() === b.trim() || a.trim().replace(/\.\.\./g, "…") === b.trim().replace(/\.\.\./g, "…");
