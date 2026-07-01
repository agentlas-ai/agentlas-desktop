// DEV-ONLY QA 갤러리 — T-rex 렌더링을 전 매트릭스(4모드 × 7역할 × 3방향 × 장수극단)로
// 한 화면에 실제 DeckStage로 렌더한다. 범용 품질 회귀 검증용. 프로덕션 네비 없음.
// (제거 예정: 셀프 QA 도구. AuthGate 밖 no-shell이라 사이드바 backdrop-filter 없이 스크린샷 가능.)
"use client";
import { DeckStage, GlobalStyle } from "@/components/trex/DeckStage";
import {
  buildDeckFromContent,
  generateDeck,
  MODE_THEMES,
  formatById,
  formatRatio,
  type ArtMode,
  type DeckContent,
  type TrexDeck,
} from "@/lib/trex/model";
import { STYLES, STYLE_IDS, styleById } from "@/lib/trex/styles";

// 전 역할을 커버하는 현실적 합성 콘텐츠(LLM 없이 렌더 품질만 검증).
const FULL: DeckContent = {
  title: "국내 로봇 배달 시장 진입 전략 리뷰",
  subtitle: "시장 규모 분석, 경쟁 구도 대응 및 단계별 상용화 로드맵",
  slides: [
    { role: "agenda", title: "시장 주도권 확보를 위한 네 가지 흐름", items: ["2,500억 배달 시장 기회 분석 — 규제 완화 이후 실수요가 열리는 구간을 짚는다", "대기업·스타트업 3파전 경쟁 구도 — 플랫폼·제조·통신 진영별 강점 비교", "규제 완화 맞춘 3단계 상용화 — 거점 검증에서 전국 확산까지의 로드맵", "초기 시장 안착 파트너십 구축 — 배달 플랫폼·지자체 제휴 우선순위"] },
    { role: "metrics", title: "규제 완화와 인건비 상승이 수요를 밀어올린다", kpis: [{ value: "2,500억원", label: "2026년 국내 시장 규모" }, { value: "+150%", label: "전년 대비 서비스 도입률" }, { value: "1,800원", label: "건당 배달 비용 절감액" }], note: "인건비 대비 절감폭이 임계점을 넘었다 — 도입을 미룰수록 경쟁사에 단가 우위를 내준다.", img: "a delivery robot crossing a rainy Seoul crosswalk at dusk" },
    { role: "comparison", title: "어느 세그먼트에 먼저 집중할 것인가", bars: [{ label: "대학·대단지", value: 82 }, { label: "도심 상권", value: 61 }, { label: "교외 지역", value: 39 }], note: "대학·대단지가 규제·수요·주행환경 3박자를 모두 갖춘 유일한 세그먼트다." },
    { role: "structure", title: "3대 핵심 플레이어가 시장을 과점하고 있다", cards: [{ label: "플랫폼 대기업", text: "배달 앱 연동 및 대규모 주문 인프라 장악. 트래픽을 쥐고 있어 제휴 협상력이 가장 세다." }, { label: "로봇 전문 제조사", text: "자율주행 하드웨어 개발 및 솔루션 공급. 원가 절감의 열쇠를 쥔 축이다." }, { label: "통신·IT 기업", text: "5G 기반 실시간 관제 및 정밀 지도 제공. 안전 규제 대응의 필수 파트너다." }], note: "세 진영 중 두 곳 이상과 동시 제휴해야 교섭력이 생긴다 — 단독 진입은 원가·트래픽 양쪽에서 진다." },
    { role: "process", title: "단계적 도입 시나리오로 운영 리스크 최소화", steps: [{ label: "1단계: 거점 검증", text: "규제 특구 내 시범 운영 및 데이터 확보. 사고율·완주율 기준선을 만든다." }, { label: "2단계: 제휴 확장", text: "배달 플랫폼 연동 및 서비스 커버리지 확대. 주문 밀도가 손익분기를 결정한다." }, { label: "3단계: 전국 상용화", text: "양산화를 통한 비용 절감 및 전면 개시. 대당 운영비를 절반으로 낮춘다." }], note: "각 단계의 관문 지표(사고율·주문밀도·대당비용)를 통과해야 다음 투자를 집행한다." },
    { role: "highlight", title: "한 가지가 성패를 가른다", stat: { value: "76%", label: "규제 샌드박스 통과율" }, text: "규제 대응 속도가 시장 선점의 결정 변수다. 심사 리드타임을 아는 팀이 6개월을 번다.", img: "a small autonomous delivery robot waiting at a university campus gate in warm morning light" },
    { role: "statement", text: "결국 실행 속도가 시장의 승자를 결정한다", note: "완벽한 계획보다 검증된 거점 하나가 협상 테이블에서 더 세다.", img: "an empty pedestrian road stretching toward the horizon at dawn" },
  ],
};

