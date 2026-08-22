/** Path-free Computer History DTOs shared by Electron and the One renderer. */

export type ComputerHistorySource = "10min" | "6h";
export type ComputerHistoryRecommendationKind = "agent" | "plugin" | "graph";

export interface ComputerHistoryRecommendation {
  id: string;
  kind: ComputerHistoryRecommendationKind;
  title: string;
  body: string;
  evidence: Array<{ entryId: string; label: string; occurredAt: string; source: ComputerHistorySource }>;
  status: "draft" | "dismissed" | "accepted";
}

/** Created only after an explicit review click. History list DTOs stay path-free. */
export interface ComputerHistoryDraftPrompt {
  recommendationId: string;
  recommendationKind: ComputerHistoryRecommendationKind;
  prompt: string;
  evidenceCount: number;
}

export interface ComputerHistoryEntry {
  id: string;
  occurredAt: string;
  title: string;
  body: string;
  apps: string[];
  source: ComputerHistorySource;
  recommendation: ComputerHistoryRecommendation | null;
}

export interface ComputerHistoryState {
  schemaVersion: 1;
  consent: "off" | "on";
  entries: ComputerHistoryEntry[];
  generatedAt: string;
}
