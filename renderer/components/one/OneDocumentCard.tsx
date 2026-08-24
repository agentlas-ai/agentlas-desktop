"use client";

import { useMemo, useState } from "react";
import { Markdown } from "@/components/Markdown";
import { IconClose, IconExpand, IconFileUp } from "@/components/Icon";
import { ipc } from "@/lib/ipc";
import { documentFileSlug, type OneDocumentMark } from "@/lib/one-document-mark";
import styles from "./OneDocumentCard.module.css";

/**
 * 에이전트가 보고서로 낸 글을 대화 안에서 문서로 읽는다.
 *
 * 오너 지시 2026-08-24: 대화 거품이 아니라 읽는 문서여야 하고, 받아 갈 수
 * 있어야 한다(마크다운·PDF). 형식으로 문서인지 추측하지 않는다 —
 * 에이전트가 앞머리에 표식을 남긴 글만 여기로 온다.
 */
export function OneDocumentCard({
  doc,
  locale,
  messageId,
}: {
  doc: OneDocumentMark;
  locale: "ko" | "en";
  messageId: string;
}) {
  const ko = locale === "ko";
  const [expanded, setExpanded] = useState(false);
  const [reading, setReading] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const title = doc.title || (ko ? "보고서" : "Report");
  // 길면 접어 둔다. 짧은 글까지 "전체 보기"를 달면 누를 것만 늘어난다.
  const longEnoughToClip = useMemo(() => doc.body.length > 1_200, [doc.body]);

  const saveMarkdown = async () => {
    setMenuOpen(false);
    setBusy(true);
    setStatus(ko ? "마크다운으로 저장하는 중" : "Saving markdown…");
    try {
      const api = ipc();
      const saved = await api?.fs?.saveTextFile?.(`${documentFileSlug(title)}.md`, doc.body);
      if (!saved || saved.canceled) { setStatus(null); return; }
      setStatus(saved.ok
        ? (ko ? "마크다운으로 저장했습니다." : "Saved as markdown.")
        : (ko ? "저장 실패: " : "Save failed: ") + (saved.error ?? (ko ? "알 수 없음" : "unknown")));
    } catch (error) {
      setStatus((ko ? "저장 실패: " : "Save failed: ") + String((error as Error)?.message ?? error));
    } finally {
      setBusy(false);
    }
  };

  const savePdf = async () => {
    setMenuOpen(false);
    setBusy(true);
    setStatus(ko ? "PDF 만드는 중" : "Building PDF…");
    try {
      const api = ipc();
      const result = await api?.document?.exportPdf?.({
        title,
        markdown: doc.body,
        suggestedName: `${documentFileSlug(title)}.pdf`,
      });
      if (!result || result.canceled) { setStatus(null); return; }
      setStatus(result.ok
        ? (ko ? "PDF로 저장했습니다." : "Saved as PDF.")
        : (ko ? "PDF 실패: " : "PDF failed: ") + (result.reason ?? (ko ? "알 수 없음" : "unknown")));
    } catch (error) {
      setStatus((ko ? "PDF 실패: " : "PDF failed: ") + String((error as Error)?.message ?? error));
    } finally {
      setBusy(false);
    }
  };

  const bodyMarkdown = <Markdown text={doc.body} messageId={`${messageId}:doc`} />;

  return (
    <>
      <article className={styles.card} data-one-document="true" data-doc-title={title}>
        <header className={styles.head}>
          <span className={styles.mark} aria-hidden="true">
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path d="M4 2h5l3 3v9H4V2z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
              <path d="M9 2v3h3M6 8h4M6 11h4" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
            </svg>
          </span>
          <span className={styles.title} title={title}>{title}</span>
          <span className={styles.menuAnchor}>
            <button
              type="button"
              className={styles.headAction}
              aria-label={ko ? "받아 가기" : "Download"}
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              disabled={busy}
              onClick={() => setMenuOpen((value) => !value)}
            >
              <IconFileUp size={15} />
            </button>
            {menuOpen && (
              <div className={styles.menu} role="menu">
                <button type="button" role="menuitem" onClick={() => void saveMarkdown()}>
                  {ko ? "마크다운(.md)으로 저장" : "Save as Markdown (.md)"}
                </button>
                <button type="button" role="menuitem" onClick={() => void savePdf()}>
                  {ko ? "PDF로 저장" : "Save as PDF"}
                </button>
              </div>
            )}
          </span>
          <button
            type="button"
            className={styles.headAction}
            aria-label={ko ? "전체 보기" : "Open full view"}
            onClick={() => setReading(true)}
          >
            <IconExpand size={15} />
          </button>
        </header>

        <div
          className={styles.bodyWrap}
          data-clipped={longEnoughToClip && !expanded ? "true" : "false"}
        >
          <div className={styles.body}>{bodyMarkdown}</div>
        </div>

        {longEnoughToClip && (
          <button type="button" className={styles.expand} onClick={() => setExpanded((value) => !value)}>
            {expanded ? (ko ? "접기" : "Collapse") : (ko ? "전체 보기" : "Show all")}
          </button>
        )}

        {status && <p className={styles.status} role="status">{status}</p>}
      </article>

      {reading && (
        <div
          className={styles.readerBackdrop}
          role="presentation"
          onClick={(event) => { if (event.target === event.currentTarget) setReading(false); }}
        >
          <section className={styles.reader} role="dialog" aria-modal="true" aria-label={title}>
            <header className={styles.head}>
              <span className={styles.title} title={title}>{title}</span>
              <button
                type="button"
                className={styles.headAction}
                aria-label={ko ? "닫기" : "Close"}
                onClick={() => setReading(false)}
              >
                <IconClose size={15} />
              </button>
            </header>
            <div className={styles.readerBody}>
              <div className={styles.body}>{bodyMarkdown}</div>
            </div>
          </section>
        </div>
      )}
    </>
  );
}
