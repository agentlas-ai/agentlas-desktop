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
import { STYLES, STYLE_IDS, styleById, PALETTES, paletteStyle } from "@/lib/trex/styles";
import { ASSET_KINDS, palOf, renderAsset } from "@/lib/trex/graphics";

// 전 역할을 커버하는 현실적 합성 콘텐츠(LLM 없이 렌더 품질만 검증).
const FULL: DeckContent = {
  title: "국내 로봇 배달 시장 진입 전략 리뷰",
  subtitle: "시장 규모 분석, 경쟁 구도 대응 및 단계별 상용화 로드맵",
  slides: [
    { role: "agenda", title: "시장 주도권 확보를 위한 네 가지 흐름", items: ["2,500억 배달 시장 기회 분석 — 규제 완화 이후 실수요가 열리는 구간을 짚는다", "대기업·스타트업 3파전 경쟁 구도 — 플랫폼·제조·통신 진영별 강점 비교", "규제 완화 맞춘 3단계 상용화 — 거점 검증에서 전국 확산까지의 로드맵", "초기 시장 안착 파트너십 구축 — 배달 플랫폼·지자체 제휴 우선순위"] },
    { role: "metrics", title: "규제 완화와 **인건비 상승**이 수요를 밀어올린다", src: "출처: 중소벤처기업부 창업실태조사, 2025", dek: "2026년 실외이동로봇 보도 통행 전면 허용 이후 첫 수요 사이클", kpis: [{ value: "2,500억원", label: "2026년 국내 시장 규모" }, { value: "+150%", label: "전년 대비 서비스 도입률" }, { value: "1,800원", label: "건당 배달 비용 절감액" }], note: "인건비 대비 절감폭이 임계점을 넘었다 — **도입을 미룰수록 경쟁사에 단가 우위**를 내준다.", img: "a delivery robot crossing a rainy Seoul crosswalk at dusk" },
    { role: "comparison", title: "**대학·대단지**에 먼저 집중한다", src: "출처: 내부 스코어링 모델, 2026.01", dek: "규제·수요밀도·주행환경 3개 축 가중 평가(내부 스코어링)", bars: [{ label: "대학·대단지", value: 82 }, { label: "도심 상권", value: 61 }, { label: "교외 지역", value: 39 }], note: "대학·대단지가 규제·수요·주행환경 3박자를 모두 갖춘 유일한 세그먼트다." },
    { role: "structure", title: "3대 핵심 플레이어가 시장을 **과점**하고 있다", dek: "상위 3개 진영이 배달 주문의 91%를 처리한다", cards: [{ label: "플랫폼 대기업", text: "배달 앱 연동 및 대규모 주문 인프라 장악. **트래픽을 쥐고 있어 제휴 협상력이 가장 세다.**" }, { label: "로봇 전문 제조사", text: "자율주행 하드웨어 개발 및 솔루션 공급. 원가 절감의 열쇠를 쥔 축이다." }, { label: "통신·IT 기업", text: "5G 기반 실시간 관제 및 정밀 지도 제공. 안전 규제 대응의 필수 파트너다." }], note: "세 진영 중 두 곳 이상과 동시 제휴해야 교섭력이 생긴다 — 단독 진입은 원가·트래픽 양쪽에서 진다." },
    { role: "process", title: "단계적 도입 시나리오로 운영 리스크 최소화", dek: "각 단계는 관문 지표 통과 시에만 다음 투자를 집행", steps: [{ label: "1단계: 거점 검증", text: "규제 특구 내 시범 운영 및 데이터 확보. 사고율·완주율 기준선을 만든다." }, { label: "2단계: 제휴 확장", text: "배달 플랫폼 연동 및 서비스 커버리지 확대. 주문 밀도가 손익분기를 결정한다." }, { label: "3단계: 전국 상용화", text: "양산화를 통한 비용 절감 및 전면 개시. 대당 운영비를 절반으로 낮춘다." }], note: "각 단계의 관문 지표(사고율·주문밀도·대당비용)를 통과해야 다음 투자를 집행한다." },
    { role: "highlight", title: "한 가지가 성패를 가른다", dek: "심사 리드타임 평균 4.2개월 — 준비팀은 6주로 단축", stat: { value: "76%", label: "규제 샌드박스 통과율" }, text: "규제 대응 속도가 시장 선점의 결정 변수다. 심사 리드타임을 아는 팀이 6개월을 번다.", img: "a small autonomous delivery robot waiting at a university campus gate in warm morning light" },
    { role: "statement", text: "결국 실행 속도가 시장의 승자를 결정한다", note: "완벽한 계획보다 검증된 거점 하나가 협상 테이블에서 더 세다.", img: "an empty pedestrian road stretching toward the horizon at dawn" },
  ],
};

