'use client';

import { useEffect, useRef, useState } from 'react';
import { businessOnlyKeys, isBusinessId, isBusinessRevision, isBusinessScope, isBusinessSession, type BusinessExactStop } from '../../../shared/business/context';
import { sameBusinessHistoryViewContext, type BusinessHistoryViewContext } from '../../../shared/business/history-view';
import { isBusinessNativeArray } from '../../../shared/business/native-registry';
import { looksSecret } from '../../../shared/secret-patterns';

/** Canonical numeric revisions and opaque owner revisions are distinct exact values. */
export type BusinessLearningBaseRevision = number | string;
function isLearningBaseRevision(value: unknown): value is BusinessLearningBaseRevision {
  return isBusinessRevision(value) || isBusinessId(value);
}
export interface BusinessLearningCandidateView {
  id: string;
  revision: number;
  controlRevision: number;
  label: string;
  currentVersion: string | null;
  baseRevision: BusinessLearningBaseRevision;
  proposalDigest: string | null;
  state: 'candidate' | 'draft' | 'review-ready' | 'active' | 'paused' | 'revoked' | 'unknown';
  validation: 'passed' | 'failed' | 'unknown';
  sourceStatus: 'allowed' | 'paused' | 'revoked' | 'unknown';
  stopTarget: Pick<BusinessExactStop, 'hostId' | 'taskId' | 'runId' | 'controlVersion'> | null;
  restoreVersion: string | null;
}
export interface BusinessLearningReviewView {
  candidateId: string;
  candidateRevision: number;
  baseRevision: BusinessLearningBaseRevision;
  proposalDigest: string;
  reviewReceiptId: string;
  reviewedHash: string;
  expiresAt: number;
  /** Native trusted reviewer supplies current content authorization after loading the exact diff. */
  trustedOwner: boolean;
  contentAuthorized: boolean;
  actualDiffLoaded: boolean;
  changes: Array<{ path: string; before: string; after: string }>;
}
export interface BusinessLearningSnapshot {
  context?: BusinessHistoryViewContext | null;
  scopeLabel: string;
  status: 'current' | 'unknown';
  sources: Array<{ id: string; label: string; policyRevision: number; collection: 'on' | 'paused' | 'off'; analysis: 'on' | 'paused' | 'off' }>;
  candidates: BusinessLearningCandidateView[];
}
interface CandidateAction { candidateId: string; expectedRevision: number; expectedControlRevision: number }
export interface BusinessLearningPanelPort {
  read(): Promise<BusinessLearningSnapshot>;
  subscribeInvalidation?(listener: () => void): () => void;
  compare(input: CandidateAction): Promise<BusinessLearningReviewView | null>;
  approve(input: CandidateAction & { baseRevision: BusinessLearningBaseRevision; proposalDigest: string; reviewReceiptId: string; reviewedHash: string }): Promise<BusinessLearningSnapshot>;
  pause(input: CandidateAction): Promise<BusinessLearningSnapshot>;
  revoke(input: CandidateAction): Promise<BusinessLearningSnapshot>;
  restoreProposal(input: CandidateAction & { version: string; expectedBaseRevision: BusinessLearningBaseRevision }): Promise<BusinessLearningSnapshot>;
  pauseCollection(input: { sourceId: string; expectedPolicyRevision: number }): Promise<BusinessLearningSnapshot>;
  /** Exact safe stop is independent of content, authority-service readiness and other pending mutations. */
  stop(input: CandidateAction & { target: NonNullable<BusinessLearningCandidateView['stopTarget']> }): Promise<{ state: 'accepted' | 'settled' | 'unknown' | 'failed' }>;
  openAudit(input: { candidateId: string }): Promise<void>;
}
export function businessReviewMatches(candidate: BusinessLearningCandidateView, review: BusinessLearningReviewView | null, now = Date.now()): boolean {
  let characters = 0;
  const content = (text: unknown): text is string => typeof text === 'string' && text.length <= 100000 && !looksSecret(text)
    && (characters += text.length) <= 1000000;
  return candidate.sourceStatus === 'allowed' && !!review
    && businessOnlyKeys(review, ['candidateId', 'candidateRevision', 'baseRevision', 'proposalDigest', 'reviewReceiptId', 'reviewedHash', 'expiresAt', 'trustedOwner', 'contentAuthorized', 'actualDiffLoaded', 'changes'])
    && review.trustedOwner === true && review.contentAuthorized === true && review.actualDiffLoaded === true
    && isLearningBaseRevision(candidate.baseRevision) && isLearningBaseRevision(review.baseRevision)
    && review.candidateId === candidate.id && review.candidateRevision === candidate.revision && review.baseRevision === candidate.baseRevision
    && candidate.proposalDigest !== null && review.proposalDigest === candidate.proposalDigest && review.reviewedHash === review.proposalDigest
    && /^[a-f0-9]{64}$/.test(review.proposalDigest) && isBusinessId(review.reviewReceiptId) && isBusinessRevision(review.expiresAt)
    && review.expiresAt > now && isBusinessNativeArray(review.changes, 128) && review.changes.length > 0
    && review.changes.every(change => businessOnlyKeys(change, ['path', 'before', 'after']) && typeof change.path === 'string'
      && change.path.length <= 240 && !change.path.startsWith('/') && !change.path.includes('\\') && !/[\u0000-\u001f\u007f]/.test(change.path)
      && change.path.split('/').every(part => !!part && part !== '.' && part !== '..') && content(change.before) && content(change.after))
    && new Set(review.changes.map(change => change.path)).size === review.changes.length;
}
export function businessReviewReady(candidate: BusinessLearningCandidateView, review: BusinessLearningReviewView | null, now = Date.now()): boolean {
  return candidate.state === 'review-ready' && candidate.validation === 'passed' && businessReviewMatches(candidate, review, now);
}
const stateLabels = { candidate: '후보', draft: '초안', 'review-ready': '검토 필요', active: '사용 중', paused: '일시 중지', revoked: '회수됨', unknown: '확인 필요' } as const;
export function isBusinessLearningSnapshot(value: unknown): value is BusinessLearningSnapshot {
  const label = (text: unknown): text is string => typeof text === 'string' && text.length <= 200 && !looksSecret(text) && !/[\u0000-\u001f\u007f]/.test(text);
  try {
    return businessOnlyKeys(value, ['context', 'scopeLabel', 'status', 'sources', 'candidates']) && label(value.scopeLabel)
      && ['current', 'unknown'].includes(value.status as string) && isBusinessNativeArray(value.sources, 160)
      && value.sources.every(source => businessOnlyKeys(source, ['id', 'label', 'policyRevision', 'collection', 'analysis'])
        && isBusinessId(source.id) && label(source.label) && isBusinessRevision(source.policyRevision)
        && ['on', 'paused', 'off'].includes(source.collection as string) && ['on', 'paused', 'off'].includes(source.analysis as string))
      && new Set(value.sources.map(source => (source as { id: string }).id)).size === value.sources.length
      && isBusinessNativeArray(value.candidates, 160) && value.candidates.every(candidate =>
        businessOnlyKeys(candidate, ['id', 'revision', 'controlRevision', 'label', 'currentVersion', 'baseRevision', 'proposalDigest', 'state', 'validation', 'sourceStatus', 'stopTarget', 'restoreVersion'])
        && isBusinessId(candidate.id) && label(candidate.label) && (candidate.currentVersion === null || isBusinessId(candidate.currentVersion))
        && [candidate.revision, candidate.controlRevision].every(isBusinessRevision) && isLearningBaseRevision(candidate.baseRevision)
        && (candidate.proposalDigest === null || typeof candidate.proposalDigest === 'string' && /^[a-f0-9]{64}$/.test(candidate.proposalDigest))
        && Object.hasOwn(stateLabels, candidate.state as string) && ['passed', 'failed', 'unknown'].includes(candidate.validation as string)
        && ['allowed', 'paused', 'revoked', 'unknown'].includes(candidate.sourceStatus as string)
        && (candidate.restoreVersion === null || isBusinessId(candidate.restoreVersion))
        && (candidate.stopTarget === null || businessOnlyKeys(candidate.stopTarget, ['hostId', 'taskId', 'runId', 'controlVersion'])
          && [candidate.stopTarget.hostId, candidate.stopTarget.taskId, candidate.stopTarget.runId].every(isBusinessId) && isBusinessRevision(candidate.stopTarget.controlVersion)))
      && new Set(value.candidates.map(v => (v as { id: string }).id)).size === value.candidates.length;
  } catch { return false; }
}
function learningCurrent(snapshot: BusinessLearningSnapshot | null, expected: BusinessHistoryViewContext | null | undefined, now: number): boolean {
  if (!isBusinessLearningSnapshot(snapshot)) return false;
  const context = snapshot?.context;
  try { return !!context && businessOnlyKeys(context, ['session', 'scope', 'target', 'bindingKey', 'revision', 'policyRevision', 'nativePolicyRevision', 'expiresAt'])
    && isBusinessSession(context.session) && isBusinessScope(context.scope) && snapshot?.status === 'current'
    && [context.bindingKey, context.revision].every(isBusinessId)
    && (context.policyRevision === null || isBusinessRevision(context.policyRevision)) && (context.nativePolicyRevision === null || isBusinessId(context.nativePolicyRevision))
    && isBusinessRevision(context.expiresAt) && context.expiresAt > now && Date.parse(context.session.expiresAt) > now
    && context.expiresAt <= Date.parse(context.session.expiresAt)
    && (context.scope.kind === 'personal' ? context.scope.principalId === context.session.principalId : context.scope.organizationId === context.session.organizationId)
    && (context.target === null || businessOnlyKeys(context.target, ['deploymentId', 'oneId', 'scope', 'organizationId', 'projectId', 'spaceId', 'pageId', 'audience'])
      && context.target.deploymentId === context.session.deploymentId && [context.target.oneId, context.target.spaceId, context.target.pageId].every(isBusinessId)
      && [context.target.organizationId, context.target.projectId].every(value => value === null || isBusinessId(value))
      && ['personal', 'project', 'organization'].includes(context.target.scope) && ['owner', 'organization'].includes(context.target.audience)
      && !(context.target.scope === 'personal' && (context.target.organizationId !== null || context.target.projectId !== null || context.target.audience !== 'owner'))
      && !(context.target.scope === 'project' && context.target.projectId === null) && !(context.target.scope === 'organization' && context.target.organizationId === null)
      && !(context.target.audience === 'organization' && context.target.organizationId === null)
      && (context.scope.kind === 'personal' ? context.target.organizationId === null : context.target.organizationId === context.scope.organizationId))
    && (expected === undefined || expected !== null && sameBusinessHistoryViewContext(context, expected)); } catch { return false; }
}
type TerminalStop = CandidateAction & { target: NonNullable<BusinessLearningCandidateView['stopTarget']> };
function terminalStop(candidate: BusinessLearningCandidateView, context: BusinessHistoryViewContext): TerminalStop | null {
  const target = candidate.stopTarget;
  if (!target || !businessOnlyKeys(target, ['hostId', 'taskId', 'runId', 'controlVersion']) || target.hostId !== context.session.hostId
    || ![candidate.id, target.hostId, target.taskId, target.runId].every(isBusinessId)
    || ![candidate.revision, candidate.controlRevision, target.controlVersion].every(isBusinessRevision)) return null;
  return { candidateId: candidate.id, expectedRevision: candidate.revision, expectedControlRevision: candidate.controlRevision, target: { ...target } };
}

