"use client";

import { IconClose } from "@/components/Icon";
import styles from "./TaskBrowser.module.css";

export function BrowserImportBanner({ ko, onImport, onDismiss }: { ko: boolean; onImport: () => void; onDismiss: () => void }) {
  return <div className={styles.importBannerSpace}>
    <div className={styles.importBanner} role="status" data-browser-import-banner>
      <span>{ko ? "평소 쓰던 로그인으로 시작하세요" : "Bring your existing sign-ins"}</span>
      <button type="button" className={styles.importAction} onClick={onImport}>{ko ? "브라우저에서 가져오기" : "Import from browser"}</button>
      <button type="button" className={styles.importDismiss} aria-label={ko ? "로그인 가져오기 안내 닫기" : "Dismiss sign-in import"} onClick={onDismiss}><IconClose size={13} /></button>
    </div>
  </div>;
}
