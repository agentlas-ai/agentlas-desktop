"use client";

import { useEffect } from "react";
import { reconcileOneOllamaSelection } from "@/lib/ollama-migration";

/** Migrates only an exact One localStorage match; unresolved identity is preserved. */
export function OllamaMigrationBridge() {
  useEffect(() => { void reconcileOneOllamaSelection().catch(() => undefined); }, []);
  return null;
}
