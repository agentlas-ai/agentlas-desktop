/**
 * The renderer-side bridge for the built-in `design` plugin output contract.
 *
 * The plugin owns the visual workflow (research, token extraction, QA), while
 * this small contract makes the resulting semantic tokens available to the
 * trusted One/Work output surfaces.  The values themselves live in
 * `globals.css` and in `electron/surface-design/theme.ts`, so static generated
 * surfaces and the in-app rail use the same names.
 */

export {
  DESIGN_OUTPUT_TOKEN_SOURCE,
  DESIGN_OUTPUT_TOKEN_CONTRACT,
  type DesignOutputSurfaceKind,
} from "@shared/design-output-tokens";
import {
  DESIGN_OUTPUT_TOKEN_SOURCE,
  DESIGN_OUTPUT_TOKEN_CONTRACT,
  type DesignOutputSurfaceKind,
} from "@shared/design-output-tokens";

/**
 * Use this on every trusted result surface.  It is intentionally a plain
 * attribute helper rather than a provider: reports, maps, code, and media can
 * all appear in different React trees, including the One and Work rails.
 */
export function designOutputSurfaceProps(
  kind: DesignOutputSurfaceKind,
  className?: string,
): {
  className: string;
  "data-design-token-source": typeof DESIGN_OUTPUT_TOKEN_SOURCE;
  "data-design-token-contract": typeof DESIGN_OUTPUT_TOKEN_CONTRACT;
  "data-design-surface": DesignOutputSurfaceKind;
} {
  return {
    className: ["design-output-surface", className].filter(Boolean).join(" "),
    "data-design-token-source": DESIGN_OUTPUT_TOKEN_SOURCE,
    "data-design-token-contract": DESIGN_OUTPUT_TOKEN_CONTRACT,
    "data-design-surface": kind,
  };
}

export function designSurfaceKindForOutput(
  kind: string | null | undefined,
): DesignOutputSurfaceKind {
  switch (kind) {
    case "browser":
    case "web":
    case "service-app":
    case "creative-studio":
      return "web";
    case "map":
    case "map-list":
      return "map";
    case "code":
    case "terminal":
      return "code";
    case "image":
      return "image";
    case "video":
      return "video";
    case "audio":
      return "audio";
    case "document":
    case "pdf":
    case "spreadsheet":
    case "presentation":
      return "document";
    case "gallery":
      return "gallery";
    default:
      return "report";
  }
}
