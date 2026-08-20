// 호스트 이름을 **등록 가능 도메인(eTLD+1)** 으로 접는다.
//
// 왜 필요한가 (2026-08-20 오너 Chrome 실측, 이름·플래그만 읽음):
//   `.mongodb.com` 쿠키 19개(로그인 후보 0) / `auth.mongodb.com` 4개(로그인 후보 4)
//   `.railway.com` 9개(0)            / `backboard.railway.com` 2개(2)
//   `.play.google.com` 6개(0) / `play.google.com` 3개(2) / `.google.com` 35개(27)
// 호스트를 그대로 한 줄로 두면 "로그인 쿠키가 있는 줄"만 남기는 필터가 **쿠키를 제일 많이
// 가진 줄을 떨어뜨린다.** 그 상태로 가져오면 4개만 복사돼 MongoDB·Railway 로그인이 깨진다.
// 그래서 목록의 한 줄은 호스트가 아니라 사이트(등록 가능 도메인)여야 한다.
//
// 왜 표를 손으로 적는가: 뒤 두 조각으로 자르는 규칙만 쓰면 `fastcampus.co.kr` → `co.kr`,
// `foo.github.io` → `github.io` 가 되어 서로 무관한 사이트가 한 줄로 뭉친다. 전체 공개
// 접미사 목록(PSL)은 1만 줄이 넘고 계속 바뀌어 번들 대상이 아니다. 아래 표는 **의도 판정이
// 아니라 데이터**다(어떤 문자열이 등록 단위인가) — 그래서 하드코딩이 허용된다.
//
// 한계(알고 쓰는 것):
//   - 표는 완전하지 않다. 표에 없는 다단계 접미사를 만나면 아래 휴리스틱이 받고, 그마저
//     못 알아보면 **덜 묶는 쪽**으로 기운다. 과하게 묶여 남의 사이트 쿠키가 한 줄에 섞이는
//     것이, 덜 묶여 사이트가 두 줄로 보이는 것보다 훨씬 나쁘기 때문이다.
//   - 여기서 나오는 값은 화면 표시와 쿠키 그룹핑에만 쓴다. 보안 경계(오리진 판정)로 쓰지 마라.

/**
 * 두 조각 이상인 공개 접미사 — "이 뒤에 한 조각을 더 붙여야 등록 단위"인 것들.
 * 실사용 빈도 위주로만 적는다(한국·일본·영국·호주 계열 + 널리 쓰이는 호스팅 도메인).
 */
const MULTI_LABEL_SUFFIXES = new Set([
  // 한국
  "co.kr", "or.kr", "ne.kr", "go.kr", "re.kr", "pe.kr", "ac.kr", "sc.kr", "hs.kr", "ms.kr", "es.kr",
  // 일본
  "co.jp", "ne.jp", "or.jp", "ac.jp", "go.jp", "lg.jp", "ed.jp", "gr.jp",
  // 영국·아일랜드
  "co.uk", "org.uk", "ac.uk", "gov.uk", "me.uk", "net.uk", "sch.uk",
  // 오세아니아·아시아·아메리카 일반형
  "com.au", "net.au", "org.au", "edu.au", "gov.au", "com.br", "com.cn", "net.cn", "org.cn",
  "com.tw", "com.hk", "com.sg", "com.my", "com.ph", "com.vn", "com.mx", "com.ar", "com.tr",
  "com.co", "com.pe", "com.ua", "com.pl", "com.es", "com.pk", "co.in", "co.il", "co.nz",
  "co.za", "co.th", "co.id", "co.ke", "or.id", "ac.id", "go.id", "gov.hk", "edu.hk",
  // 사용자마다 다른 사이트가 서는 호스팅 도메인 — 여기를 묶으면 남의 사이트와 한 줄이 된다.
  "github.io", "gitlab.io", "pages.dev", "workers.dev", "vercel.app", "netlify.app",
  "herokuapp.com", "web.app", "firebaseapp.com", "appspot.com", "cloudfront.net",
  "s3.amazonaws.com", "blogspot.com", "wordpress.com", "notion.site", "myshopify.com",
  "sharepoint.com", "azurewebsites.net", "on.aws", "ngrok.io", "trycloudflare.com",
]);

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * 표에 없는 접미사를 만났을 때의 보수적 판단.
 * `<짧은조각>.<두글자 ccTLD>` 모양(co.kr·com.au·ne.jp…)은 거의 언제나 공개 접미사다.
 * 이 판정이 틀리면 사이트가 두 줄로 보일 뿐, 남의 쿠키가 섞이지는 않는다(덜 묶는 쪽).
 */
