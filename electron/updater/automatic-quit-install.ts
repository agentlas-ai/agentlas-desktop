import type { UpdaterActionResult, UpdaterState } from "../../shared/types";

export interface AppQuitEventLike {
  preventDefault(): void;
}

export interface AutomaticQuitInstallDependencies {
  getState: () => UpdaterState;
  /**
   * Stops external writers after every renderer window has closed but before
   * the controller captures continuity. A rejected preparation falls back to
   * the user's original normal quit without attempting an update.
   */
  prepare?: () => Promise<void>;
  install: () => Promise<UpdaterActionResult>;
  /** Arms a fresh app process when a retryable native handoff terminates this one. */
  relaunch?: () => void;
  quit: () => void;
  subscribe?: (listener: (state: UpdaterState) => void) => () => void;
  shouldInstallOnQuit?: () => boolean;
  logger?: Pick<Console, "warn">;
}

export interface AutomaticQuitInstaller {
  /**
   * Returns true only when this quit must be deferred while the updater creates
   * its recovery copy and durable journal. The native updater's second quit is
   * allowed through because the controller has already moved to `installing`.
   */
  handle(event: AppQuitEventLike): boolean;
  /** Marks the one native-updater quit that must never be intercepted again. */
  authorizeNativeQuit(): void;
}

/**
 * Installs an already-downloaded update during the next normal application
 * quit without enabling electron-updater's unsafe `autoInstallOnAppQuit` path.
 *
 * The controller remains the only install authority: it verifies the running
 * app, quiesces writers, captures continuity, writes the journal, and only then
 * calls the native updater. If any of those steps fail, the original quit is
 * resumed so an update can never trap the user inside a running application.
 */
export function createAutomaticQuitInstaller(
  deps: AutomaticQuitInstallDependencies,
): AutomaticQuitInstaller {
  const logger = deps.logger ?? console;
  let installAttemptInFlight = false;
  let installHandoffAccepted = false;
  let quitDeferred = false;
  let allowNextQuitWithoutUpdate = false;
  let nativeQuitAuthorized = false;

  const continueNormalQuit = () => {
    if (!quitDeferred) return;
    quitDeferred = false;
    installHandoffAccepted = false;
    allowNextQuitWithoutUpdate = true;
    deps.quit();
  };

  const observeInstallState = (state: UpdaterState) => {
    if (!quitDeferred || !installHandoffAccepted) return;
    if (state.status === "installing" || state.status === "downloaded") return;
    if (
      state.status === "manual-required" &&
      state.code === "install-start-failed" &&
      state.canRetry === true
    ) {
      // quitAndInstall may already have started Electron's shutdown before
      // Squirrel reports a transient native error. Arm a replacement process
      // first; its normal startup check clears the stale payload after backoff
      // and downloads the current release instead of leaving Agentlas closed.
      deps.relaunch?.();
    }
    logger.warn("[updater] automatic install handoff did not complete; continuing normal quit");
    continueNormalQuit();
  };

  // The controller's native watchdog and native error handlers publish their
  // terminal state after install() has already returned accepted:true. Keep the
  // original user quit pending until either the native updater authorizes its
  // own quit or that later state proves the handoff failed.
  deps.subscribe?.(observeInstallState);

  return {
    authorizeNativeQuit(): void {
      // Ignore unrelated native events. A legitimate handoff is emitted only
      // after the controller has published `installing` and called the updater.
      if (quitDeferred && deps.getState().status === "installing") nativeQuitAuthorized = true;
    },
    handle(event): boolean {
      // OS shutdown/logoff always wins, including if it races a pending native
      // handoff. Never turn a system shutdown into an app relaunch.
      if (deps.shouldInstallOnQuit && !deps.shouldInstallOnQuit()) return false;
      if (nativeQuitAuthorized) {
        nativeQuitAuthorized = false;
        quitDeferred = false;
        installHandoffAccepted = false;
        return false;
      }
      if (allowNextQuitWithoutUpdate) {
        allowNextQuitWithoutUpdate = false;
        return false;
      }
      // A second user quit while macOS Squirrel is staging is not the native
      // update quit. Keep it blocked until before-quit-for-update authorizes it.
      if (quitDeferred) {
        event.preventDefault();
        return true;
      }
      if (deps.getState().status !== "downloaded") return false;

      event.preventDefault();
      if (installAttemptInFlight) return true;
      installAttemptInFlight = true;
      quitDeferred = true;

      void Promise.resolve()
        .then(() => deps.prepare?.())
        .then(() => deps.install())
        .then((result) => {
          if (result.accepted) {
            installHandoffAccepted = true;
            observeInstallState(deps.getState());
            return;
          }
          logger.warn("[updater] automatic install on quit was not accepted; continuing normal quit");
          continueNormalQuit();
        })
        .catch(() => {
          logger.warn("[updater] automatic install on quit failed; continuing normal quit");
          continueNormalQuit();
        })
        .finally(() => {
          installAttemptInFlight = false;
        });
      return true;
    },
  };
}
