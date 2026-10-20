"use client";

import { useCallback, useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { markPlanPickerHost, PLAN_PICKER_OPEN_EVENT, type PlanPickerRequest } from "@/lib/plan-picker";

const PlanPickerModal = dynamic(() => import("./PlanPickerModal").then((module) => module.PlanPickerModal), { ssr: false });

/** Keep the event listener ready on every route; load the plan UI on first use. */
export function PlanPickerHost() {
  const [request, setRequest] = useState<PlanPickerRequest | null>(null);
  const [requested, setRequested] = useState(false);
  useEffect(() => {
    const onOpen = (event: Event) => {
      const detail = (event as CustomEvent<PlanPickerRequest>).detail;
      setRequested(true);
      setRequest({ source: detail?.source ?? "other" });
    };
    window.addEventListener(PLAN_PICKER_OPEN_EVENT, onOpen);
    markPlanPickerHost(true);
    return () => {
      window.removeEventListener(PLAN_PICKER_OPEN_EVENT, onOpen);
      markPlanPickerHost(false);
    };
  }, []);
  const close = useCallback(() => setRequest(null), []);
  return requested ? <PlanPickerModal open={request !== null} source={request?.source ?? "other"} onClose={close} /> : null;
}
