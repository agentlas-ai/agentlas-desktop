/** Shared identity for the built-in `design` plugin's trusted output surface. */
export const DESIGN_OUTPUT_TOKEN_SOURCE = "builtin:design@0.1.0" as const;
export const DESIGN_OUTPUT_TOKEN_CONTRACT = "output-surface.v1" as const;

export type DesignOutputSurfaceKind =
  | "report"
  | "web"
  | "map"
  | "code"
  | "image"
  | "video"
  | "audio"
  | "document"
  | "gallery";
