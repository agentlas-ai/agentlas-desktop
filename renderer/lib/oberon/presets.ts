// Oberon — 예제 브리프 프리셋. 영상/영화 문외한도 원클릭으로 시작.

import type { FilmBrief } from "./types";

export interface BriefPreset {
  id: string;
  label: string;
  emoji: string;
  brief: FilmBrief;
}

export const BRIEF_PRESETS: BriefPreset[] = [
  {
    id: "perfume_ad",
    label: "프리미엄 향수 광고",
    emoji: "🌃",
    brief: {
      title: "MIDNIGHT BLOOM",
      format: "commercial_30",
      genre: "commercial",
      aspect: "16:9",
      durationSec: 30,
      logline: "도시의 밤, 한 여인이 향수 한 방울로 군중 속에서 자신만의 빛을 찾는다.",
      synopsis: "네온이 번지는 빗속 거리. 무채색 군중 사이에서 주인공이 향수를 뿌리는 순간, 세계가 그녀를 중심으로 다시 채색된다. 제품 클로즈업과 함께 브랜드 로고로 마무리.",
      audience: "25-40 도시 여성, 프리미엄 뷰티 소비자",
      tone: ["cinematic", "neon", "sleek", "sensual"],
      visualReferences: ["Blade Runner 2049 lighting", "Chanel No.5 film"],
      characters: [
        { name: "ELARA", role: "주연", description: "30대 초반, 어깨 길이 흑발, 실크 슬립 드레스, 차분하고 자신감 있는 눈빛" },
      ],
      setting: "심야의 네온 도시 거리",
      brandOrProduct: "MIDNIGHT BLOOM 향수 (호박색 유리병, 금장 캡)",
      mustInclude: ["향수병 클로즈업", "빗방울", "브랜드 로고 엔드카드"],
      mustAvoid: ["경쟁사 로고", "과도한 노출"],
      language: "ko",
    },
  },
  {
    id: "scifi_trailer",
    label: "SF 단편 트레일러",
    emoji: "🚀",
    brief: {
      title: "THE LAST SIGNAL",
      format: "trailer",
      genre: "scifi",
      aspect: "2.39:1",
      durationSec: 90,
      logline: "지구 최후의 통신 기지에서, 한 엔지니어가 인류의 마지막 신호를 우주로 보낸다.",
      synopsis: "버려진 우주 기지. 고독한 엔지니어가 다가오는 폭풍 속에서 시스템을 재가동한다. 긴장이 고조되며 미지의 응답 신호가 잡히고, 타이틀 카드로 끝난다.",
      audience: "SF 팬, 영화제 출품 관객",
      tone: ["cinematic", "cold", "epic", "tense"],
      visualReferences: ["Interstellar", "Arrival", "Dune"],
      characters: [
        { name: "KAI", role: "주연", description: "40대 엔지니어, 짧은 회색 머리, 닳은 작업복, 지친 결의의 표정" },
      ],
      setting: "버려진 심우주 통신 기지 (실내/관제실)",
      mustInclude: ["홀로그램 인터페이스", "다가오는 우주 폭풍", "타이틀 카드"],
      mustAvoid: ["기존 영화 IP 캐릭터", "실존 인물"],
      language: "ko",
    },
  },
  {
    id: "short_drama",
    label: "단편 드라마 (재회)",
    emoji: "☕",
    brief: {
      title: "비 오는 날의 커피",
      format: "short_drama",
      genre: "drama",
      aspect: "16:9",
      durationSec: 240,
      logline: "10년 만에 카페에서 마주친 두 옛 연인이 끝내지 못한 대화를 다시 시작한다.",
      synopsis: "비 내리는 오후의 작은 카페. 우연히 마주친 두 사람이 어색한 인사 끝에 묻어둔 진심을 꺼낸다. 후회와 용서 사이에서, 그들은 새로운 선택을 한다.",
      audience: "20-40대 드라마 시청자",
      tone: ["warm", "melancholic", "cinematic"],
      visualReferences: ["In the Mood for Love", "Before Sunset"],
      characters: [
        { name: "지오", role: "주연", description: "30대 후반 남성, 단정한 코트, 차분하지만 흔들리는 눈" },
        { name: "수아", role: "주연", description: "30대 중반 여성, 베이지 니트, 따뜻하지만 경계하는 미소" },
      ],
      setting: "비 오는 날의 아늑한 카페 (실내)",
      mustInclude: ["창밖의 비", "두 잔의 커피", "shot/reverse 대화"],
      mustAvoid: ["과한 멜로드라마", "폭력"],
      language: "ko",
    },
  },
  {
    id: "social_short",
    label: "소셜 숏폼 (제품 훅)",
    emoji: "📱",
    brief: {
      title: "3초 만에 빨라진 아침",
      format: "social_short",
      genre: "commercial",
      aspect: "9:16",
      durationSec: 30,
      logline: "바쁜 아침, 스마트 텀블러 하나가 출근 루틴을 바꾼다.",
      synopsis: "알람, 정신없는 아침. 텀블러 버튼 한 번에 완벽한 커피가 완성되고, 주인공이 여유롭게 문을 나선다. 빠른 컷과 자막 친화 구성.",
      audience: "Z세대·밀레니얼 직장인",
      tone: ["energetic", "sleek", "bright"],
      visualReferences: ["Apple product films", "fast-cut TikTok ads"],
      characters: [
        { name: "MINA", role: "주연", description: "20대 후반, 캐주얼 오피스룩, 활기찬 표정" },
      ],
      setting: "모던한 도시 원룸 주방",
      brandOrProduct: "스마트 텀블러 (무광 차콜, 원터치 버튼)",
      mustInclude: ["1초 훅", "원터치 버튼 클로즈업", "CTA 자막"],
      mustAvoid: ["느린 인트로", "경쟁사 브랜드"],
      language: "ko",
    },
  },
];

export function emptyBrief(): FilmBrief {
  return {
    title: "",
    format: "commercial_30",
    genre: "commercial",
    aspect: "16:9",
    durationSec: 30,
    logline: "",
    synopsis: "",
    audience: "",
    tone: [],
    visualReferences: [],
    characters: [],
    setting: "",
    mustInclude: [],
    mustAvoid: [],
    language: "ko",
  };
}
