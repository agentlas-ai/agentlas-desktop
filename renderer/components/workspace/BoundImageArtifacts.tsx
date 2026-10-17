'use client';

import { useEffect, useState } from 'react';
import {
  isOneArtifactPreviewCapabilityV1,
  isOneArtifactPreviewRefusalCode,
  isOneArtifactPreviewRefusalV1,
  ONE_ARTIFACT_PREVIEW_REFUSAL_HEADER,
  type OneArtifactPreviewCapabilityV1,
  type OneArtifactPreviewRefusalCode,
} from '@shared/one-artifacts';
import type { OneActivityArtifact } from '@/lib/one-activity';
import { boundArtifactKey, scopedBoundImages } from '@/lib/bound-image-artifacts';
import { requestOneArtifactOpen } from '@/lib/one-artifact-open';
import { ipc } from '@/lib/ipc';
import { IconChevronRight } from '@/components/Icon';
import styles from './BoundImageArtifacts.module.css';

/** Main's refusal code, or what the card itself saw (no bridge, the IPC threw, the served bytes did not decode). */
type PreviewFailureCode = OneArtifactPreviewRefusalCode | 'bridge_unavailable' | 'issue_failed' | 'image_undecodable' | 'load_failed';

/** A refusal that a moment later cannot pass either: retrying it only repeats the same answer. */
const SETTLED_REFUSALS = new Set<PreviewFailureCode>([
  'request_invalid', 'task_missing', 'task_chat_mismatch', 'task_archived', 'binding_missing', 'binding_version_mismatch',
  'path_archived', 'type_mismatch', 'file_missing', 'path_out_of_scope', 'path_changed', 'identity_changed', 'content_changed',
  'file_not_bounded',
]);

/** Ask Main why it would not serve the capability the <img> just failed to load. */
async function probeLoadFailure(capabilityUrl: string): Promise<PreviewFailureCode> {
  try {
    const response = await fetch(capabilityUrl, { method: 'HEAD', cache: 'no-store' });
    if (response.ok) return 'image_undecodable';
    const code = response.headers.get(ONE_ARTIFACT_PREVIEW_REFUSAL_HEADER);
    return isOneArtifactPreviewRefusalCode(code) ? code : 'load_failed';
  } catch {
    return 'load_failed';
  }
}

function BoundImage({ item, locale }: { item: OneActivityArtifact; locale: 'ko' | 'en' }) {
  const key = boundArtifactKey(item);
  const [preview, setPreview] = useState<{ key: string; value: OneArtifactPreviewCapabilityV1 } | null>(null);
  const [attempt, setAttempt] = useState(0);
  // A click on a failed card asks again from the first attempt; after a manual retry that fails too, the click opens.
  const [manualRetries, setManualRetries] = useState(0);
  const [failure, setFailure] = useState<PreviewFailureCode | null>(null);
  useEffect(() => {
    let disposed = false;
    let issued: OneArtifactPreviewCapabilityV1 | null = null;
    let retryTimer: number | null = null;
    const bridge = ipc()?.oneArtifacts;
    setPreview(null);
    setFailure(null);
    if (!bridge) { setFailure('bridge_unavailable'); return; }
    const retry = (code: PreviewFailureCode) => {
      if (disposed) return;
      if (attempt >= 2 || SETTLED_REFUSALS.has(code)) { setFailure(code); return; }
      retryTimer = window.setTimeout(() => setAttempt((value) => value + 1), attempt === 0 ? 350 : 1_200);
    };
    void bridge.issuePreview(item.binding).then((value) => {
      const capability = isOneArtifactPreviewCapabilityV1(value) ? value : null;
      issued = capability?.kind === 'image' ? capability : null;
      if (capability && !issued) void bridge.revokePreview({ ...item.binding, capabilityUrl: capability.capabilityUrl }).catch(() => undefined);
      if (disposed) {
        if (issued) void bridge.revokePreview({ ...item.binding, capabilityUrl: issued.capabilityUrl }).catch(() => undefined);
        return;
      }
      if (issued) setPreview({ key, value: issued });
      else retry(isOneArtifactPreviewRefusalV1(value) ? value.code : 'type_mismatch');
    }).catch(() => retry('issue_failed'));
    return () => {
      disposed = true;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      if (issued) void bridge.revokePreview({ ...item.binding, capabilityUrl: issued.capabilityUrl }).catch(() => undefined);
    };
  // `key` contains the exact binding fields; object identity changes whenever
  // activity rows are reprojected and must not mint a fresh capability loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempt, key, manualRetries]);
  const current = preview?.key === key ? preview.value : null;
  const onImageError = (capabilityUrl: string) => {
    setPreview(null);
    void probeLoadFailure(capabilityUrl).then((code) => {
      if (attempt < 2 && !SETTLED_REFUSALS.has(code)) setAttempt((value) => value + 1);
      else setFailure(code);
    });
  };
  const retryable = failure !== null && manualRetries < 1 && !SETTLED_REFUSALS.has(failure);
  const onClick = () => {
    if (retryable) {
      setAttempt(0);
      setManualRetries((value) => value + 1);
      return;
    }
    requestOneArtifactOpen({ binding: item.binding, label: item.label });
  };
  const failedCopy = failure && (locale === 'ko'
    ? `미리보기 실패 (${failure}) · ${retryable ? '눌러서 다시 시도' : '눌러서 열기'}`
    : `Preview failed (${failure}) · ${retryable ? 'click to retry' : 'click to open'}`);
  return <button type="button" className={styles.image} onClick={onClick} data-preview-failure={failure ?? undefined}
    aria-label={`${item.label} · ${failure ? failedCopy : locale === 'ko' ? '크게 보기' : 'Open image'}`}>
    {current ? <img src={current.capabilityUrl} alt={item.label} loading="lazy" onError={() => onImageError(current.capabilityUrl)} />
      : <span>{failedCopy || (locale === 'ko' ? '이미지 불러오는 중…' : 'Loading image…')}</span>}
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
