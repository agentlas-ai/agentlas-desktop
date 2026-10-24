import type { AppCandidate, HarvestOutcome, ReachHost, ReachPlatform } from "./types";

// One provider per operating system. discover() lists the installed apps; harvest() asks one app what it publishes about itself,
// one HarvestOutcome per source it tried. Both are read-only: nothing here launches an app or sends it an event.
export interface PlatformProvider {
  platform: ReachPlatform;
  discover(host: ReachHost): Promise<AppCandidate[]>;
  harvest(host: ReachHost, app: AppCandidate): Promise<HarvestOutcome[]>;
  // The folders where a newly installed or removed app shows up as a new or missing entry. Only their entry names are looked at (see
  // install-watch.ts), so noticing an install costs a few directory listings, not a discovery run.
  installDirectories?(host: ReachHost): string[];
}
