"use client";

import { createContext } from "react";

export interface WorkChatDraftRequest { id: string; text: string; onConsumed: () => void }

// Keep the draft handoff independent of the Work renderer. A provider on a
// dashboard must not load the whole chat just to share this context identity.
export const WorkChatDraftContext = createContext<WorkChatDraftRequest | null>(null);
