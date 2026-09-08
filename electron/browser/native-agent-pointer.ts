import type { WebContents } from "electron";

export type NativeAgentPointerInput = { phase: "move" | "down" | "up"; x: number; y: number };
const POINTER_WORLD = 1007;
const states = new WeakMap<WebContents, { generation: number; sequence: number }>();

type PointerWorld = Window & { __agentlasPointer?: { ticket: number; remove: () => void } };

/** Runs only in our isolated world. All interpolated input has passed numeric validation. */
function renderPointer(input: NativeAgentPointerInput, ticket: number, deadline: number): void {
  if (Date.now() >= deadline) return;
  const world = window as PointerWorld;
  world.__agentlasPointer?.remove();
  if (!document.documentElement || input.x >= innerWidth || input.y >= innerHeight) return;
  const host = document.createElement("div");
  host.setAttribute("aria-hidden", "true");
  host.setAttribute("data-agentlas-input-pointer", "");
  host.style.cssText = `all:initial!important;position:fixed!important;left:${input.x}px!important;top:${input.y}px!important;width:0!important;height:0!important;pointer-events:none!important;z-index:2147483647!important;`;
  const shadow = host.attachShadow({ mode: "closed" });
  const style = document.createElement("style");
  style.textContent = `:host,*{pointer-events:none!important}svg{position:absolute;left:-2px;top:-2px;width:22px;height:27px;filter:drop-shadow(0 1px 2px #0008)}span{position:absolute;left:16px;top:18px;padding:2px 4px;border-radius:4px;background:#2563eb;color:white;font:600 9px/12px system-ui}i{position:absolute;left:-13px;top:-13px;width:24px;height:24px;border:2px solid #60a5fa;border-radius:50%;animation:pulse 240ms ease-out both}@keyframes pulse{from{transform:scale(.5);opacity:1}to{transform:scale(1.4);opacity:0}}@media(prefers-reduced-motion:reduce){i{animation:none}}`;
  shadow.append(style);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 22 27");
  const path = document.createElementNS(svg.namespaceURI, "path");
  path.setAttribute("d", "M3 2 L3 22 L8 17 L12 25 L16 23 L12 15 L20 15 Z");
  path.setAttribute("fill", "#2563eb");
  path.setAttribute("stroke", "white");
  path.setAttribute("stroke-width", "1.5");
  svg.append(path);
  shadow.append(svg);
  const label = document.createElement("span");
  label.textContent = "AI";
  shadow.append(label);
  if (input.phase === "down") shadow.append(document.createElement("i"));
  const events = ["pointermove", "pointerdown", "keydown", "wheel", "touchstart"] as const;
  let timer: ReturnType<typeof setTimeout>;
  const remove = () => {
    clearTimeout(timer);
    host.remove();
    for (const name of events) window.removeEventListener(name, onInput, true);
    window.removeEventListener("pagehide", remove);
    if (world.__agentlasPointer?.ticket === ticket) delete world.__agentlasPointer;
  };
  // CDP input is also trusted: the next acknowledged AI event replaces this marker.
  // Synthetic page events cannot prolong or assert an AI action.
  const onInput = (event: Event) => { if (event.isTrusted) remove(); };
  world.__agentlasPointer = { ticket, remove };
  for (const name of events) window.addEventListener(name, onInput, { capture: true, passive: true });
  window.addEventListener("pagehide", remove, { once: true });
  document.documentElement.append(host);
  timer = setTimeout(remove, 1_500);
}

function removePointer(ticket?: number): void {
  const current = (window as PointerWorld).__agentlasPointer;
  if (current && (ticket === undefined || current.ticket === ticket)) current.remove();
}

async function executeDisplay(contents: WebContents, code: string): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      contents.executeJavaScriptInIsolatedWorld(POINTER_WORLD, [{ code }]),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, 500); }),
    ]);
  } finally { clearTimeout(timer); }
}

/**
 * Main-only display adapter. The caller must prove the exact registered guest and
 * invoke this only after its real CDP mouse dispatch succeeds and authority is rechecked.
 * Coordinates are CSS viewport pixels; this never moves the OS cursor or dispatches input.
 * Display failure must not change the underlying tool result.
 */
export async function showNativeAgentPointer(contents: WebContents, input: NativeAgentPointerInput): Promise<void> {
  if (!input || !["move", "down", "up"].includes(input.phase)
    || !Number.isFinite(input.x) || !Number.isFinite(input.y)
    || input.x < 0 || input.y < 0 || input.x > 1_000_000 || input.y > 1_000_000 || contents.isDestroyed()) return;
  let state = states.get(contents);
  if (!state) {
    state = { generation: 0, sequence: 0 };
    states.set(contents, state);
    const captured = state;
    const clear = () => {
      captured.generation += 1;
      if (!contents.isDestroyed()) void executeDisplay(contents, `(${removePointer.toString()})()`).catch(() => {});
    };
    contents.on("did-start-navigation", (_event, _url, _inPlace, isMainFrame) => { if (isMainFrame) clear(); });
    contents.on("did-navigate-in-page", (_event, _url, isMainFrame) => { if (isMainFrame) clear(); });
    contents.once("destroyed", () => { captured.generation += 1; states.delete(contents); });
  }
  const generation = state.generation;
  const ticket = ++state.sequence;
  const safeInput = { phase: input.phase, x: input.x, y: input.y };
  try {
    await executeDisplay(contents, `(${renderPointer.toString()})(${JSON.stringify(safeInput)},${ticket},${Date.now() + 500})`);
    if (!contents.isDestroyed() && state.generation !== generation) {
      await executeDisplay(contents, `(${removePointer.toString()})(${ticket})`);
    }
  } catch { /* A closed/navigating guest is allowed to drop this transient display. */ }
}