function Deck({ label, content, deck: prebuilt, mode, formatId, styleId, only }: { label: string; content?: DeckContent; deck?: TrexDeck; mode?: ArtMode; formatId?: string; styleId?: string; only?: number[] }) {
  const deck = prebuilt ?? buildDeckFromContent({ ...(content as DeckContent), mode: mode ?? content?.mode }, formatId, "ko", styleId);
  const fmt = formatById(prebuilt ? prebuilt.formatId : formatId);
  const ratio = formatRatio(fmt);
  const wide = fmt.w / fmt.h >= 1.25;
  const slides = only ? only.map((i) => deck.slides[i]).filter(Boolean) : deck.slides;
  const dna = styleById(deck.styleId);
  return (
    <section style={{ marginBottom: 40 }}>
      <div style={{ fontSize: 13, fontWeight: 800, color: "#111", marginBottom: 10, fontFamily: "monospace" }}>{label}</div>
      <div style={{ display: "grid", gridTemplateColumns: wide ? "repeat(auto-fill, minmax(360px, 1fr))" : "repeat(auto-fill, minmax(230px, 1fr))", gap: 16, alignItems: "start" }}>
        {slides.map((s, i) => (
          <div key={s.id} style={{ position: "relative" }}>
            <DeckStage slide={s} accent={deck.accent} editable={false} ratio={ratio} dna={dna} />
            <div style={{ position: "absolute", top: 4, left: 4, fontSize: 9, fontWeight: 800, color: "#fff", background: "rgba(0,0,0,.5)", padding: "1px 5px", borderRadius: 4, zIndex: 9 }}>{only ? only[i] : i}</div>
          </div>
        ))}
      </div>
    </section>
  );
}

