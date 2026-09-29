import { Suspense } from "react";
import { AskUserSheet } from "@/components/AskUserSheet";
import { ToolApprovalSheet } from "@/components/ToolApprovalSheet";
import { OneShell } from "@/components/one/OneShell";

export default function AgentlasOnePage() {
  return (
    <Suspense fallback={null}>
      <OneShell />
      {/*
        One renders outside AppShell, so the runner's synchronous questions (ask_user,
        Codex MCP approval elicitations) had no surface here at all: the Work badge sent
        the owner to a One conversation that could never show the card (2026-09-29).
        The sheet portals into One's composer slot and only for the chat on screen.
      */}
      <AskUserSheet />
      {/* Chat-less tool approvals only, and only when the owner opens them from the switcher dot. */}
      <ToolApprovalSheet />
    </Suspense>
  );
}
