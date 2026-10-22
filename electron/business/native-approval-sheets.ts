/**
 * Native approval sheets: the Electron `dialog.showMessageBox` options for every company and employee approval.
 *
 * Fixed here, for every sheet: two buttons, the first is Cancel and is both the default and the escape button, the second is the one approval; the type is
 * "question" and links are off. A sheet is wording only. Each caller still binds the response to its own digest, epoch, focused window and expiry, and any
 * response other than the second button is a refusal, so nothing in this file can grant an approval.
 *
 * Wording order, so the eye finds the same things in the same place: `message` says what approving does, in one sentence; `detail` lists who and where as
 * labelled lines, then limits or promises, then, last because it is the longest, the material under review.
 */
import type { CompanyWorkHost } from '../../shared/business/company-work';
import type { EmployeeAgentTransferPackage } from '../../shared/business/employee-agent-transfer';

export interface ApprovalSheet {
  readonly type: 'question';
  readonly title: string;
  readonly message: string;
  readonly detail: string;
  readonly buttons: [string, string];
  readonly defaultId: 0;
  readonly cancelId: 0;
  readonly noLink: true;
}

const sheet = (ko: boolean, o: { title: string; message: string; detail: string; approve: string }): ApprovalSheet =>
  ({ type: 'question', title: o.title, message: o.message, detail: o.detail, buttons: [ko ? '취소' : 'Cancel', o.approve], defaultId: 0, cancelId: 0, noLink: true });
/** `Label: value` lines; a missing value drops its line instead of printing "undefined". */
const lines = (rows: ReadonlyArray<readonly [string, string | number | null | undefined]>) =>
  rows.filter(([, value]) => value !== undefined && value !== null && String(value) !== '').map(([label, value]) => `${label}: ${value}`).join('\n');
const groups = (...parts: ReadonlyArray<string | null | undefined | false>) => parts.filter((part): part is string => !!part).join('\n\n');
const fileBlocks = (files: ReadonlyArray<{ readonly path: string; readonly content: string }>) => files.map(file => `${file.path}\n${file.content}`).join('\n\n');

/** The company window connecting this device to the signed-in company account. */
export function companyDeviceSheet(ko: boolean, session: { readonly organizationId: string; readonly principalId: string; readonly expiresAt: string }): ApprovalSheet {
  return sheet(ko, {
    title: ko ? '회사 기기 연결' : 'Connect company device',
    message: ko ? '이 기기를 현재 회사 계정에 연결합니다.' : 'Connect this device to the current company account.',
    detail: lines(ko
      ? [['조직', session.organizationId], ['직원', session.principalId], ['세션 만료', session.expiresAt]]
      : [['Organization', session.organizationId], ['Employee', session.principalId], ['Session expires', session.expiresAt]]),
    approve: ko ? '이 기기 연결' : 'Connect this device',
  });
}

export interface CompanyProviderSheetInput {
  readonly organizationId: string;
  readonly employeePrincipalId: string;
  readonly agentId: string;
  readonly host: Pick<CompanyWorkHost, 'sourceKind' | 'configurationDigest' | 'credential'> & { readonly runtime: { readonly kind: string; readonly backend?: string; readonly model?: string; readonly source?: string } };
  readonly customEndpoint: string | null;
  readonly limits: { readonly maxRuns: number; readonly maxOutputTokens: number; readonly minutes: number };
}
/** Letting one provider configuration run company work on this device. The company operator separately approves the same configuration. */
export function companyProviderSheet(ko: boolean, c: CompanyProviderSheetInput): ApprovalSheet {
  const { host, limits } = c, subscription = host.runtime.kind === 'claude-code';
  const provider = subscription ? (ko ? 'Claude Code 구독' : 'Claude Code subscription') : host.runtime.backend;
  const provenance = subscription
    ? lines(ko ? [['원본 CLI', host.runtime.source], ['구독·실행 파일 지문', host.configurationDigest]] : [['Original CLI', host.runtime.source], ['Subscription and binary fingerprint', host.configurationDigest]])
    : lines(ko
      ? [['자격 증명 출처', host.sourceKind], ['지문', host.credential?.fingerprint ?? '이 승인 뒤에 원본 제공자 정보를 만듭니다.'], ['OpenAI 호환 엔드포인트', c.customEndpoint]]
      : [['Credential source', host.sourceKind], ['Fingerprint', host.credential?.fingerprint ?? 'Original provider metadata will be created after this approval.'], ['OpenAI-compatible endpoint', c.customEndpoint]]);
  return sheet(ko, {
    title: ko ? '회사 업무 제공자' : 'Company work provider',
    message: ko ? '이 제공자로 이 기기에서 회사 업무를 실행하도록 허용합니다.' : 'Allow this provider to run company work on this device.',
    detail: groups(
      lines(ko ? [['조직', c.organizationId], ['직원', c.employeePrincipalId], ['에이전트', c.agentId]] : [['Organization', c.organizationId], ['Employee', c.employeePrincipalId], ['Agent', c.agentId]]),
      groups(lines(ko ? [['제공자', provider], ['모델', host.runtime.model]] : [['Provider', provider], ['Model', host.runtime.model]]), provenance),
      ko
        ? `한도: 최대 ${limits.maxRuns}회 실행 · 실행당 출력 토큰 ${limits.maxOutputTokens}개 · ${limits.minutes}분\n사용 범위: 회사 메일과 승인된 입력 파일. 출력은 작업별로 크기가 제한된 회사 출력 파일만 만듭니다.`
        : `Limits: up to ${limits.maxRuns} runs · ${limits.maxOutputTokens} output tokens per run · ${limits.minutes} minutes\nScope: Company Mail and approved input files; bounded per-job company output files only.`,
      ko ? '이 구성은 회사 운영자가 따로 승인해야 합니다. 키와 개인 맥락은 공유하지 않습니다.' : 'Your company operator must separately approve this exact configuration. This does not share the key or personal context.',
    ),
    approve: ko ? '이 회사 제공자 허용' : 'Allow this company provider',
  });
}

