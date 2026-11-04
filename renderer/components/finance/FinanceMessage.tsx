import styles from "./FinanceWorkspace.module.css";

/**
 * Plain words for everything Finance can report. A machine code (finance_*), the host's IPC wrapper around it, or a technical error string is never
 * shown as it is: each becomes one sentence that names the cause (a provider, the network, the account, a limit the owner set, a value the owner
 * typed) and, where there is one, what to do. The mobile app has its own copy of the codes it handles; this is the desktop's. (Kept in this file, not in shared/, so the screen's gates can load it with its two imports.)
 */
const hostMessages: Record<string, [string, string]> = {
  finance_monitoring_pro_required: ["예약 모니터링은 Pro 이상에서 사용할 수 있습니다.", "Scheduled monitoring is available on Pro and above."],
  finance_monitoring_access_unavailable: ["이용 권한을 확인하지 못했습니다. 계정 연결을 확인한 뒤 다시 시도하세요.", "Access could not be verified. Check the account connection and try again."],
  finance_evidence_metric_invalid: ["저장 자료 연결 형식이 유효하지 않습니다. 원본 보고서에서 다시 고정하세요.", "The saved-data reference is invalid. Pin it again from the original report."],
  finance_evidence_reference_invalid: ["블록에 연결된 보고서 자료를 찾지 못했습니다. 활성 보고서와 자료 섹션을 확인하세요.", "The report data linked to this block could not be found. Check the active report and data section."],
  finance_evidence_is_referenced: ["대시보드가 이 자료를 사용 중입니다. 연결된 블록을 먼저 제거한 뒤 보고서나 섹션을 보관·제거하세요.", "A dashboard is using this data. Remove its linked blocks before archiving or removing the report or section."],
  finance_source_rate_limited: ["공급자가 호출을 잠시 제한했습니다. 호출 간격과 이용 한도를 확인한 뒤 다시 조회하세요.", "The provider temporarily limited requests. Check request frequency and quota before retrying."],
  finance_source_busy: ["다른 자료를 조회 중입니다. 진행 중인 조회가 끝난 뒤 다시 시도하세요.", "Other source requests are running. Retry after they finish."],
  finance_provider_not_configured: ["가격 공급자 키가 연결되지 않았습니다. 공급자 키를 저장한 뒤 접속 검사를 실행하세요.", "No price-provider key is configured. Save a key, then run the access test."],
  finance_provider_credentials_unavailable: ["키 보관함을 읽지 못했습니다. 앱의 보안 저장소 상태를 확인하세요.", "The credential store could not be read. Check the app's secure storage."],
  finance_provider_limit_or_entitlement: ["공급자가 호출 한도 또는 이용 권한 문제를 반환했습니다. 이용권과 호출 한도를 확인한 뒤 다시 조회하세요.", "The provider returned a request-limit or entitlement response. Check the account plan and quota before retrying."],
  finance_provider_rejected: ["공급자가 접속 검사를 거절했습니다. 저장된 키와 계정 권한을 확인하세요.", "The provider rejected the access test. Check the configured key and account access."],
  finance_source_shape: ["응답에서 필요한 관측 구조를 확인하지 못했습니다. 접속 성공으로 표시하지 않았습니다.", "The required observation structure was not found in the response. Access was not marked verified."],
  finance_connection_failed: ["공급자 접속 검사를 완료하지 못했습니다. 네트워크와 공급자 상태를 확인하세요.", "The provider access test did not finish. Check the network and provider status."],
  finance_monitor_run_receipt_not_recorded: ["브리핑 보고서는 저장됐지만 실행 이력의 최종 기록을 보관하지 못했습니다. 같은 작업을 재실행하기 전에 보고서를 확인하세요.", "The briefing report was saved, but its final run record could not be retained. Inspect the report before repeating the operation."],
  finance_monitor_run_index_pending: ["브리핑 보고서와 실행 원본은 저장됐으며 실행 이력 색인 갱신을 기다리고 있습니다. 보고서는 바로 열 수 있고 이력은 다음 조회에서 복구합니다.", "The briefing and original run record were saved. Run-history indexing is pending; open the report now and refresh history to recover the index."],
  finance_archive_read_only_snapshot: ["읽기 전용 보관 원본입니다. 복원하기 전에는 활성 자료가 바뀌지 않습니다.", "This is a read-only preserved snapshot. Active material changes only after restoration."],
  finance_archive_integrity_failed: ["보관 원본의 무결성을 확인하지 못해 열거나 복원하지 않았습니다.", "The preserved snapshot failed its integrity check and was not opened or restored."],
  finance_archive_not_found: ["연결된 보관 원본을 찾지 못했습니다. 현재 계정과 보관 목록을 확인하세요.", "The preserved snapshot was not found. Check the current account and archive list."],
  finance_archive_report_conflict: ["같은 보고서 식별자에 다른 내용이 있어 복원하지 않았습니다. 현재 보고서를 확인하세요.", "An active report with the same ID has different content. Restoration was stopped."],
  finance_archive_source_conflict: ["같은 출처 식별자의 내용이 달라 복원하지 않았습니다. 활성 출처는 유지됩니다.", "An active source with the same ID has different content. The active source is preserved."],
  finance_archive_source_missing: ["보고서가 참조하는 보관 출처를 확인하지 못해 복원하지 않았습니다.", "A source required by the report could not be verified. Restoration was stopped."],
  finance_archive_cursor_invalid: ["보관 목록의 조회 기준이 유효하지 않습니다. 보관함을 다시 여세요.", "The archive cursor is invalid. Reopen the archive list."],
  finance_archive_conflict: ["보관 원본과 현재 자료가 충돌합니다. 현재 자료는 유지됩니다.", "The preserved snapshot conflicts with current material. Current material is retained."],
  finance_archive_nothing_to_reclaim: ["보관할 보고서나 참조 없는 출처가 없습니다. 현재 참조 중인 자료는 그대로 유지됩니다.", "No selected reports or unused sources can be archived. Referenced material remains active."],
  finance_archive_nothing_to_restore: ["선택한 자료가 이미 활성 목록에 있어 추가로 복원할 항목이 없습니다.", "The selected material is already active; there is nothing additional to restore."],
  finance_archive_sources_still_referenced: ["보고서는 보관했으며, 다른 보고서·보유 자산·가격이 참조하는 출처는 활성 목록에 유지했습니다.", "Reports were archived. Sources referenced by other reports, holdings or prices remain active."],
  finance_archive_catalog_pending: ["보관 목록의 이전 저장을 확인해야 합니다. 활성 자료를 유지했으니 보관함을 다시 열어주세요.", "A previous archive catalog write needs recovery. Active material is preserved; reopen the archive."],
  finance_archive_catalog_invalid: ["보관 목록을 확인하지 못했습니다. 보관 원본은 유지되며 자동으로 지우지 않습니다.", "The archive catalog could not be verified. Preserved originals are retained."],
  finance_history_index_building: ["이전 실행 이력을 준비 중입니다. 잠시 후 이력을 새로고침하세요.", "Previous run history is being indexed. Refresh the ledger shortly."],
  finance_history_recovery_required: ["중단된 이력을 복구 중입니다. 다음 조회에서 진행 상태를 확인하세요.", "Interrupted history is being recovered. Check progress with the next ledger refresh."],
  finance_history_busy: ["다른 작업이 이력을 저장 중입니다. 잠시 후 다시 확인하세요.", "Another operation is saving history. Try the ledger again shortly."],
  finance_history_runtime_unavailable: ["이 앱에서 실행 이력 저장소를 열지 못했습니다. 기존 실행 원본은 유지됩니다.", "The run-history store could not be opened in this app. Original run records are retained."],
  finance_history_cursor_invalid: ["이력 조회 기준이 유효하지 않습니다. 새로고침하여 최신 페이지부터 확인하세요.", "The history cursor is invalid. Refresh to start with the latest page."],
  finance_history_index_invalid: ["실행 이력 색인을 확인하지 못했습니다. 기존 실행 원본을 유지하고 조회를 중단했습니다.", "The history index could not be verified. Original records are preserved and the read was stopped."],
};
const messages: Record<string, string> = {
  "finance_archive_read_only_snapshot": "원본 스냅샷을 읽기 전용으로 열었습니다. 활성 자료는 복원 전까지 바뀌지 않습니다.",
  "finance_archive_integrity_failed": "보관 원본의 무결성을 확인하지 못해 열거나 복원하지 않았습니다.",
  "finance_archive_not_found": "연결된 보관 원본을 찾지 못했습니다. 현재 계정과 보관 목록을 확인하세요.",
  "finance_archive_report_conflict": "같은 보고서 식별자에 다른 활성 내용이 있어 복원하지 않았습니다. 활성 원본과 보관 원본을 확인하세요.",
  "finance_archive_source_conflict": "같은 출처 식별자의 내용이 달라 복원하지 않았습니다. 활성 출처는 유지됩니다.",
  "finance_archive_source_missing": "보고서가 참조하는 보관 출처를 확인하지 못해 복원하지 않았습니다.",
  "finance_archive_cursor_invalid": "보관 목록의 조회 기준이 만료되었거나 유효하지 않습니다. 보관함을 다시 여세요.",
  "finance_archive_conflict": "보관 원본과 현재 자료가 충돌합니다. 자동으로 덮어쓰지 않았습니다.",
  "finance_workspace_capacity_reached": "보고서 또는 출처 저장 한도에 도달했습니다. 보고서나 참조없는 출처를 보관함에 보관한 뒤 다시 실행하세요. 기존 자료는 자동으로 지우지 않습니다.",
  "finance_workspace_too_large": "작업 공간의 저장 크기 한도에 도달했습니다. 필요한 보고서를 내보내고 보관 자료를 정리하세요.",
  "finance_monitor_definition_changed": "조회 중 모니터 질문이나 대상 자산이 바뀌어 이전 조건의 결과를 저장하지 않았습니다. 현재 조건을 확인하고 다시 실행하세요.",
  "finance_monitor_interrupted": "이전 실행이 중단되어 완료 여부를 확인할 수 없습니다. 저장된 자료와 실행 이력을 확인한 뒤 다시 실행하세요.",
  "finance_monitor_removed": "조회 중 모니터가 제거되어 브리핑을 저장하지 않았습니다.",
  "finance_monitor_no_evidence": "사용할 수 있는 근거 자료를 가져오지 못했습니다. 자료 연결 상태를 확인하세요.",
  "finance_account_changed": "계정이나 로그인 세션이 바뀌어 이전 요청을 중단했습니다. 현재 계정에서 다시 실행하세요.",
  "finance_sign_in_required": "Finance 자료를 열려면 Agentlas에 로그인하세요.",
  "User-imported observations only. Check observation dates and missing values before sharing.": "사용자가 가져온 관측 자료입니다. 공유하기 전에 관측일과 누락된 값을 확인하세요.",
  "Observations have different timestamps; see each row.": "관측 시각이 서로 다릅니다. 각 행의 기준 시각을 확인하세요.",
  "No event provider is connected.": "사건 자료 공급자가 연결되지 않았습니다.",
  "TWR/MWR requires dated cash flows and valuation history; a quote snapshot cannot calculate it.": "시간가중·금액가중 수익률에는 날짜별 입출금과 평가 이력이 필요합니다. 가격 관측만으로 계산하지 않습니다.",
  "Range ends at the last imported observation, not current market time. Gaps are not interpolated.": "표시 기간은 마지막으로 가져온 관측일까지입니다. 현재 시장 시각을 뜻하지 않으며 빈 구간은 채우지 않습니다.",
  "Some assets have fewer than two observations; do not infer a trend.": "일부 자산의 관측이 2개 미만입니다. 추세를 판단할 수 없습니다.",
  "Different currencies must use separate series/scales; no implicit FX conversion.": "통화가 다른 자료는 구분해 표시해야 합니다. 자동으로 환산하지 않습니다.",
  "Market value requires an actual price. A total-return index is not a tradable valuation price.": "평가액에는 실제 거래 가격이 필요합니다. 총수익 지수는 평가 가격으로 사용할 수 없습니다.",
  "Values remain in each holding's currency; no implicit FX conversion or cross-currency total.": "금액은 자산별 통화로 표시합니다. 자동 환산하거나 서로 다른 통화의 금액을 합산하지 않습니다.",
  "This is direct holding exposure. ETF look-through and portfolio weights are unavailable without complete compatible holdings and FX data.": "직접 보유 자료입니다. 전체 편입 내역과 환율이 확인되기 전에는 ETF 관통 노출과 포트폴리오 비중을 계산하지 않습니다.",
  "Some holdings have no compatible imported price. Missing values are not zero.": "일부 보유 자산에 통화·기준이 맞는 가격 자료가 없습니다. 누락된 값은 0이 아닙니다.",
  "Some assets have no compatible imported quote. Missing values are not zero.": "일부 자산에 통화·기준이 맞는 가격 관측이 없습니다. 누락된 값은 0이 아닙니다.",
  "Imported snapshots are a table, not a historical time series. No synthetic trend is generated.": "가져온 자료는 개별 관측입니다. 과거 시계열이나 임의의 추세를 만들지 않습니다.",
  "No dated quote snapshots were imported. Market values remain missing.": "날짜가 명시된 가격 관측을 가져오지 않았습니다. 평가액은 미확인 상태로 남습니다.",
  "Import is not committed. Resolve errors before applying these rows.": "아직 가져오지 않았습니다. 오류를 수정한 뒤 적용하세요.",
  "User-provided file; values are not independently verified market data.": "사용자가 제공한 파일입니다. 수치는 독립적으로 검증한 시장 자료가 아닙니다.",
  "CSV is empty.": "CSV 내용이 비어 있습니다.",
  "CSV has headers but no data rows.": "열 이름만 있고 자료 행이 없습니다.",
  "Duplicate CSV columns.": "같은 이름의 CSV 열이 중복되어 있습니다.",
  "Required column: symbol.": "종목 식별자 열(symbol)이 필요합니다.",
  "currency must be an explicit three-letter code": "통화를 3자리 코드로 명시하세요(예: KRW, USD).",
  "duplicate asset row; aggregate explicitly before import": "동일 자산 행이 중복됩니다. 수량과 원가를 확인해 합친 뒤 가져오세요.",
  "quantity is missing, not zero": "수량이 비어 있습니다. 빈 값은 0으로 처리하지 않습니다.",
  "as_of requires an explicit date or timestamp with timezone when price is supplied": "가격이 있으면 관측일(as_of)을 날짜 또는 시간대가 포함된 시각으로 명시하세요.",
  "as_of with timezone is required when price is supplied": "가격이 있으면 시간대를 포함한 관측 시각(as_of)이 필요합니다.",
  "column count mismatch.": "열 이름과 자료 행의 열 개수가 다릅니다.",
  "finance_revision_conflict": "다른 작업에서 자료가 바뀌었습니다. 최신 상태를 다시 열어주세요.",
  "finance_scope_changed": "계정이나 작업 범위가 바뀌어 이전 변경을 중단했습니다.",
  "finance_asset_has_holdings": "보유 자료가 연결된 자산은 제거할 수 없습니다.",
  "finance_asset_is_referenced": "대시보드나 모니터링이 참조하는 자산입니다. 연결을 먼저 해제하세요.",
  "finance_bridge_unavailable": "이 앱의 Finance 저장 연결을 사용할 수 없습니다. 앱 버전과 연결 상태를 확인하세요.",
  "finance_persistence_unavailable": "저장 위치에 연결할 수 없습니다. 변경을 저장하지 않았습니다.",
  "finance_local_save_unconfirmed": "로컬 저장 결과를 확인하지 못했습니다. 저장 상태를 다시 확인하세요.",
  "finance_save_receipt_mismatch": "저장 결과가 요청한 변경과 일치하지 않습니다. 최신 상태를 다시 열어주세요.",
  "finance_monitor_scheduler_unavailable": "모니터링 실행기에 연결되지 않았습니다. 초안은 유지됩니다.",
  "finance_csv_too_large": "CSV 자료가 너무 큽니다. 파일을 나누어 가져오세요.",
  "finance_csv_too_many_rows": "CSV는 한 번에 최대 10,000개 자료 행을 가져올 수 있습니다.",
  "finance_csv_invalid_quote": "CSV 따옴표 형식이 잘못되었습니다.",
  "finance_csv_trailing_quote_data": "CSV의 닫는 따옴표 뒤에 잘못된 내용이 있습니다.",
  "finance_csv_unclosed_quote": "CSV의 따옴표가 닫히지 않았습니다.",
};

