'use client';

import { useEffect, useRef, useState } from 'react';
import { useBusinessCopy } from '../use-business-copy';
import { IconRefresh } from '../../components/Icon';
import { businessOnlyKeys, isBusinessId, isBusinessRevision, isBusinessScope, isBusinessSession, type BusinessExactStop } from '../../../shared/business/context';
import { sameBusinessHistoryViewContext, type BusinessHistoryViewContext } from '../../../shared/business/history-view';
import { isBusinessNativeArray } from '../../../shared/business/native-registry';
import { businessReviewMatches, businessReviewReady, isBusinessLearningSnapshot, type BusinessLearningCandidateAction as CandidateAction, type BusinessLearningCandidateView, type BusinessLearningReviewView, type BusinessLearningSnapshot, type BusinessLearningPanelPort } from '../../../shared/business/console-contracts';
export { businessReviewMatches, businessReviewReady, isBusinessLearningSnapshot, type BusinessLearningBaseRevision, type BusinessLearningCandidateView, type BusinessLearningReviewView, type BusinessLearningSnapshot, type BusinessLearningPanelPort } from '../../../shared/business/console-contracts';

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
export function BusinessLearningPanel({ port, expectedContext, initialSnapshot = null, displayClosed = false }: { port: BusinessLearningPanelPort | null; expectedContext?: BusinessHistoryViewContext | null; initialSnapshot?: BusinessLearningSnapshot | null; displayClosed?: boolean }) {
  const { copy } = useBusinessCopy();
  const stateLabels = { candidate: copy("후보", "Candidate"), draft: copy("초안", "Draft"), 'review-ready': copy("검토 필요", "Review required"), active: copy("사용 중", "Active"), paused: copy("일시 중지", "Paused"), revoked: copy("회수됨", "Revoked"), unknown: copy("확인 필요", "Check required") } as const;
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
    if (!port) { setNotice(copy("학습·검토·실행 관리 연결이 필요합니다.", "Connect learning, review and execution management.")); return () => { generation.current++; }; }
    const off = port.subscribeInvalidation?.(() => {
      generation.current++; setSnapshot(null); setReview(null); setConfirmed(false); setBusy(false); setNotice(copy("현재 권한이 바뀌어 변경안 표시를 닫았습니다.", "Permissions changed and proposal display closed."));
    });
    if (!displayClosed) void port.read().then(value => { if (generation.current === expected) {
      try { accept(value); } catch { setSnapshot(null); setConfirmed(false); setNotice(copy("현재 업무 범위와 학습 상태를 확인해야 합니다.", "Check the current work scope and learning status.")); }
    } }, () => {
      if (generation.current === expected) { setSnapshot(null); setNotice(copy("현재 학습 상태를 확인할 수 없습니다.", "Could not verify the current learning status.")); }
    });
    return () => { generation.current++; ownerGeneration.current++; off?.(); };
  }, [port, expectedKey]);
  useEffect(() => {
    if (displayClosed) { generation.current++; setSnapshot(null); setReview(null); setConfirmed(false); setBusy(false); }
    // Preserve the exact original terminal targets and their owner generation.
  }, [displayClosed]);
  useEffect(() => {
    if (!snapshot?.context) return;
    const expiresAt = Math.min(snapshot.context.expiresAt, Date.parse(snapshot.context.session.expiresAt)); let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      if (expiresAt > Date.now()) { timer = setTimeout(expire, Math.min(2147483647, expiresAt - Date.now())); return; }
      generation.current++; setSnapshot(null); setReview(null); setConfirmed(false); setBusy(false); setNotice(copy("학습 범위가 만료되어 변경안 표시를 닫았습니다. 현재 상태를 다시 확인해 주세요.", "Learning scope expired and proposal display closed. Check the current status again."));
    };
    timer = setTimeout(expire, Math.max(0, Math.min(2147483647, expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [snapshot?.context]);
  useEffect(() => {
    if (!review) return;
    let timer: ReturnType<typeof setTimeout>;
    const expire = () => {
      if (review.expiresAt > Date.now()) { timer = setTimeout(expire, Math.min(2147483647, review.expiresAt - Date.now())); return; }
      generation.current++; setReview(null); setBusy(false); setNotice(copy("변경안 검토가 만료됐습니다. 현재 변경안과 처리 상태를 다시 확인해 주세요.", "Proposal review expired. Check the current proposal and request status again."));
    };
    timer = setTimeout(expire, Math.max(0, Math.min(2147483647, review.expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [review]);
  async function update(operation: () => Promise<BusinessLearningSnapshot>, message?: string) {
    if (!port) return;
    const expected = ++generation.current;
    setBusy(true); setReview(null); setNotice(null);
    try { const next = await operation(); if (generation.current === expected) { accept(next); if (message) setNotice(message); } }
    catch { if (generation.current === expected) { setSnapshot(null); setConfirmed(false); setNotice(copy("완료 여부를 확인하지 못했습니다. 현재 상태를 다시 확인해 주세요.", "Completion is unconfirmed. Check the current status again.")); } }
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
        else setNotice(copy("이 변경안을 볼 수 있는 검토자의 확인이 필요합니다.", "A reviewer with access must verify this proposal."));
      }
    } catch { if (generation.current === expected) setNotice(copy("현재 변경안을 불러올 수 없습니다.", "Could not load the current proposal.")); }
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
      if (owner === ownerGeneration.current) setNotice(result.state === 'settled' ? copy("해당 실행이 중지됐습니다.", "This execution stopped.") : result.state === 'accepted' ? copy("중지를 전달했습니다. 결과를 확인 중입니다.", "Stop requested. Checking the result.") : copy("중지 결과를 확인해야 합니다.", "Verify the stop result."));
    } catch { if (owner === ownerGeneration.current) setNotice(copy("중지 결과가 확인되지 않았습니다. 실행 상태를 다시 확인해 주세요.", "Stop result unconfirmed. Check execution status again.")); }
  }
  const visible = !displayClosed && learningCurrent(snapshot, expectedContext, Date.now()) ? snapshot : null;
  const current = port !== null && confirmed && visible !== null;
  return (
    <section aria-labelledby="business-learning-heading" className="business-learning-panel">
      <header className="business-section-header"><h2 id="business-learning-heading">{copy("학습과 개선", "Learning and improvements")}</h2>
        <button type="button" className="business-icon-button" title={copy("현재 상태 확인", "Check current status")} aria-label={copy("현재 상태 확인", "Check current status")} disabled={displayClosed || busy || !port} onClick={() => void update(() => port!.read())}><IconRefresh size={16} /></button></header>
      {visible && <span className="business-status">{visible.scopeLabel}</span>}
      {!port && <span role="status" className="business-status">{copy("개선 연결 필요", "Improvement connection required")}</span>}
      {visible?.sources.map(source => <div key={source.id} className="business-setting-row">
        <span>{source.label}</span><span className="business-status">{copy("수집 ", "Collection ")}{source.collection === 'on' ? copy("허용", "Allowed") : source.collection === 'paused' ? copy("중지", "Paused") : copy("꺼짐", "Off")}</span><span className="business-status">{copy("분석 ", "Analysis ")}{source.analysis === 'on' ? copy("허용", "Allowed") : source.analysis === 'paused' ? copy("중지", "Paused") : copy("꺼짐", "Off")}</span>
        <button type="button" disabled={busy || !current || source.collection !== 'on'} onClick={() => void update(() => port!.pauseCollection({ sourceId: source.id, expectedPolicyRevision: source.policyRevision }))}>{copy("수집 중지", "Pause collection")}</button>
      </div>)}
      {visible?.candidates.map(candidate => <article key={candidate.id} aria-label={candidate.label}>
        <h3>{candidate.label}</h3>
        <div className="business-context-line"><span>{copy("현재 버전 ", "Current version ")}{candidate.currentVersion ?? copy("적용 전", "Not applied")}</span><span className="business-status" data-state={candidate.state}>{stateLabels[candidate.state]}</span><span className="business-status" data-state={candidate.validation}>{copy("검증 ", "Validation ")}{candidate.validation === 'passed' ? copy("통과", "Passed") : candidate.validation === 'failed' ? copy("실패", "Failed") : copy("확인 필요", "Check required")}</span></div>
        <div className="business-actions">
          <button type="button" disabled={busy || !current} onClick={() => void compare(candidate)}>{copy("변경안 비교", "Compare proposal")}</button>
          <button type="button" disabled={busy || !current || !businessReviewReady(candidate, review)} onClick={() => {
            if (!review || !businessReviewReady(candidate, review)) return;
            void update(() => port!.approve({ ...action(candidate), baseRevision: review.baseRevision, proposalDigest: review.proposalDigest, reviewReceiptId: review.reviewReceiptId, reviewedHash: review.reviewedHash }));
          }}>{copy("검토한 변경안 적용", "Apply reviewed proposal")}</button>
          <button type="button" disabled={busy || !current} onClick={() => void update(() => port!.pause(action(candidate)))}>{copy("개선 일시 중지", "Pause improvements")}</button>
          <button type="button" disabled={!candidate.stopTarget || !port} onClick={() => {
            const target = snapshot?.context ? terminalStop(candidate, snapshot.context) : null; if (target) void stop(target);
          }}>{copy("실행 중지", "Stop execution")}</button>
          <button type="button" disabled={busy || !current} onClick={() => void update(() => port!.revoke(action(candidate)))}>{copy("회수", "Revoke")}</button>
          <button type="button" disabled={busy || !current || candidate.restoreVersion === null} onClick={() => {
            if (candidate.restoreVersion) void update(() => port!.restoreProposal({ ...action(candidate), version: candidate.restoreVersion!, expectedBaseRevision: candidate.baseRevision }), copy("복원 변경안을 확인하고 현재 권한으로 검토해 주세요.", "Check the restore proposal and review with current permissions."));
          }}>{copy("이전 버전 복원안 만들기", "Prepare previous-version restore")}</button>
          <button type="button" disabled={busy || !port} onClick={() => void port?.openAudit({ candidateId: candidate.id }).catch(() => setNotice(copy("감사 기록을 확인할 수 없습니다.", "Could not verify audit activity.")))}>{copy("감사 기록", "Audit activity")}</button>
        </div>
        {businessReviewMatches(candidate, review) && review && <div aria-label={copy("검토할 실제 변경안", "Actual changes for review")}>
          {review.changes.map(change => <details key={change.path} open><summary>{change.path}</summary><p>{copy("이전", "Before")}</p><pre>{change.before}</pre><p>{copy("변경 후", "After")}</p><pre>{change.after}</pre></details>)}
        </div>}
      </article>)}
      {!visible && terminalTargets.length > 0 && <section aria-label={copy("원래 실행의 중지", "Stop original execution")}>
        {terminalTargets.map((target, index) => <button key={JSON.stringify(target)} type="button" disabled={!port}
          aria-label={copy(`원래 실행 중지 ${index + 1}`, `Stop original execution ${index + 1}`)} onClick={() => void stop(target)}>{copy("원래 실행 중지", "Stop original execution")}</button>)}
      </section>}
      {notice && <p role="status">{notice}</p>}
    </section>
  );
}
