import type { RuntimeSelection } from "../../shared/types";
import { ensureScienceRuntimeChat, setChatRuntimeSelection } from "../store/chats";
import { getMeta, setMeta } from "../store/meta";
import type { ScienceStore } from "./store";
import { normalizeScienceRuntimeSelection } from "./runtime-selection";

const PREFERENCE_KEY = "science.runtime-selection.v1";
const pendingSelections = new Map<string, symbol>();

function conversationChat(store: ScienceStore, input: { projectId: string; conversationId: string }) {
  const project = store.getProject(input.projectId);
  if (!project) throw new Error("science-project-not-found");
  if (!store.listConversations(project.id).some((item) => item.id === input.conversationId)) {
    throw new Error("science-conversation-not-found");
  }
  return ensureScienceRuntimeChat({ conversationId: input.conversationId, title: project.title });
}

/** Science's last choice initializes new conversations without reading Work/One role defaults. */
export function scienceRuntimePreference(store: ScienceStore, input: { projectId: string; conversationId: string }): RuntimeSelection | null {
  const chat = conversationChat(store, input);
  if (chat.runtimeSelection) return normalizeScienceRuntimeSelection(chat.runtimeSelection);
  const raw = getMeta(PREFERENCE_KEY);
  if (!raw) return null;
  let decoded: unknown;
  try { decoded = JSON.parse(raw); } catch { throw new Error("science-runtime-preference-invalid"); }
  const selection = normalizeScienceRuntimeSelection(decoded);
  if (selection) setChatRuntimeSelection(chat.id, selection);
  return selection;
}

export interface ScienceModelOption {
  selection: RuntimeSelection;
  label: string;
  provider: string;
}

function sameModel(a: RuntimeSelection, b: RuntimeSelection): boolean {
  return a.kind === b.kind && a.backend === b.backend && a.source === b.source && a.model === b.model;
}

async function modelOptions(): Promise<ScienceModelOption[]> {
  // These modules may probe providers. Load them only after an authorized Science picker request.
  const { detectRuntimes } = await import("../runtime/detect");
  const { listRuntimeModels } = await import("../runtime/providers");
  const runtimes = await detectRuntimes();
  const groups = await Promise.all(runtimes.map(async (runtime): Promise<ScienceModelOption[]> => {
    if (runtime.credentialAccess?.status === "unavailable" || runtime.modelDiscovery?.stale) return [];
    const models = await listRuntimeModels(runtime.kind, runtime.backend, runtime.availableModels, Date.now()).catch(() => []);
    return models.map((model) => ({
      selection: {
        kind: runtime.kind, backend: runtime.backend, source: runtime.source, model: model.id,
        role: "orchestrator", inherit: false, longContext: false,
        effort: runtime.allocationModelProfiles?.[model.id]?.defaultEffort ?? "",
      },
      label: model.label,
      provider: runtime.label ?? (runtime.kind === "byok" ? runtime.backend : runtime.kind),
    }));
  }));
  return groups.flat();
}

export async function inspectScienceRuntime(store: ScienceStore, input: { projectId: string; conversationId: string }) {
  const selection = scienceRuntimePreference(store, input);
  const options = await modelOptions();
  return { selection, options, unavailable: Boolean(selection && !options.some((option) => sameModel(option.selection, selection))) };
}

export async function selectScienceRuntime(store: ScienceStore, input: { projectId: string; conversationId: string; selection: unknown }) {
  const chat = conversationChat(store, input);
  const selection = normalizeScienceRuntimeSelection(input.selection);
  if (!selection?.model) throw new Error("science-runtime-selection-required");
  const request = Symbol("science-model-selection");
  pendingSelections.set(chat.id, request);
  try {
    const options = await modelOptions();
    if (pendingSelections.get(chat.id) !== request) throw new Error("science-runtime-selection-superseded");
    if (!options.some((option) => sameModel(option.selection, selection))) throw new Error("science-runtime-unavailable");
    // Recheck after discovery: a controller can start while the picker awaits
    // provider inventory. Its immutable model must not be presented as changed.
    const loop = store.getActiveLoopSession(input.projectId);
    if (store.getActiveTurn(input.projectId, input.conversationId)
      || (loop?.runtimeChatId === chat.id && ["queued", "running", "pausing"].includes(loop.status))) {
      throw new Error("science-runtime-selection-locked");
    }
    const saved = setChatRuntimeSelection(chat.id, selection).runtimeSelection;
    if (!saved || !sameModel(saved, selection)) throw new Error("science-runtime-selection-receipt-mismatch");
    setMeta(PREFERENCE_KEY, JSON.stringify(saved));
    return { selection: normalizeScienceRuntimeSelection(saved) };
  } finally {
    if (pendingSelections.get(chat.id) === request) pendingSelections.delete(chat.id);
  }
}
