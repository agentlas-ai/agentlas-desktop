/*
 * The feature registry: ONE implementation per feature a person sees.
 *
 * A surface (Work, One full, One in Space, personal, a room's split pane, a new-chat start) only MOUNTS the registered implementation; it never draws its
 * own version of the feature. A repair goes into the one implementation and every surface is repaired with it. Every drawing of a registered feature
 * carries `data-feature="<id>" data-impl="<impl>"`, which the real-app test (scripts/test-r3-one-implementation-ui.cjs) reads on every surface, and the
 * cheap commit-time check (scripts/test-r3-feature-registry-static.cjs) reads THIS file: the files named below are the only files that may import the
 * building blocks of the feature (AskCard, ApprovalPrompt, the @ pick rules, the close/reopen rules, the action words).
 *
 * Boundary notes (what is one feature): a question with choices and an approval are different features; the global sheet and the card inside a
 * conversation are two places for ONE implementation. New feature: add one entry here in the same change.
 */
export interface RegisteredFeature {
  /** The id on `data-feature`. */
  id: string;
  /** The id on `data-impl`. */
  impl: string;
  /** What the person sees. */
  what: string;
  /** The files that implement it (and nothing else may import its building blocks). */
  files: readonly string[];
  /** The files that only MOUNT it or call its rules (they import the rules; they draw none of the feature's own words or buttons). */
  mounts: readonly string[];
}

export const FEATURE_REGISTRY: readonly RegisteredFeature[] = [
  {
    id: "question-card", impl: "question-card-host", what: "a question with choices, its X, Skip and Reopen line",
    files: ["components/decision/QuestionCardHost.tsx", "components/decision/useQuestionCards.ts", "lib/question-cards.ts", "components/AskCard.tsx"],
    mounts: ["components/TaskCockpit.tsx", "components/one/OneShell.tsx", "components/one/PersonalOneAsk.tsx", "components/one/OneDispatchNotice.tsx", "components/AskUserSheet.tsx"],
  },
  {
    id: "approval-card", impl: "approval-prompt", what: "an approval the person gives or refuses (tool, browser action, One decision, strategy)",
    files: [
      "components/ApprovalPrompt.tsx", "components/ToolApprovalInline.tsx", "components/BrowserActionApprovalSheet.tsx", "components/decision/DecisionApprovalCard.tsx",
      "components/automation/AutomationStrategyApprovalSheet.tsx", "components/McpKeyRequestSheet.tsx", "components/PluralHandoffCards.tsx",
    ],
    mounts: [],
  },
  {
    // Not an approval of an agent's action and not a question: a plain confirm the person gives or refuses about their own app (release a room, clear
    // rules, resume after an update, use a quota that resets soon). Each is the one implementation of its own confirm; this entry exists so a NEW
    // alertdialog has to be added here on purpose. The two overlay guards only NAME the role in a selector (they draw none).
    id: "confirm-dialog", impl: "popup-frame", what: "a confirmation about the person's own app (not an agent's action, not a question)",
    files: [
      "components/PersonalAgentRoomNotice.tsx", "components/UpdateResumeConfirm.tsx", "components/UsageResetInvitePanel.tsx",
      "components/workspace-rules/WorkspaceRulesPage.tsx", "components/browser/BrowserControls.tsx", "components/NativeLiveWebView.tsx",
    ],
    mounts: [],
  },
  {
    id: "composer-agent-pick", impl: "composer-agent-pick", what: "picking an agent with @ in a composer",
    files: ["lib/composer-agent-pick.ts", "components/composer/ComposerAgentPicker.tsx", "components/one/OneComposerControls.tsx"],
    mounts: ["components/ChatInput.tsx", "components/one/OneShell.tsx", "components/one/OneComposerInput.tsx"],
  },
  {
    // what a person is told was done or not done is drawn from a receipt row (a schedule saved, a message sent, a file written, a run that did not finish), with the
    // buttons the receipt owns. The four surfaces only MOUNT it; the strip lists the conversation's pending promises from its durable objects.
    id: "receipt-card", impl: "receipt-card", what: "a receipt card (what the host recorded as done or not done) and its buttons, and the conversation's pending-promises strip",
    files: ["components/ReceiptCard.tsx", "components/PendingPromisesStrip.tsx", "components/ReceiptCard.module.css", "lib/receipt-card-model.ts"],
    mounts: ["components/ChatStream.tsx", "components/room/RoomPane.tsx", "components/one/OneShell.tsx", "components/one/PersonalOneWorkspace.tsx"],
  },
  {
    id: "usage-meter", impl: "usage-meter", what: "how much of the usage allowance is used",
    files: ["components/usage/UsageMeter.tsx", "lib/usage-copy.ts", "lib/key-status.ts"],
    mounts: [],
  },
] as const;

export const featureById = (id: string): RegisteredFeature | undefined => FEATURE_REGISTRY.find((feature) => feature.id === id);
