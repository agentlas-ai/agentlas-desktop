import styles from "./FinanceWorkspace.module.css";

const messages: Record<string, string> = {
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
const statuses: Record<string, string> = { "Summary": "핵심 판단", "Sources and limitations": "출처와 한계", ready: "자료 있음", partial: "일부 자료", empty: "자료 없음", unsupported: "미지원", connected: "연결됨", imported: "가져옴", unconnected: "연결 안 됨", error: "오류", draft: "초안", active: "실행 중", paused: "일시정지", ok: "조회 완료", csv: "CSV 파일", manual: "직접 입력", provider: "공급자 연결", dashboard: "대시보드", watchlist: "자산 찾기", reports: "보고서", sources: "자료와 근거", monitors: "모니터링", "CSV import": "CSV 가져오기" };
export function financeStatus(value: string, ko: boolean): string { return ko ? statuses[value] ?? value : value; }
export function financeMessage(value: string, ko: boolean): string {
  if (!ko) return value;
  if (messages[value]) return messages[value];
  const row = /^Row (\d+): ([\s\S]+)$/.exec(value);
  if (row) return `${row[1]}행: ${financeMessage(row[2], true)}`;
  const unused = /^Unused columns: (.+)$/.exec(value);
  if (unused) return `사용하지 않는 열: ${unused[1]}`;
  const metric = /^Metric '(.+)' has no connected (historical )?data(?:; only available price snapshots are shown\.)?\.?$/.exec(value);
  if (metric) return `${metric[1]} 지표의 ${metric[2] ? "과거 " : ""}자료가 연결되지 않았습니다.${metric[2] ? "" : " 확인된 가격 관측만 표시합니다."}`;
  const conflict = /^Conflicting sources for (.+) at (.+); selected source (.+)\.$/.exec(value);
  if (conflict) return `${conflict[1]}의 ${conflict[2]} 관측값이 출처마다 다릅니다. 선택한 출처: ${conflict[3]}.`;
  const number = /^(.+) must be a nonnegative decimal without separators$/.exec(value);
  if (number) return `${({ quantity: "수량", price: "가격", average_cost: "평균 원가" } as Record<string,string>)[number[1]] ?? number[1]}은 구분기호 없는 0 이상의 숫자로 입력하세요.`;
  return value;
}
/** Preserve unknown provider diagnostics rather than guessing their meaning. */
export function FinanceMessage({ value, ko, error = false }: { value: string; ko: boolean; error?: boolean }) {
  const translated = financeMessage(value, ko);
  const unknown = ko && translated === value && /^[\x00-\x7f]/.test(value) && !/[가-힣]/.test(value);
  return <div className={error ? styles.negative : styles.muted}>{unknown ? <><p>{error ? "자료 처리 중 오류가 발생했습니다. 원문 안내를 확인하세요." : "추가 자료 안내가 있습니다. 원문을 확인하세요."}</p><details><summary>원문 안내</summary><p style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{value}</p></details></> : <p>{translated}</p>}</div>;
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
