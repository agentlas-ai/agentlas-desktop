import { loadSciencePluginRuntime } from "./plugin-runtime";
import { scienceDeclaredProjectionSupport, type ScienceDeclaredProjectionAccepts, type ScienceDeclaredSchemaNode } from "./statistics-declared-projection";

/**
 * The list of statistical methods a researcher may choose from.
 *
 * This exists because the list was being built twice. The Research Director got a catalogue
 * assembled inside the MCP tool server, and the Science launch screen got nothing -- so the one
 * screen a researcher starts an analysis from could reach exactly one method out of 178, and it
 * was hard-coded: `method: "kaplan_meier"`. A survival curve, and nothing else, from a screen
 * titled "Data & Statistics".
 *
 * One loader, read by both the agent and the screen, so the two cannot drift into offering
 * different sets. The registry itself stays the source: nothing here enumerates method names.
 */
export interface ScienceStatisticsMethodSummary {
  readonly method: string;
  readonly family: string;
  /**
   * The opening sentence of the method's own `neededWhen`. It answers the question a researcher
   * actually has in front of this list -- "when would I reach for this one?" -- and it is written
   * beside the method rather than here, so it cannot describe a method it no longer matches.
   */
  readonly neededWhen: string | null;
  /**
   * Whether this method can be run from an uploaded table at all, and what each of its declared
   * data properties would need from that table.
   *
   * The screen builds its column pickers from this rather than from a list of method names. That is
   * the whole point: the launch screen used to hard-code one method's two columns (`time`, `event`)
   * and could therefore offer exactly one analysis. A control derived from the declaration works
   * for a method nobody has thought about yet.
   */
  readonly projectable: boolean;
  readonly dataProperties: ReadonlyArray<{
    readonly property: string;
    readonly required: boolean;
    readonly accepts: ScienceDeclaredProjectionAccepts;
    /** Field names when the property is a row-object array, so the screen can ask for each column. */
    readonly fields: readonly string[];
    /** For a choice list, the options the method declares -- the screen offers exactly these. */
    readonly options: readonly string[];
  }>;
}

interface MethodDefinition {
  readonly method?: unknown;
  readonly family?: unknown;
  readonly linkage?: { readonly neededWhen?: unknown };
  readonly dataSchema?: ScienceDeclaredSchemaNode;
}

interface StatisticsEngineModule {
  readonly METHODS?: readonly unknown[];
  readonly METHOD_REGISTRY?: { readonly definitions?: readonly MethodDefinition[] };
}

function firstSentence(value: unknown): string | null {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) return null;
  const boundary = text.search(/\.\s/u);
  return (boundary > 0 ? text.slice(0, boundary + 1) : text).slice(0, 240);
}

export function scienceStatisticsMethodCatalogue(): ScienceStatisticsMethodSummary[] {
  // Through the shared resolver, not a path built here: it pins the manifest, refuses a symlink or
  // a swapped root, and runs the module from verified bytes in memory. A second way in would be a
  // second set of rules.
  const engine = loadSciencePluginRuntime<StatisticsEngineModule>(
    "agentlas-science-statistics", "runtime/engine.cjs", 16 * 1024 * 1024,
  ).runtime;
  // Core methods carry no registry definition; their declared shapes live beside the engine so the
  // screen can build column controls for them like any other method.
  const core = loadSciencePluginRuntime<{
    CORE_DATA_SCHEMAS?: Record<string, ScienceDeclaredSchemaNode>;
  }>("agentlas-science-statistics", "runtime/core-data-schemas.cjs", 4 * 1024 * 1024).runtime.CORE_DATA_SCHEMAS ?? {};
  const described = new Map<string, MethodDefinition>();
  for (const definition of engine.METHOD_REGISTRY?.definitions ?? []) {
    if (typeof definition?.method === "string") described.set(definition.method, definition);
  }
  // Ordered by the engine's own method list, so the screen and the engine agree on what exists.
  // The core methods carry no decision linkage; they are still offered, without the guidance,
  // rather than hidden -- a method with no blurb is still a method a researcher may need.
  return (engine.METHODS ?? [])
    .filter((method): method is string => typeof method === "string")
    .map((method) => {
      const definition = described.get(method);
      const dataSchema = definition?.dataSchema ?? core[method];
      const support = scienceDeclaredProjectionSupport(dataSchema);
      const itemProperties = (property: string): string[] => {
        const node = dataSchema?.properties?.[property];
        return Object.keys(node?.items?.properties ?? {});
      };
      // A grouped shape's label is implicit -- the screen renders it as "group column" -- so only
      // the parallel value fields need a control of their own.
      const choiceOptions = (property: string): string[] => {
        const items = dataSchema?.properties?.[property]?.items;
        return Array.isArray(items?.enum) ? items.enum.map(String) : [];
      };
      const valueFields = (property: string): string[] => {
        const item = dataSchema?.properties?.[property]?.items;
        return Object.entries(item?.properties ?? {}).filter(([, child]) => child.type === "array").map(([key]) => key);
      };
      return {
        method,
        family: typeof definition?.family === "string" ? definition.family : "core",
        neededWhen: firstSentence(definition?.linkage?.neededWhen),
        projectable: support.supported,
        dataProperties: support.properties
          .filter((entry) => entry.accepts !== null)
          .map((entry) => ({ ...entry, fields: entry.accepts === "row-columns" ? itemProperties(entry.property)
            : entry.accepts === "grouped-columns" ? valueFields(entry.property) : [],
            options: entry.accepts === "choice-list" ? choiceOptions(entry.property) : [] })),
      };
    });
}
