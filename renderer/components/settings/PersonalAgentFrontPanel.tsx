"use client";

import { useT } from "@/lib/i18n";
import { OneFrontSetting, useOneFront } from "@/components/one/PersonalOneFront";

/**
 * Settings: where the personal agent's fast replies are processed. Off by default (the runtime the owner chose); turning it
 * on shows the one-time notice here and only takes effect once it is confirmed. See shared/one-front.ts.
 */
export function PersonalAgentFrontPanel() {
  const { locale } = useT();
  const ko = locale !== "en";
  const controller = useOneFront();
  // Nothing to offer in a build without the bridge (a browser preview, an older preload).
  if (!controller.view && !controller.failed) return null;
  return (
    <section data-personal-agent-front-panel="true">
      <h2 style={{ fontFamily: "var(--font-head)", fontSize: 15, margin: "28px 0 12px" }}>
        {ko ? "개인 에이전트" : "Personal agent"}
      </h2>
      <OneFrontSetting controller={controller} locale={ko ? "ko" : "en"} withNotice />
    </section>
  );
}
