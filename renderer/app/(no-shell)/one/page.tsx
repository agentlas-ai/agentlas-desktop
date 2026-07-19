import { Suspense } from "react";
import { OneShell } from "@/components/one/OneShell";

export default function AgentlasOnePage() {
  return (
    <Suspense fallback={null}>
      <OneShell />
    </Suspense>
  );
}
