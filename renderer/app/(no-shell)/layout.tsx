import { MenuBridge } from "@/components/MenuBridge";

// 캔버스/QA 전용 화면은 앱 셸 없이 렌더하되, 네이티브 메뉴와 확장 뷰의
// 복귀 요청은 기존 앱 라우터로 받을 수 있어야 한다.
export default function NoShellLayout({ children }: { children: React.ReactNode }) {
  return <><MenuBridge />{children}</>;
}
