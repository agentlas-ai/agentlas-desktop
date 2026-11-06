import styles from "./FinanceWorkspace.module.css";

/**
 * Plain words for everything Finance can report. A machine code (finance_*), the host's IPC wrapper around it, or a technical error string is never
 * shown as it is: each becomes one sentence that names the cause (a provider, the network, the account, a limit the owner set, a value the owner
 * typed) and, where there is one, what to do. The mobile app has its own copy of the codes it handles; this is the desktop's. (Kept in this file, not in shared/, so the screen's gates can load it with its two imports.)
 */
const hostMessages: Record<string, [string, string]> = {
  finance_monitoring_pro_required: ["예약 모니터링은 Pro 이상에서 사용할 수 있습니다.", "Scheduled monitoring is available on Pro and above."],
  finance_monitoring_access_unavailable: ["이용 권한을 확인하지 못했습니다. 계정 연결을 확인한 뒤 다시 시도하세요.", "Access could not be verified. Check the account connection and try again."],
  finance_daily_registration_timeout: ["백그라운드 서비스가 응답하지 않아 모니터링을 켜지 못했습니다. 설정은 꺼진 상태 그대로입니다. 잠시 후 다시 켜 보세요.", "The background service did not respond, so monitoring could not be turned on. The setting is still off. Try turning it on again in a moment."],
  finance_daily_registration_unconfirmed: ["모니터링 등록을 확인하지 못해 켜지 않았습니다. 설정은 꺼진 상태 그대로입니다. 잠시 후 다시 켜 보세요.", "Monitoring could not be confirmed, so it was not turned on. The setting is still off. Try turning it on again in a moment."],
  finance_daily_registration_invalid: ["모니터링 등록 정보가 올바르지 않아 켜지 못했습니다. 설정은 꺼진 상태 그대로입니다. 다시 켜 보세요.", "The monitoring registration was not valid, so it could not be turned on. The setting is still off. Try turning it on again."],
  finance_evidence_metric_invalid: ["저장된 자료 연결이 올바르지 않습니다. 원본 보고서에서 다시 고정하세요.", "The saved-data link isn't valid. Pin it again from the original report."],
  finance_evidence_reference_invalid: ["블록에 연결된 보고서 자료를 찾지 못했습니다. 사용 중인 보고서와 자료 부분을 확인하세요.", "We couldn't find the report data linked to this block. Check the current report and its data section."],
  finance_evidence_is_referenced: ["대시보드가 이 자료를 사용 중입니다. 연결된 블록을 먼저 제거한 뒤 보고서나 섹션을 보관·제거하세요.", "A dashboard is using this data. Remove its linked blocks before archiving or removing the report or section."],
  finance_source_rate_limited: ["데이터 출처가 요청을 잠시 제한했습니다. 잠시 후 다시 조회하세요.", "The data source is limiting requests for a moment. Try again shortly."],
  finance_source_busy: ["다른 자료를 조회하는 중입니다. 끝난 뒤 다시 시도하세요.", "Other data is still loading. Try again when it finishes."],
  finance_source_timeout: ["데이터 출처가 제때 응답하지 않았습니다. 잠시 후 다시 조회하세요.", "The data source did not answer in time. Try again shortly."],
  finance_provider_not_configured: ["시세를 가져올 데이터 출처가 아직 연결되지 않았습니다. 설정의 데이터 소스를 확인하세요.", "No data source is connected for prices yet. Check Data sources in settings."],
  finance_provider_credentials_unavailable: ["저장된 연결 정보를 읽지 못했습니다. 앱을 다시 시작한 뒤 시도하세요.", "Saved connection details couldn't be read. Restart the app and try again."],
  finance_provider_limit_or_entitlement: ["데이터 출처의 이용 한도나 권한 문제로 가져오지 못했습니다. 이용 중인 플랜을 확인한 뒤 다시 시도하세요.", "The data source reached a usage limit or needs a different plan. Check your plan and try again."],
  finance_provider_rejected: ["데이터 출처가 연결을 거절했습니다. 설정의 데이터 소스를 확인하세요.", "The data source refused the connection. Check Data sources in settings."],
  finance_source_shape: ["받은 자료에서 필요한 내용을 찾지 못했습니다. 연결된 것으로 표시하지 않았습니다.", "The data we received didn't contain what was needed, so it isn't marked as connected."],
  finance_connection_failed: ["데이터 출처에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요.", "Couldn't reach the data source. Check your internet connection and try again."],
  finance_monitor_run_receipt_not_recorded: ["브리핑 보고서는 저장됐지만 실행 기록을 마무리하지 못했습니다. 같은 브리핑을 다시 만들기 전에 보고서를 확인하세요.", "The briefing was saved, but its run history couldn't be finished. Check the report before running it again."],
  finance_monitor_run_index_pending: ["브리핑 보고서와 실행 내용은 저장됐으며 실행 기록 목록을 갱신하는 중입니다. 보고서는 바로 열 수 있고, 목록은 새로고침하면 복구됩니다.", "The briefing was saved and the run history list is still updating. Open the report now; refresh the history to bring the list up to date."],
  finance_archive_read_only_snapshot: ["읽기 전용으로 보관된 사본입니다. 복원하기 전에는 현재 자료가 바뀌지 않습니다.", "This is a read-only archived copy. Your current material doesn't change until you restore it."],
  finance_archive_integrity_failed: ["보관된 사본이 손상되어 열거나 복원하지 않았습니다.", "The archived copy looks damaged, so it was not opened or restored."],
  finance_archive_not_found: ["보관된 사본을 찾지 못했습니다. 현재 계정과 보관함을 확인하세요.", "The archived copy wasn't found. Check the current account and the archive."],
  finance_archive_report_conflict: ["같은 보고서가 이미 다른 내용으로 있어 복원하지 않았습니다. 현재 보고서를 확인하세요.", "A report with the same name already exists with different content, so it was not restored."],
  finance_archive_source_conflict: ["같은 출처가 이미 다른 내용으로 있어 복원하지 않았습니다. 현재 출처는 유지됩니다.", "A source with the same name already exists with different content. The current source is kept."],
  finance_archive_source_missing: ["보고서가 쓰는 보관된 출처를 확인하지 못해 복원하지 않았습니다.", "A source this report relies on couldn't be found, so it was not restored."],
  finance_archive_cursor_invalid: ["보관 목록의 현재 위치를 잃었습니다. 보관함을 다시 여세요.", "The archive list lost its place. Reopen the archive."],
  finance_archive_conflict: ["보관된 사본과 현재 자료가 충돌합니다. 현재 자료는 유지됩니다.", "The archived copy conflicts with current material. Current material is kept."],
  finance_archive_nothing_to_reclaim: ["보관할 보고서나 참조 없는 출처가 없습니다. 현재 참조 중인 자료는 그대로 유지됩니다.", "No selected reports or unused sources can be archived. Referenced material remains active."],
  finance_archive_nothing_to_restore: ["선택한 자료가 이미 활성 목록에 있어 추가로 복원할 항목이 없습니다.", "The selected material is already active; there is nothing additional to restore."],
  finance_archive_sources_still_referenced: ["보고서는 보관했으며, 다른 보고서·보유 자산·가격이 참조하는 출처는 활성 목록에 유지했습니다.", "Reports were archived. Sources referenced by other reports, holdings or prices remain active."],
  finance_archive_catalog_pending: ["보관 목록의 이전 변경을 마무리해야 합니다. 현재 자료는 그대로이니 보관함을 다시 열어 주세요.", "An earlier archive update needs to be finished. Your current material is safe; reopen the archive."],
  finance_archive_catalog_invalid: ["보관 목록을 확인하지 못했습니다. 보관된 사본은 유지되며 자동으로 지우지 않습니다.", "The archive list couldn't be checked. Archived copies are kept and are not deleted automatically."],
  finance_history_index_building: ["이전 실행 기록을 준비하는 중입니다. 잠시 후 새로고침하세요.", "Earlier run history is being prepared. Refresh in a moment."],
  finance_history_recovery_required: ["중단된 기록을 복구하는 중입니다. 잠시 후 새로고침해 확인하세요.", "Interrupted history is being recovered. Refresh in a moment to check."],
  finance_history_busy: ["다른 작업이 기록을 저장 중입니다. 잠시 후 다시 확인하세요.", "Another task is saving history. Check again shortly."],
  finance_history_runtime_unavailable: ["실행 기록을 열지 못했습니다. 기존 기록은 그대로 있습니다.", "Run history couldn't be opened. Existing records are kept."],
  finance_history_cursor_invalid: ["기록 목록의 위치를 잃었습니다. 새로고침해 최신 기록부터 확인하세요.", "The history list lost its place. Refresh to start from the latest."],
  finance_history_index_invalid: ["실행 기록 목록을 확인하지 못했습니다. 기존 기록은 그대로 두고 조회를 멈췄습니다.", "The run history list couldn't be checked. Existing records are kept and loading was stopped."],
};
const messages: Record<string, string> = {
  "finance_archive_read_only_snapshot": "보관된 사본을 읽기 전용으로 열었습니다. 현재 자료는 복원 전까지 바뀌지 않습니다.",
  "finance_archive_integrity_failed": "보관된 사본이 손상되어 열거나 복원하지 않았습니다.",
  "finance_archive_not_found": "보관된 사본을 찾지 못했습니다. 현재 계정과 보관함을 확인하세요.",
  "finance_archive_report_conflict": "같은 보고서가 이미 다른 내용으로 있어 복원하지 않았습니다. 현재 보고서를 확인하세요.",
  "finance_archive_source_conflict": "같은 출처가 이미 다른 내용으로 있어 복원하지 않았습니다. 현재 출처는 유지됩니다.",
  "finance_archive_source_missing": "보고서가 쓰는 보관된 출처를 확인하지 못해 복원하지 않았습니다.",
  "finance_archive_cursor_invalid": "보관 목록의 현재 위치를 잃었습니다. 보관함을 다시 여세요.",
  "finance_archive_conflict": "보관된 사본과 현재 자료가 충돌합니다. 자동으로 덮어쓰지 않았습니다.",
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
  "No event provider is connected.": "이벤트 자료 출처가 연결되지 않았습니다.",
  "TWR/MWR requires dated cash flows and valuation history; a quote snapshot cannot calculate it.": "시간가중·금액가중 수익률에는 날짜별 입출금과 평가 이력이 필요합니다. 가격 관측만으로 계산하지 않습니다.",
  "Range ends at the last imported observation, not current market time. Gaps are not interpolated.": "표시 기간은 마지막으로 가져온 관측일까지입니다. 현재 시장 시각을 뜻하지 않으며 빈 구간은 채우지 않습니다.",
  "Some assets have fewer than two observations; do not infer a trend.": "일부 자산의 관측이 2개 미만입니다. 추세를 판단할 수 없습니다.",
  "Different currencies must use separate series/scales; no implicit FX conversion.": "통화가 다른 자료는 구분해 표시해야 합니다. 자동으로 환산하지 않습니다.",
  "Market value requires an actual price. A total-return index is not a tradable valuation price.": "평가액에는 실제 거래 가격이 필요합니다. 총수익 지수는 평가 가격으로 사용할 수 없습니다.",
  "Values remain in each holding's currency; no implicit FX conversion or cross-currency total.": "금액은 자산별 통화로 표시합니다. 자동 환산하거나 서로 다른 통화의 금액을 합산하지 않습니다.",
  "This is direct holding exposure. ETF look-through and portfolio weights are unavailable without complete compatible holdings and FX data.": "직접 보유 자료입니다. 전체 편입 내역과 환율이 확인되기 전에는 ETF 안의 구성 종목 노출과 포트폴리오 비중을 계산하지 않습니다.",
  "Some holdings have no compatible imported price. Missing values are not zero.": "일부 보유 자산에 통화·기준이 맞는 가격 자료가 없습니다. 누락된 값은 0이 아닙니다.",
  "Some assets have no compatible imported quote. Missing values are not zero.": "일부 자산에 통화·기준이 맞는 가격 관측이 없습니다. 누락된 값은 0이 아닙니다.",
  "Imported snapshots are a table, not a historical time series. No synthetic trend is generated.": "가져온 자료는 개별 관측입니다. 과거 시계열이나 임의의 추세를 만들지 않습니다.",
  "No dated quote snapshots were imported. Market values remain missing.": "날짜가 명시된 가격 관측을 가져오지 않았습니다. 평가액은 미확인 상태로 남습니다.",
  "Import is not committed. Resolve errors before applying these rows.": "아직 가져오지 않았습니다. 오류를 수정한 뒤 적용하세요.",
  "User-provided file; values are not independently verified market data.": "사용자가 제공한 파일입니다. 수치는 독립적으로 검증한 시장 자료가 아닙니다.",
  "CSV is empty.": "CSV 내용이 비어 있습니다.",
  "CSV has headers but no data rows.": "열 이름만 있고 자료 행이 없습니다.",
  "Duplicate CSV columns.": "같은 이름의 CSV 열이 중복되어 있습니다.",
  "Required column: symbol.": "종목 열(symbol)이 필요합니다.",
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
  "finance_bridge_unavailable": "Finance 저장소를 열 수 없습니다. 앱을 다시 시작해 주세요.",
  "finance_persistence_unavailable": "저장 위치에 연결할 수 없습니다. 변경을 저장하지 않았습니다.",
  "finance_local_save_unconfirmed": "로컬 저장 결과를 확인하지 못했습니다. 저장 상태를 다시 확인하세요.",
  "finance_save_receipt_mismatch": "저장 결과가 요청한 변경과 일치하지 않습니다. 최신 상태를 다시 열어주세요.",
  "finance_monitor_scheduler_unavailable": "예약 실행을 시작하지 못했습니다. 초안은 유지됩니다.",
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
  finance_briefing_model_unavailable: ["브리핑을 쓸 AI 모델을 사용할 수 없습니다. 대화 화면의 모델 선택에서 Agentlas 또는 쓸 수 있는 모델을 고른 뒤 다시 실행하세요.", "No AI model was available to write this briefing. Choose Agentlas or another available model in the chat's model picker, then run it again."],
  finance_monitor_asset_not_found: ["이 모니터가 확인할 자산이 없습니다. 관심 자산을 추가하거나 모니터에서 자산을 고른 뒤 다시 실행하세요.", "This monitor has no asset to check. Add an asset to your watchlist, or choose one in the monitor, then run it again."],
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
  finance_consent_required: ["Finance를 시작하려면 Finance 화면에서 '계속'을 눌러 주세요.", "Press Continue on the Finance screen to get started."],
  finance_revision_conflict: ["다른 곳(다른 창이나 기기)에서 같은 자료를 바꿔 이 변경을 저장하지 않았습니다. 최신 상태를 다시 열어 같은 작업을 다시 하세요.", "The same data was changed somewhere else (another window or device), so this change was not saved. Reopen the latest state and repeat it."],
  finance_analyst_revision_conflict: ["이 Analyst가 다른 곳에서 수정되었습니다. 최신 내용을 다시 열어 확인하세요.", "This Analyst was edited elsewhere. Reopen it to see the latest version."],
  finance_analyst_capacity_reached: ["저장할 수 있는 Analyst 수(100개)에 도달했습니다. 쓰지 않는 Analyst를 제거한 뒤 저장하세요.", "The limit of 100 saved Analysts was reached. Remove one you do not use, then save."],
  finance_asset_has_holdings: ["보유 자료가 연결된 자산은 제거할 수 없습니다. 보유 내역을 먼저 정리하세요.", "An asset with saved holdings cannot be removed. Remove the holdings first."],
  finance_asset_is_referenced: ["대시보드나 모니터링이 참조하는 자산입니다. 연결을 먼저 해제하세요.", "A dashboard or monitor uses this asset. Unlink it first."],
  finance_asset_not_found: ["선택한 자산을 관심 목록에서 찾지 못했습니다. 자산을 다시 검색해 추가하세요.", "The selected asset is not in your watchlist. Search for it again and add it."],
  finance_asset_selection_required: ["여러 종목이 검색되어 하나를 정하지 못했습니다. 거래소나 티커를 더 정확히 입력하세요.", "More than one asset matched. Give the exchange or the exact ticker."],
  finance_bridge_unavailable: ["Finance 저장소를 열 수 없습니다. 앱을 다시 시작해 주세요.", "Finance storage couldn't be opened. Restart the app."],
  finance_persistence_unavailable: ["저장 위치에 연결할 수 없습니다. 변경을 저장하지 않았습니다.", "The storage location could not be reached. The change was not saved."],
  finance_local_save_unconfirmed: ["로컬 저장 결과를 확인하지 못했습니다. 저장 상태를 다시 확인하세요.", "The local save could not be confirmed. Check the saved state."],
  finance_save_receipt_mismatch: ["저장 결과가 요청한 변경과 일치하지 않습니다. 최신 상태를 다시 열어주세요.", "The saved result did not match the requested change. Reopen the latest state."],
  finance_monitor_scheduler_unavailable: ["예약 실행을 시작하지 못했습니다. 초안은 유지됩니다.", "Scheduled runs couldn't be started. The draft is kept."],
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
  finance_provider_connection_unavailable: ["데이터 출처를 사용할 수 없습니다. 설정의 데이터 소스를 확인하세요.", "The data source isn't available. Check Data sources in settings."],
  finance_cloud_provider_access_denied: ["클라우드 이용 권한이 없습니다. 플랜과 로그인 상태를 확인하세요.", "Cloud access was denied. Check your plan and sign-in."],
  finance_cloud_provider_budget_unavailable: ["클라우드 이용 한도를 확인하지 못했습니다. 잠시 후 다시 시도하세요.", "The cloud usage allowance couldn't be checked. Try again shortly."],
  finance_cloud_provider_outcome_unknown: ["클라우드 요청의 결과를 확인하지 못했습니다. 같은 요청을 반복하기 전에 결과를 확인하세요.", "The result of the cloud request is unknown. Check it before repeating the request."],
  finance_cloud_watchlist_unavailable: ["클라우드에 저장된 관심 목록이 없습니다. 먼저 이 기기의 목록을 올리세요.", "There is no watchlist saved in the cloud. Upload this device's list first."],
  finance_cloud_watchlist_deleted: ["클라우드의 관심 목록이 삭제되어 있습니다. 다시 올려서 만드세요.", "The cloud watchlist was deleted. Upload it again to recreate it."],
  finance_cloud_watchlist_count_limit: ["클라우드가 한 번에 받을 수 있는 관심 종목 수(1,000개)를 넘었습니다. 목록을 줄이세요.", "The cloud accepts at most 1,000 watchlist assets. Shorten the list."],
  finance_cloud_watchlist_size_limit: ["클라우드가 받을 수 있는 관심 목록 크기를 넘었습니다. 목록을 줄이세요.", "The watchlist is larger than the cloud accepts. Shorten it."],
  finance_cloud_watchlist_in_use: ["클라우드 목록에 없는 자산을 이 기기의 보유 내역이나 대시보드가 사용 중이라 교체하지 않았습니다. 그 자산을 클라우드에 올리거나 사용을 먼저 해제하세요.", "The cloud list lacks assets this device's holdings or dashboards still use, so nothing was replaced. Upload those assets first or stop using them."],
  finance_feed_watchlist_required: ["관심 종목을 추가하면 이 피드를 볼 수 있습니다.", "Add assets to your watchlist to see this feed."],
  finance_earnings_no_upcoming_dates: ["예정된 실적 발표일이 아직 없습니다.", "No upcoming earnings dates are listed."],
  finance_compute_history_too_short: ["가격 이력이 31개 거래일보다 짧아 계산하지 못했습니다. 이력이 더 긴 자산이나 더 긴 기간을 선택하세요.", "The price history is shorter than 31 trading days, so it could not be calculated. Choose an asset with a longer history or a longer period."],
  finance_compute_currency_unknown: ["자산의 통화를 확인하지 못해 계산하지 않았습니다. 통화가 확인된 자산을 선택하세요.", "The asset's currency is unknown, so nothing was calculated. Choose an asset with a confirmed currency."],
  finance_compute_history_unavailable: ["가격 이력을 받지 못해 계산하지 못했습니다. 잠시 후 다시 시도하거나 다른 자산을 선택하세요.", "No price history was available, so it couldn't be calculated. Try again shortly or choose another asset."],
  finance_compute_period_invalid: ["지원하지 않는 기간입니다. 1M, 3M, 1Y, 5Y, all 중에서 고르세요.", "That period is not supported. Choose 1M, 3M, 1Y, 5Y or all."],
  finance_compute_constant_history: ["가격이 거의 변하지 않아 위험을 계산할 수 없습니다. 다른 자산이나 기간을 선택하세요.", "The price barely moves, so risk cannot be calculated. Choose another asset or period."],
  finance_compute_bounds_infeasible: ["지정한 비중 범위로는 합이 1이 되는 배분이 없습니다. 최소·최대 비중을 조정하세요.", "No allocation summing to 1 fits those weight limits. Adjust the minimum and maximum weight."],
  finance_compute_solver_not_converged: ["이 자료로는 비중을 계산하지 못했습니다. 다른 자산이나 기간을 선택하세요.", "An allocation couldn't be worked out from this data. Choose other assets or a different period."],
  finance_arguments_invalid: ["요청 값이 올바르지 않습니다. 입력을 확인한 뒤 다시 시도하세요.", "The request values are not valid. Check the input and try again."],
  finance_operation_failed: ["작업을 마치지 못했습니다. 잠시 후 다시 시도하세요. 계속되면 Finance를 다시 열어 주세요.", "The task did not finish. Try again shortly; if it keeps happening, reopen Finance."],
  finance_store_unreadable: ["저장된 Finance 자료를 읽지 못했습니다. 저장 위치의 디스크 상태를 확인하세요. 기존 자료는 지우지 않았습니다.", "The saved Finance data could not be read. Check the disk at its location. Nothing was deleted."],
  finance_store_invalid: ["Finance가 자료를 저장할 위치를 사용할 수 없습니다. 앱을 다시 시작해 주세요.", "Finance can't use its storage location. Restart the app."],
  finance_ui_not_presented: ["결과 카드를 표시하지 못했습니다. 대화를 다시 열어 확인하세요.", "The result card could not be shown. Reopen the conversation."],
  finance_card_chart_from_reads: ["카드의 차트는 이번 답에서 조회한 자료로 그렸습니다.", "The card's chart shows the data read for this answer."],
  finance_card_fitted_to_guide: ["카드는 이 주제의 기본 구성으로 정리했고, 빠진 내용은 답변에 담았습니다.", "The card uses this topic's standard layout; anything it left out is in the answer."],
  finance_card_not_guide_layout: ["카드는 이번 답에 맞춰 구성했습니다.", "This card is arranged for this answer."],
  finance_card_without_guide: ["카드는 이번 답에 맞춰 구성했습니다.", "This card is arranged for this answer."],
  finance_card_guide_chosen: ["카드는 이번 답에 맞는 주제의 기본 구성으로 만들었습니다.", "The card uses the standard layout of the topic that fits this answer."],
  finance_price_from_saved_quote: ["지금은 실시간 시세를 읽지 못해 마지막으로 저장된 시세를 보여 드립니다. 관측 시각을 확인하세요.", "The live price could not be read, so this is the last saved price. Check the time it was observed."],
  finance_monitor_sources_unavailable: ["데이터 출처가 일시적으로 응답하지 않아 이번 브리핑 조회를 마치지 못했습니다. 잠시 뒤 같은 지점부터 다시 시도합니다.", "The data sources are temporarily unavailable, so this briefing could not read its data. It will try again shortly from the same point."],
  finance_news_search_fallback: ["뉴스 색인이 응답하지 않아 Yahoo Finance 키워드 뉴스를 대신 보여 드립니다. 영어 기사가 많고 기간은 적용되지 않았습니다.", "The news index did not answer, so these are Yahoo Finance keyword headlines instead. They are mostly English and the period was not applied."],
  finance_treasury_previous_month: ["이번 달 금리 자료가 아직 없어 지난달의 실제 관측값을 보여 드립니다. 관측일을 확인하세요.", "This month has no yield observations yet, so these are last month's real observations. Check the observation dates."],
  finance_data_error: ["데이터 출처에서 자료를 받지 못했습니다. 잠시 후 다시 시도하세요.", "The data source didn't return any data. Try again shortly."],
  finance_data_unconnected: ["이 자료의 출처가 연결되어 있지 않거나 꺼져 있습니다. 설정의 데이터 소스를 확인하세요.", "The source for this data is not connected or is switched off. Check Data sources in settings."],
  finance_manual_asset_identity_unverified: ["직접 입력한 종목은 데이터 출처에서 확인할 수 없어 시세를 조회하지 않았습니다. 검색으로 찾은 종목을 사용하세요.", "A manually entered asset can't be identified at a data source, so no price was requested. Use an asset found by search."],
  finance_yahoo_search_latin_script_only: ["이 데이터 출처는 영문 회사명과 티커로만 검색됩니다. 영문 이름이나 티커로 다시 검색하세요.", "This data source searches English names and tickers only. Search again with the English name or the ticker."],
  finance_yahoo_duplicate_dates_merged: ["데이터 출처가 같은 거래일을 두 번 보낸 곳이 있어 마지막 값만 사용했습니다.", "The data source sent some trading days twice; the last value of each day is used."],
  finance_period_unsupported: ["지원하지 않는 기간입니다. 1M, 3M, 1Y, 5Y, all 중에서 고르세요(뉴스 검색은 1D, 1W, 1M, 3M).", "That period is not supported. Choose 1M, 3M, 1Y, 5Y or all (news search: 1D, 1W, 1M, 3M)."],
  finance_macro_series_unsupported: ["지원하지 않는 경제 지표입니다. 지원 목록에 있는 지표를 사용하세요.", "That economic series isn't supported. Use one from the supported list."],
  finance_fx_pair_unsupported: ["지원하지 않는 통화쌍입니다. USD/KRW 같은 형식으로 입력하세요.", "That currency pair isn't supported. Enter it like USD/KRW."],
  finance_news_search_query_invalid: ["검색어를 입력하세요(문자와 숫자, 어떤 언어든 가능).", "Enter the words to search for (letters and digits, any language)."],
  finance_social_period_invalid: ["지원하지 않는 기간입니다. 1D, 1W, 7d, 1M, 3M, 1Y, 5Y, all 중에서 고르세요.", "That period is not supported. Choose 1D, 1W, 7d, 1M, 3M, 1Y, 5Y or all."],
  finance_portfolio_extraction_unavailable: ["AI가 이 자료에서 보유 내역을 읽어내지 못했습니다. AI 연결과 로그인 상태를 확인하고 다시 시도하거나 직접 입력하세요.", "The AI couldn't read any holdings from this. Check that an AI is connected and signed in, then try again or type them in."],
  finance_portfolio_input_empty: ["사진을 첨부하거나 보유 내역 텍스트를 붙여 넣은 뒤 읽기를 누르세요.", "Attach a photo or paste your holdings text, then press Extract."],
  finance_portfolio_image_size: ["사진이 너무 큽니다. 한 장당 5MB, 합계 12MB 이하로 선택하세요.", "A photo is too large. Keep each under 5MB and the total under 12MB."],
  finance_portfolio_image_type: ["PNG, JPG, WebP 사진만 사용할 수 있습니다.", "Only PNG, JPG or WebP photos can be used."],
  finance_portfolio_review_required: ["종목, 통화, 수량이 빠진 행이 있습니다. 모두 채운 뒤 저장하세요.", "Some rows are missing a symbol, currency or quantity. Fill them in, then save."],
  finance_portfolio_price_date_required: ["가격을 입력한 행에는 기준 날짜(YYYY-MM-DD)도 입력하세요.", "A row with a price also needs its date (YYYY-MM-DD)."],
  finance_portfolio_duplicate_asset: ["같은 종목이 두 번 들어 있습니다. 한 행으로 합친 뒤 저장하세요.", "The same asset appears twice. Combine it into one row, then save."],
  finance_portfolio_duplicate_row: ["같은 행이 중복되었습니다. 다시 읽어 보세요.", "A row is duplicated. Try reading it again."],
  finance_plugin_activation_required: ["Finance를 시작하지 못했습니다. 다시 시도하세요.", "Couldn't start Finance. Try again."],
  finance_sign_in_or_plan_required: ["로그인과 이용 플랜을 확인하세요.", "Check your sign-in and plan."],
};
/** Cause families, tried in order for any code without its own sentence. [pattern, ko, en] */
const familyMessages: Array<[RegExp, string, string]> = [
  [/sign_in|account_unproven|account_binding|account_changed|pairing_changed|owner_scope|owner_mismatch|owner_required|scope_changed/, "계정 확인이 필요합니다. Agentlas에 로그인했는지 확인하고 다시 시도하세요.", "Account verification is needed. Make sure you are signed in to Agentlas and try again."],
  [/consent/, "Finance를 시작하려면 '계속'을 눌러 주세요.", "Press Continue to get started with Finance."],
  [/pro_required|plan_required|entitlement/, "이 기능은 이용 중인 플랜에서 쓸 수 없습니다. 플랜을 확인하세요.", "This feature is not part of your current plan. Check your plan."],
  [/plugin_|activation|bundled|manifest/, "Finance를 시작하지 못했습니다. 다시 시도하세요.", "Couldn't start Finance. Try again."],
  [/rate_limited|budget|quota/, "데이터 출처가 요청을 잠시 제한했습니다. 잠시 후 다시 조회하세요.", "The data source is limiting requests for a moment. Try again shortly."],
  [/cancel/, "요청이 취소되었습니다.", "The request was cancelled."],
  [/timeout|timed_out/, "데이터 출처의 응답이 늦어 조회를 멈췄습니다. 잠시 후 다시 시도하세요.", "The data source took too long to answer, so the request was stopped. Try again shortly."],
  [/busy/, "같은 작업이 진행 중입니다. 끝난 뒤 다시 시도하세요.", "The same task is already running. Try again when it finishes."],
  [/too_large|too_many|payload|capacity|_limit$|size/, "크기나 개수 한도를 넘었습니다. 항목을 나누거나 줄인 뒤 다시 시도하세요.", "A size or count limit was exceeded. Split or reduce the items and try again."],
  [/_conflict$|revision|changed$|stale|uncertain/, "다른 곳에서 자료가 바뀌었거나 결과를 확정하지 못했습니다. 최신 상태를 다시 열어 확인한 뒤 다시 시도하세요.", "The data changed elsewhere or the outcome could not be confirmed. Reopen the latest state, check it, and try again."],
  [/not_found|_missing$|no_longer/, "대상을 찾지 못했습니다. 삭제되었거나 계정이 달라졌을 수 있습니다. 목록을 새로 고친 뒤 다시 시도하세요.", "The item was not found; it may have been removed or belong to another account. Refresh the list and try again."],
  [/shape|response_invalid|invalid_response|output_invalid|output_contract|input_contract|identity_mismatch|identity_unverified|identity_unknown|identity_unavailable|type_unknown|schema_unsupported|contract|observation|granularity|listing_mismatch|currency_mismatch|source_invalid|json_output|xml_unsafe|provenance|binding_mismatch|integrity|market_provider_invalid|capability_invalid|projection/, "데이터 출처가 예상과 다른 자료를 보내 사용하지 않았습니다. 잘못된 값은 저장하지 않았습니다. 잠시 후 다시 시도하세요.", "The data source sent something unexpected, so it was not used and nothing wrong was saved. Try again shortly."],
  [/http_(\d+)|http_error/, "데이터 출처가 오류를 반환했습니다. 잠시 후 다시 시도하세요.", "The data source returned an error. Try again shortly."],
  [/unavailable|failed|connection|outcome_unknown|python|runtime/, "데이터 출처에 연결하지 못했습니다. 인터넷 연결을 확인한 뒤 다시 시도하세요.", "Couldn't reach the data source. Check your internet connection and try again."],
  [/empty|no_records|no_headlines|no_articles|no_upcoming|no_evidence|no_verified|not_available|unconnected|data_error|missing|incomplete|partial|requery|shortfall|nonpositive|zero_total|out_of_range/, "조회되거나 계산할 수 있는 자료가 부족합니다. 종목·기간을 바꾸거나 나중에 다시 시도하세요.", "There is not enough data retrieved or computable. Change the asset or period, or try again later."],
  [/unsupported|disabled|not_model_authorable|not_saveable|read_only|immutable|required_owner|owner_review|owner_action/, "현재 선택한 자료 출처나 설정에서는 지원하지 않는 요청입니다. 설정이나 요청을 바꿔 보세요.", "The current data source or settings do not support this request. Change the settings or the request."],
  [/ambiguous|selection|duplicate/, "대상을 하나로 정하지 못했습니다. 더 구체적으로 지정하세요.", "The target could not be narrowed to one. Be more specific."],
  [/invalid|required|mismatch|period|symbol|query|arguments|operation|method|action|labels|columns|cursor|rows|price_date|input|image|preset|reference|currency|position|batch/, "입력한 값을 사용할 수 없습니다. 입력을 확인한 뒤 다시 시도하세요.", "A value entered could not be used. Check the input and try again."],
  [/store_|private_|file_|path_|storage|persistence|receipt|archive|history|monitor|daily|plan_|portfolio|analyst|work_project|settings|workspace|export|dashboard|widget|artifact|briefing|report|source|feed|world|yahoo|cloud|earnings|fx_|macro|news|social|issuer|adapter|discovery|data_/, "자료를 처리하지 못했습니다. 기존 자료는 지우지 않았습니다. 잠시 후 다시 시도하고, 계속되면 Finance를 다시 열어 주세요.", "The data could not be processed. Existing data was not deleted. Try again shortly; if it keeps happening, reopen Finance."],
];
/** Plain English for the sentences the host writes in English (the Korean side is `messages`). Keyed by the exact host sentence. */
const messagesEn: Record<string, string> = {
  "User-imported observations only. Check observation dates and missing values before sharing.": "These are values you imported. Check their dates and any missing values before sharing.",
  "Observations have different timestamps; see each row.": "The values are from different times. See the time on each row.",
  "No event provider is connected.": "No source for events is connected. Connect one under Data sources in settings.",
  "TWR/MWR requires dated cash flows and valuation history; a quote snapshot cannot calculate it.": "Time-weighted and money-weighted returns need dated deposits and withdrawals plus a value history. Prices alone can't produce them.",
  "Range ends at the last imported observation, not current market time. Gaps are not interpolated.": "The range ends at the last imported value, not at today's market. Gaps are not filled in.",
  "Some assets have fewer than two observations; do not infer a trend.": "Some assets have fewer than two values, so no trend can be drawn.",
  "Different currencies must use separate series/scales; no implicit FX conversion.": "Assets in different currencies are shown separately and are not converted.",
  "Market value requires an actual price. A total-return index is not a tradable valuation price.": "Market value needs a real price. A total-return index isn't a price you can trade at.",
  "Values remain in each holding's currency; no implicit FX conversion or cross-currency total.": "Amounts stay in each holding's own currency. They are not converted or added across currencies.",
  "This is direct holding exposure. ETF look-through and portfolio weights are unavailable without complete compatible holdings and FX data.": "This shows only what you hold directly. What is inside ETFs, and portfolio weights, need full holdings and exchange-rate data.",
  "Some holdings have no compatible imported price. Missing values are not zero.": "Some holdings have no matching price, so their value is left blank, not counted as zero.",
  "Some assets have no compatible imported quote. Missing values are not zero.": "Some assets have no matching price, so their value is left blank, not counted as zero.",
  "Imported snapshots are a table, not a historical time series. No synthetic trend is generated.": "Imported values are single readings, not a price history. No trend is drawn.",
  "No dated quote snapshots were imported. Market values remain missing.": "No prices with dates were imported, so market values stay blank.",
  "Import is not committed. Resolve errors before applying these rows.": "Nothing is imported yet. Fix the errors, then apply the rows.",
  "User-provided file; values are not independently verified market data.": "This is your own file; its values haven't been checked against market data.",
  "CSV is empty.": "The CSV is empty.",
  "CSV has headers but no data rows.": "The CSV has column names but no rows.",
  "Duplicate CSV columns.": "Two columns have the same name.",
  "Required column: symbol.": "A symbol column is required.",
  "currency must be an explicit three-letter code": "Enter the currency as a three-letter code, such as USD or KRW.",
  "duplicate asset row; aggregate explicitly before import": "This asset appears twice. Combine the rows before importing.",
  "quantity is missing, not zero": "The quantity is empty. An empty value is not treated as zero.",
  "as_of requires an explicit date or timestamp with timezone when price is supplied": "A row with a price needs its date (YYYY-MM-DD) or a time with its time zone.",
  "as_of with timezone is required when price is supplied": "A row with a price needs its date (YYYY-MM-DD) or a time with its time zone.",
  "column count mismatch.": "A row has a different number of columns than the header.",
};
/** Provider caveats are written for the model. A reader gets the plain gist of each, in both languages: [pattern, ko, en]. */
const noteFamilies: Array<[RegExp, string, string]> = [
  [/redistribut|licen[sc]e|rights|attribution|personal use|terms apply/i, "개인 용도로만 사용하고 다시 배포하지 마세요. 출처를 밝혀야 합니다.", "For personal use only; don't redistribute it. Credit the source."],
  [/not verified|unverified|not guaranteed|claims|relevance|identity|not independent|not corroborat/i, "내용의 정확성과 관련성이 확인되지 않았습니다. 출처를 직접 확인하세요.", "Accuracy and relevance aren't verified. Check the source yourself."],
  [/latest \d+|first \d+|at most|truncated|limited to|not exhausted|pagination|bounded|row limit|coverage is/i, "최근 항목 위주로 일부만 가져왔습니다. 전체가 아닐 수 있습니다.", "Only the most recent items were fetched, so this may not be everything."],
  [/period is not enforced|point-in-time|vintage|revis|can change/i, "요청한 기간이 그대로 적용되지 않았거나 나중에 수정될 수 있습니다.", "The period asked for may not be applied exactly, and values can be revised later."],
  [/interpolat|not filled|left out|omitted|skipped|substituted|no missing|missing|unknown|unavailable|not (?:estimated|imported)/i, "일부 값이 없어 채우지 않고 비워 두었습니다.", "Some values were missing and are left blank, not filled in."],
  [/currency|unit|fx|conversion/i, "통화나 단위가 확인되지 않은 값은 환산하지 않았습니다.", "Values with an unknown currency or unit were not converted."],
];
/** One caveat line for a reader: a machine code (optionally after "SYMBOL: "), a known host sentence, or a provider caveat in plain words. */
export function financeNote(value: string, ko: boolean): string {
  const text = (typeof value === "string" ? value : "").trim();
  if (!text) return "";
  const prefixed = /^([^:\s][^:]{0,40}): (finance_[a-z0-9_]+)(?:: .*)?$/.exec(text);
  if (prefixed) return `${prefixed[1]}: ${financeCodeMessage(prefixed[2], ko) ?? GENERIC[ko ? 0 : 1]}`;
  if (CODE.test(text)) return financeMessage(text, ko);
  if (hostMessages[text] || messages[text] || messagesEn[text]) return financeMessage(text, ko);
  if (/[가-힣]/.test(text)) return text;
  for (const [pattern, koText, enText] of noteFamilies) if (pattern.test(text)) return ko ? koText : enText;
  return ko ? "이 자료에는 확인이 필요한 한계가 있습니다." : TECHNICAL.test(text) ? "This data has limits worth checking." : text;
}
const GENERIC: [string, string] = ["자료를 처리하지 못했습니다. 잠시 후 다시 시도하세요. 계속되면 Finance를 다시 열어 주세요.", "Something went wrong while handling this. Try again shortly; if it keeps happening, reopen Finance."];
const TECHNICAL = /^\s*[\[{]|"(?:code|path|message)"\s*:|(?:^|\W)(?:[A-Z][A-Za-z]*Error|ECONN\w*|ENOTFOUND|ETIMEDOUT|EAI_AGAIN|EPERM|EACCES|ENOENT|EBUSY|EEXIST|SQLITE_\w+|ERR_\w+|fetch failed|Unexpected token|Cannot read|is not a function|undefined|\[object)|Error invoking remote method|\bat\s.+:\d+:\d+/;
const CODE = /finance_[a-z0-9_]+/;
/** The sentence for one code, or null when only the closing generic sentence would fit. */
export function financeCodeMessage(code: string, ko: boolean): string | null {
  const index = ko ? 0 : 1;
  const exact = hostMessages[code] ?? codeMessages[code];
  if (exact) return exact[index];
  if (ko && messages[code]) return messages[code];
  const status = /^finance_[a-z_]+_http_\d{3}$/.test(code);
  if (status) return ko ? "데이터 출처가 오류를 반환했습니다. 잠시 후 다시 시도하세요." : "The data source returned an error. Try again shortly.";
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
    if (row && !TECHNICAL.test(row[2])) return `Row ${row[1]}: ${financeMessage(row[2], false)}`;
    if (messagesEn[text]) return messagesEn[text];
    const unused = /^Unused columns: (.+)$/.exec(text);
    if (unused) return `Columns not used: ${unused[1]}`;
    const metric = /^Metric '(.+)' has no connected (historical )?data(?:; only available price snapshots are shown\.)?\.?$/.exec(text);
    if (metric) return `No ${metric[2] ? "history" : "data"} is connected for ${metric[1]}.${metric[2] ? "" : " Only the prices that were read are shown."}`;
    const conflict = /^Conflicting sources for (.+) at (.+); selected source (.+)\.$/.exec(text);
    if (conflict) return `Sources disagree on ${conflict[1]} at ${conflict[2]}. Using ${conflict[3]}.`;
  }
  if (TECHNICAL.test(text)) return GENERIC[index];
  // Korean sentences the app itself wrote are already plain; an English sentence nobody translated is not shown to a Korean reader as it is.
  if (ko) return /[가-힣]/.test(text) ? text : GENERIC[0];
  return text;
}

const statuses: Record<string, string> = { running:"실행 중", succeeded:"완료", failed:"실패", cancelled:"취소됨", unavailable:"실행 불가", invalid_output:"결과 형식 확인 필요", conflict:"변경 충돌", nav:"공식 펀드 NAV", price_history:"과거 가격 · 원시 종가", price:"가격", news:"뉴스", filings:"공시", social:"공식 계정 글", social_search:"SNS 검색", company_facts:"기업 재무 원자료", macro_news:"거시 뉴스", treasury_yields:"국채 수익률", etf_holdings:"ETF 편입", "dashboard.add":"대시보드 추가", "dashboard.update":"대시보드 조건 변경", "dashboard.rename":"대시보드 이름 변경", "dashboard.select":"대시보드 선택", "widget.add":"블록 추가", "widget.update":"블록 설정 변경", "widget.move":"블록 순서 변경", "widget.remove":"블록 제거", "report.add":"보고서 생성", "report.refresh":"새 자료 보고서 버전", "report.update":"보고서 변경", "report.section.update":"보고서 문장·제목 변경", "report.section.move":"보고서 순서 변경", "report.section.remove":"보고서 섹션 제거", "watchlist.add":"관심 자산 추가", "watchlist.remove":"관심 자산 제거", "source.upsert":"출처 기록", "holdings.import":"보유 자료 가져오기", "quotes.import":"가격 관측 추가", "monitor.upsert":"모니터링 조건 저장", "Summary": "핵심 판단", "Sources and limitations": "출처와 한계", ready: "자료 있음", partial: "일부 자료", empty: "자료 없음", unsupported: "미지원", connected: "연결됨", imported: "가져옴", unconnected: "연결 안 됨", error: "오류", draft: "초안", active: "예약 활성", paused: "일시정지", ok: "조회 완료", csv: "CSV 파일", manual: "직접 입력", provider: "데이터 출처 연결", dashboard: "대시보드", watchlist: "자산 찾기", reports: "보고서", sources: "자료와 근거", monitors: "모니터링", "CSV import": "CSV 가져오기" };
export function financeStatus(value: string, ko: boolean): string {
  const known = ko ? statuses[value] : undefined;
  if (known !== undefined) return known;
  // A status that is really a machine code or a technical string never reaches the screen as it is.
  return /finance_|^(?:[A-Z]\w*)?Error\b/.test(value) ? financeMessage(value, ko) : value;
}
/** Text the host saved into a report or run in Korean only (section titles, fixed notes, progress lines): shown in the reader's language. Anything else a person or the model wrote is left exactly as saved. */
const storedText: Array<[string, string]> = [
  ["조회 자료", "Retrieved data"], ["원출처와 조회 시각", "Original sources and retrieval times"], ["Finance 자료", "Finance data"], ["조회 범위", "Coverage"], ["자료 조회 중", "Fetching data"],
  ["조회 시점의 고정 자료입니다. 출처의 보도·게시·거래 기준과 커버리지 한계를 확인하세요.", "Data frozen at the time it was fetched. Check the source's reporting basis and its coverage limits."],
  ["각 항목의 실제 조회 상태입니다. 자료 없음이나 부분 조회는 분석 완료를 뜻하지 않습니다.", "The actual fetch status of each item. Missing or partial data does not mean the analysis is complete."],
  ["조회할 수 있는 근거 자료가 없어 이 종목들을 분석하지 못했습니다.", "No data could be fetched for these assets, so they were not analyzed."],
  ["브리핑을 완료하지 못했습니다. 저장된 실행 오류와 자료 연결 상태를 확인하세요.", "The briefing did not finish. Check the saved run error and the data connections."],
  ["나머지 종목은 완료하지 못했습니다. 저장된 실행 오류를 확인하세요.", "The remaining assets did not finish. Check the saved run error."],
  ["저장된 보고서의 조회 범위와 자료 누락을 확인하세요.", "Check the saved report for what was covered and what is missing."],
  ["저장된 보고서에서 조회 범위를 확인하세요.", "Check the saved report for what was covered."],
];
/** A monitor's note is saved by the host in one language (the scheduled-run explanation in Korean, the unlinked-automation line in English): shown in the reader's language. A note a person wrote is shown as saved. */
const monitorNotes: Array<[string, string]> = [
  ["Agentlas 실행 중 실제 자료를 조회하고 Finance 보고서에 브리핑을 저장합니다. 실행 이력은 Finance와 자동화에서 확인하세요. 일시정지는 다음 실행을 막으며 진행 중인 실행은 마무리될 수 있습니다.", "While Agentlas is open, this fetches real data and saves the briefing to your Finance reports. See run history in Finance and Automations. Pausing stops the next run; a run already in progress may finish."],
  ["연결된 자동화를 사용할 수 없습니다. 자동화에서 확인하세요.", "The linked automation is unavailable. Review it in Automations."],
  ["점검 초안입니다. 지금 실행하거나, 일정을 정해 자동으로 실행하세요.", "A draft check. Run it now, or schedule it to run automatically."],
  ["아직 실행하지 않은 점검 초안입니다.", "A draft check. Run it now, or schedule it to run automatically."],
  ["A draft check that has not been executed.", "A draft check. Run it now, or schedule it to run automatically."],
];
export function financeMonitorNote(note: string, ko: boolean): string {
  const known = monitorNotes.find(([k, e]) => note === k || note === e);
  if (!known) return note;
  const draft = known[1] === monitorNotes[2][1];
  return ko ? (draft ? monitorNotes[2][0] : known[0]) : known[1];
}
export function financeStoredText(value: string, ko: boolean): string {
  const text = typeof value === "string" ? value : "";
  if (/^finance_[a-z0-9_]+$/.test(text.trim())) return financeMessage(text.trim(), ko);
  if (ko) return text;
  let out = text;
  const progress = /(\d+)\/(\d+) 종목 조회 시도\./g;
  out = out.replace(progress, (_m, a, b) => `Tried ${a} of ${b} assets.`);
  for (const [k, e] of storedText) out = out.split(k).join(e);
  return out;
}
export function FinanceMessage({ value, ko, error = false, note = false }: { value: string; ko: boolean; error?: boolean; note?: boolean }) {
  return <div className={error ? styles.negative : styles.muted}><p>{note ? financeNote(value, ko) : financeMessage(value, ko)}</p></div>;
}

const columns: Record<string, string> = { "Form": "공시 유형", "Filed": "제출일", "Accession": "접수 번호", "Document": "원문", "Volume": "거래량", "Latest trading day": "최근 거래일", "Title": "제목", "Publisher": "매체", "Published": "발행 시각", "Description": "설명", "Weight": "편입 비중", "Symbol": "티커", "Asset": "자산", "Name": "이름", "Exchange": "거래소", "Currency": "통화", "Price": "가격", "Observed at": "관측 시각", "Source": "출처", "Quantity": "수량", "Average cost": "평균 원가", "Market value": "평가액", "Unrealized P&L": "미실현 손익", "Status": "상태", "Retrieved at": "가져온 시각", "Note": "메모", "Author DID": "작성자 ID", "Author created at": "작성 시각", "Author handle": "작성자", "Author": "작성자", "Close (raw)": "종가(조정 전)", "Evidence status": "자료 상태", "Evidence type": "자료 종류", "Fund": "펀드", "High": "고가", "Low": "저가", "Open": "시가", "Indexed at": "등록 시각", "Maturity": "만기", "NAV date": "NAV 기준일", "NAV per share": "주당 NAV", "Observation date": "관측일", "Original post": "원문 글", "Par curve yield": "수익률", "Post text (claim)": "글 내용(검증 전)", "Short claim": "글 요약(검증 전)", "Post time": "작성 시각", "Price basis": "가격 기준", "URL": "링크", "Unit": "단위", "Headline": "제목", "Published at": "발행 시각", "Event date": "일정일", "Date": "날짜", "Value": "값" };
const columnsEn: Record<string, string> = { "Author DID": "Author ID", "Close (raw)": "Close (before adjustments)", "Evidence status": "Data status", "Evidence type": "Data type", "Indexed at": "Added at", "Par curve yield": "Yield", "Price basis": "Price type", "Post text (claim)": "Post text (unverified)", "Short claim": "Post summary (unverified)", "URL": "Link" };
export function financeColumn(value: string, ko: boolean): string { return ko ? columns[value] ?? value : columnsEn[value] ?? value; }
export function financeCell(value: string | number | null, column: string, ko: boolean): string {
  if (value === null) return "—";
  if (typeof value === "number") return value.toLocaleString(ko ? "ko-KR" : "en-US", { maximumFractionDigits: 6 });
  if (value === "XXX") return ko ? "통화 미확인" : "Currency unknown";
  if (["Status", "Source"].includes(column)) return financeStatus(value, ko);
  return value;
}