// 긴 텍스트 스트레스 — LLM이 길게 쓸 때 클리핑/오버플로 임계 검증.
const STRESS: DeckContent = {
  title: "글로벌 공급망 리스크와 지정학적 불확실성 속에서 회복탄력성을 확보하기 위한 통합 전략 로드맵",
  subtitle: "원자재 조달 다변화, 재고 최적화, 니어쇼어링, 공급업체 리스크 관리, 디지털 트윈 기반 시나리오 대응을 아우르는 종합 실행 계획",
  slides: [
    { role: "agenda", title: "복잡한 다층 공급망 환경에서 우선적으로 다뤄야 할 다섯 가지 전략적 의제와 실행 우선순위", items: ["원자재 조달처 다변화와 대체 소싱 전략의 단계적 구축 방안", "안전재고 수준 재설정과 수요예측 정확도 개선을 통한 재고 최적화", "니어쇼어링과 리쇼어링 판단 기준 및 총소유비용 분석", "핵심 공급업체 재무건전성 모니터링과 이중 소싱 체계", "디지털 트윈 기반 공급망 시나리오 시뮬레이션 역량 내재화"] },
    { role: "metrics", title: "지난 3년간 누적된 공급망 교란이 재무 성과에 미친 정량적 영향의 규모", kpis: [{ value: "1조 2,400억원", label: "공급 교란으로 인한 연간 누적 기회손실 추정액과 지연 비용" }, { value: "-38.5%", label: "핵심 부품 리드타임 변동성 증가에 따른 정시납품률 하락폭" }, { value: "127일", label: "평균 현금전환주기 확대로 묶인 운전자본 부담 일수" }] },
    { role: "structure", title: "회복탄력성을 좌우하는 세 가지 구조적 축과 각 축이 요구하는 조직 역량", cards: [{ label: "가시성과 예측 인프라", text: "다단계 공급망 전 구간에 걸친 실시간 데이터 연계와 예외 감지, 그리고 수요·공급 시그널을 통합한 예측 정확도 향상 체계의 구축이 선행되어야 한다" }, { label: "유연성과 대체 역량", text: "단일 소싱 의존도를 낮추고 지역별 이중화와 유연 생산능력을 확보하여 특정 지역 교란에도 신속히 물량을 재배분할 수 있어야 한다" }, { label: "거버넌스와 협업 체계", text: "공급업체와의 리스크 정보 공유 및 공동 대응 프로토콜, 그리고 유사시 의사결정 권한과 에스컬레이션 경로를 사전에 정의해 두어야 한다" }] },
    { role: "process", title: "18개월에 걸쳐 단계적으로 회복탄력성을 내재화하는 실행 로드맵의 세 국면", steps: [{ label: "1단계: 진단과 가시성 확보", text: "핵심 품목의 다단계 공급망을 매핑하고 리스크 익스포저를 정량화하며 데이터 연계 기반을 마련하는 초기 6개월" }, { label: "2단계: 이중화와 유연성 구축", text: "우선순위 품목부터 대체 소싱과 지역 이중화를 실행하고 안전재고 정책을 재설계하는 중기 6개월" }, { label: "3단계: 자동화와 지속개선", text: "시나리오 시뮬레이션을 상시화하고 조기경보 자동화와 공급업체 협업 체계를 정착시키는 후기 6개월" }] },
    { role: "highlight", title: "결국 모든 것을 좌우하는 단 하나의 결정 변수", stat: { value: "72시간", label: "교란 발생부터 대체 계획 실행까지의 대응 소요시간이 손실 규모를 결정한다" }, text: "가시성과 사전 정의된 대응 프로토콜이 이 골든타임을 좌우하며, 여기서 승부가 갈린다는 점을 잊어서는 안 된다" },
    { role: "statement", text: "회복탄력성은 비용이 아니라 불확실성의 시대에 기업의 생존을 담보하는 가장 확실한 전략적 투자다" },
  ],
};