function looksLikeCountrySuffix(secondLast: string, last: string): boolean {
  return last.length === 2 && secondLast.length <= 3;
}

/**
 * 호스트(또는 쿠키 host_key)를 등록 가능 도메인으로 접는다.
 * `.mongodb.com` · `auth.mongodb.com` · `www.mongodb.com` → 전부 `mongodb.com`.
 * `fastcampus.co.kr` 은 `co.kr` 로 접히지 않고 그대로 남는다.
 * 판단할 수 없으면(IP·단일 라벨·빈 문자열) 입력을 정규화만 해서 그대로 돌려준다.
 */
export function registrableDomain(hostOrKey: string): string {
  const host = String(hostOrKey ?? "")
    .trim()
    .toLowerCase()
    .replace(/^\.+/, "")
    .replace(/\.+$/, "");
  if (!host) return "";
  // IP 와 단일 라벨(localhost 등)은 접을 것이 없다.
  if (IPV4.test(host) || host.includes(":") || !host.includes(".")) return host;

  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 2) return labels.join(".");

  // 표에서 가장 긴 접미사부터 맞춰 본다(예: s3.amazonaws.com 이 amazonaws.com 보다 먼저).
  for (let take = Math.min(3, labels.length - 1); take >= 2; take -= 1) {
    const suffix = labels.slice(-take).join(".");
    if (MULTI_LABEL_SUFFIXES.has(suffix)) return labels.slice(-(take + 1)).join(".");
  }

  const last = labels[labels.length - 1];
  const secondLast = labels[labels.length - 2];
  if (looksLikeCountrySuffix(secondLast, last)) return labels.slice(-3).join(".");

  return `${secondLast}.${last}`;
}

/**
 * 도메인에서 사람이 읽는 사이트 이름을 만든다 — `mongodb.com` → "MongoDB".
 *
 * 왜 방문 기록 제목을 안 쓰는가 (2026-08-20 dev QA 실측): 제목은 "마지막에 본 페이지"의
 * 것이라 사이트 이름 구실을 못 한다. 113줄 중 33줄이 도메인 브랜드를 안 담았고, 그중에는
 *   google.com  → "받은편지함 (13,005) - <이메일> - Gmail"   ← 개인정보가 화면에 뜬다
 *   google.co.kr→ "Two-factor authentication · GitHub"      ← 엉뚱한 사이트로 오인
 *   brunch.co.kr→ "특허 청구항 작성방법"                      ← 이름이 아니다
 * 가 있었다. 도메인에서 만들면 항상 맞고, 개인 데이터가 섞이지 않으며, 표도 필요 없다.
 *
 * 알려진 브랜드 표기(카멜케이스 등)는 별도로 두지 않는다 — 그건 다시 손 목록이 되고
 * 빠진 사이트만 어색해진다. 첫 글자만 올리는 규칙이 전 사이트에 고르게 적용된다.
 */
export function siteDisplayName(hostOrKey: string): string {
  const domain = registrableDomain(hostOrKey);
  if (!domain) return "";
  const first = domain.split(".")[0] ?? domain;
  if (!first) return domain;
  // 하이픈·언더바는 낱말 경계로 본다: `app-store` → "App Store".
  return first
    .split(/[-_]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}
