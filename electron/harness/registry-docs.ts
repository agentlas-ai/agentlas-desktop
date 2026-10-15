import { CANONICAL_AREAS, CANONICAL_ENTRIES, CANONICAL_REGISTRY_REVISION, canonicalSchemaDigest } from "./canonical-registry";
import type { CanonicalEntry } from "./canonical-registry";

/*
 * G40: pure markdown reference rendered from the canonical registry (discovery / alias / consent tables).
 * No clock, no filesystem: the same entries give byte-identical output, so a stale generated file is detectable by
 * the revision line alone.
 */

const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/\s*\n\s*/g, " ");
const backingText = (item: CanonicalEntry): string =>
  item.backing.kind === "port" ? `port:${item.backing.operationId}`
    : item.backing.kind === "tool" ? `tool:${item.backing.server}/${item.backing.name}`
      : `none (${item.backing.reason})`;

export function renderCanonicalRegistryMarkdown(
  entries: readonly CanonicalEntry[] = CANONICAL_ENTRIES,
  revision: string = CANONICAL_REGISTRY_REVISION,
  digestOf: (item: CanonicalEntry) => string = canonicalSchemaDigest,
): string {
  const lines: string[] = [
    "# Canonical registry reference (generated)",
    "",
    "Generated from `agentlas_desktop/electron/harness/canonical-registry.ts` by `agentlas_desktop/scripts/generate-registry-docs.cjs`. Do not edit by hand.",
    "",
    `- registryRevision: \`${revision}\``,
    `- entries: ${entries.length}`,
    `- areas: ${CANONICAL_AREAS.length}`,
    "",
    "## Discovery",
    "",
    "| canonicalId | area | backing | effects | consent | schemaDigest |",
    "|---|---|---|---|---|---|",
  ];
  for (const item of entries) {
    lines.push(`| \`${item.canonicalId}\` | ${item.area} | ${cell(backingText(item))} | ${item.effects.join(", ")} | ${item.consentPolicy} | \`${digestOf(item).slice(0, 16)}\` |`);
  }
  lines.push("", "## Aliases", "", "| alias | canonicalId |", "|---|---|");
  const aliasRows = entries.flatMap((item) => item.aliases.map((alias) => [alias, item.canonicalId] as const)).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  if (!aliasRows.length) lines.push("| (none) | |");
  for (const [alias, id] of aliasRows) lines.push(`| \`${alias}\` | \`${id}\` |`);
  lines.push("", "## Consent", "");
  const byConsent = new Map<string, string[]>();
  for (const item of entries) byConsent.set(item.consentPolicy, [...(byConsent.get(item.consentPolicy) ?? []), item.canonicalId]);
  for (const policy of [...byConsent.keys()].sort()) {
    lines.push(`### ${policy}`, "", ...(byConsent.get(policy) as string[]).map((id) => `- \`${id}\``), "");
  }
  lines.push("## Entries", "");
  for (const area of CANONICAL_AREAS) {
    const inArea = entries.filter((item) => item.area === area);
    if (!inArea.length) continue;
    lines.push(`### ${area}`, "");
    for (const item of inArea) {
      lines.push(
        `#### \`${item.canonicalId}\``, "",
        `- purpose: ${cell(item.purpose)}`,
        `- whenNotToUse: ${cell(item.whenNotToUse)}`,
        `- aliases: ${item.aliases.length ? item.aliases.map((alias) => `\`${alias}\``).join(", ") : "-"}`,
        `- effects: ${item.effects.join(", ")}`,
        `- consent: ${item.consentPolicy}`,
        `- backing: ${cell(backingText(item))}`,
        `- schemaDigest: \`${digestOf(item)}\``,
        `- registryRevision: \`${revision}\``,
        `- source: \`${item.sourceRef}\``, "",
      );
    }
  }
  return `${lines.join("\n")}\n`;
}
