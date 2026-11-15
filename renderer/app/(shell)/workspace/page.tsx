"use client";

import { Suspense } from "react";
import { Space } from "@/components/space/Space";
import { SpaceDeepLink } from "@/components/space/SpaceDeepLink";

export default function WorkspacePage() {
  return (
    <>
      <Suspense fallback={null}><SpaceDeepLink /></Suspense>
      <Space />
    </>
  );
}
