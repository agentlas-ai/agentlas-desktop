"use client";

import { useEffect, useState } from "react";
import { ipc } from "@/lib/ipc";
import { navigate } from "@/lib/navigation";
import type { Automation } from "@/lib/types";

export function AutomationRail({ currentId, locale }: { currentId: string; locale: "ko" | "en" }) {
  const ko = locale === "ko";
  const [items, setItems] = useState<Automation[]>([]);
  useEffect(() => { void ipc()?.automations.list().then(setItems).catch(() => setItems([])); }, []);
  return <aside className="automation-rail titlebar-nodrag">
    <div className="automation-rail-head"><strong>{ko ? "자동화" : "Automations"}</strong><button type="button" onClick={() => navigate("/automation/new")}>＋</button></div>
    <nav>{items.map((item) => <button key={item.id} type="button" data-active={item.id === currentId} onClick={() => navigate(`/automation/flow?id=${encodeURIComponent(item.id)}`)}><span data-enabled={item.enabled ? "true" : "false"} /><strong>{item.name}</strong></button>)}</nav>
  </aside>;
}
