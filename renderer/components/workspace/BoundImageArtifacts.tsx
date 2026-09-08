'use client';

import { useEffect, useState } from 'react';
import { isOneArtifactPreviewCapabilityV1, type OneArtifactPreviewCapabilityV1 } from '@shared/one-artifacts';
import type { OneActivityArtifact } from '@/lib/one-activity';
import { boundArtifactKey, scopedBoundImages } from '@/lib/bound-image-artifacts';
import { requestOneArtifactOpen } from '@/lib/one-artifact-open';
import { ipc } from '@/lib/ipc';
import styles from './BoundImageArtifacts.module.css';

function BoundImage({ item, locale }: { item: OneActivityArtifact; locale: 'ko' | 'en' }) {
  const key = boundArtifactKey(item);
  const [preview, setPreview] = useState<{ key: string; value: OneArtifactPreviewCapabilityV1 } | null>(null);
  useEffect(() => {
    let disposed = false;
    let issued: OneArtifactPreviewCapabilityV1 | null = null;
    const bridge = ipc()?.oneArtifacts;
    if (!bridge) return;
    void bridge.issuePreview(item.binding).then((value) => {
      issued = value;
      if (disposed) {
        if (value) void bridge.revokePreview({ ...item.binding, capabilityUrl: value.capabilityUrl }).catch(() => undefined);
        return;
      }
      setPreview(isOneArtifactPreviewCapabilityV1(value) && value.kind === 'image' ? { key, value } : null);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      if (issued) void bridge.revokePreview({ ...item.binding, capabilityUrl: issued.capabilityUrl }).catch(() => undefined);
    };
  }, [key]);
  const current = preview?.key === key ? preview.value : null;
  return <button type="button" className={styles.image} onClick={() => requestOneArtifactOpen({ binding: item.binding, label: item.label })}
    aria-label={`${item.label} · ${locale === 'ko' ? '크게 보기' : 'Open image'}`}>
    {current ? <img src={current.capabilityUrl} alt={item.label} loading="lazy" /> : <span>{locale === 'ko' ? '이미지 열기' : 'Open image'}</span>}
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
      <button type="button" disabled={page === 0} onClick={() => setPaging({ scope, page: page - 1 })}>{locale === 'ko' ? '최신 이미지' : 'Newer images'}</button>
      <span>{page + 1} / {Math.ceil(images.length / 6)}</span>
      <button type="button" disabled={(page + 1) * 6 >= images.length} onClick={() => setPaging({ scope, page: page + 1 })}>{locale === 'ko' ? '이전 이미지' : 'Older images'}</button>
    </div>}
  </div> : null;
}
