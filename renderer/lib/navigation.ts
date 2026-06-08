export function navigate(path: string, mode: "assign" | "replace" = "assign") {
  if (typeof window === "undefined") return;

  try {
    const method = mode === "replace" ? "replaceState" : "pushState";
    window.history[method](null, "", path);
    window.dispatchEvent(new PopStateEvent("popstate", { state: null }));
  } catch {
    if (mode === "replace") window.location.replace(path);
    else window.location.assign(path);
  }
}
