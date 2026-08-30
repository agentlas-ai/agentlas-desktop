"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { ipc } from "../../lib/ipc";
import { useT } from "../../lib/i18n";
import { useDismissibleLayer } from "../../lib/use-dismissible-layer";
import {
  closeTelegramOneDialog,
  friendlyTelegramError,
  getTelegramOneDialogServerSnapshot,
  getTelegramOneDialogSnapshot,
  pushTelegramOneLog,
  setTelegramOneBusy,
  setTelegramOneReceipt,
  subscribeTelegramOneDialog,
  telegramOneLogId,
  telegramOneNowLabel,
} from "../../lib/telegram-one-dialog";
import type { TelegramConnectBinding, TelegramConnectStatus } from "../../lib/types";
import styles from "./TelegramOneDialog.module.css";

type ConnectMode = "auto" | "manual";

const CONNECT_MODES: readonly ConnectMode[] = ["auto", "manual"];

const STATUS_KEY: Record<TelegramConnectStatus, string> = {
  draft: "tgone.status.draft",
  bot_verified: "tgone.status.bot_verified",
  waiting_for_chat: "tgone.status.waiting_for_chat",
  chat_paired: "tgone.status.chat_paired",
  test_passed: "tgone.status.test_passed",
  running: "tgone.status.running",
  failed: "tgone.status.failed",
  disabled: "tgone.status.disabled",
};

/**
 * 텔레그램 ↔ One 연결 팝업.
 *
 * 예전 /connect 페이지가 하던 "에이전트를 골라 연결"은 사라졌다. 제품이 프로젝트 기반
 * 채팅으로 옮겨가면서 텔레그램의 상대는 One 하나이기 때문이다. 남은 레거시 연결은
 * 여기서 한 번에 정리한다.
 */
