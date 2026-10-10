'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { BUSINESS_HISTORY_SEARCH_SCHEMA, filterBusinessHistoryTimeline, sameBusinessHistoryViewContext as sameContext,
  type BusinessHistoryDeleteReceipt, type BusinessHistoryDeleteRequest, type BusinessHistoryFilter, type BusinessHistorySearchRequest, type BusinessHistorySearchResult,
  type BusinessHistoryPanelPort, type BusinessHistoryViewContext, type BusinessHistoryViewSnapshot } from '../../../shared/business/history-view';

const collectionLabels = { on: '허용', paused: '중지', off: '꺼짐', unknown: '확인 필요' } as const;
const candidateLabels = { observed: '후보 발견', drafting: '초안 준비 중', draft: '초안', evaluated: '평가됨', accepted: '승인한 변경안', running: '실행 요청됨', feedback: '결과 반영됨', paused: '일시 중지', revoked: '회수됨', deleted: '삭제됨', unknown: '결과 확인 필요' } as const;
const recommendationLabels = { agent: '에이전트 초안', plugin: '플러그인 초안', graph: '그래프 초안' } as const;
const unavailableLabels = { personal_timeline: '개인 기록 읽기', organization_timeline: '조직 범위 기록 읽기', one_history: 'One 개선 후보', owner_controls: '수집·보존 관리', privacy_delete: '삭제 전용 권한·기록 소유자', native_review: '원래 One의 검토 화면' } as const;
export function BusinessHistoryPanel({ port, expectedContext, initialSnapshot = null }: {
  port: BusinessHistoryPanelPort | null;
  expectedContext?: BusinessHistoryViewContext | null;
  initialSnapshot?: BusinessHistoryViewSnapshot | null;
}) {
  const [snapshot, setSnapshot] = useState<BusinessHistoryViewSnapshot | null>(port ? initialSnapshot : null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [unsettled, setUnsettled] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteMode, setDeleteMode] = useState<'scope' | 'before'>('scope');
  const [deleteBefore, setDeleteBefore] = useState('');
  const [pendingDelete, setPendingDelete] = useState<{ request: BusinessHistoryDeleteRequest; receipt: BusinessHistoryDeleteReceipt } | null>(null);
  const [period, setPeriod] = useState<'24h' | '7d' | '30d'>('24h');
  const [application, setApplication] = useState('');
  const [filterEnd, setFilterEnd] = useState(Date.now);
  const [query, setQuery] = useState('');
  const [searchResult, setSearchResult] = useState<BusinessHistorySearchResult | null>(null);
  const searchId = useId();
  const generation = useRef(0);
  const stopTarget = useRef<BusinessHistoryViewContext | null>(null);
  const expectedKey = expectedContext === undefined ? 'standalone' : JSON.stringify(expectedContext);
  const context = snapshot?.context ?? null;
  const matches = context !== null && (expectedContext === undefined || expectedContext !== null && sameContext(context, expectedContext));
  const current = port !== null && confirmed && snapshot?.status === 'current' && matches && context!.expiresAt > Date.now();
  const deleteCurrent = port !== null && confirmed && matches && context!.expiresAt > Date.now() && !!snapshot?.availability.deleteHistory;
  async function refresh() {
    if (!port) return;
    const expected = ++generation.current;
    setBusy(true); setConfirmed(false); setSnapshot(null); setSearchResult(null);
    try {
      const read = await port.read();
      if (generation.current !== expected) return;
      if (read.context && expectedContext !== undefined && (expectedContext === null || !sameContext(read.context, expectedContext))) {
        setNotice('계정·조직 또는 기록 revision이 바뀌었습니다. 현재 범위를 다시 선택해 주세요.'); return;
      }
      setSnapshot(read); setConfirmed(true); setFilterEnd(Date.now());
      if (read.context && read.availability.pauseCollection) stopTarget.current = read.context;
    } catch { if (generation.current === expected) setNotice('현재 범위의 기록을 확인할 수 없습니다.'); }
    finally { if (generation.current === expected) setBusy(false); }
  }
  useEffect(() => {
    ++generation.current; setSnapshot(port ? initialSnapshot : null); setConfirmed(false); setBusy(false); setUnsettled(false); setNotice(null); setPendingDelete(null); setDeleteMode('scope'); setDeleteBefore(''); stopTarget.current = null;
    setSearchResult(null); setQuery(''); setPeriod('24h'); setApplication(''); setFilterEnd(Date.now());
    const off = port?.subscribeInvalidation?.(() => {
      generation.current++; setSnapshot(null); setConfirmed(false); setBusy(false); setSearchResult(null);
      setNotice('현재 권한이 바뀌어 기록 표시를 닫았습니다. 현재 범위를 다시 확인해 주세요.');
    });
    if (port) void refresh();
    return () => { generation.current++; stopTarget.current = null; off?.(); };
  }, [port, expectedKey]);
  useEffect(() => {
    if (!snapshot?.context) return;
    const timer = setTimeout(() => {
      generation.current++; setSnapshot(null); setSearchResult(null); setConfirmed(false); setBusy(false);
      setNotice('현재 계정·기록 범위가 만료되어 표시를 닫았습니다. 현재 범위를 다시 확인해 주세요.');
      // Keep the exact bounded stop target and uncertain original delete receipt.
      // Expiry closes display/read actions, not terminal control or reconciliation.
    }, Math.max(0, Math.min(2_147_483_647, snapshot.context.expiresAt - Date.now())));
    return () => clearTimeout(timer);
  }, [snapshot?.context?.expiresAt]);
  function clearSearch() { generation.current++; setSearchResult(null); }
  async function action(operation: () => Promise<void>) {
    if (busy || unsettled || !current) return;
    const expected = ++generation.current; setBusy(true); setNotice(null); setSearchResult(null);
    try { await operation(); if (generation.current === expected) setNotice('원래 One의 현재 검토 화면을 요청했습니다.'); }
    catch { if (generation.current === expected) { setUnsettled(true); setNotice('요청 결과를 확인하지 못했습니다. 같은 요청의 상태를 확인해 주세요.'); } }
    finally { if (generation.current === expected) setBusy(false); }
  }
  async function pause() {
    const target = stopTarget.current;
    if (!port?.pauseCollection || !target || target.policyRevision === null) return;
    ++generation.current; setBusy(false); setSearchResult(null);
    try {
      const result = await port.pauseCollection({ context: target, expectedPolicyRevision: target.policyRevision });
      setNotice(result.state === 'applied' ? '수집 중지를 확인했습니다.' : result.state === 'denied' ? '중지를 적용하지 못했습니다. 현재 관리 범위를 확인하세요.' : '중지 전달 결과를 확인해야 합니다.');
      if (result.state === 'unknown') setUnsettled(true);
      await refresh();
    } catch { setUnsettled(true); setNotice('중지 결과가 확인되지 않았습니다.'); }
  }
  async function remove() {
    if (!port?.deleteHistory || !deleteCurrent || !context || context.policyRevision === null || unsettled || busy) return;
    const date = deleteMode === 'before' && deleteBefore ? new Date(`${deleteBefore}T00:00:00`) : null;
    if (deleteMode === 'before' && (!date || !Number.isFinite(date.getTime()) || date.getTime() > Date.now())) return;
    const before = date?.toISOString() ?? null;
    const request: BusinessHistoryDeleteRequest = { context, expectedHistoryRevision: context.revision, expectedPolicyRevision: context.policyRevision,
      filter: deleteMode === 'scope' ? { kind: 'scope', before: null } : { kind: 'before', before: before! } };
    const expected = ++generation.current; setBusy(true); setNotice(null); setUnsettled(true); setSearchResult(null);
    try {
      const result = await port.deleteHistory(request);
      if (generation.current !== expected) return;
      if (result.state === 'unknown') { setPendingDelete({ request, receipt: result }); setUnsettled(true); setNotice('삭제 결과가 확인되지 않았습니다. 원래 삭제 요청의 기록을 확인해야 합니다.'); }
      else { setUnsettled(false); setNotice(result.state === 'applied' ? '허용된 범위의 삭제를 확인했습니다.' : '삭제 권한과 기록 revision을 다시 확인해 주세요.'); await refresh(); }
    } catch { if (generation.current === expected) { setUnsettled(true); setNotice('삭제 결과가 확인되지 않았습니다.'); } }
    finally { if (generation.current === expected) setBusy(false); }
  }
  async function reconcileRemoval() {
    if (!port?.reconcileDelete || !pendingDelete?.receipt.originalIntent || busy) return;
    const exact = pendingDelete; const expected = ++generation.current; setBusy(true);
    try {
      const receipt = await port.reconcileDelete({ request: exact.request, originalIntent: exact.receipt.originalIntent! });
      if (generation.current !== expected) return;
      setPendingDelete({ request: exact.request, receipt });
      if (receipt.state === 'unknown') setNotice('원래 삭제 요청의 결과가 아직 확인되지 않았습니다.');
      else { setUnsettled(false); setPendingDelete(null); setNotice(receipt.state === 'applied' ? `삭제 기록을 확인했습니다. 삭제된 항목 ${receipt.deletedCount ?? 0}개.` : '원래 삭제 요청이 적용되지 않은 기록을 확인했습니다.'); await refresh(); }
    } catch { if (generation.current === expected) setNotice('원래 삭제 요청의 기록을 읽을 수 없습니다.'); }
    finally { if (generation.current === expected) setBusy(false); }
  }
  async function findEvidence() {
    if (!port?.search || !current || !snapshot?.availability.search || !context || busy || unsettled || !query.trim()) return;
    const request: BusinessHistorySearchRequest = { context, expectedHistoryRevision: context.revision, query, filter,
      entryRevisions: snapshot.entries.map(entry => ({ entryId: entry.id, revision: entry.revision })) };
    const expected = ++generation.current; setBusy(true); setSearchResult(null); setNotice(null);
    try {
      const result = await port.search(request);
      if (generation.current !== expected) return;
      const valid = result.schema === BUSINESS_HISTORY_SEARCH_SCHEMA && result.state !== 'blocked' && result.context !== null
        && sameContext(result.context, request.context) && result.historyRevision === request.expectedHistoryRevision
        && JSON.stringify(result.filter) === JSON.stringify(request.filter) && Array.isArray(result.citations) && result.citations.length <= 20
        && result.citations.every(citation => {
          const entry = snapshot.entries.find(value => value.id === citation.entryId && value.revision === citation.entryRevision);
          return entry && citation.title === entry.title && citation.occurredAt === entry.occurredAt && typeof citation.excerpt === 'string'
            && citation.excerpt.length <= 280 && `${entry.title} ${entry.summary}`.includes(citation.excerpt.replace(/^…|…$/g, ''));
        }) && (result.state === 'matched' ? result.citations.length > 0 : result.state === 'no-evidence' && result.citations.length === 0);
      if (valid && context.expiresAt > Date.now()) setSearchResult(result);
      else setNotice('현재 기록 권한 또는 revision을 다시 확인해 주세요.');
    } catch { if (generation.current === expected) setNotice('현재 허용된 기록에서 근거를 확인할 수 없습니다.'); }
    finally { if (generation.current === expected) setBusy(false); }
  }
  const visible = matches && context!.expiresAt > Date.now() && snapshot?.status === 'current' ? snapshot : null;
  const duration = period === '24h' ? 86400_000 : period === '7d' ? 7 * 86400_000 : 30 * 86400_000;
  const filter: BusinessHistoryFilter = { from: new Date(filterEnd - duration).toISOString(), to: new Date(filterEnd).toISOString(), applications: application ? [application] : [] };
  const apps = [...new Set((visible?.entries ?? []).flatMap(entry => entry.applications))].sort();
  const filteredEntries = filterBusinessHistoryTimeline(visible?.entries ?? [], filter);
  const result = current && searchResult?.context && sameContext(searchResult.context, context!) && searchResult.historyRevision === context!.revision
    && JSON.stringify(searchResult.filter) === JSON.stringify(filter) ? searchResult : null;
  const groups = new Map<string, NonNullable<typeof visible>['entries'][number][]>();
  for (const entry of filteredEntries) {
    const key = new Date(entry.occurredAt).toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric' });
    const group = groups.get(key) ?? []; group.push(entry); groups.set(key, group);
  }
  return <section aria-labelledby="business-history-heading" className="business-history-panel">
    <header className="business-section-header"><div><h2 id="business-history-heading">컴퓨터 기록과 개선 후보</h2><p>허용한 업무의 흐름에서 반복 작업을 찾고, 원래 One에서 변경안을 검토합니다.</p></div>
      <button type="button" disabled={busy || !port} onClick={() => void refresh()}>현재 기록 확인</button></header>
    {!port && <p role="status">기록 관리 연결 필요 · 실제 기록과 관리 기능을 아직 사용할 수 없습니다.</p>}
    {visible?.context && <div className="business-context-line"><span>{visible.context.scope.kind === 'personal' ? '내 개인 기록' : `조직 ${visible.context.scope.organizationId}`}</span>
      <span>Desktop {visible.context.session.hostId}</span><span>기록 revision {visible.context.revision}</span></div>}
    <form role="search" aria-label="허용된 기록에서 근거 검색" className="business-policy-strip" onSubmit={event => { event.preventDefault(); void findEvidence(); }}>
      <label>기간 <select value={period} disabled={busy || !visible?.availability.timeline} onChange={event => { clearSearch(); setPeriod(event.target.value as '24h' | '7d' | '30d'); }}>
        <option value="24h">최근 24시간</option><option value="7d">최근 7일</option><option value="30d">최근 30일</option></select></label>
      <label>앱 <select value={application} disabled={busy || !visible?.availability.timeline} onChange={event => { clearSearch(); setApplication(event.target.value); }}>
        <option value="">허용된 모든 앱</option>{apps.map(app => <option key={app} value={app}>{app}</option>)}</select></label>
      <label htmlFor={searchId}>허용된 기록에서 근거 검색</label><input id={searchId} type="search" value={query} maxLength={200}
        disabled={busy || !current || !port?.search || !visible?.availability.search} placeholder="기록의 제목·요약에서 찾을 내용"
        onChange={event => { clearSearch(); setQuery(event.target.value); }} />
      <button type="submit" disabled={busy || unsettled || !current || !port?.search || !visible?.availability.search || !query.trim()}>근거 찾기</button>
    </form>
    {!port?.search && <p role="status">현재 권한으로 기록을 다시 확인할 검색 연결이 필요합니다.</p>}
    {result && <section aria-label="기록 검색 결과"><h3>{result.state === 'matched' ? '일치하는 기록 근거' : '허용된 기록에 일치하는 근거가 없습니다.'}</h3>
      <p>현재 선택한 기간·앱의 제목과 요약에서 확인한 결과입니다.</p><ul>{result.citations.map(citation => <li key={`${citation.entryId}:${citation.entryRevision}`}>
        <strong>{citation.title}</strong><p>{citation.excerpt}</p><small>기록 {citation.entryId} · revision {citation.entryRevision} · <time dateTime={citation.occurredAt}>{new Date(citation.occurredAt).toLocaleString('ko-KR')}</time></small>
      </li>)}</ul></section>}
    <div className="business-policy-strip"><span>수집 {collectionLabels[visible?.collection ?? 'unknown']}</span><span>분석 {collectionLabels[visible?.analysis ?? 'unknown']}</span>
      <span>보존 {visible?.retentionMs ? `${Math.round(visible.retentionMs / 86400_000)}일` : '정책 확인 필요'}</span>
      <button type="button" disabled={!port?.pauseCollection || !stopTarget.current} onClick={() => void pause()}>수집 중지</button>
      <label>삭제 범위 <select value={deleteMode} disabled={!deleteCurrent || busy || unsettled} onChange={event => setDeleteMode(event.target.value as 'scope' | 'before')}>
        <option value="scope">현재 개인·조직 범위</option><option value="before">선택한 날짜 이전</option></select></label>
      {deleteMode === 'before' && <label>날짜 <input type="date" value={deleteBefore} disabled={!deleteCurrent || busy || unsettled} onChange={event => setDeleteBefore(event.target.value)} /></label>}
      <button type="button" disabled={!deleteCurrent || busy || unsettled || !port?.deleteHistory || deleteMode === 'before' && !deleteBefore} onClick={() => void remove()}>현재 범위 기록 삭제</button></div>
    {matches && context && snapshot?.availability.deleteHistory && <p>삭제 범위: {context.scope.kind === 'personal' ? '내 개인 기록' : `조직 ${context.scope.organizationId}`} · 기록 revision {context.revision}. 삭제 전용 권한을 다시 확인합니다.</p>}
    {pendingDelete && <button type="button" disabled={busy || !pendingDelete.receipt.originalIntent || !port?.reconcileDelete} onClick={() => void reconcileRemoval()}>원래 삭제 요청의 결과 확인</button>}
    {port && !snapshot?.availability.deleteHistory && <p role="status">삭제 전용 소유자 연결이 필요합니다. 읽기 권한으로 삭제하지 않습니다.</p>}
    {visible?.context?.scope.kind === 'organization' && <p>관리자 권한만으로 개인 기록이 표시되지는 않습니다. 조직에 허용된 기록만 이 범위에서 확인합니다.</p>}
    {visible?.unavailable.length ? <p role="status">연결 필요: {visible.unavailable.map(key => unavailableLabels[key]).join(' · ')}</p> : null}
    {!busy && (!visible || visible.status !== 'current') && <p role="status">현재 계정·출처 권한·기록 범위를 확인해야 합니다.</p>}
    {busy && <p role="status">현재 범위를 확인하고 있습니다.</p>}
    {visible?.availability.timeline && groups.size === 0 && <p>이 범위에서 확인할 수 있는 기록이 없습니다.</p>}
    {[...groups].map(([day, entries]) => <section key={day} className="business-history-day" aria-label={day}><h3>{day}</h3><ol>
      {entries.map(entry => <li key={entry.id}><time dateTime={entry.occurredAt}>{new Date(entry.occurredAt).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit' })}</time>
        <article className="business-history-card"><h4>{entry.title}</h4><small>Computer History · {entry.bucket} · revision {entry.revision}</small><p>{entry.summary}</p>
          <ul className="business-app-tags" aria-label="사용한 앱">{entry.applications.map(app => <li key={app}>{app}</li>)}</ul>
          {entry.recommendation && <aside className="business-recommendation"><small>{recommendationLabels[entry.recommendation.kind]} · 허용된 근거 {entry.recommendation.evidenceCount}개</small>
            <strong>{entry.recommendation.title}</strong><p>{entry.recommendation.summary}</p>
            <button type="button" disabled={!current || busy || unsettled || entry.recommendation.status !== 'draft' || !visible?.availability.reviewRecommendation || !port?.reviewRecommendation}
              onClick={() => { if (port?.reviewRecommendation && context && entry.recommendation) void action(() => port.reviewRecommendation!({ context, recommendationId: entry.recommendation!.id, entryId: entry.id, expectedEntryRevision: entry.revision })); }}>원래 One에서 초안 검토</button></aside>}
        </article></li>)}
    </ol></section>)}
    {visible?.availability.evolution && <section aria-label="개선 후보" className="business-candidate-list"><h3>개선 후보</h3>
      {visible.candidates.length === 0 && <p>현재 범위의 개선 후보가 없습니다.</p>}
      {visible.candidates.map(candidate => <article key={candidate.id} className="business-history-card"><h4>{candidate.kind === 'skill' ? '스킬' : candidate.kind === 'toolchain' ? '툴체인' : candidate.kind === 'agent' ? '에이전트' : '업무 개선'} · {candidate.id}</h4>
        <p>{candidateLabels[candidate.status]} · 허용된 관찰 {candidate.observationCount}개 · 후보 revision {candidate.revision}</p><small>변경안 버전 {candidate.proposalVersion ?? '아직 없음'} · 평가 {candidate.evaluation === 'passed' ? '통과' : candidate.evaluation === 'failed' ? '실패' : '확인 필요'}</small>
        <button type="button" disabled={!current || busy || unsettled || !visible.availability.openCandidate || !port?.openCandidate}
          onClick={() => { if (port?.openCandidate && context) void action(() => port.openCandidate!({ context, candidateId: candidate.id, expectedRevision: candidate.revision })); }}>원래 One에서 변경안·실행 확인</button>
      </article>)}
    </section>}
    {context?.target && <button type="button" disabled={!current || busy || unsettled || !visible?.availability.openPage || !port?.openPage}
      onClick={() => { if (port?.openPage && context) void action(() => port.openPage!({ context })); }}>Space {context.target.spaceId} · Page {context.target.pageId} 열기</button>}
    {notice && <p role="status">{notice}</p>}
  </section>;
}
