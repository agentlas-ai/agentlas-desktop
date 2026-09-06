import { dialog, Menu, type BrowserWindow, type MenuItemConstructorOptions } from "electron";
import type { RuntimeBackend } from "../../shared/types";

const pending = new Map<string, Promise<void>>();
let openingRecoveryMenu = false;

type RecoveryMessage = { ok: boolean; message: string };

/** The native menu click owns this attempt. Building the menu performs no
 * credential discovery, native storage call, or automatic retry.
 */
function runRecovery(
  resource: string,
  parent: BrowserWindow | null,
  korean: boolean,
  attempt: () => Promise<RecoveryMessage>,
): Promise<void> {
  const current = pending.get(resource);
  if (current) return current;
  const started = Promise.resolve().then(async () => {
    let result: RecoveryMessage;
    try { result = await attempt(); }
    catch {
      result = {
        ok: false,
        message: korean ? "아직 저장소에 접근할 수 없습니다. 자동으로 다시 시도하지 않습니다."
          : "Storage access is still unavailable. No automatic retry will run.",
      };
    }
    const options: Electron.MessageBoxOptions = {
      type: result.ok ? "info" : "warning",
      title: korean ? "저장된 연결 정보" : "Saved connection access",
      message: result.message,
    };
    if (parent && !parent.isDestroyed()) await dialog.showMessageBox(parent, options);
    else await dialog.showMessageBox(options);
  });
  pending.set(resource, started);
  void started.then(() => { if (pending.get(resource) === started) pending.delete(resource); },
    () => { if (pending.get(resource) === started) pending.delete(resource); });
  return started;
}

export function credentialRecoveryMenuItems(
  getWindow: () => BrowserWindow | null,
  locale: "ko" | "en",
): MenuItemConstructorOptions[] {
  const korean = locale === "ko";
  const providers: Array<[RuntimeBackend, string]> = [
    ["anthropic", "Anthropic"], ["openai", "OpenAI"], ["google", "Google Gemini"],
    ["glm", "GLM"], ["kimi", "Kimi"], ["deepseek", "DeepSeek"],
    ["minimax", "MiniMax"], ["xai", "xAI"], ["openrouter", "OpenRouter"],
    ["upstage", "Upstage"], ["custom", korean ? "사용자 지정" : "Custom"],
  ];
  return [
    {
      label: korean ? "접근하지 못한 연결 정보 복구…" : "Recover Unavailable Connections…",
      click: () => {
        if (openingRecoveryMenu) return;
        openingRecoveryMenu = true;
        void (async () => {
          const { listCredentialRecoveryFailures, retryCredentialRecoveryFromUser } = await import("./vault");
          // Failure metadata only. Opening this menu never probes any credential.
          const failures = await listCredentialRecoveryFailures();
          if (failures.length === 0) {
            await runRecovery("recovery:status", getWindow(), korean, async () => ({
              ok: true,
              message: korean ? "기록된 접근 실패가 없습니다. 저장된 키를 새로 읽지는 않았습니다."
                : "No access failures are recorded. Saved credentials were not read.",
            }));
            return;
          }
          const kinds = korean
            ? { api: "API 키", "api-metadata": "API 키 등록 정보", env: "연결 키", secret: "연결 인증 정보" }
            : { api: "API key", "api-metadata": "API-key metadata", env: "Connection key", secret: "Connection credential" };
          const menu = Menu.buildFromTemplate(failures.map((failure) => ({
            label: failure.operation === "list"
              ? korean ? "저장된 항목 목록 — 다시 시도" : "Saved item list — retry"
              : `${kinds[failure.kind]} · ${failure.name ?? ""}`,
            enabled: failure.status !== "retrying",
            click: () => {
              void runRecovery(`recovery:${failure.retryToken}`, getWindow(), korean, async () => {
                const result = await retryCredentialRecoveryFromUser(failure.retryToken);
                const messages = korean
                  ? { restored: "선택한 항목의 접근을 복구했습니다. 다른 항목은 다시 읽지 않았습니다.",
                    missing: "선택한 항목을 읽었지만 저장된 값이 없습니다.",
                    unavailable: "선택한 항목에 아직 접근할 수 없습니다. 자동으로 다시 시도하지 않습니다.",
                    "invalid-token": "이 복구 항목이 갱신됐습니다. 메뉴를 다시 열어 현재 상태를 확인하세요." }
                  : { restored: "Access to the selected item was restored. Other items were not reread.",
                    missing: "The selected item was read, but no saved value was found.",
                    unavailable: "The selected item is still unavailable. No automatic retry will run.",
                    "invalid-token": "This recovery item changed. Reopen the menu to see its current status." };
                const message = result.status === "restored" && failure.operation === "list"
                  ? korean ? "저장된 항목 목록에 다시 접근했습니다. 개별 항목의 접근 실패 상태는 그대로 유지됩니다."
                    : "Access to the saved item list was restored. Individual item failure states are unchanged."
                  : messages[result.status];
                return { ok: result.status === "restored", message };
              }).catch(() => {});
            },
          })));
          const window = getWindow();
          menu.popup(window && !window.isDestroyed() ? { window } : {});
        })().catch(() => runRecovery("recovery:status", getWindow(), korean, async () => ({
          ok: false,
          message: korean ? "접근 상태 기록을 읽지 못했습니다. 저장된 키는 다시 읽지 않았습니다."
            : "Access status records could not be read. Saved credentials were not reread.",
        }))).catch(() => {}).finally(() => { openingRecoveryMenu = false; });
      },
    },
    {
      label: korean ? "저장된 로그인 복원…" : "Restore Saved Login…",
      click: () => {
        void runRecovery("auth:saved-session", getWindow(), korean, async () => {
          const { retryAuthRestoreFromUser } = await import("../auth");
          const result = await retryAuthRestoreFromUser();
          const ok = result.status === "restored";
          const missing = ["missing", "expired", "invalid"].includes(result.status);
          return {
            ok,
            message: ok
              ? korean ? "저장된 로그인을 복원했습니다." : "Your saved login was restored."
              : missing
                ? korean ? "복원할 수 있는 저장된 로그인이 없습니다." : "No restorable saved login was found."
                : korean ? "저장된 로그인에 아직 접근할 수 없습니다. 자동으로 다시 시도하지 않습니다."
                  : "Your saved login is still unavailable. No automatic retry will run.",
          };
        }).catch(() => { /* A closed window must not start another attempt. */ });
      },
    },
    {
      label: korean ? "API 키 접근 다시 시도" : "Retry API Key Access",
      submenu: providers.map(([backend, label]) => ({
        label,
        click: () => {
          void runRecovery(`api:${backend}`, getWindow(), korean, async () => {
            const { retryCredentialReadFromUser, hasApiKey } = await import("./vault");
            await retryCredentialReadFromUser("api", backend);
            const present = await hasApiKey(backend);
            return {
              ok: present,
              message: present
                ? korean ? `${label} API 키를 다시 읽었습니다.` : `${label} API key access was restored.`
                : korean ? `저장된 ${label} API 키가 없습니다.` : `No saved ${label} API key was found.`,
            };
          }).catch(() => { /* A closed window must not start another attempt. */ });
        },
      })),
    },
  ];
}