/** Metadata first; private diff content is requested separately and requires current owner/content review. */
export function BusinessLearningPanel({ port, expectedContext, initialSnapshot = null }: { port: BusinessLearningPanelPort | null; expectedContext?: BusinessHistoryViewContext | null; initialSnapshot?: BusinessLearningSnapshot | null }) {
  const [snapshot, setSnapshot] = useState<BusinessLearningSnapshot | null>(port ? initialSnapshot : null);
  const [confirmed, setConfirmed] = useState(false);
  const [review, setReview] = useState<BusinessLearningReviewView | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const generation = useRef(0);
  const ownerGeneration = useRef(0);
  const [terminalTargets, setTerminalTargets] = useState<TerminalStop[]>([]);
  const expectedKey = expectedContext === undefined ? 'standalone' : JSON.stringify(expectedContext);
  function accept(next: BusinessLearningSnapshot) {
    if (!learningCurrent(next, expectedContext, Date.now()) || !isBusinessNativeArray(next.candidates, 160) || !isBusinessNativeArray(next.sources, 160)) throw Error('current_learning_context_required');
    const exact = structuredClone(next);
    if (!learningCurrent(exact, expectedContext, Date.now())) throw Error('current_learning_context_required');
    setSnapshot(exact); setConfirmed(true);
    const stops = exact.candidates.map(candidate => terminalStop(candidate, exact.context!)).filter((value): value is TerminalStop => value !== null);
    setTerminalTargets(stops);
  }
  useEffect(() => {
    const expected = ++generation.current;
    ownerGeneration.current++;
    setSnapshot(port ? initialSnapshot : null); setConfirmed(false); setBusy(false); setNotice(null);
    setReview(null); setTerminalTargets([]);
    if (!port) { setNotice('학습·검토·실행 관리 연결이 필요합니다.'); return () => { generation.current++; }; }
    const off = port.subscribeInvalidation?.(() => {
      generation.current++; setSnapshot(null); setReview(null); setConfirmed(false); setBusy(false); setNotice('현재 권한이 바뀌어 변경안 표시를 닫았습니다.');
    });
    void port.read().then(value => { if (generation.current === expected) {
      try { accept(value); } catch { setSnapshot(null); setConfirmed(false); setNotice('현재 업무 범위와 학습 상태를 확인해야 합니다.'); }
    } }, () => {
      if (generation.current === expected) { setSnapshot(null); setNotice('현재 학습 상태를 확인할 수 없습니다.'); }
    });
    return () => { generation.current++; ownerGeneration.current++; off?.(); };
  }, [port, expectedKey]);
  useEffect(() => {
    if (!snapshot?.context) return;
    const expiresAt = Math.min(snapshot.context.expiresAt, Date.parse(snapshot.context.session.expiresAt)); let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      if (expiresAt > Date.now()) { timer = setTimeout(expire, Math.min(2147483647, expiresAt - Date.now())); return; }
      generation.current++; setSnapshot(null); setReview(null); setConfirmed(false); setBusy(false); setNotice('학습 범위가 만료되어 변경안 표시를 닫았습니다. 현재 상태를 다시 확인해 주세요.');
    };
    timer = setTimeout(expire, Math.max(0, Math.min(2147483647, expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [snapshot?.context]);
  useEffect(() => {
    if (!review) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      if (review.expiresAt > Date.now()) { timer = setTimeout(expire, Math.min(2147483647, review.expiresAt - Date.now())); return; }
      generation.current++; setReview(null); setBusy(false); setNotice('변경안 검토가 만료됐습니다. 현재 변경안과 처리 상태를 다시 확인해 주세요.');
    };
    timer = setTimeout(expire, Math.max(0, Math.min(2147483647, review.expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [review]);
  async function update(operation: () => Promise<BusinessLearningSnapshot>, message?: string) {
    if (!port) return;
    const expected = ++generation.current;
    setBusy(true); setReview(null); setNotice(null);
    try { const next = await operation(); if (generation.current === expected) { accept(next); if (message) setNotice(message); } }
    catch { if (generation.current === expected) { setSnapshot(null); setConfirmed(false); setNotice('완료 여부를 확인하지 못했습니다. 현재 상태를 다시 확인해 주세요.'); } }
    finally { if (generation.current === expected) setBusy(false); }
  }
  async function compare(candidate: BusinessLearningCandidateView) {
    if (!port || !confirmed || !learningCurrent(snapshot, expectedContext, Date.now())) return;
    const expected = ++generation.current;
    setBusy(true); setReview(null); setNotice(null);
    try {
      const loaded = await port.compare(action(candidate));
      if (generation.current === expected) {
        if (learningCurrent(snapshot, expectedContext, Date.now()) && businessReviewMatches(candidate, loaded, Date.now())) setReview(structuredClone(loaded));
        else setNotice('이 변경안을 볼 수 있는 검토자의 확인이 필요합니다.');
      }
    } catch { if (generation.current === expected) setNotice('현재 변경안을 불러올 수 없습니다.'); }
    finally { if (generation.current === expected) setBusy(false); }
  }
  function action(candidate: BusinessLearningCandidateView): CandidateAction {
    return { candidateId: candidate.id, expectedRevision: candidate.revision, expectedControlRevision: candidate.controlRevision };
  }
  async function stop(input: TerminalStop) {
    if (!port) return;
    const owner = ownerGeneration.current;
    generation.current++; setBusy(false); setReview(null); setConfirmed(false);
    try {
      const result = await port.stop(structuredClone(input));
      if (owner === ownerGeneration.current) setNotice(result.state === 'settled' ? '해당 실행이 중지됐습니다.' : result.state === 'accepted' ? '중지를 전달했습니다. 결과를 확인 중입니다.' : '중지 결과를 확인해야 합니다.');
    } catch { if (owner === ownerGeneration.current) setNotice('중지 결과가 확인되지 않았습니다. 실행 상태를 다시 확인해 주세요.'); }
  }
  const visible = learningCurrent(snapshot, expectedContext, Date.now()) ? snapshot : null;
  const current = port !== null && confirmed && visible !== null;
  return (
    <section aria-labelledby="business-learning-heading" className="business-learning-panel">
      <h2 id="business-learning-heading">학습과 개선</h2>
      <p>{visible?.scopeLabel ?? '업무 범위를 확인하세요.'}</p>
      <p>허용한 업무에서 개선안을 만듭니다. 적용 전 변경안과 검증 결과를 확인하세요.</p>
      {!port && <p role="status">관리 연결 필요 · 실제 변경안과 현재 권한을 확인한 후 검토할 수 있습니다.</p>}
      <button type="button" disabled={busy || !port} onClick={() => void update(() => port!.read())}>현재 상태 확인</button>
      {visible?.sources.map(source => <div key={source.id}>
        <span>{source.label} · 수집 {source.collection === 'on' ? '허용' : source.collection === 'paused' ? '중지' : '꺼짐'} · 분석 {source.analysis === 'on' ? '허용' : source.analysis === 'paused' ? '중지' : '꺼짐'}</span>
        <button type="button" disabled={busy || !current || source.collection !== 'on'} onClick={() => void update(() => port!.pauseCollection({ sourceId: source.id, expectedPolicyRevision: source.policyRevision }))}>수집 중지</button>
      </div>)}
      {visible?.candidates.map(candidate => <article key={candidate.id} aria-label={candidate.label}>
        <h3>{candidate.label}</h3>
        <p>현재 버전 {candidate.currentVersion ?? '적용 전'} · {stateLabels[candidate.state]} · 검증 {candidate.validation === 'passed' ? '통과' : candidate.validation === 'failed' ? '실패' : '확인 필요'}</p>
        <div>
          <button type="button" disabled={busy || !current} onClick={() => void compare(candidate)}>변경안 비교</button>
          <button type="button" disabled={busy || !current || !businessReviewReady(candidate, review)} onClick={() => {
            if (!review || !businessReviewReady(candidate, review)) return;
            void update(() => port!.approve({ ...action(candidate), baseRevision: review.baseRevision, proposalDigest: review.proposalDigest, reviewReceiptId: review.reviewReceiptId, reviewedHash: review.reviewedHash }));
          }}>검토한 변경안 적용</button>
          <button type="button" disabled={busy || !current} onClick={() => void update(() => port!.pause(action(candidate)))}>개선 일시 중지</button>
          <button type="button" disabled={!candidate.stopTarget || !port} onClick={() => {
            const target = snapshot?.context ? terminalStop(candidate, snapshot.context) : null; if (target) void stop(target);
          }}>실행 중지</button>
          <button type="button" disabled={busy || !current} onClick={() => void update(() => port!.revoke(action(candidate)))}>회수</button>
          <button type="button" disabled={busy || !current || candidate.restoreVersion === null} onClick={() => {
            if (candidate.restoreVersion) void update(() => port!.restoreProposal({ ...action(candidate), version: candidate.restoreVersion!, expectedBaseRevision: candidate.baseRevision }), '복원 변경안을 확인하고 현재 권한으로 검토해 주세요.');
          }}>이전 버전 복원안 만들기</button>
          <button type="button" disabled={busy || !port} onClick={() => void port?.openAudit({ candidateId: candidate.id }).catch(() => setNotice('감사 기록을 확인할 수 없습니다.'))}>감사 기록</button>
        </div>
        {businessReviewMatches(candidate, review) && review && <div aria-label="검토할 실제 변경안">
          {review.changes.map(change => <details key={change.path} open><summary>{change.path}</summary><p>이전</p><pre>{change.before}</pre><p>변경 후</p><pre>{change.after}</pre></details>)}
        </div>}
      </article>)}
      {!visible && terminalTargets.length > 0 && <section aria-label="원래 실행의 중지">
        <p>앞서 확인한 실행을 중지할 수 있습니다.</p>
        {terminalTargets.map((target, index) => <button key={JSON.stringify(target)} type="button" disabled={!port}
          aria-label={`원래 실행 중지 ${index + 1}`} onClick={() => void stop(target)}>원래 실행 중지</button>)}
      </section>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