function injectImages(deck: TrexDeck, images: (string | undefined)[]): TrexDeck {
  return {
    ...deck,
    slides: deck.slides.map((s, i) => {
      const url = images[i];
      if (!url) return s;
      let used = false;
      const blocks = s.blocks.map((b) => (b.kind === "image" && !used ? ((used = true), { ...b, src: url }) : b));
      const bg = s.bg.kind === "image" ? { ...s.bg, src: url } : s.bg;
      return { ...s, blocks, bg };
    }),
  };
}
function Deck({ label, content, deck: prebuilt, mode, formatId, styleId, only, locale = "en", images }: { label: string; content?: DeckContent; deck?: TrexDeck; mode?: ArtMode; formatId?: string; styleId?: string; only?: number[]; locale?: "ko" | "en"; images?: (string | undefined)[] }) {
  const built = prebuilt ?? buildDeckFromContent({ ...(content as DeckContent), mode: mode ?? content?.mode }, formatId, locale, styleId);
  const deck = images ? injectImages(built, images) : built;
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

// 전체 에셋 50종을 aurora 팔레트로 직접 렌더(레이아웃 없이 순수 SVG 품질/파손 검증).
function AssetGrid() {
  const pal = palOf(styleById("aurora"));
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(190px, 1fr))", gap: 12, background: "#fff", padding: 14, borderRadius: 12 }}>
      {ASSET_KINDS.map((k) => (
        <div key={k} style={{ border: "1px solid #ececf2", borderRadius: 10, padding: 8, background: "#F8F8FC" }}>
          <div style={{ fontSize: 10, fontWeight: 800, color: "#6B6880", marginBottom: 4, fontFamily: "monospace" }}>{k}</div>
          <div style={{ height: 120, display: "flex", alignItems: "center", justifyContent: "center" }} dangerouslySetInnerHTML={{ __html: renderAsset({ kind: k }, pal) }} />
        </div>
      ))}
    </div>
  );
}

