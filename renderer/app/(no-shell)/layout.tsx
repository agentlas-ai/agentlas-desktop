// 캔버스/QA 전용 화면은 앱 셸 없이 렌더한다.
export default function NoShellLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
