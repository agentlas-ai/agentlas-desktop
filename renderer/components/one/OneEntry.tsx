"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { PersonalOneWorkspace } from "./PersonalOneWorkspace";

// The legacy team/session shell loads only when that route is actually selected.
const LegacyOneShell = dynamic(() => import("./OneShell").then(module => module.OneShell), { ssr: false });

export function OneEntry() {
  const params = useSearchParams();
  return params.get("personal") === "1"
    ? <PersonalOneWorkspace detached={params.get("companion") === "1"} />
    : <LegacyOneShell />;
}