// 색조합 팔레트 50종 스와치(gradient accent→accent2 + ink/bg).
function PaletteStrip() {
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 10 }}>
      {PALETTES.map((p) => {
        const d = paletteStyle(p);
        const bg = d.bodyBg.kind === "solid" ? d.bodyBg.color : "#fff";
        return (
          <div key={p.id} style={{ borderRadius: 10, overflow: "hidden", border: "1px solid #e2e1ea", background: bg }}>
            <div style={{ height: 46, background: `linear-gradient(135deg, ${p.accent}, ${p.accent2})` }} />
            <div style={{ padding: "7px 9px" }}>
              <div style={{ fontSize: 12, fontWeight: 800, color: d.ink }}>{p.nameKo} <span style={{ color: "#9a97a8", fontWeight: 600 }}>{p.nameEn}</span></div>
              <div style={{ display: "flex", gap: 4, marginTop: 5 }}>
                <span style={{ width: 16, height: 16, borderRadius: 4, background: p.accent }} />
                <span style={{ width: 16, height: 16, borderRadius: 4, background: p.accent2 }} />
                <span style={{ fontSize: 9, color: "#9a97a8", fontFamily: "monospace", marginLeft: "auto" }}>{p.accent}</span>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// advertise 장르 — 포스터 5 아키타입(overlay/split/hero/diagonal/frame).
const AD: DeckContent = {
  title: "MEGA BURGER",
  genre: "advertise",
  slides: [
    { role: "statement", title: "메가버거 **오픈 특가**", text: "두툼한 패티 · 신선한 재료", offer: "1+1", cta: "주문하기", img: "a juicy gourmet cheeseburger on dark background, dramatic studio lighting" },
    { role: "statement", title: "프리미엄 **가구** 신제품", text: "클래식을 담은 새 세대 디자인", offer: "30% 할인", cta: "쇼핑하기", img: "modern minimalist living room furniture, warm tones" },
    { role: "statement", title: "주말 **디저트** 페어", text: "이번 주말 한정 스페셜", offer: "20% OFF", cta: "예약하기", img: "assorted colorful gourmet desserts on a marble table" },
    { role: "statement", title: "연말 **댄스** 쇼케이스", text: "12월 31일 · 시티홀", offer: "티켓 오픈", cta: "예매하기", img: "ballet dancer silhouette on stage under a dramatic spotlight" },
    { role: "statement", title: "발레 **클래스** 모집", text: "등록 문의 010-1234-5678", offer: "무료 체험", cta: "등록하기", img: "ballet class studio with soft natural light" },
  ],
};

// cardnews 장르 — 인스타 캐러셀(4:5). 커버→콘텐츠→CTA.
const CARDNEWS: DeckContent = {
  title: "요즘 뜨는 배달로봇 5가지",
  subtitle: "규제 완화 이후 시장이 열렸다",
  genre: "cardnews",
  slides: [
    { role: "metrics", title: "2,500억 시장이 열렸다", text: "2026년 실외이동로봇 보도 통행 전면 허용", img: "a delivery robot crossing a city crosswalk at dusk" },
    { role: "structure", title: "3대 진영이 과점 중이다", text: "플랫폼·제조·통신이 배달의 91%를 처리한다", img: "tech companies competing, abstract cityscape" },
    { role: "statement", title: "결국 실행 속도가 승자를 가른다", text: "검증된 거점 하나가 협상 테이블에서 더 세다" },
    { role: "process", title: "대학·대단지부터 공략한다", items: ["규제 특구 시범 검증", "배달 플랫폼 제휴 확장", "양산 통한 전국 상용화"], img: "university campus with a small delivery robot" },
  ],
};

// PNG 출력용 샘플 — 리포트(고밀도, 이미지無)·카드뉴스·포스터(이미지 주입).
const REPORT_SAMPLE: DeckContent = {
  title: "국내 로봇 배달 시장 진입 전략 리포트",
  subtitle: "규제 완화 이후 시장 구조와 3단계 상용화 로드맵",
  genre: "report",
  slides: [
    { role: "metrics", title: "규제 완화로 **첫 수요 사이클**이 열렸다", dek: "2026년 실외이동로봇 보도 통행 전면 허용 이후", src: "출처: 중소벤처기업부, 2026", kpis: [{ value: "2,500억원", label: "2026년 국내 시장 규모" }, { value: "+150%", label: "전년 대비 서비스 도입률" }, { value: "1,800원", label: "건당 배달 비용 절감액" }], note: "절감폭이 임계점 돌파 — 미룰수록 단가 우위를 내준다." },
    { role: "structure", title: "3대 진영이 시장을 **과점**한다", dek: "상위 3개 진영이 배달 주문의 91%를 처리한다", cards: [{ label: "플랫폼 대기업", text: "앱 연동·대규모 주문 장악. 제휴 협상력 최강." }, { label: "로봇 제조사", text: "자율주행 HW·솔루션 공급. 원가 절감의 열쇠." }, { label: "통신·IT", text: "5G 관제·정밀지도. 안전 규제 대응 필수." }], note: "두 진영 이상 동시 제휴해야 교섭력 확보 — 단독은 진다." },
    { role: "comparison", title: "**대학·대단지**에 먼저 집중한다", dek: "규제·수요밀도·주행환경 3개 축 가중 평가", bars: [{ label: "대학·대단지", value: 82 }, { label: "도심 상권", value: 61 }, { label: "교외 지역", value: 39 }, { label: "산업단지", value: 27 }], note: "대학·대단지가 3박자를 모두 갖춘 유일 세그먼트." },
    { role: "process", title: "**3단계**로 운영 리스크를 최소화한다", dek: "각 단계는 관문 지표 통과 시에만 다음 투자를 집행", steps: [{ label: "거점 검증", text: "규제특구 시범 → 사고율·완주율 기준선" }, { label: "제휴 확장", text: "플랫폼 연동 → 주문밀도 손익분기 돌파" }, { label: "전국 상용화", text: "양산 → 대당 운영비 절반, 전면 개시" }], note: "관문 지표 통과 시에만 다음 투자 집행." },
  ],
};
const CARDNEWS_SAMPLE: DeckContent = {
  title: "요즘 뜨는 배달로봇 5가지",
  subtitle: "규제 완화 이후 시장이 열렸다",
  genre: "cardnews",
  slides: [
    { role: "metrics", title: "2,500억 시장이 열렸다", text: "2026년 실외이동로봇 보도 통행 전면 허용", img: "delivery robot on a city crosswalk" },
    { role: "structure", title: "3대 진영이 과점 중이다", text: "플랫폼·제조·통신이 배달의 91%를 처리한다", img: "tech cityscape" },
    { role: "process", title: "대학·대단지부터 공략한다", items: ["규제 특구 시범 검증", "배달 플랫폼 제휴 확장", "양산 통한 전국 상용화"], img: "campus robot" },
  ],
};
const POSTER_SAMPLE: DeckContent = {
  title: "MEGA BURGER",
  genre: "advertise",
  slides: [
    { role: "statement", title: "메가버거 **오픈 특가**", text: "두툼한 패티 · 신선한 재료", offer: "1+1", cta: "주문하기", img: "burger", layout: "overlay" },
    { role: "statement", title: "프리미엄 **가구** 신제품", text: "클래식을 담은 새 세대 디자인", offer: "30% 할인", cta: "쇼핑하기", img: "furniture", layout: "split" },
    { role: "statement", title: "주말 **디저트** 페어", text: "이번 주말 한정 스페셜", offer: "20% OFF", cta: "예약하기", img: "dessert", layout: "hero" },
  ],
};

// 영어 advertise + cardnews (영어 타이포/오버플로 검증).
const AD_EN: DeckContent = {
  title: "MEGA BURGER",
  genre: "advertise",
  slides: [
    { role: "statement", title: "MEGA **BURGER** Deal", text: "Thick patty, fresh ingredients", offer: "BUY 1 GET 1", cta: "ORDER NOW", img: "a juicy gourmet cheeseburger on dark background, dramatic studio lighting" },
    { role: "statement", title: "EXCLUSIVE **FURNITURE**", text: "Designs inspired by a classic touch", offer: "30% OFF", cta: "SHOP NOW", img: "modern minimalist living room furniture, warm tones" },
    { role: "statement", title: "Weekend **Dessert** Fair", text: "This weekend only", offer: "20% OFF", cta: "RESERVE", img: "assorted colorful gourmet desserts on a marble table" },
    { role: "statement", title: "YEAR-END **DANCE** SHOW", text: "Dec 31 · City Hall", offer: "TICKETS", cta: "BOOK NOW", img: "ballet dancer silhouette on stage under a dramatic spotlight" },
    { role: "statement", title: "BALLET **CLASSES**", text: "Enroll now · 555-1234", offer: "FREE TRIAL", cta: "ENROLL", img: "ballet class studio with soft natural light" },
  ],
};
const CARDNEWS_EN: DeckContent = {
  title: "5 Rising Delivery Robots",
  subtitle: "The market opened after deregulation",
  genre: "cardnews",
  slides: [
    { role: "metrics", title: "A $250M market just opened", text: "2026 sidewalk access fully approved for delivery robots", img: "a delivery robot crossing a city crosswalk at dusk" },
    { role: "structure", title: "Three camps dominate", text: "Platform, maker, and telco handle 91% of orders", img: "tech companies competing, abstract cityscape" },
    { role: "statement", title: "Speed of execution decides the winner", text: "One proven site beats a perfect plan at the table" },
    { role: "process", title: "Start with campuses and complexes", items: ["Pilot in a regulatory sandbox", "Expand platform partnerships", "Nationwide rollout at scale"], img: "university campus with a small delivery robot" },
  ],
};

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

// SVG 인포그래픽 에셋 쇼케이스 — diagram/flow/chart 레이아웃을 명시해 전 종류를 강제 렌더(QA).
const ASSET_SHOWCASE: DeckContent = {
  title: "SVG 인포그래픽 에셋",
  slides: [
    { role: "structure", layout: "diagram", title: "구성 요소를 **허브앤스포크**로", dek: "중심 생태계와 위성 축", cards: [{ label: "투자", text: "성장 자본 조달" }, { label: "채용", text: "핵심 인재 확보" }, { label: "홍보", text: "브랜드 인지 확대" }, { label: "데이터", text: "의사결정 근거" }, { label: "제휴", text: "채널 파트너십" }] },
    { role: "structure", layout: "diagram", title: "역량을 중심으로 **수렴**시킨다", dek: "바깥 자원이 하나의 코어로", cards: [{ label: "투자", text: "" }, { label: "채용", text: "" }, { label: "홍보", text: "" }, { label: "데이터", text: "" }, { label: "제휴", text: "" }] },
    { role: "structure", layout: "diagram", title: "네 갈래 **다이아몬드** 구조", dek: "동등한 네 요소", cards: [{ label: "수집", text: "데이터 확보" }, { label: "분석", text: "성장 스코어링" }, { label: "협업", text: "교차 검증" }, { label: "실행", text: "선제 접촉" }] },
    { role: "structure", layout: "diagram", title: "**피라미드**로 계층을 세운다", dek: "비전에서 실행까지", cards: [{ label: "비전", text: "지향점" }, { label: "전략", text: "우선순위" }, { label: "실행", text: "실무 과제" }] },
    { role: "process", layout: "flow", title: "**계단 스텝**으로 성장 단계", dek: "인지→관심→전환→확장", steps: [{ label: "인지", text: "시장 진입 신호 포착" }, { label: "관심", text: "리드 확보·검증" }, { label: "전환", text: "유료 전환" }, { label: "확장", text: "재구매·확산" }] },
    { role: "process", layout: "flow", title: "**사이클** 성장 루프", dek: "수집→분석→인사이트→확장", steps: [{ label: "수집", text: "데이터 수집" }, { label: "분석", text: "패턴 분석" }, { label: "인사이트", text: "의미 도출" }, { label: "확장", text: "적용 확대" }] },
    { role: "process", layout: "flow", title: "**반원 팬**으로 네 축", dek: "01~04 방사 배치", steps: [{ label: "발굴", text: "기회 발굴" }, { label: "분석", text: "타당성 분석" }, { label: "협업", text: "파트너 협업" }, { label: "실행", text: "실행·검증" }] },
    { role: "process", layout: "flow", title: "**셰브론** 화살표 플로우", dek: "발굴→분석→실행→검증", steps: [{ label: "발굴", text: "데이터 자동 수집" }, { label: "분석", text: "교차·시계열 스코어링" }, { label: "실행", text: "우선순위 딜 접촉" }, { label: "검증", text: "재무·리스크 확인" }] },
    { role: "comparison", layout: "chart", title: "세그먼트별 **집중도**를 막대로", dek: "규제·수요·주행환경 가중 점수", bars: [{ label: "대학·대단지", value: 82 }, { label: "도심 상권", value: 61 }, { label: "교외 지역", value: 39 }, { label: "산업단지", value: 27 }] },
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

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>①-b SVG 인포그래픽 에셋 — diagram/flow/chart (aurora)</h2>
      <Deck label="에셋 쇼케이스 · aurora · 허브·수렴·다이아몬드·피라미드·계단·사이클·반원팬·셰브론·막대" content={ASSET_SHOWCASE} mode="editorial" styleId="aurora" />

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>①-c 전체 SVG 에셋 {ASSET_KINDS.length}종 (aurora 팔레트)</h2>
      <AssetGrid />
      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>①-d 색조합 팔레트 {PALETTES.length}종</h2>
      <PaletteStrip />

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>①-e 장르 대분류 — 같은 콘텐츠, 피치(저밀도 에셋) vs 리포트(고밀도 고정)</h2>
      <Deck label="genre=pitch · aurora · 저밀도 차트+그림 (구조·지표·비교·과정)" content={{ ...FULL, genre: "pitch" }} mode="editorial" styleId="ocean" only={[0, 2, 3, 4, 5]} />
      <Deck label="genre=report · aurora · 고밀도 고정 레이아웃" content={{ ...FULL, genre: "report" }} mode="editorial" styleId="sapphire" only={[0, 2, 3, 4, 5]} />

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>①-f advertise 포스터 — 5 아키타입 (overlay·split·hero·diagonal·frame)</h2>
      <Deck label="genre=advertise · coral · story 9:16 · 메가버거/가구/디저트/댄스/발레" content={AD} mode="editorial" styleId="coral" formatId="story" />

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>①-g 카드뉴스 — 인스타 캐러셀 4:5 (커버→콘텐츠→CTA)</h2>
      <Deck label="genre=cardnews · azure · ig-portrait 4:5 · 배달로봇 5가지" content={CARDNEWS} mode="editorial" styleId="azure" formatId="ig-portrait" />

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>★ PNG 출력 — 리포트 5 · 카드뉴스 5 · 포스터 3 (실이미지 주입)</h2>
      <div data-png="report"><Deck label="genre=report · indigo · 16:9 · 5장 (표지 풀블리드 이미지)" content={REPORT_SAMPLE} mode="editorial" styleId="indigo" formatId="widescreen" images={["/trex-samples/c1.png", undefined, undefined, undefined, undefined]} /></div>
      <div data-png="cardnews"><Deck label="genre=cardnews · sky · 4:5 · 5장" content={CARDNEWS_SAMPLE} mode="editorial" styleId="sky" formatId="ig-portrait" images={["/trex-samples/c1.png", "/trex-samples/c2.png", undefined, "/trex-samples/c1.png", undefined]} /></div>
      <div data-png="poster"><Deck label="genre=advertise · red · 9:16 · 3장" content={POSTER_SAMPLE} mode="editorial" styleId="red" formatId="story" images={["/trex-samples/p1.png", "/trex-samples/p2.png", "/trex-samples/p3.png"]} /></div>

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>①-h ENGLISH — advertise + cardnews (영어 타이포/오버플로)</h2>
      <Deck label="genre=advertise · EN · coral · story 9:16" content={AD_EN} mode="editorial" styleId="coral" formatId="story" locale="en" />
      <Deck label="genre=cardnews · EN · azure · ig-portrait 4:5" content={CARDNEWS_EN} mode="editorial" styleId="azure" formatId="ig-portrait" locale="en" />

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>② 방향 인지 — 같은 콘텐츠, 세로/정사각</h2>
      <Deck label="story 9:16 (portrait)  ·  표지·구조·과정·클로징" content={FULL} mode="editorial" formatId="story" only={[0, 4, 5, 7]} />
      <Deck label="ig-square 1:1 (square)  ·  표지·지표·구조·클로징" content={FULL} mode="editorial" formatId="ig-square" only={[0, 2, 4, 7]} />
      <Deck label="A4 세로 (print portrait)  ·  표지·목차·구조" content={FULL} mode="diagrammatic" formatId="a4" only={[0, 1, 4]} />

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>③ 긴 텍스트 스트레스 — 클리핑/오버플로 임계(LLM 변동 대비)</h2>
      <Deck label="STRESS editorial  ·  9장 전체" content={STRESS} mode="editorial" />
      <Deck label="STRESS story 9:16  ·  표지·구조·과정" content={STRESS} mode="editorial" formatId="story" only={[0, 4, 5]} />
      <Deck label="STRESS timeline · swiss · 4단계 긴 텍스트 + note(번호핀 겹침 회귀)" content={{ title: "타임라인 겹침 스트레스", subtitle: "4단계 × 2문장 + 하단 인사이트", slides: [
        { role: "process", title: "4단계 로드맵으로 시장을 점유합니다", layout: "timeline", dek: "빌더 생태계에서 엔터프라이즈 매출로 넘어가는 18개월 계획", steps: [
          { label: "빌더 확보", text: "글로벌 개발자 해커톤을 개최합니다. **초기 핵심 에이전트 1,000개** 확보가 목표입니다." },
          { label: "에코시스템", text: "평가 및 평판 시스템을 도입합니다. 우수한 에이전트가 자연스럽게 상위에 노출되도록 유도합니다." },
          { label: "비즈니스", text: "엔터프라이즈 전용 패키지를 출시합니다. 대기업의 기간계 시스템과 연동하는 솔루션을 제공합니다." },
          { label: "스케일업", text: "글로벌 솔루션 파트너십을 체결합니다. 전 세계 엔터프라이즈 시장으로 판매망을 동시 다발적으로 확장합니다." },
        ], note: "개발자 생태계 구축을 시작으로 엔터프라이즈 매출처를 다변화하여 시장 리더십을 굳히겠습니다." },
      ] }} mode="editorial" styleId="swiss" only={[1]} />

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>④ 개수 적응형 — KPI/카드 2개·4개(LLM은 2~4개 반환)</h2>
      <Deck label="KPI 2개 / 카드 2개" content={{ title: "개수 적응형 검증 — 두 항목", subtitle: "2개일 때 가운데 분배되는지", slides: [
        { role: "metrics", title: "두 지표만 있을 때", kpis: [{ value: "84%", label: "첫 번째 지표 설명" }, { value: "2.3배", label: "두 번째 지표 설명" }] },
        { role: "structure", title: "두 축으로 나뉜다", cards: [{ label: "첫 번째 축", text: "이 축이 다루는 범위와 핵심 역할에 대한 설명" }, { label: "두 번째 축", text: "다른 축이 담당하는 영역과 그 중요성 설명" }] },
      ] }} mode="editorial" only={[1, 2]} />
      <Deck label="KPI 4개 / 카드 4개" content={{ title: "개수 적응형 검증 — 네 항목", subtitle: "4개일 때 유실 없이 4열로", slides: [
        { role: "metrics", title: "네 지표를 한눈에", layout: "row", dek: "4분기 연속 개선 — 시장·성장·수익·품질 전 축 상승", kpis: [{ value: "1,240억", label: "시장 규모" }, { value: "+38%", label: "성장률" }, { value: "6.2배", label: "ROI" }, { value: "94점", label: "만족도" }] },
        { role: "structure", title: "네 갈래 구조", layout: "columns", dek: "네 축이 서로 다른 KPI를 책임진다", cards: [{ label: "첫째 축", text: "첫 번째 영역 설명 텍스트" }, { label: "둘째 축", text: "두 번째 영역 설명 텍스트" }, { label: "셋째 축", text: "세 번째 영역 설명 텍스트" }, { label: "넷째 축", text: "네 번째 영역 설명 텍스트" }] },
      ] }} mode="editorial" styleId="vignelli" only={[1, 2]} />

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>⑤ 장수 극단 — 결정적 생성기(스캐폴드)</h2>
      <Deck label="count=3 (MIN)  ·  deterministic" deck={generateDeck("최소 장수 테스트 — 핵심만", "editorial", 3)} />
      <Deck label="count=14 (MAX)  ·  deterministic 표지·중간·클로징" deck={generateDeck("최대 장수 스트레스 테스트 — 여러 역할 회전", "editorial", 14)} only={[0, 1, 6, 10, 13]} />

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>⑥ Style DNA — 6개 디자인 유파 × 같은 콘텐츠(표지·목차·지표·구조·핵심·클로징)</h2>
      {STYLE_IDS.map((sid) => (
        <Deck key={sid} label={`style=${sid} (${STYLES[sid].nameKo})  ·  ${STYLES[sid].hintKo}`} content={FULL} mode="editorial" styleId={sid} only={[0, 1, 2, 3, 4, 5, 6, 7]} />
      ))}
      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>⑥-b 컨설팅 고밀도 2패널(실적→성과) — 중기부 업무보고 밀도</h2>
      <Deck label="consulting · twopanel · 실적/성과 각 4행 + 화살표 + 인사이트" content={{ title: "규제 완화로 **초기 수요**가 실제로 열렸다", slides: [
        { role: "structure", layout: "twopanel", title: "규제 완화로 **초기 수요**가 실제로 열렸다", dek: "2026년 실외이동로봇 보도 통행 전면 허용 이후 6개월", src: "출처: 내부 파일럿 데이터, 2026.06", panels: [
          { title: "실적", rows: [
            { label: "규제", text: "보도 통행 **전면 허용** 시행", sub: "실외이동로봇법 개정, 2026.01" },
            { label: "파일럿", text: "규제 특구 3곳에서 **누적 12만 건** 배달 수행", sub: "대학·대단지 중심, 완주율 97.4%" },
            { label: "제휴", text: "배달 플랫폼 2사와 **API 연동** 완료", sub: "주문 인입 자동 라우팅" },
            { label: "단가", text: "건당 운영비 **1,800원 절감** 달성", sub: "인건비 대비 임계점 돌파" },
          ] },
          { title: "성과", rows: [
            { label: "수요", text: "월 주문량 **전월비 +38%** 성장 지속", sub: "3개월 연속 두 자릿수" },
            { label: "만족", text: "이용자 재사용률 **71%** 기록", sub: "N=2,400, 2026.05" },
            { label: "안전", text: "사고율 **0.02%** 이하 유지", sub: "보험 손해율 업계 최저" },
            { label: "확장", text: "다음 분기 **거점 5곳 추가** 확정", sub: "비수도권 3곳 포함" },
          ] },
        ], note: "규제·수요·안전 3개 관문을 모두 통과했다 — **전국 확산 투자를 집행할 근거**가 확보됐다." },
      ] }} mode="editorial" styleId="consulting" />
      <Deck label="consulting · twopanel STRESS · 5행 + 긴 문장 + 긴 부연(오버플로 방어 회귀)" content={{ title: "긴 문장에서도 패널이 넘치지 않아야 한다", slides: [
        { role: "structure", layout: "twopanel", title: "긴 문장에서도 패널이 넘치지 않아야 한다", dek: "행 수가 많고 각 문장이 길어질 때의 오버플로 임계 검증", src: "출처: 스트레스 테스트 픽스처, 2026", panels: [
          { title: "현황 — 다층 공급망의 구조적 취약성", rows: [
            { label: "가시성", text: "다단계 공급망 전 구간에 걸친 실시간 데이터 연계가 부재하여 **예외 상황 감지가 지연**되고 있다", sub: "1~3차 협력사 데이터 연계율 34%에 불과, 나머지는 수기 취합 의존" },
            { label: "재고정책", text: "수요예측 정확도가 낮아 안전재고를 과다 보유하면서도 **결품이 반복**되는 이중 손실 구조", sub: "평균 현금전환주기 127일로 운전자본 부담 과중" },
            { label: "소싱", text: "핵심 부품의 단일 소싱 의존도가 높아 특정 지역 교란에 **전 라인이 멈추는 리스크**에 노출", sub: "상위 5개 부품 중 4개가 단일 공급사" },
            { label: "거버넌스", text: "유사시 의사결정 권한과 에스컬레이션 경로가 사전에 정의되지 않아 **초기 대응이 느리다**", sub: "72시간 골든타임 내 대체계획 실행률 41%" },
            { label: "가시성2", text: "협력사 재무건전성 모니터링 체계가 없어 **공급 중단을 선제적으로 예측하지 못한다**", sub: "최근 2년 공급 중단 사고 9건 전부 사후 인지" },
          ] },
          { title: "개선 — 18개월 회복탄력성 내재화", rows: [
            { label: "진단", text: "핵심 품목의 다단계 공급망을 매핑하고 **리스크 익스포저를 정량화**하는 초기 6개월", sub: "데이터 연계 기반 우선 구축" },
            { label: "이중화", text: "우선순위 품목부터 대체 소싱과 지역 이중화를 실행하고 **안전재고 정책을 재설계**", sub: "중기 6개월, 총소유비용 기준 판단" },
            { label: "자동화", text: "시나리오 시뮬레이션을 상시화하고 **조기경보 자동화**와 협업 체계를 정착", sub: "후기 6개월, 디지털 트윈 활용" },
            { label: "협업", text: "공급업체와 리스크 정보를 공유하고 **공동 대응 프로토콜**을 표준화한다", sub: "핵심 40개사 우선 적용" },
            { label: "성과목표", text: "정시납품률을 회복하고 대체계획 실행 리드타임을 **72시간에서 24시간으로 단축**", sub: "18개월 후 KPI 목표" },
          ] },
        ], note: "가시성·유연성·거버넌스 3축을 동시에 강화해야 **불확실성 시대의 생존 역량**이 확보된다." },
      ] }} mode="editorial" styleId="consulting" />

      <h2 style={{ fontSize: 15, fontWeight: 900, margin: "24px 0 14px" }}>⑦ Style DNA × 방향 — 세로/정사각 회귀</h2>
      <Deck label="swiss · story 9:16" content={FULL} mode="editorial" styleId="swiss" formatId="story" only={[0, 2, 4, 7]} />
      <Deck label="didot · ig-square 1:1" content={FULL} mode="editorial" styleId="didot" formatId="ig-square" only={[0, 2, 4, 7]} />
      <Deck label="brutal · A4 세로" content={FULL} mode="editorial" styleId="brutal" formatId="a4" only={[0, 4, 7]} />
    </div>
  );
}
