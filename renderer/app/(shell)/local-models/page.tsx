"use client";

import { useT } from "@/lib/i18n";
import { useCallback, useState } from "react";
import { LocalModelHubPanel } from "@/components/settings/LocalModelHubPanel";
import { HuggingFaceModelBrowser } from "@/components/settings/HuggingFaceModelBrowser";
import { LocalModelOperations } from "@/components/settings/LocalModelOperations";
import styles from "./page.module.css";

export default function LocalModelsPage() {
  const { locale } = useT();
  const ko = locale === "ko";
  const [view, setView] = useState<"browse" | "library">("browse");
  const [selectedPackageId, setSelectedPackageId] = useState<string>();
  const [ownedOperations, setOwnedOperations] = useState<Set<string>>(new Set());
  const onOperationStarted = useCallback((id: string) => setOwnedOperations(prior => new Set([...prior,id])), []);
  const onViewModel = (packageId: string) => { setSelectedPackageId(packageId); setView("library"); };
  return <div className={styles.page} data-local-models-page>
    <header className={styles.header}>
      <div><h1>{ko ? "로컬 모델" : "Local Models"}</h1>
        <p>{ko ? "Hugging Face에서 모델을 찾아 이 컴퓨터에서 실행하세요." : "Find models on Hugging Face and run them on this computer."}</p></div>
      <span className={styles.localBadge}>{ko ? "내 컴퓨터에서 실행" : "Runs on your computer"}</span>
    </header>
    <nav className={styles.tabs} aria-label={ko ? "로컬 모델 보기" : "Local model views"}>
      <button type="button" aria-pressed={view === "browse"} onClick={() => setView("browse")}>{ko ? "탐색" : "Explore"}</button>
      <button type="button" aria-pressed={view === "library"} onClick={() => setView("library")}>{ko ? "내 모델" : "My models"}</button>
    </nav>
    <LocalModelOperations ko={ko} hiddenIds={ownedOperations} onViewModel={onViewModel} />
    <div hidden={view !== "browse"}><HuggingFaceModelBrowser ko={ko} onInstalled={onViewModel} onOperationStarted={onOperationStarted} /></div>
    <div hidden={view !== "library"}><LocalModelHubPanel locale={locale} standalone selectedPackageId={selectedPackageId} onOperationStarted={onOperationStarted} /></div>
  </div>;
}
