"use client";
import { useT } from "@/lib/i18n";
import { ScienceInstallExperience } from "./ScienceInstallExperience";
import { SCIENCE_INSTALL_DISCOVERY_ENABLED } from "@/lib/science-install-entry";

/**
 * 앱 셸 없는 화면(One·Science)에서도 "Science 설치" 요청을 받는 자리.
 *
 * ★QA 실측 2026-09-08: One 좌상단 제품 메뉴에서 Science 를 누르면 **아무 일도 일어나지
 * 않았다.** 두 번 눌러도 안내도 오류도 이동도 없다. 라벨은 "켜기 필요"라고 말하면서
 * 켜는 길을 주지 않는 상태였다.
 *
 * 원인은 화면이 아니라 자리다. requestScienceInstall() 은 창 이벤트를 쏘기만 하고,
 * 그것을 듣는 ScienceInstallExperience 는 AppShell 안에만 걸려 있었다. One 과 Science 는
 * `(no-shell)` 그룹이라 AppShell 이 없다 — 이벤트는 나가는데 들을 사람이 없었다.
 *
 * eligible={false} 로 둔다: 이 화면들에서 **자동으로 권하지는 않고**, 사람이 눌렀을 때만
 * 연다. 자동 제안은 eligible 을 보지만 이벤트로 여는 길은 그것과 무관하다.
 */
export function ScienceInstallEntryHost() {
  const { locale } = useT();
  if (!SCIENCE_INSTALL_DISCOVERY_ENABLED) return null;
  return <ScienceInstallExperience eligible={false} locale={locale === "ko" ? "ko" : "en"} />;
}
