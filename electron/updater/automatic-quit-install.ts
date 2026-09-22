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
  /** Restore an external supervisor when preparation succeeded but the native
   * handoff was refused or failed. Runs before resuming the original quit. */
  onAbandoned?: () => Promise<void>;
  /** Bounds only the reversible pre-install cleanup. Once the native updater is
   * called, its platform handoff owns process lifetime and must not be cut off. */
  prepareTimeoutMs?: number;
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
   * Classifies the next quit before Electron starts tearing down windows.
   * Update-owned quits must never inherit the ordinary cleanup watchdog: the
   * native installer may legitimately keep the old process alive while it
   * stages, replaces, and relaunches the application.
   */
  quitDisposition(): "ordinary" | "defer-update" | "native-update";
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
  let preparedForUpdate = false;
  const requestedPrepareTimeoutMs = deps.prepareTimeoutMs ?? 45_000;
  const prepareTimeoutMs = Number.isFinite(requestedPrepareTimeoutMs)
    ? Math.max(1, Math.trunc(requestedPrepareTimeoutMs))
    : 45_000;

  const prepareWithinDeadline = async (): Promise<void> => {
    if (!deps.prepare) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        Promise.resolve().then(() => deps.prepare?.()),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("automatic_update_prepare_timed_out")),
            prepareTimeoutMs,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  };

  const continueNormalQuit = () => {
    if (!quitDeferred) return;
    quitDeferred = false;
    installHandoffAccepted = false;
    allowNextQuitWithoutUpdate = true;
    const restore = preparedForUpdate ? deps.onAbandoned : undefined;
    preparedForUpdate = false;
    void Promise.resolve().then(() => restore?.()).catch((error) => {
      logger.warn("[updater] abandoned update supervisor restore failed", error);
    }).finally(() => deps.quit());
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
    quitDisposition(): "ordinary" | "defer-update" | "native-update" {
      if (deps.shouldInstallOnQuit && !deps.shouldInstallOnQuit()) return "ordinary";
      if (nativeQuitAuthorized) return "native-update";
      if (allowNextQuitWithoutUpdate) return "ordinary";
      if (quitDeferred || deps.getState().status === "downloaded") return "defer-update";
      return "ordinary";
    },
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
        preparedForUpdate = false;
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
        .then(prepareWithinDeadline)
        .then(() => { preparedForUpdate = true; })
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