/** Codes whose cause and next step are specific enough to say on their own. [ko, en] */
const codeMessages: Record<string, [string, string]> = {
  finance_workspace_capacity_reached: ["보고서 또는 출처가 저장 한도에 도달했습니다. 대시보드에 고정되지 않은 오래된 보고서는 보관함으로 옮길 수 있습니다. 보고서를 보관하거나 내보내고, 고정된 자료는 고정을 해제한 뒤 다시 시도하세요.", "Saved reports or sources reached their limit. Older reports not pinned to a dashboard can be moved to the archive; archive or export some reports, and unpin pinned ones, then try again."],
  finance_workspace_too_large: ["작업 공간의 저장 크기 한도에 도달했습니다. 필요한 보고서를 내보내고 보관 자료를 정리하세요.", "The workspace reached its storage size limit. Export the reports you need and clear archived material."],
  finance_monitor_definition_changed: ["조회 중 모니터 질문이나 대상 자산이 바뀌어 이전 조건의 결과를 저장하지 않았습니다. 현재 조건을 확인하고 다시 실행하세요.", "The monitor's question or assets changed while data was loading, so the older result was not saved. Check the current settings and run it again."],
  finance_monitor_interrupted: ["이전 실행이 중단되어 완료 여부를 확인할 수 없습니다. 저장된 자료와 실행 이력을 확인한 뒤 다시 실행하세요.", "An earlier run was interrupted and its outcome cannot be confirmed. Check the saved data and run history, then run it again."],
  finance_monitor_removed: ["조회 중 모니터가 제거되어 브리핑을 저장하지 않았습니다.", "The monitor was removed while data was loading, so the briefing was not saved."],
  finance_monitor_no_evidence: ["사용할 수 있는 근거 자료를 가져오지 못했습니다. 자료 연결 상태를 확인하세요.", "No usable evidence could be retrieved. Check the data connection."],
  finance_monitor_running: ["이 모니터가 이미 실행 중입니다. 끝난 뒤 실행 이력에서 결과를 확인하세요.", "This monitor is already running. Check its run history when it finishes."],
  finance_monitor_cancelled: ["모니터 실행이 취소되었습니다. 저장된 부분 결과는 실행 이력에 남아 있습니다.", "The monitor run was cancelled. Any partial result is kept in its run history."],
  finance_monitor_failed: ["모니터 실행을 마치지 못했습니다. 실행 이력의 원인과 자료 연결 상태를 확인하세요.", "The monitor run did not finish. Check the cause in its run history and the data connection."],
  finance_monitor_source_changed: ["실행 중에 자료 출처 설정이 바뀌어 결과를 저장하지 않았습니다. 설정을 확인하고 다시 실행하세요.", "The data-source settings changed during the run, so the result was not saved. Check the settings and run it again."],
  finance_monitor_pause_before_edit: ["예약된 모니터는 먼저 일시정지한 뒤 수정할 수 있습니다.", "Pause a scheduled monitor before editing it."],
  finance_monitor_pause_before_remove: ["예약된 모니터는 먼저 일시정지한 뒤 제거할 수 있습니다.", "Pause a scheduled monitor before removing it."],
  finance_monitor_not_found: ["모니터를 찾지 못했습니다. 이미 제거되었을 수 있습니다. 목록을 새로 고치세요.", "The monitor was not found; it may have been removed. Refresh the list."],
  finance_monitoring_sign_in_required: ["예약 모니터링을 쓰려면 Agentlas에 로그인하세요.", "Sign in to Agentlas to use scheduled monitoring."],
  finance_monitoring_disabled: ["예약 모니터링이 꺼져 있습니다. Finance 설정에서 켠 뒤 다시 시도하세요.", "Scheduled monitoring is switched off. Turn it on in Finance settings and try again."],
  finance_account_changed: ["계정이나 로그인 세션이 바뀌어 이전 요청을 중단했습니다. 현재 계정에서 다시 실행하세요.", "The account or sign-in session changed, so the earlier request was stopped. Run it again with the current account."],
  finance_sign_in_required: ["Finance 자료를 열려면 Agentlas에 로그인하세요.", "Sign in to Agentlas to open Finance."],
  finance_account_binding_unavailable: ["로그인 세션을 확인하지 못했습니다. Agentlas에 로그인한 뒤 새 대화에서 다시 시도하세요.", "The signed-in session could not be confirmed. Sign in to Agentlas and try again in a new turn."],
  finance_account_unproven: ["계정을 확인하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요.", "The account could not be verified. Check the internet connection and try again."],
  finance_pairing_changed: ["휴대폰 연결이 바뀌었습니다. 다시 연결한 뒤 시도하세요.", "The phone pairing changed. Reconnect and try again."],
  finance_owner_scope_mismatch: ["이 자료는 다른 계정의 것이라 열지 않았습니다. 올바른 계정으로 로그인하세요.", "This data belongs to a different account and was not opened. Sign in with the right account."],
  finance_scope_changed: ["계정이나 작업 범위가 바뀌어 이전 변경을 중단했습니다. 다시 시도하세요.", "The account or workspace changed, so the earlier change was stopped. Try again."],
  finance_consent_required: ["Finance 안내를 확인하고 동의한 뒤 사용할 수 있습니다. Finance 화면에서 안내를 열어 주세요.", "Review and accept the Finance notice first. Open the notice on the Finance screen."],
  finance_revision_conflict: ["다른 곳(다른 창이나 기기)에서 같은 자료를 바꿔 이 변경을 저장하지 않았습니다. 최신 상태를 다시 열어 같은 작업을 다시 하세요.", "The same data was changed somewhere else (another window or device), so this change was not saved. Reopen the latest state and repeat it."],
  finance_analyst_revision_conflict: ["이 Analyst가 다른 곳에서 수정되었습니다. 최신 내용을 다시 열어 확인하세요.", "This Analyst was edited elsewhere. Reopen it to see the latest version."],
  finance_analyst_capacity_reached: ["저장할 수 있는 Analyst 수(100개)에 도달했습니다. 쓰지 않는 Analyst를 제거한 뒤 저장하세요.", "The limit of 100 saved Analysts was reached. Remove one you do not use, then save."],
  finance_asset_has_holdings: ["보유 자료가 연결된 자산은 제거할 수 없습니다. 보유 내역을 먼저 정리하세요.", "An asset with saved holdings cannot be removed. Remove the holdings first."],
  finance_asset_is_referenced: ["대시보드나 모니터링이 참조하는 자산입니다. 연결을 먼저 해제하세요.", "A dashboard or monitor uses this asset. Unlink it first."],
  finance_asset_not_found: ["선택한 자산을 관심 목록에서 찾지 못했습니다. 자산을 다시 검색해 추가하세요.", "The selected asset is not in your watchlist. Search for it again and add it."],
  finance_asset_selection_required: ["여러 종목이 검색되어 하나를 정하지 못했습니다. 거래소나 티커를 더 정확히 입력하세요.", "More than one asset matched. Give the exchange or the exact ticker."],
  finance_bridge_unavailable: ["이 앱의 Finance 저장 연결을 사용할 수 없습니다. 앱 버전과 연결 상태를 확인하세요.", "This app's Finance storage connection is unavailable. Check the app version and connection."],
  finance_persistence_unavailable: ["저장 위치에 연결할 수 없습니다. 변경을 저장하지 않았습니다.", "The storage location could not be reached. The change was not saved."],
  finance_local_save_unconfirmed: ["로컬 저장 결과를 확인하지 못했습니다. 저장 상태를 다시 확인하세요.", "The local save could not be confirmed. Check the saved state."],
  finance_save_receipt_mismatch: ["저장 결과가 요청한 변경과 일치하지 않습니다. 최신 상태를 다시 열어주세요.", "The saved result did not match the requested change. Reopen the latest state."],
  finance_monitor_scheduler_unavailable: ["모니터링 실행기에 연결되지 않았습니다. 초안은 유지됩니다.", "The monitor scheduler could not be reached. The draft is kept."],
  finance_csv_too_large: ["CSV 자료가 너무 큽니다. 파일을 나누어 가져오세요.", "The CSV is too large. Split the file and import it in parts."],
  finance_csv_too_many_rows: ["CSV는 한 번에 최대 10,000개 자료 행을 가져올 수 있습니다. 파일을 나누어 가져오세요.", "A CSV can hold at most 10,000 data rows per import. Split the file."],
  finance_csv_invalid_quote: ["CSV 따옴표 형식이 잘못되었습니다. 파일을 확인하세요.", "The CSV quoting is malformed. Check the file."],
  finance_csv_trailing_quote_data: ["CSV의 닫는 따옴표 뒤에 잘못된 내용이 있습니다. 파일을 확인하세요.", "There is stray text after a closing quote in the CSV. Check the file."],
  finance_csv_unclosed_quote: ["CSV의 따옴표가 닫히지 않았습니다. 파일을 확인하세요.", "A quote in the CSV is never closed. Check the file."],
  finance_csv_invalid: ["CSV 내용을 읽을 수 없습니다. 열 이름과 값을 확인하세요.", "The CSV could not be read. Check its columns and values."],
  finance_export_file_locked: ["다른 프로그램이 파일을 열고 있어 저장하지 못했습니다. 그 프로그램을 닫고 다시 내보내세요.", "The file is open in another program, so it could not be saved. Close it and export again."],
  finance_export_too_large: ["내보낼 파일이 너무 큽니다. 보고서를 나누어 내보내세요.", "The file to export is too large. Export the reports in parts."],
  finance_export_readback_mismatch: ["저장한 파일을 다시 읽어 확인하지 못했습니다. 저장 위치의 디스크 상태를 확인하고 다시 내보내세요.", "The saved file could not be read back to confirm it. Check the disk at the destination and export again."],
  finance_request_busy: ["같은 종류의 작업이 이미 여러 개 진행 중입니다. 끝난 뒤 다시 시도하세요.", "Several of the same kind of task are already running. Try again when they finish."],
  finance_source_url_rejected: ["허용 목록에 없는 주소라 조회하지 않았습니다. 지원되는 자료 출처를 선택하세요.", "That address is not on the allowed list, so it was not requested. Choose a supported data source."],
  finance_provider_connection_unavailable: ["가격 공급자 연결을 사용할 수 없습니다. 설정에서 공급자 키와 접속 검사를 확인하세요.", "The price-provider connection is unavailable. Check the provider key and access test in settings."],
  finance_cloud_provider_access_denied: ["클라우드 공급자 이용 권한이 없습니다. 계정의 플랜과 로그인 상태를 확인하세요.", "The cloud provider denied access. Check your plan and sign-in."],
  finance_cloud_provider_budget_unavailable: ["클라우드 공급자의 이용 한도를 확인하지 못했습니다. 잠시 후 다시 시도하세요.", "The cloud provider's usage allowance could not be checked. Try again shortly."],
  finance_cloud_provider_outcome_unknown: ["클라우드 공급자 요청의 결과를 확인하지 못했습니다. 같은 요청을 반복하기 전에 결과를 확인하세요.", "The outcome of the cloud-provider request is unknown. Check it before repeating the request."],
  finance_cloud_watchlist_unavailable: ["클라우드에 저장된 관심 목록이 없습니다. 먼저 이 기기의 목록을 올리세요.", "There is no watchlist saved in the cloud. Upload this device's list first."],
  finance_cloud_watchlist_deleted: ["클라우드의 관심 목록이 삭제되어 있습니다. 다시 올려서 만드세요.", "The cloud watchlist was deleted. Upload it again to recreate it."],
  finance_cloud_watchlist_count_limit: ["클라우드가 한 번에 받을 수 있는 관심 종목 수(1,000개)를 넘었습니다. 목록을 줄이세요.", "The cloud accepts at most 1,000 watchlist assets. Shorten the list."],
  finance_cloud_watchlist_size_limit: ["클라우드가 받을 수 있는 관심 목록 크기를 넘었습니다. 목록을 줄이세요.", "The watchlist is larger than the cloud accepts. Shorten it."],
  finance_cloud_watchlist_in_use: ["클라우드 목록에 없는 자산을 이 기기의 보유 내역이나 대시보드가 사용 중이라 교체하지 않았습니다. 그 자산을 클라우드에 올리거나 사용을 먼저 해제하세요.", "The cloud list lacks assets this device's holdings or dashboards still use, so nothing was replaced. Upload those assets first or stop using them."],
  finance_feed_watchlist_required: ["관심 종목을 추가하면 이 피드를 볼 수 있습니다.", "Add assets to your watchlist to see this feed."],
  finance_earnings_no_upcoming_dates: ["예정된 실적 발표일이 공급자에 없습니다.", "The provider lists no upcoming earnings dates."],
  finance_compute_history_too_short: ["가격 이력이 31개 거래일보다 짧아 계산하지 못했습니다. 이력이 더 긴 자산이나 더 긴 기간을 선택하세요.", "The price history is shorter than 31 trading days, so it could not be calculated. Choose an asset with a longer history or a longer period."],
  finance_compute_currency_unknown: ["자산의 통화를 확인하지 못해 계산하지 않았습니다. 통화가 확인된 자산을 선택하세요.", "The asset's currency is unknown, so nothing was calculated. Choose an asset with a confirmed currency."],
  finance_compute_history_unavailable: ["공급자가 가격 이력을 주지 않아 계산하지 못했습니다. 잠시 후 다시 시도하거나 다른 자산을 선택하세요.", "The provider returned no price history, so it could not be calculated. Try again shortly or choose another asset."],
  finance_compute_period_invalid: ["지원하지 않는 기간입니다. 1M, 3M, 1Y, 5Y, all 중에서 고르세요.", "That period is not supported. Choose 1M, 3M, 1Y, 5Y or all."],
  finance_compute_constant_history: ["가격이 거의 변하지 않아 위험을 계산할 수 없습니다. 다른 자산이나 기간을 선택하세요.", "The price barely moves, so risk cannot be calculated. Choose another asset or period."],
  finance_compute_bounds_infeasible: ["지정한 비중 범위로는 합이 1이 되는 배분이 없습니다. 최소·최대 비중을 조정하세요.", "No allocation summing to 1 fits those weight limits. Adjust the minimum and maximum weight."],
  finance_compute_solver_not_converged: ["이 자료로는 배분이 수렴하지 않았습니다. 다른 자산이나 기간을 선택하세요.", "The allocation did not converge on this data. Choose other assets or a different period."],
  finance_arguments_invalid: ["요청 값이 올바르지 않습니다. 입력을 확인한 뒤 다시 시도하세요.", "The request values are not valid. Check the input and try again."],
  finance_operation_failed: ["작업을 마치지 못했습니다. 잠시 후 다시 시도하세요. 계속되면 Finance를 다시 열어 주세요.", "The operation did not finish. Try again shortly; if it keeps happening, reopen Finance."],
  finance_store_unreadable: ["저장된 Finance 자료를 읽지 못했습니다. 저장 위치의 디스크 상태를 확인하세요. 기존 자료는 지우지 않았습니다.", "The saved Finance data could not be read. Check the disk at its location. Nothing was deleted."],
  finance_store_invalid: ["Finance 저장 위치가 올바르지 않습니다. 앱 데이터 폴더의 권한과 상태를 확인하세요.", "The Finance storage location is not valid. Check the app data folder and its permissions."],
  finance_ui_not_presented: ["결과 카드를 표시하지 못했습니다. 대화를 다시 열어 확인하세요.", "The result card could not be shown. Reopen the conversation."],
  finance_data_error: ["공급자가 오류를 반환해 자료를 가져오지 못했습니다. 잠시 후 다시 시도하세요.", "The provider returned an error and no data. Try again shortly."],
  finance_data_unconnected: ["이 자료의 출처가 연결되어 있지 않거나 꺼져 있습니다. Finance 설정에서 출처를 확인하세요.", "The source for this data is not connected or is switched off. Check the sources in Finance settings."],
  finance_manual_asset_identity_unverified: ["직접 입력한 종목은 공급자에서 신원을 확인할 수 없어 시세를 조회하지 않았습니다. 검색으로 찾은 종목을 사용하세요.", "A manually entered asset cannot be identified at a provider, so no price was requested. Use an asset found by search."],
  finance_yahoo_search_latin_script_only: ["이 공급자는 영문 회사명과 티커로만 검색됩니다. 영문 이름이나 티커로 다시 검색하세요.", "This provider searches Latin-script names and tickers only. Search again with the English name or the ticker."],
  finance_yahoo_duplicate_dates_merged: ["공급자가 같은 거래일을 두 번 보낸 곳이 있어 마지막 값만 사용했습니다.", "The provider sent some trading days twice; the last value of each day is used."],
  finance_period_unsupported: ["지원하지 않는 기간입니다. 1M, 3M, 1Y, 5Y, all 중에서 고르세요(뉴스 검색은 1D, 1W, 1M, 3M).", "That period is not supported. Choose 1M, 3M, 1Y, 5Y or all (news search: 1D, 1W, 1M, 3M)."],
  finance_macro_series_unsupported: ["지원하지 않는 거시 지표 코드입니다. 지원 목록에 있는 FRED 코드를 사용하세요.", "That macro series code is not supported. Use a FRED code from the supported list."],
  finance_fx_pair_unsupported: ["지원하지 않는 통화쌍입니다. ECB가 제공하는 통화로 BASE/QUOTE 형식(예: USD/KRW)으로 입력하세요.", "That currency pair is not supported. Enter BASE/QUOTE with ECB currencies, for example USD/KRW."],
  finance_news_search_query_invalid: ["검색어를 입력하세요(문자와 숫자, 어떤 언어든 가능).", "Enter the words to search for (letters and digits, any language)."],
  finance_social_period_invalid: ["지원하지 않는 기간입니다. 1D, 1W, 7d, 1M, 3M, 1Y, 5Y, all 중에서 고르세요.", "That period is not supported. Choose 1D, 1W, 7d, 1M, 3M, 1Y, 5Y or all."],
  finance_plugin_activation_required: ["Finance 도구를 준비해야 합니다. Finance 설정에서 도구 준비를 실행하세요.", "The Finance tools need to be prepared. Run tool preparation in Finance settings."],
  finance_sign_in_or_plan_required: ["로그인과 이용 플랜을 확인하세요.", "Check your sign-in and plan."],
};
/** Cause families, tried in order for any code without its own sentence. [pattern, ko, en] */
const familyMessages: Array<[RegExp, string, string]> = [
  [/sign_in|account_unproven|account_binding|account_changed|pairing_changed|owner_scope|owner_mismatch|owner_required|scope_changed/, "계정 확인이 필요합니다. Agentlas에 로그인했는지 확인하고 다시 시도하세요.", "Account verification is needed. Make sure you are signed in to Agentlas and try again."],
  [/consent/, "Finance 안내를 확인하고 동의한 뒤 사용할 수 있습니다.", "Review and accept the Finance notice first."],
  [/pro_required|plan_required|entitlement/, "이 기능은 이용 중인 플랜에서 쓸 수 없습니다. 플랜을 확인하세요.", "This feature is not part of your current plan. Check your plan."],
  [/plugin_|activation|bundled|manifest/, "Finance 도구를 준비하지 못했습니다. 앱을 다시 시작하거나 Finance 설정에서 도구 준비를 다시 실행하세요.", "The Finance tools could not be prepared. Restart the app or run tool preparation again in Finance settings."],
  [/rate_limited|budget|quota/, "공급자가 호출을 잠시 제한했습니다. 호출 간격과 이용 한도를 확인한 뒤 나중에 다시 조회하세요.", "The provider temporarily limited requests. Check request frequency and quota, then try again later."],
  [/cancel/, "요청이 취소되었습니다.", "The request was cancelled."],
  [/timeout|timed_out/, "공급자 응답이 늦어 조회를 중단했습니다. 잠시 후 다시 시도하세요.", "The provider took too long to answer, so the request was stopped. Try again shortly."],
  [/busy/, "같은 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요.", "The same task is already running. Try again when it finishes."],
  [/too_large|too_many|payload|capacity|_limit$|size/, "크기나 개수 한도를 넘었습니다. 항목을 나누거나 줄인 뒤 다시 시도하세요.", "A size or count limit was exceeded. Split or reduce the items and try again."],
  [/_conflict$|revision|changed$|stale|uncertain/, "다른 곳에서 자료가 바뀌었거나 결과를 확정하지 못했습니다. 최신 상태를 다시 열어 확인한 뒤 다시 시도하세요.", "The data changed elsewhere or the outcome could not be confirmed. Reopen the latest state, check it, and try again."],
  [/not_found|_missing$|no_longer/, "대상을 찾지 못했습니다. 삭제되었거나 계정이 달라졌을 수 있습니다. 목록을 새로 고친 뒤 다시 시도하세요.", "The item was not found; it may have been removed or belong to another account. Refresh the list and try again."],
  [/shape|response_invalid|invalid_response|output_invalid|output_contract|input_contract|identity_mismatch|identity_unverified|identity_unknown|identity_unavailable|type_unknown|schema_unsupported|contract|observation|granularity|listing_mismatch|currency_mismatch|source_invalid|json_output|xml_unsafe|provenance|binding_mismatch|integrity|market_provider_invalid|capability_invalid|projection/, "공급자가 예상과 다른 형식의 자료를 보내 사용하지 않았습니다. 잘못된 값은 저장하지 않았습니다. 잠시 후 다시 시도하세요.", "The provider sent data in an unexpected form, so it was not used and nothing wrong was saved. Try again shortly."],
  [/http_(\d+)|http_error/, "공급자가 오류를 반환했습니다. 잠시 후 다시 시도하세요.", "The provider returned an error. Try again shortly."],
  [/unavailable|failed|connection|outcome_unknown|python|runtime/, "자료 공급자나 로컬 도구에 연결하지 못했습니다. 네트워크와 공급자 상태를 확인한 뒤 다시 시도하세요.", "A data provider or local tool could not be reached. Check the network and provider status, then try again."],
  [/empty|no_records|no_headlines|no_articles|no_upcoming|no_evidence|no_verified|not_available|unconnected|data_error|missing|incomplete|partial|requery|shortfall|nonpositive|zero_total|out_of_range/, "조회되거나 계산할 수 있는 자료가 부족합니다. 종목·기간을 바꾸거나 나중에 다시 시도하세요.", "There is not enough data retrieved or computable. Change the asset or period, or try again later."],
  [/unsupported|disabled|not_model_authorable|not_saveable|read_only|immutable|required_owner|owner_review|owner_action/, "현재 선택한 자료 출처나 설정에서는 지원하지 않는 요청입니다. 설정이나 요청을 바꿔 보세요.", "The current data source or settings do not support this request. Change the settings or the request."],
  [/ambiguous|selection|duplicate/, "대상을 하나로 정하지 못했습니다. 더 구체적으로 지정하세요.", "The target could not be narrowed to one. Be more specific."],
  [/invalid|required|mismatch|period|symbol|query|arguments|operation|method|action|labels|columns|cursor|rows|price_date|input|image|preset|reference|currency|position|batch/, "입력한 값을 사용할 수 없습니다. 입력을 확인한 뒤 다시 시도하세요.", "A value entered could not be used. Check the input and try again."],
  [/store_|private_|file_|path_|storage|persistence|receipt|archive|history|monitor|daily|plan_|portfolio|analyst|work_project|settings|workspace|export|dashboard|widget|artifact|briefing|report|source|feed|world|yahoo|cloud|earnings|fx_|macro|news|social|issuer|adapter|discovery|data_/, "자료를 처리하지 못했습니다. 기존 자료는 지우지 않았습니다. 잠시 후 다시 시도하고, 계속되면 Finance를 다시 열어 주세요.", "The data could not be processed. Existing data was not deleted. Try again shortly; if it keeps happening, reopen Finance."],
];
const GENERIC: [string, string] = ["자료를 처리하지 못했습니다. 잠시 후 다시 시도하세요. 계속되면 Finance를 다시 열어 주세요.", "Something went wrong while handling this. Try again shortly; if it keeps happening, reopen Finance."];
const TECHNICAL = /^\s*[\[{]|"(?:code|path|message)"\s*:|(?:^|\W)(?:[A-Z][A-Za-z]*Error|ECONN\w*|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPERM|EACCES|ENOENT|EBUSY|EEXIST|SQLITE_\w+|ERR_\w+|fetch failed|Unexpected token|Cannot read|is not a function|undefined|\[object)|Error invoking remote method|\bat\s.+:\d+:\d+/;
const CODE = /finance_[a-z0-9_]+/;
/** The sentence for one code, or null when only the closing generic sentence would fit. */
export function financeCodeMessage(code: string, ko: boolean): string | null {
  const index = ko ? 0 : 1;
  const exact = hostMessages[code] ?? codeMessages[code];
  if (exact) return exact[index];
  if (ko && messages[code]) return messages[code];
  const status = /^finance_[a-z_]+_http_(\d{3})$/.exec(code);
  if (status) return ko ? `공급자가 오류(HTTP ${status[1]})를 반환했습니다. 잠시 후 다시 시도하세요.` : `The provider returned an error (HTTP ${status[1]}). Try again shortly.`;
  for (const [pattern, koText, enText] of familyMessages) if (pattern.test(code.slice('finance_'.length))) return ko ? koText : enText;
  return null;
}
export function financeMessage(value: string, ko: boolean): string {
  const index = ko ? 0 : 1;
  // Electron wraps the host's machine code in a fixed IPC envelope; the code can also carry trailing detail or parameters.
  const text = typeof value === 'string' ? value : '';
  if (hostMessages[text]) return hostMessages[text][index];
  const token = CODE.exec(text)?.[0];
  if (token) return financeCodeMessage(token, ko) ?? GENERIC[index];
  if (!text.trim()) return GENERIC[index];
  if (ko && messages[text]) return messages[text];
  if (ko) {
    const row = /^Row (\d+): ([\s\S]+)$/.exec(text);
    if (row) return `${row[1]}행: ${financeMessage(row[2], true)}`;
    const unused = /^Unused columns: (.+)$/.exec(text);
    if (unused) return `사용하지 않는 열: ${unused[1]}`;
    const metric = /^Metric '(.+)' has no connected (historical )?data(?:; only available price snapshots are shown\.)?\.?$/.exec(text);
    if (metric) return `${metric[1]} 지표의 ${metric[2] ? "과거 " : ""}자료가 연결되지 않았습니다.${metric[2] ? "" : " 확인된 가격 관측만 표시합니다."}`;
    const conflict = /^Conflicting sources for (.+) at (.+); selected source (.+)\.$/.exec(text);
    if (conflict) return `${conflict[1]}의 ${conflict[2]} 관측값이 출처마다 다릅니다. 선택한 출처: ${conflict[3]}.`;
    const number = /^(.+) must be a nonnegative decimal without separators$/.exec(text);
    if (number) return `${({ quantity: "수량", price: "가격", average_cost: "평균 원가" } as Record<string,string>)[number[1]] ?? number[1]}은 구분기호 없는 0 이상의 숫자로 입력하세요.`;
  } else {
    const row = /^Row (\d+): ([\s\S]+)$/.exec(text);
    if (row && !TECHNICAL.test(row[2])) return text;
  }
  if (TECHNICAL.test(text)) return GENERIC[index];
  // Korean sentences the app itself wrote are already plain; an English sentence nobody translated is not shown to a Korean reader as it is.
  if (ko) return /[가-힣]/.test(text) ? text : GENERIC[0];
  return text;
}

const statuses: Record<string, string> = { running:"실행 중", succeeded:"완료", failed:"실패", cancelled:"취소됨", unavailable:"실행 불가", invalid_output:"결과 형식 확인 필요", conflict:"변경 충돌", nav:"공식 펀드 NAV", price_history:"과거 가격 · 원시 종가", price:"가격", news:"뉴스", filings:"공시", social:"공식 계정 글", social_search:"SNS 검색", company_facts:"기업 재무 원자료", macro_news:"거시 뉴스", treasury_yields:"국채 수익률", etf_holdings:"ETF 편입", "dashboard.add":"대시보드 추가", "dashboard.update":"대시보드 조건 변경", "dashboard.rename":"대시보드 이름 변경", "dashboard.select":"대시보드 선택", "widget.add":"블록 추가", "widget.update":"블록 설정 변경", "widget.move":"블록 순서 변경", "widget.remove":"블록 제거", "report.add":"보고서 생성", "report.refresh":"새 자료 보고서 버전", "report.update":"보고서 변경", "report.section.update":"보고서 문장·제목 변경", "report.section.move":"보고서 순서 변경", "report.section.remove":"보고서 섹션 제거", "watchlist.add":"관심 자산 추가", "watchlist.remove":"관심 자산 제거", "source.upsert":"출처 기록", "holdings.import":"보유 자료 가져오기", "quotes.import":"가격 관측 추가", "monitor.upsert":"모니터링 조건 저장", "Summary": "핵심 판단", "Sources and limitations": "출처와 한계", ready: "자료 있음", partial: "일부 자료", empty: "자료 없음", unsupported: "미지원", connected: "연결됨", imported: "가져옴", unconnected: "연결 안 됨", error: "오류", draft: "초안", active: "예약 활성", paused: "일시정지", ok: "조회 완료", csv: "CSV 파일", manual: "직접 입력", provider: "공급자 연결", dashboard: "대시보드", watchlist: "자산 찾기", reports: "보고서", sources: "자료와 근거", monitors: "모니터링", "CSV import": "CSV 가져오기" };
export function financeStatus(value: string, ko: boolean): string {
  const known = ko ? statuses[value] : undefined;
  if (known !== undefined) return known;
  // A status that is really a machine code or a technical string never reaches the screen as it is.
  return /finance_|^(?:[A-Z]\w*)?Error\b/.test(value) ? financeMessage(value, ko) : value;
}
export function FinanceMessage({ value, ko, error = false }: { value: string; ko: boolean; error?: boolean }) {
  return <div className={error ? styles.negative : styles.muted}><p>{financeMessage(value, ko)}</p></div>;
}

const columns: Record<string, string> = { "Form": "공시 유형", "Filed": "제출일", "Accession": "접수 번호", "Document": "원문", "Volume": "거래량", "Latest trading day": "최근 거래일", "Title": "제목", "Publisher": "매체", "Published": "발행 시각", "Description": "설명", "Weight": "편입 비중", "Symbol": "티커", "Asset": "자산", "Name": "이름", "Exchange": "거래소", "Currency": "통화", "Price": "가격", "Observed at": "관측 시각", "Source": "출처", "Quantity": "수량", "Average cost": "평균 원가", "Market value": "평가액", "Unrealized P&L": "미실현 손익", "Status": "상태", "Retrieved at": "가져온 시각", "Note": "메모" };
export function financeColumn(value: string, ko: boolean): string { return ko ? columns[value] ?? value : value; }
export function financeCell(value: string | number | null, column: string, ko: boolean): string {
  if (value === null) return "—";
  if (typeof value === "number") return value.toLocaleString(ko ? "ko-KR" : "en-US", { maximumFractionDigits: 6 });
  if (value === "XXX") return ko ? "통화 미확인" : "Currency unknown";
  if (["Status", "Source"].includes(column)) return financeStatus(value, ko);
  return value;
}