export default function TelegramOneDialog() {
  const { locale, t } = useT();
  const dialog = useSyncExternalStore(
    subscribeTelegramOneDialog,
    getTelegramOneDialogSnapshot,
    getTelegramOneDialogServerSnapshot,
  );
  const cardRef = useRef<HTMLDivElement | null>(null);
  const primaryRef = useRef<HTMLButtonElement | null>(null);
  const tokenRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Partial<Record<ConnectMode, HTMLButtonElement | null>>>({});
  const [oneName, setOneName] = useState("One");
  const [bindings, setBindings] = useState<TelegramConnectBinding[]>([]);
  const [mode, setMode] = useState<ConnectMode>("auto");
  const [botToken, setBotToken] = useState("");
  const [botName, setBotName] = useState("");
  const [deleteBots, setDeleteBots] = useState(false);
  const [error, setError] = useState("");
  const [addingAnother, setAddingAnother] = useState(false);

  const busy = dialog.busy;
  const open = dialog.open;

  const appendLog = useCallback(
    (text: string, tone: "info" | "success" | "error" = "info") => {
      pushTelegramOneLog({ id: telegramOneLogId(), at: telegramOneNowLabel(locale), text, tone });
    },
    [locale],
  );

  const refresh = useCallback(async () => {
    const api = ipc();
    if (!api) return;
    try {
      const [rows, profile] = await Promise.all([
        api.telegram.listBindings(),
        api.oneProfile.get().catch(() => null),
      ]);
      // 구 preload·목 브리지는 모르는 메서드에 null 을 돌려준다. 그대로 담으면
      // 다음 렌더의 .find 에서 팝업 전체가 죽는다(실측: 화면이 아예 안 뜸).
      setBindings(Array.isArray(rows) ? rows : []);
      if (profile?.displayName) setOneName(profile.displayName);
    } catch (err) {
      setError(friendlyTelegramError(err));
    }
  }, []);

  useEffect(() => {
    if (!open) return;
    // 영수증은 그 열림 세션의 사실이다. 다음에 열 때까지 남겨 두면 며칠 전 정리를
    // 방금 한 일처럼 보고하게 된다.
    setTelegramOneReceipt(null);
    setError("");
    void refresh();
  }, [open, refresh]);

  // 바깥 클릭 · Escape · 포커스 복원은 공용 레이어 계약이 담당한다.
  // 진행 중에도 닫힌다 — 진행 상태가 모듈 스토어에 살아 있어서 다시 열면 그대로
  // 이어 보인다. 안내문이 "닫아도 계속됩니다"라고 말하는데 닫히지 않으면 거짓말이다.
  useDismissibleLayer({ open, roots: [cardRef], onDismiss: closeTelegramOneDialog });

  useEffect(() => {
    if (!open) return;
    // 팝업을 연 사이드바 항목. 닫을 때 여기로 포커스를 돌려주지 않으면 키보드
    // 사용자는 문서 맨 위부터 다시 Tab 해야 한다(실측: 닫은 뒤 activeElement가 body).
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    // 실수로 Enter를 눌러도 파괴적인 "정리"가 아니라 주 CTA가 눌리게 한다.
    // preventScroll 필수 — CTA는 카드 맨 아래라, 그냥 focus() 하면 브라우저가 카드를
    // 스크롤해 제목·닫기 버튼이 잘린 채 열린다(실측 scrollTop 92px).
    const focusTimer = window.setTimeout(() => primaryRef.current?.focus({ preventScroll: true }), 0);
    return () => {
      window.clearTimeout(focusTimer);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus({ preventScroll: true });
      // 붙여넣은 BotFather 토큰은 비밀값이다. 이 컴포넌트는 닫혀도 언마운트되지
      // 않으므로(셸이 항상 마운트) 여기서 지우지 않으면 다시 열 때 그대로 보인다.
      setBotToken("");
      setMode("auto");
      // 다시 열었을 때 "봇 추가" 폼이 펼쳐진 채로 시작하면 이미 연결된 사람이
      // 실수로 봇을 하나 더 만든다.
      setAddingAnother(false);
    };
  }, [open]);

  // One은 방마다 하나다 — 봇을 더 붙이면 연결이 늘고, 늘어난 만큼 텔레그램에서
  // 나란히 굴릴 수 있는 대화가 생긴다. 그래서 "하나"가 아니라 목록으로 본다.
  const oneBindings = useMemo(
    () => bindings.filter((binding) => binding.targetKind === "one"),
    [bindings],
  );
  const legacyBindings = useMemo(
    () => bindings.filter((binding) => binding.targetKind !== "one"),
    [bindings],
  );

  const runConnect = useCallback(async () => {
    const api = ipc();
    if (!api || busy) return;
    setError("");
    setTelegramOneBusy("connect");
    appendLog(t("tgone.connecting.title"));
    try {
      const result = mode === "manual"
        ? await api.telegram.start({
            targetKind: "one",
            targetId: "one",
            botToken: botToken.trim(),
          })
        : await api.telegram.connectOne({
            ...(botName.trim() ? { botName: botName.trim() } : {}),
            ...(addingAnother ? { newConnection: true } : {}),
          });
      setBotToken("");
      setAddingAnother(false);
      appendLog(result.message, "success");
      await refresh();
    } catch (err) {
      const message = friendlyTelegramError(err);
      setError(message);
      appendLog(message, "error");
    } finally {
      setTelegramOneBusy(null);
    }
  }, [addingAnother, appendLog, botName, botToken, busy, mode, refresh, t]);

  const runCleanup = useCallback(async () => {
    const api = ipc();
    if (!api || busy || !legacyBindings.length) return;
    if (!window.confirm(t("tgone.legacy.confirm", { count: String(legacyBindings.length) }))) return;
    setError("");
    setTelegramOneBusy("legacy");
    try {
      const result = await api.telegram.removeLegacy({ deleteBots });
      const lines = [
        deleteBots && result.botsDeleted > 0
          ? t("tgone.legacy.done_with_bots", {
              removed: String(result.removed),
              bots: String(result.botsDeleted),
            })
          : t("tgone.legacy.done", { removed: String(result.removed) }),
      ];
      // 봇 삭제는 BotFather 웹 자동화라 실패할 수 있다. 실패를 성공으로 뭉개지 않는다.
      if (result.botDeleteFailures.length) {
        lines.push(t("tgone.legacy.bot_failed", { bots: result.botDeleteFailures.join(", ") }));
      }
      const receipt = lines.join("\n");
      setTelegramOneReceipt(receipt);
      appendLog(receipt, result.botDeleteFailures.length ? "error" : "success");
      await refresh();
    } catch (err) {
      const message = friendlyTelegramError(err);
      setError(message);
      appendLog(message, "error");
    } finally {
      setTelegramOneBusy(null);
    }
  }, [appendLog, busy, deleteBots, legacyBindings.length, refresh, t]);

  const runBindingAction = useCallback(
    async (action: "open" | "test" | "settings" | "import_terminal" | "remove", oneBinding: TelegramConnectBinding) => {
      const api = ipc();
      if (!api || !oneBinding || busy) return;
      if (action === "remove" && !window.confirm(t("tgone.disconnect.confirm"))) return;
      if (action === "import_terminal" && !window.confirm(t("tgone.terminal_import.confirm"))) return;
      setError("");
      setTelegramOneBusy(action);
      try {
        if (action === "open") {
          const result = await api.telegram.openBot(oneBinding.id);
          appendLog(result.message, result.ok ? "success" : "error");
        } else if (action === "test") {
          const result = await api.telegram.sendTest(oneBinding.id);
          appendLog(result.message, "success");
        } else if (action === "settings") {
          const result = await api.telegram.configureBotSettings(oneBinding.id);
          appendLog(result.message, result.ok ? "success" : "error");
        } else if (action === "import_terminal") {
          const result = await api.telegram.importTerminal(oneBinding.id);
          appendLog(result.message, "success");
        } else {
          // 봇은 남긴다 — 다시 연결할 때 재사용할 수 있고, 봇 삭제는 되돌릴 수 없다.
          await api.telegram.remove(oneBinding.id, false);
        }
        await refresh();
      } catch (err) {
        const message = friendlyTelegramError(err);
        setError(message);
        appendLog(message, "error");
      } finally {
        setTelegramOneBusy(null);
      }
    },
    [appendLog, busy, refresh, t],
  );

  if (!open) return null;

  const connected = oneBindings.length > 0;
  // 연결이 하나도 없으면 곧바로 연결 폼, 있으면 "하나 더" 를 눌렀을 때만 폼을 편다.
  const showConnectForm = !connected || addingAnother;
  const latestLog = dialog.logs[0]?.text ?? "";
  const canConnect = mode === "auto" || botToken.trim().length > 0;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab" || !cardRef.current) return;
    const focusable = cardRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), [tabindex]:not([tabindex="-1"])',
    );
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  return (
    <div className={`${styles.layer} titlebar-nodrag`}>
      <div className={styles.scrim} aria-hidden="true" />
      <div
        ref={cardRef}
        className={styles.card}
        role="dialog"
        aria-modal="true"
        aria-labelledby="tgone-title"
        aria-describedby="tgone-subtitle"
        aria-busy={busy ? "true" : "false"}
        onKeyDown={onKeyDown}
      >
        <div className={styles.head}>
          <div className={styles.mark} aria-hidden="true">✈</div>
          <button
            type="button"
            className={styles.close}
            onClick={closeTelegramOneDialog}
            aria-label={t("tgone.action.close")}
          >
            ✕
          </button>
        </div>

        {/* 스크롤은 이 안쪽만 — 닫기 버튼과 주 CTA는 항상 보여야 한다.
            (내용이 카드보다 길어지면 CTA가 접힘 아래로 사라지던 것을 실측하고 고침) */}
        <div className={styles.scroll}>
        <h2 id="tgone-title" className={styles.title}>{t("tgone.title", { name: oneName })}</h2>
        <p id="tgone-subtitle" className={styles.subtitle}>{t("tgone.subtitle", { name: oneName })}</p>

        <p className={styles.notice}>{t("tgone.migration.notice", { name: oneName })}</p>

        {busy === "connect" ? (
          <div className={styles.progress}>
            <strong>{t("tgone.connecting.title")}</strong>
            {latestLog ? <span className={styles.progressLine}>{latestLog}</span> : null}
            <span className={styles.progressHint}>{t("tgone.connecting.keep_open")}</span>
          </div>
        ) : null}

        {busy !== "connect" && connected ? (
          <>
            {oneBindings.map((oneBinding) => (
              <div key={oneBinding.id} className={styles.connected}>
                <div className={styles.connectedHead}>
                  <span className={styles.pill}>{t(STATUS_KEY[oneBinding.status] as never)}</span>
                  {oneBinding.botUsername ? <span>@{oneBinding.botUsername}</span> : null}
                </div>
                <p className={styles.connectedChat}>
                  {oneBinding.telegramChatTitle || t("tgone.connected.chat_waiting")}
                </p>
                <p className={styles.hint}>{t("tgone.connected.commands_hint")}</p>
                <div className={styles.actions}>
                  <button type="button" onClick={() => void runBindingAction("open", oneBinding)} disabled={Boolean(busy)}>
                    {t("tgone.action.open_bot")}
                  </button>
                  <button type="button" onClick={() => void runBindingAction("test", oneBinding)} disabled={Boolean(busy)}>
                    {t("tgone.action.test")}
                  </button>
                  <button
                    type="button"
                    onClick={() => void runBindingAction("settings", oneBinding)}
                    disabled={Boolean(busy)}
                    title={t("tgone.action.group_settings.hint")}
                  >
                    {t("tgone.action.group_settings")}
                  </button>
                  {oneBinding.terminalImportAvailable ? (
                    <button
                      type="button"
                      onClick={() => void runBindingAction("import_terminal", oneBinding)}
                      disabled={Boolean(busy)}
                      title={t("tgone.action.import_terminal.hint")}
                    >
                      {t("tgone.action.import_terminal")}
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className={styles.danger}
                    onClick={() => void runBindingAction("remove", oneBinding)}
                    disabled={Boolean(busy)}
                  >
                    {t("tgone.action.disconnect")}
                  </button>
                </div>
              </div>
            ))}
            <p className={styles.hint}>{t("tgone.multi.hint")}</p>
            <div className={styles.actions}>
              <button
                type="button"
                onClick={() => setAddingAnother((value) => !value)}
                disabled={Boolean(busy)}
              >
                {addingAnother ? t("tgone.action.add_bot.cancel") : t("tgone.action.add_bot")}
              </button>
            </div>
          </>
        ) : null}

        {busy !== "connect" && showConnectForm ? (
          <div className={styles.options} role="radiogroup" aria-labelledby="tgone-title">
            {CONNECT_MODES.map((option, index) => (
              <button
                key={option}
                type="button"
                role="radio"
                aria-checked={mode === option}
                // 로빙 tabindex — radiogroup 은 Tab 한 번에 그룹 전체를 지나고
                // 그룹 안에서는 방향키로 옮긴다(ARIA radiogroup 계약).
                tabIndex={mode === option ? 0 : -1}
                className={styles.option}
                data-active={mode === option ? "true" : "false"}
                disabled={Boolean(busy)}
                onKeyDown={(event) => {
                  const step = event.key === "ArrowDown" || event.key === "ArrowRight"
                    ? 1
                    : event.key === "ArrowUp" || event.key === "ArrowLeft"
                      ? -1
                      : 0;
                  if (step === 0) return;
                  event.preventDefault();
                  const next = CONNECT_MODES[
                    (index + step + CONNECT_MODES.length) % CONNECT_MODES.length
                  ];
                  setMode(next);
                  // 선택이 곧 포커스여야 한다 — 안 옮기면 다음 방향키가 제자리를 돈다.
                  window.setTimeout(() => {
                    optionRefs.current[next]?.focus();
                  }, 0);
                }}
                ref={(element) => {
                  optionRefs.current[option] = element;
                }}
                onClick={() => {
                  setMode(option);
                  if (option === "manual") window.setTimeout(() => tokenRef.current?.focus(), 0);
                }}
              >
                <span className={styles.optionTitle}>
                  {t(option === "auto" ? "tgone.mode.auto" : "tgone.mode.manual")}
                  {option === "auto" ? <em className={styles.badge}>{t("tgone.mode.auto.badge")}</em> : null}
                </span>
                <span className={styles.optionHint}>
                  {t(option === "auto" ? "tgone.mode.auto.hint" : "tgone.mode.manual.hint")}
                </span>
              </button>
            ))}
            {mode === "manual" ? (
              <label className={styles.field}>
                <span>{t("tgone.field.token")}</span>
                <input
                  ref={tokenRef}
                  type="password"
                  value={botToken}
                  onChange={(event) => setBotToken(event.target.value)}
                  placeholder={t("tgone.field.token.placeholder")}
                  disabled={Boolean(busy)}
                  autoComplete="off"
                />
                <small>{t("tgone.field.token.help")}</small>
              </label>
            ) : (
              <label className={styles.field}>
                <span>{t("tgone.field.botname")}</span>
                <input
                  type="text"
                  value={botName}
                  onChange={(event) => setBotName(event.target.value)}
                  placeholder={t("tgone.field.botname.placeholder", { name: oneName })}
                  disabled={Boolean(busy)}
                />
              </label>
            )}
          </div>
        ) : null}

        {legacyBindings.length > 0 ? (
          <div className={styles.legacy}>
            <div className={styles.legacyHead}>
              <strong>{t("tgone.legacy.title", { count: String(legacyBindings.length) })}</strong>
              <span>{t("tgone.legacy.body")}</span>
            </div>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={deleteBots}
                onChange={(event) => setDeleteBots(event.target.checked)}
                disabled={Boolean(busy)}
              />
              <span>
                {t("tgone.legacy.delete_bots")}
                <small>{t("tgone.legacy.delete_bots.hint")}</small>
              </span>
            </label>
            <button
              type="button"
              className={styles.legacyAction}
              onClick={() => void runCleanup()}
              disabled={Boolean(busy)}
            >
              {busy === "legacy" ? t("tgone.legacy.removing") : t("tgone.legacy.action")}
            </button>
          </div>
        ) : null}

        {dialog.receipt ? <p className={styles.receipt}>{dialog.receipt}</p> : null}
        {error ? <p className={styles.error}>{error}</p> : null}
        </div>

        <button
          ref={primaryRef}
          type="button"
          className={styles.primary}
          disabled={Boolean(busy) || (showConnectForm && !canConnect)}
          onClick={() => {
            if (!showConnectForm) {
              closeTelegramOneDialog();
              return;
            }
            void runConnect();
          }}
        >
          {!showConnectForm
            ? t("tgone.action.done")
            : busy === "connect"
              ? t("tgone.action.connecting")
              : t("tgone.action.connect")}
        </button>
      </div>
    </div>
  );
}
