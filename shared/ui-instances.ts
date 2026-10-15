// Renderer-visible UI instance types (docs/2026-10-13-native-harness/16 §7; contracts/inline-result.schema.json).
// Produced by electron/harness/ui-instances.ts; types only.
import type { InlineUiPresentationContent } from "./inline-ui-presentation";

export type UiIntent = "local-state" | "prepare-input" | "host-action" | "open-artifact" | "model-followup";
export type UiInstanceState = "running" | "ready" | "awaiting-input" | "failed" | "cancelled" | "closed";
export type UiViewKind = "native" | "mcp-app";
export type UiDisplay = "inline" | "fullscreen" | "pip";
export type UiReason = "result" | "decision" | "required-input" | "meaningful-progress";

export interface UiActionView {
  actionId: string;
  /** Short button text supplied by the presenter; the card falls back to actionId. */
  label?: string;
  operationId?: string;
  inputSchemaRef: string;
  expectedRevision: number;
  actionRef: string;
  intent: UiIntent;
}

export interface UiPresentation {
  viewId: string;
  kind: UiViewKind;
  resourceRef: string;
  display: UiDisplay;
  title: string;
  reason: UiReason;
  fallbackText: string;
}

/** One revision, matching agentlas.inline-result.v1 plus lifetime fields. */
export interface UiInstanceRevision {
  schemaVersion: "agentlas.inline-result.v1";
  instanceId: string;
  chatId: string;
  turnId: string;
  callId: string;
  resultRef: string;
  sequence: number;
  revision: number;
  state: UiInstanceState;
  presentation: UiPresentation;
  actions: UiActionView[];
  /** Host-validated chat content; absent on legacy durable-result and third-party MCP app views. */
  content?: InlineUiPresentationContent;
  structuredResultRef?: string;
  artifactRefs?: string[];
}

export interface UiInstanceView extends UiInstanceRevision {
  /** Highest revision (this object is that revision). */
  revisionCount: number;
  closedAt?: string;
  createdAt: string;
  updatedAt: string;
}

export type UiEventType = "presented" | "updated" | "closed" | "action" | "draft" | "followup" | "open-request";
export interface UiInstanceEvent {
  cursor: number;
  at: string;
  type: UiEventType;
  instanceId: string;
  chatId: string;
  revision: number;
  data?: unknown;
}

