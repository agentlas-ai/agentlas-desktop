"use client";
import { useT } from "@/lib/i18n";
import { ScienceInstallExperience } from "./ScienceInstallExperience";
import { SCIENCE_INSTALL_DISCOVERY_ENABLED } from "@/lib/science-install-entry";

/**












 */
export function ScienceInstallEntryHost() {
  const { locale } = useT();
  if (!SCIENCE_INSTALL_DISCOVERY_ENABLED) return null;
  return <ScienceInstallExperience eligible={false} locale={locale === "ko" ? "ko" : "en"} />;
}