export default function TrexGalleryPage() {
  // DEV 전용 QA 도구 — 프로덕션 번들에선 렌더하지 않는다.
  if (process.env.NODE_ENV === "production") return null;
  const modes: ArtMode[] = ["editorial", "cinematic", "diagrammatic", "hybrid"];
  return (
    <div style={{ padding: 28, background: "#e9ebef", minHeight: "100vh", color: "#111" }}>
      <GlobalStyle />
      <h1 style={{ fontSize: 20, fontWeight: 900, marginBottom: 6 }}>T-rex 렌더 QA 갤러리</h1>
      <p style={{ fontSize: 12, color: "#555", marginBottom: 28 }}>4모드 × 7역할 × 방향/장수. 각 슬라이드 좌상단 숫자 = 슬라이드 인덱스. 겹침·오버플로·대비·방향 회귀 확인용.</p>

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "8px 0 14px" }}>① 4개 아트모드 — 전체 아크(표지→7역할→클로징)</h2>
      {modes.map((m) => (
        <Deck key={m} label={`mode=${m}  ·  9장 전체`} content={FULL} mode={m} />
      ))}

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>② 방향 인지 — 같은 콘텐츠, 세로/정사각</h2>
      <Deck label="story 9:16 (portrait)  ·  표지·구조·과정·클로징" content={FULL} mode="editorial" formatId="story" only={[0, 4, 5, 7]} />
      <Deck label="ig-square 1:1 (square)  ·  표지·지표·구조·클로징" content={FULL} mode="editorial" formatId="ig-square" only={[0, 2, 4, 7]} />
      <Deck label="A4 세로 (print portrait)  ·  표지·목차·구조" content={FULL} mode="diagrammatic" formatId="a4" only={[0, 1, 4]} />

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>③ 긴 텍스트 스트레스 — 클리핑/오버플로 임계(LLM 변동 대비)</h2>
      <Deck label="STRESS editorial  ·  9장 전체" content={STRESS} mode="editorial" />
      <Deck label="STRESS story 9:16  ·  표지·구조·과정" content={STRESS} mode="editorial" formatId="story" only={[0, 4, 5]} />

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>④ 개수 적응형 — KPI/카드 2개·4개(LLM은 2~4개 반환)</h2>
      <Deck label="KPI 2개 / 카드 2개" content={{ title: "개수 적응형 검증 — 두 항목", subtitle: "2개일 때 가운데 분배되는지", slides: [
        { role: "metrics", title: "두 지표만 있을 때", kpis: [{ value: "84%", label: "첫 번째 지표 설명" }, { value: "2.3배", label: "두 번째 지표 설명" }] },
        { role: "structure", title: "두 축으로 나뉜다", cards: [{ label: "첫 번째 축", text: "이 축이 다루는 범위와 핵심 역할에 대한 설명" }, { label: "두 번째 축", text: "다른 축이 담당하는 영역과 그 중요성 설명" }] },
      ] }} mode="editorial" only={[1, 2]} />
      <Deck label="KPI 4개 / 카드 4개" content={{ title: "개수 적응형 검증 — 네 항목", subtitle: "4개일 때 유실 없이 4열로", slides: [
        { role: "metrics", title: "네 지표를 한눈에", kpis: [{ value: "1,240억", label: "시장 규모" }, { value: "+38%", label: "성장률" }, { value: "6.2배", label: "ROI" }, { value: "94점", label: "만족도" }] },
        { role: "structure", title: "네 갈래 구조", cards: [{ label: "첫째 축", text: "첫 번째 영역 설명 텍스트" }, { label: "둘째 축", text: "두 번째 영역 설명 텍스트" }, { label: "셋째 축", text: "세 번째 영역 설명 텍스트" }, { label: "넷째 축", text: "네 번째 영역 설명 텍스트" }] },
      ] }} mode="editorial" only={[1, 2]} />

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>⑤ 장수 극단 — 결정적 생성기(스캐폴드)</h2>
      <Deck label="count=3 (MIN)  ·  deterministic" deck={generateDeck("최소 장수 테스트 — 핵심만", "editorial", 3)} />
      <Deck label="count=14 (MAX)  ·  deterministic 표지·중간·클로징" deck={generateDeck("최대 장수 스트레스 테스트 — 여러 역할 회전", "editorial", 14)} only={[0, 1, 6, 10, 13]} />

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>⑥ Style DNA — 6개 디자인 유파 × 같은 콘텐츠(표지·목차·지표·구조·핵심·클로징)</h2>
      {STYLE_IDS.map((sid) => (
        <Deck key={sid} label={`style=${sid} (${STYLES[sid].nameKo})  ·  ${STYLES[sid].hintKo}`} content={FULL} mode="editorial" styleId={sid} only={[0, 1, 2, 4, 6, 7]} />
      ))}
      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>⑦ Style DNA × 방향 — 세로/정사각 회귀</h2>
      <Deck label="swiss · story 9:16" content={FULL} mode="editorial" styleId="swiss" formatId="story" only={[0, 2, 4, 7]} />
      <Deck label="didot · ig-square 1:1" content={FULL} mode="editorial" styleId="didot" formatId="ig-square" only={[0, 2, 4, 7]} />
      <Deck label="brutal · A4 세로" content={FULL} mode="editorial" styleId="brutal" formatId="a4" only={[0, 4, 7]} />
    </div>
  );
}
