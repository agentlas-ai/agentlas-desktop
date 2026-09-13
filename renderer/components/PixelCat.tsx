"use client";

const CAT_PALETTES = [
  { fur: "#7d8061", shade: "#5f6248", light: "#d8d7c5", eye: "#253032" },
  { fur: "#a58f72", shade: "#78654f", light: "#e4d8c6", eye: "#303635" },
  { fur: "#6d7c78", shade: "#4e5d59", light: "#cad6cf", eye: "#242d2e" },
  { fur: "#8b7b75", shade: "#665955", light: "#ded0c9", eye: "#2f3131" },
  { fur: "#72766f", shade: "#525750", light: "#d5d7cf", eye: "#28302e" },
] as const;

function identityHash(seed: string): number {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index += 1) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

/** Decorative, deterministic pixel-cat avatar. It conveys identity only. */
export function PixelCat({ seed, size = 32 }: { seed: string; size?: number }) {
  const hash = identityHash(seed || "agentlas");
  const palette = CAT_PALETTES[hash % CAT_PALETTES.length];
  const mirrored = (hash & 1) === 1;

  return (
    <svg
      aria-hidden="true"
      focusable="false"
      width={size}
      height={size}
      viewBox="0 0 32 32"
      shapeRendering="crispEdges"
      style={{ display: "block", flex: "0 0 auto" }}
    >
      <rect x="1" y="1" width="30" height="30" rx="7" fill="var(--paper-2, #f7f7f4)" />
      <g transform={mirrored ? "translate(32 0) scale(-1 1)" : undefined}>
        {/* Long tail, separated from the body so the silhouette cannot read as a crab. */}
        <rect x="23" y="17" width="3" height="8" fill={palette.shade} />
        <rect x="25" y="14" width="3" height="5" fill={palette.shade} />
        <rect x="27" y="12" width="2" height="4" fill={palette.fur} />

        <rect x="7" y="12" width="17" height="13" fill={palette.fur} />
        <rect x="9" y="8" width="13" height="8" fill={palette.fur} />
        {/* Original cat silhouette: two unmistakable pointed ears. */}
        <path d="M8 10V4l6 5v3H8Z" fill={palette.fur} />
        <path d="M18 9l6-5v8h-6V9Z" fill={palette.fur} />
        <path d="M10 8V6l3 3h-3Z" fill={palette.light} />
        <path d="M21 8V6l-3 3h3Z" fill={palette.light} />

        <rect x="10" y="13" width="3" height="3" fill={palette.eye} />
        <rect x="19" y="13" width="3" height="3" fill={palette.eye} />
        <rect x="15" y="17" width="2" height="2" fill={palette.shade} />
        <rect x="13" y="20" width="2" height="1" fill={palette.light} />
        <rect x="17" y="20" width="2" height="1" fill={palette.light} />
        <rect x="9" y="24" width="5" height="3" fill={palette.shade} />
        <rect x="18" y="24" width="5" height="3" fill={palette.shade} />
      </g>
    </svg>
  );
}
