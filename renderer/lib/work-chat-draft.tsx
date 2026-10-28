"use client";

import { createContext } from "react";

/** An installed plugin workflow the screen's button or menu asks the conversation's next turn to carry (typed, recorded in Main). */
export interface WorkChatCapabilityRequest { plugin: string; workflow: string }
export interface WorkChatDraftRequest { id: string; text: string; capability?: WorkChatCapabilityRequest; onConsumed: () => void }

// Keep the draft handoff independent of the Work renderer. A provider on a
// dashboard must not load the whole chat just to share this context identity.
export const WorkChatDraftContext = createContext<WorkChatDraftRequest | null>(null);
