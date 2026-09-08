"use client";

import { useMemo, useState } from "react";
import { projectToolObservation, TOOL_OBSERVATION_RAW_LIMIT } from "@/lib/tool-observation";
import styles from "./ToolObservation.module.css";

/** Mounted by the parent disclosure only after the person opens a tool row. */
export function ToolObservation({ toolName, detail, args, result, locale }: {
  toolName: string; detail?: string; args?: string; result?: string; locale: "ko" | "en";
}) {
  const observed = useMemo(() => projectToolObservation(result, toolName), [result, toolName]);
  const [rawOpen, setRawOpen] = useState(false);
  const ko = locale === "ko";
  return <section className={styles.observation} aria-label={ko ? "도구 관측 결과" : "Tool observations"}>
    {observed.images.length > 0 && <div className={styles.images}>
      {observed.images.map((image) => <figure key={image.id}>
        {/* Only sanitized tool-returned media; local paths never become renderer URLs. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={image.src} alt={image.label} loading="lazy" decoding="async" crossOrigin="anonymous" referrerPolicy="no-referrer" />
        <figcaption>{image.label}</figcaption>
      </figure>)}
    </div>}
    {observed.text.map((block, index) => <div className={styles.block} key={index}>
      <small>{block.kind === "tree" ? (ko ? "화면 구조" : "Page structure")
        : block.kind === "diff" ? (ko ? "도구가 반환한 변경 내역" : "Tool-reported diff")
          : (ko ? "관측 결과" : "Observed result")}</small>
      <pre className={styles.text} data-observation-kind={block.kind}>{block.kind === "diff"
        ? block.text.split("\n").map((line, i) => <span key={i} data-diff={line.startsWith("+") ? "added" : line.startsWith("-") ? "removed" : undefined}>{line}{"\n"}</span>)
        : block.text}</pre>
    </div>)}
    {observed.omitted && <p className={styles.note}>{ko ? "크기 또는 표시 형식 제한으로 일부 결과를 접었습니다. 원문에서 확인할 수 있습니다." : "Some results exceed the preview size or format limits. Inspect the original details below."}</p>}
    {(detail || args || result) && <details className={styles.raw} onToggle={(event) => setRawOpen(event.currentTarget.open)}>
      <summary>{ko ? "도구 원문" : "Original tool details"}</summary>
      {rawOpen && <>
        {[[ko ? "인자" : "Arguments", args], [ko ? "결과" : "Result", result], [ko ? "상세" : "Detail", detail]].map(([label, value]) => value ? <div key={label}>
          <small>{label}</small><pre>{value.slice(0, TOOL_OBSERVATION_RAW_LIMIT)}</pre>
          {value.length > TOOL_OBSERVATION_RAW_LIMIT && <p className={styles.note}>{ko ? "화면에는 원문의 처음 64,000자만 표시합니다. 전체 기록은 실행 이력에 보존됩니다." : "Showing the first 64,000 characters. The full receipt remains in run history."}</p>}
        </div> : null)}
      </>}
    </details>}
  </section>;
}
