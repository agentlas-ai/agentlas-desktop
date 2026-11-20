"use client";

// "Account connections - the phone and every computer use them together": the section of the existing connector list (Customize > Connectors > Mine) that shows
// where a service is used from and by which road (decision reuse of the existing screen; design CONNECTOR-ROUTING-API-FIRST 6.2).
// No judgment here: the rows come from Main (electron/connectors/install.ts rows(), shared/connector-route-view.ts), already grouped and with the road in use as a closed word.
// Read-only: an account connection is connected and removed on the phone; another computer's roads are shown, not changed. With the routing switch off (or an older Main that has no
// answer) the section does not render at all, so the screen is exactly what it was.
import { useEffect, useState } from "react";
import { ToolLogo } from "./ToolLogo";
import { CollapsedRows, Section, type RowData } from "./DetailParts";
import { ROUTE_VIEW_GROUP_ORDER, type RouteViewGroup, type RouteViewRow, type RouteViewWay } from "@shared/connector-route-view";

const WAY: Record<RouteViewWay, [string, string]> = {
  login: ["로그인", "Sign-in"], key: ["키", "Key"], remote: ["원격", "Hosted"], program: ["이 컴퓨터의 프로그램", "This computer's program"], file: ["동기화 폴더", "Synced folder"],
  app_script: ["앱 스크립트", "App scripting"], browser: ["로그인된 브라우저", "Signed-in browser"], other_desktop: ["다른 컴퓨터", "Another computer"], phone: ["폰", "Phone"],
};
const GROUP: Record<RouteViewGroup, [string, string]> = {
  account: ["계정 연결 — 폰과 모든 컴퓨터가 함께 써요", "Account connections - the phone and every computer use them"],
  "this-desktop": ["이 컴퓨터에서", "On this computer"],
  "other-desktop": ["다른 컴퓨터에서 (보기만)", "On another computer (view only)"],
  "phone-only": ["폰에서만 (폰 에이전트에게 맡겨요)", "Only on the phone (the phone agent takes it)"],
};

type RouteViewBridge = { connectors?: { routeView?: () => Promise<RouteViewRow[]> } };

export function AccountConnectorsSection({ ko }: { ko: boolean }) {
  const [rows, setRows] = useState<RouteViewRow[]>([]);
  useEffect(() => {
    let active = true;
    const read = typeof window === "undefined" ? undefined : (window.agentlas as unknown as RouteViewBridge | undefined)?.connectors?.routeView;
    if (!read) return;
    void read().then((value) => { if (active && Array.isArray(value)) setRows(value); }).catch(() => { if (active) setRows([]); });
    return () => { active = false; };
  }, []);
  const groups = ROUTE_VIEW_GROUP_ORDER.map((group) => ({ group, items: rows.filter((row) => row.group === group) })).filter((entry) => entry.items.length > 0);
  if (!groups.length) return null;
  return <>
    {groups.map(({ group, items }) => {
      const data: RowData[] = items.map((row) => ({
        key: `acct-${group}-${row.id}`,
        icon: <ToolLogo catalogId={row.id} name={row.name} frame="row" size={30} />,
        name: row.name,
        sub: `${ko ? "쓰는 길: " : "Used via: "}${WAY[row.way][ko ? 0 : 1]}`,
      }));
      return <Section key={group} title={GROUP[group][ko ? 0 : 1]} count={items.length}><CollapsedRows rows={data} ko={ko} /></Section>;
    })}
  </>;
}
