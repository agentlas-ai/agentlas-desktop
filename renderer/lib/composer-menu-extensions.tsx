"use client";

import { createContext, useContext, type ReactNode } from "react";

/**
 * Items a surface adds to the common Work composer's + menu (a submenu per extension). The composer knows no domain: an extension lists
 * its items and each item is the text it puts in the message, which the owner sees and can edit before sending. Finance registers its
 * Analysts here; any other screen that wraps the Work chat can register its own.
 */
export interface ComposerMenuItem { id: string; label: string; description?: string; insert: string }
export interface ComposerMenuExtension {
  id: string;
  label: string;
  icon?: ReactNode;
  load: () => Promise<readonly ComposerMenuItem[]>;
  emptyLabel?: string;
}

const NONE: readonly ComposerMenuExtension[] = [];
export const ComposerMenuExtensions = createContext<readonly ComposerMenuExtension[]>(NONE);
export function useComposerMenuExtensions(): readonly ComposerMenuExtension[] { return useContext(ComposerMenuExtensions); }
