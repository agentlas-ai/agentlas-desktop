// Updates preserve active work across the restart; native installation stays in the main process.
"use client";
import { useT } from "@/lib/i18n";
import { IconCheck, IconRefresh, IconPower, IconChat } from "./Icon";
import { PopupAction, PopupDetails, PopupFacts, PopupFrame, PopupSteps } from "./Popup";

export function UpdateResumeConfirm({ count, line, busy, onInstall, onLater }: {
  count: number; line?: string; busy: boolean; onInstall: () => void; onLater: () => void;
}) {
  const { t, locale } = useT();
  const ko = locale === "ko";
  return <PopupFrame dataAttributes={{ "data-update-resume-confirm": "true" }}
    title={t("update.resume_confirm_title", { n: String(count) })} icon={<IconRefresh size={20} />}
    closeLabel={ko ? "닫기" : "Close"} onClose={onLater} busy={busy} role="alertdialog"
    footer={<>
      <PopupAction data-update-resume-action="later" disabled={busy} onClick={onLater}>{t("update.resume_confirm_later")}</PopupAction>
      <PopupAction primary icon={<IconRefresh size={16} />} data-update-resume-action="install" disabled={busy} onClick={onInstall}>{t("update.resume_confirm_install")}</PopupAction>
    </>}>
    <PopupFacts items={[{ icon: <IconChat size={17} />, label: ko ? "진행 중인 작업" : "Active work", value: count }]} />
    <PopupSteps steps={[
      { label: ko ? "작업 보존" : "Save work", icon: <IconCheck size={19} />, active: true },
      { label: ko ? "앱 재시작" : "Restart", icon: <IconPower size={19} /> },
      { label: ko ? "이어하기" : "Continue", icon: <IconRefresh size={19} /> },
    ]} />
    {line && <PopupDetails label={ko ? "작업 목록" : "Active tasks"}><p data-update-resume-line>{line}</p></PopupDetails>}
  </PopupFrame>;
}