/** Sending a reviewed package to the company, or installing a received copy: the same facts either way. */
export function transferPackageSheet(ko: boolean, ticket: EmployeeAgentTransferPackage['ticket'], files: ReadonlyArray<{ readonly path: string; readonly content: string }>, direction: 'export' | 'import'): ApprovalSheet {
  const action = ticket.mode === 'clone' ? (ko ? '새 에이전트 복제' : 'Copy to a new agent') : (ko ? '후임자 인계' : 'Hand over to a successor');
  return sheet(ko, {
    title: ko ? (direction === 'export' ? '선택한 회사 에이전트 공유' : '회사 에이전트 사본 설치') : (direction === 'export' ? 'Share selected company agent' : 'Install company agent copy'),
    message: direction === 'export'
      ? (ko ? '아래 자료를 새 에이전트로 전달합니다.' : 'Deliver the files below as a new agent.')
      : (ko ? '아래 자료로 새 에이전트를 이 기기에 설치합니다.' : 'Install a new agent on this device from the files below.'),
    detail: groups(
      lines(ko
        ? [['조직', ticket.organizationId], ['보내는 직원', ticket.source.employeePrincipalId], ['받는 직원', ticket.target.employeePrincipalId], ['동작', action], ['새 에이전트', ticket.target.displayName]]
        : [['Organization', ticket.organizationId], ['From', ticket.source.employeePrincipalId], ['To', ticket.target.employeePrincipalId], ['Action', action], ['New agent', ticket.target.displayName]]),
      ko ? `검토할 자료 (정의·스킬·회사 기억·업무 자료 ${files.length}개)` : `Files to review (definition, skills, company memory, work files: ${files.length})`,
      fileBlocks(files),
    ),
    approve: ko ? '검토한 내용만 승인' : 'Approve reviewed content',
  });
}

/** An employee proposing a new company agent from files they picked. */
export function registerAgentSheet(ko: boolean, agent: { readonly displayName: string; readonly role: string }, files: ReadonlyArray<{ readonly path: string; readonly content: string }>): ApprovalSheet {
  return sheet(ko, {
    title: ko ? '새 회사 에이전트 등록' : 'Register company agent',
    message: ko ? `‘${agent.displayName}’을(를) 회사 에이전트로 등록합니다.` : `Register “${agent.displayName}” as a company agent.`,
    detail: groups(
      lines(ko ? [['이름', agent.displayName], ['역할', agent.role.trim()]] : [['Name', agent.displayName], ['Role', agent.role.trim()]]),
      ko ? `등록할 자료 (${files.length}개)` : `Files to register (${files.length})`,
      fileBlocks(files),
    ),
    approve: ko ? '회사 자료만 등록' : 'Register company files',
  });
}

/** Preparing a personal One agent's definition so the company can transfer it. */
export function prepareDefinitionSheet(ko: boolean, source: { readonly displayName: string }, content: string): ApprovalSheet {
  return sheet(ko, {
    title: ko ? 'One 회사 에이전트 정의 준비' : 'Prepare One company agent definition',
    message: ko ? `‘${source.displayName}’의 정의를 회사가 전달할 수 있게 준비합니다.` : `Prepare the definition of “${source.displayName}” so the company can transfer it.`,
    detail: groups(ko ? '준비할 자료 (1개)' : 'Files to prepare (1)', `AGENT.md\n${content}`),
    approve: ko ? '검토한 정의만 준비' : 'Prepare reviewed definition',
  });
}

