import { EventEmitter } from "node:events";

const events = new EventEmitter();
export interface FinanceWorkspaceChange { ownerScope: string; revision: number }
export function publishFinanceWorkspaceChange(change: FinanceWorkspaceChange): void { events.emit("change", change); }
export function onFinanceWorkspaceChange(listener: (change: FinanceWorkspaceChange) => void): () => void {
  events.on("change", listener); return () => { events.off("change", listener); };
}
