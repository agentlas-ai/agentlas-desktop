/**
 * Why a run in flight was ended by the hub: the engine under it exited on its own (llama-server died, e.g. SIGBUS).
 *
 * The hub aborts such a run with this as the abort REASON. A plain abort() carries a DOMException, which the caller can only
 * read as "Aborted", and the run receipt could only say "cancelled", as if the owner had pressed stop. The managed runner turns
 * this error into the words the owner already gets when the engine cannot be reached (localServerUnreachableMessage), so the
 * order in which the exit event and the connection error arrive no longer changes what is shown.
 */
export const LOCAL_ENGINE_EXITED = "local_engine_exited";

export class LocalEngineExitedError extends Error {
  readonly code = LOCAL_ENGINE_EXITED;
  /** @param endpoint the engine's loopback address the run was talking to
   *  @param reasonCode the same code the load receipt of that process gets (engine_exited_<exit code | signal>) */
  constructor(readonly endpoint: string, readonly reasonCode: string) {
    super(LOCAL_ENGINE_EXITED);
    this.name = "LocalEngineExitedError";
  }
}

export function isLocalEngineExited(value: unknown): value is LocalEngineExitedError {
  return value instanceof LocalEngineExitedError;
}