/** Preparing selected company files so the company can transfer them. */
export function prepareFilesSheet(ko: boolean, source: { readonly displayName: string }, files: ReadonlyArray<{ readonly path: string; readonly content: string }>): ApprovalSheet {
  return sheet(ko, {
    title: ko ? '회사 에이전트 자료 준비' : 'Prepare company agent files',
    message: ko ? `‘${source.displayName}’의 선택한 자료를 회사가 전달할 수 있게 준비합니다.` : `Prepare the selected files of “${source.displayName}” so the company can transfer them.`,
    detail: groups(ko ? `준비할 자료 (${files.length}개)` : `Files to prepare (${files.length})`, fileBlocks(files)),
    approve: ko ? '선택한 회사 자료만 준비' : 'Prepare selected company files',
  });
}

type WorkReviewKind = 'materialize' | 'oracle' | 'change';
const isRecord = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const isFile = (value: unknown): value is { path: string; content: string } => isRecord(value) && typeof value.path === 'string' && typeof value.content === 'string';
const text = (value: unknown) => typeof value === 'string' ? value : value === undefined || value === null ? '—' : JSON.stringify(value, null, 2);
/**
 * The WORK review used to show the raw JSON of what it approves, with every newline of every file escaped. This renders the same data readably.
 * Nothing is dropped: a field that is not one of the known shapes is printed as indented JSON, and text that is not the expected JSON is shown as is.
 */
export function workReviewDetail(ko: boolean, kind: string, detail: string): string {
  let parsed: unknown;
  try { parsed = JSON.parse(detail); } catch { return detail; }
  if (!isRecord(parsed) || parsed.kind !== kind) return detail;
  const { kind: _kind, ...rest } = parsed;
  const head: Record<WorkReviewKind, [string, string]> = {
    materialize: ['로컬 작업공간에 만들 파일', 'Files to create in the local workspace'], oracle: ['채점 사례', 'Scoring cases'], change: ['파일 변경', 'File changes'],
  };
  const known = (head as Record<string, [string, string] | undefined>)[kind];
  if (!known) return detail;
  const sections: string[] = [];
  for (const [key, value] of Object.entries(rest)) {
    if (key === 'files' && Array.isArray(value) && value.every(isFile)) sections.push(groups(`${known[ko ? 0 : 1]} (${value.length}${ko ? '개' : ''})`, fileBlocks(value)));
    else if (key === 'changes' && Array.isArray(value) && value.every(change => isRecord(change) && typeof change.path === 'string')) {
      sections.push(groups(`${known[ko ? 0 : 1]} (${value.length}${ko ? '개' : ''})`, value.map(change => {
        const c = change as { path: string; before?: unknown; after?: unknown };
        return ko ? `${c.path}\n[이전]\n${text(c.before)}\n[이후]\n${text(c.after)}` : `${c.path}\n[Before]\n${text(c.before)}\n[After]\n${text(c.after)}`;
      }).join('\n\n')));
    } else sections.push(`${key}:\n${text(value)}`);
  }
  return groups(...sections);
}
/** Approving one original WORK scope (materialize, oracle or change). The response is bound by the caller to its exact digest. */
export function workOriginalSheet(ko: boolean, kind: string, detail: string): ApprovalSheet {
  return sheet(ko, {
    title: ko ? 'WORK 원본 승인' : 'Review original WORK',
    message: ko ? '이 원본과 범위만 승인합니다' : 'Approve only this original scope',
    detail: workReviewDetail(ko, kind, detail),
    approve: ko ? '검토한 원본 승인' : 'Approve reviewed original',
  });
}

/** Connecting this device's WORK changes to an organization. Only the connection is approved here; criteria and each change are approved later. */
export function workConnectionSheet(ko: boolean, organizationLabel: string): ApprovalSheet {
  return sheet(ko, {
    title: ko ? '조직 업무 변경 연결' : 'Connect organization WORK changes',
    message: ko ? `${organizationLabel} 조직의 업무 변경을 연결할까요?` : `Connect WORK changes for ${organizationLabel}?`,
    detail: ko
      ? '• 선택한 업무 파일만 별도로 등록합니다.\n• 평가 기준과 각 변경은 다시 검토하고 승인합니다.\n• 기존 보고 공유 동의와 별개입니다.'
      : '• Register only selected WORK files.\n• Review and approve the evaluation criteria and each change separately.\n• This is separate from report sharing.',
    approve: ko ? '연결 승인' : 'Approve connection',
  });
}

/** Sharing a reviewed summary or report with the organization. The title is also the message: it already names the action. */
export function sharingSheet(ko: boolean, title: string, detail: string): ApprovalSheet {
  return sheet(ko, { title, message: title, detail, approve: ko ? '이 내용만 조직에 공유' : 'Share only this with organization' });
}
