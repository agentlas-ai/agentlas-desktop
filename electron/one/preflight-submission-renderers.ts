/**











 */

/** The parts of Electron's WebContents this registry reads. */
export type PreflightRendererContents = {
  readonly id: number;
  isDestroyed(): boolean;
  on(event: "did-navigate" | "render-process-gone", listener: () => void): unknown;
  once(event: "destroyed", listener: () => void): unknown;
};

type Binding = { contentsId: number; generation: number };
type DocumentState = { generation: number };

export type PreflightRendererOwnership = "absent" | "same-document" | "other-live-document";

export function createPreflightSubmissionRenderers(release: (submissionId: string) => void) {
  const bindings = new Map<string, Binding>();
  const documents = new Map<number, DocumentState>();

  const endDocument = (contentsId: number, destroyed: boolean): void => {
    const state = documents.get(contentsId);
    if (!state) return;
    state.generation += 1;
    if (destroyed) documents.delete(contentsId);
    for (const [submissionId, binding] of [...bindings]) {
      if (binding.contentsId !== contentsId || binding.generation >= state.generation) continue;
      bindings.delete(submissionId);
      try { release(submissionId); }
      catch (error) {
        console.warn("[one-preflight] could not release the submission of a gone renderer",
          { submissionId, code: String((error as { message?: string })?.message ?? error).slice(0, 80) });
      }
    }
  };

  const track = (contents: PreflightRendererContents): DocumentState => {
    let state = documents.get(contents.id);
    if (state) return state;
    state = { generation: 0 };
    documents.set(contents.id, state);
    const id = contents.id;
    // did-navigate fires only for a committed main-frame cross-document navigation (a reload included). Same-document
    // history changes (replaceState, in-page navigation) keep the document and its submissions.
    contents.on("did-navigate", () => endDocument(id, false));
    contents.on("render-process-gone", () => endDocument(id, false));
    contents.once("destroyed", () => endDocument(id, true));
    return state;
  };

  const usable = (contents: unknown): contents is PreflightRendererContents => {
    const value = contents as Partial<PreflightRendererContents> | null;
    return !!value && typeof value.id === "number" && typeof value.on === "function"
      && typeof value.once === "function" && typeof value.isDestroyed === "function";
  };

  return {
    /** Who drives this submission now, seen from the asking renderer. */
    ownership(submissionId: string, contents: unknown): PreflightRendererOwnership {
      const binding = bindings.get(submissionId);
      if (!binding) return "absent";
      const state = documents.get(binding.contentsId);
      if (!state || state.generation !== binding.generation) return "absent";
      if (usable(contents) && contents.id === binding.contentsId) {
        return track(contents).generation === binding.generation ? "same-document" : "absent";
      }
      return "other-live-document";
    },
    /** An open submission belongs to the renderer document that opened (or took over) it. */
    bind(submissionId: string, contents: unknown): void {
      if (!usable(contents) || contents.isDestroyed()) return;
      const state = track(contents);
      bindings.set(submissionId, { contentsId: contents.id, generation: state.generation });
    },
    /** Main itself finished or released it (bound, held, cancelled): the renderer no longer drives it. */
    forget(submissionId: string): void { bindings.delete(submissionId); },
    /** Test and diagnostics only. */
    size(): number { return bindings.size; },
  };
}
