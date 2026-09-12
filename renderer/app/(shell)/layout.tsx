import { AppShell } from "@/components/AppShell";
import { OllamaMigrationBridge } from "@/components/OllamaMigrationBridge";

export default function ShellLayout({ children }: { children: React.ReactNode }) {
  return <AppShell><OllamaMigrationBridge />{children}</AppShell>;
}
