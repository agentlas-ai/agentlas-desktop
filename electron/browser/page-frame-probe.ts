// Node-safe structural page probe shared by the native relay and browser ladder.
/** Visible iframe sources and the top URL, read structurally (no page wording). */
export const PAGE_FRAME_PROBE_SOURCE = `(() => {
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el);
    return r.width >= 20 && r.height >= 20 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity || '1') > 0.05; };
  return { url: location.href, frames: [...document.querySelectorAll('iframe')].filter(visible).map((f) => String(f.src || '')).filter(Boolean).slice(0, 32) };
})()`;
