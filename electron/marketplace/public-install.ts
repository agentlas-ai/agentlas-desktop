import { readCanonicalPromptFromPackageFiles } from "../agents/prompt-authority";
import { assertHubReleasePin, type HubReleasePin } from "../../shared/hub-release-pin";
import type { MarketplaceListing } from "../../shared/types";
import type { SeedListingFull } from "./source";

/** Only the public authority's exact descriptor can authorize source delivery. */
export function isPublicSourceDescriptor(listing: MarketplaceListing): boolean {
  const raw = listing as MarketplaceListing & { scope?: unknown; delivery?: { mode?: unknown; sourceDownload?: unknown } };
  return raw.source === "hub-profile" && raw.scope === "hub-public"
    && raw.delivery?.mode === "source_download" && raw.delivery.sourceDownload === true
    && !raw.cloudId && !raw.cloudRegistration
    && (!raw.cloudPackage?.scope || raw.cloudPackage.scope === "hub-public");
}

export function requirePublicInstallDescriptor(
  listing: (SeedListingFull & MarketplaceListing) | null,
  slug: string,
  entityKind: "agent" | "team",
  release: HubReleasePin,
): SeedListingFull & MarketplaceListing {
  if (!listing || listing.slug !== slug || listing.entityKind !== entityKind
    || !isPublicSourceDescriptor(listing) || !listing.cloudPackage
    || listing.cloudPackage.agentKind !== entityKind
    || (listing.trustGrade !== "A" && listing.trustGrade !== "B")) {
    throw new Error("hub_source_install_unavailable");
  }
  assertHubReleasePin(release, listing);
  if (listing.cloudPackage.packageHash !== release.packageHash) throw new Error("hub_release_changed");
  // Portable paths, decoded byte counts, file hashes, executable flags and the
  // complete package hash are verified again by the atomic restore transaction.
  const prompt = readCanonicalPromptFromPackageFiles(listing.cloudPackage.files)?.content;
  if (!prompt?.trim()) throw new Error("hub_source_prompt_unavailable");
  return { ...listing, systemPrompt: prompt };
}
