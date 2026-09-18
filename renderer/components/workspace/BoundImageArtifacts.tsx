'use client';

import { useEffect, useState } from 'react';
import { isOneArtifactPreviewCapabilityV1, type OneArtifactPreviewCapabilityV1 } from '@shared/one-artifacts';
import type { OneActivityArtifact } from '@/lib/one-activity';
import { boundArtifactKey, scopedBoundImages } from '@/lib/bound-image-artifacts';
import { requestOneArtifactOpen } from '@/lib/one-artifact-open';
import { ipc } from '@/lib/ipc';
import { IconChevronRight } from '@/components/Icon';
import styles from './BoundImageArtifacts.module.css';

function BoundImage({ item, locale }: { item: OneActivityArtifact; locale: 'ko' | 'en' }) {
  const key = boundArtifactKey(item);
  const [preview, setPreview] = useState<{ key: string; value: OneArtifactPreviewCapabilityV1 } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let disposed = false;
    let issued: OneArtifactPreviewCapabilityV1 | null = null;
    let retryTimer: number | null = null;
    const bridge = ipc()?.oneArtifacts;
    setPreview(null);
    setFailed(false);
    if (!bridge) { setFailed(true); return; }
    const retry = () => {
      if (disposed || attempt >= 2) { if (!disposed) setFailed(true); return; }
      retryTimer = window.setTimeout(() => setAttempt((value) => value + 1), attempt === 0 ? 350 : 1_200);
    };
    void bridge.issuePreview(item.binding).then((value) => {
      issued = isOneArtifactPreviewCapabilityV1(value) && value.kind === 'image' ? value : null;
      if (disposed) {
        if (value) void bridge.revokePreview({ ...item.binding, capabilityUrl: value.capabilityUrl }).catch(() => undefined);
        return;
      }
      if (issued) setPreview({ key, value: issued });
      else retry();
    }).catch(retry);
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (issued) void bridge.revokePreview({ ...item.binding, capabilityUrl: issued.capabilityUrl }).catch(() => undefined);
    };
  // `key` contains the exact binding fields; object identity changes whenever
  // activity rows are reprojected and must not mint a fresh capability loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, key]);
  const current = preview?.key === key ? preview.value : null;
  return <button type="button" className={styles.image} onClick={() => requestOneArtifactOpen({ binding: item.binding, label: item.label })}
    aria-label={`${item.label} · ${locale === 'ko' ? '크게 보기' : 'Open image'}`}>
    {current ? <img src={current.capabilityUrl} alt={item.label} loading="lazy" onError={() => {
      setPreview(null);
      if (attempt < 2) setAttempt((value) => value + 1);
      else setFailed(true);
    }} /> : <span>{failed
      ? (locale === 'ko' ? '미리보기 실패 · 열어서 다시 시도' : 'Preview failed · open to retry')
      : (locale === 'ko' ? '이미지 불러오는 중…' : 'Loading image…')}</span>}
    <span className={styles.label}>{item.label}</span>
  </button>;
}

export function BoundImageArtifacts({ items, chatId, runId, locale }: {
  items: readonly OneActivityArtifact[]; chatId?: string | null; runId?: string | null; locale: 'ko' | 'en';
}) {
  const images = scopedBoundImages(items, chatId, runId);
  const scope = JSON.stringify([chatId, runId]);
  const [paging, setPaging] = useState({ scope, page: 0 });
  const page = Math.min(paging.scope === scope ? paging.page : 0, Math.max(0, Math.ceil(images.length / 6) - 1));
  const visible = images.slice().reverse().slice(page * 6, page * 6 + 6);
  return images.length ? <div className={styles.list} data-bound-images="true">
    {visible.map((item) => <BoundImage key={boundArtifactKey(item)} item={item} locale={locale} />)}
    {images.length > 6 && <div className={styles.pages}>
      <button
        type="button"
        disabled={page === 0}
        onClick={() => setPaging({ scope, page: page - 1 })}
        aria-label={locale === 'ko' ? '최신 이미지' : 'Newer images'}
        title={locale === 'ko' ? '최신 이미지' : 'Newer images'}
      ><IconChevronRight size={14} style={{ transform: 'rotate(180deg)' }} /></button>
      <span aria-label={locale === 'ko' ? `${page + 1} / ${Math.ceil(images.length / 6)} 페이지` : `Page ${page + 1} of ${Math.ceil(images.length / 6)}`}>{page + 1} / {Math.ceil(images.length / 6)}</span>
      <button
        type="button"
        disabled={(page + 1) * 6 >= images.length}
        onClick={() => setPaging({ scope, page: page + 1 })}
        aria-label={locale === 'ko' ? '이전 이미지' : 'Older images'}
        title={locale === 'ko' ? '이전 이미지' : 'Older images'}
      ><IconChevronRight size={14} /></button>
    </div>}
  </div> : null;
}
