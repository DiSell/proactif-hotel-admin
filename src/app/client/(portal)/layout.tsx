import type { ReactNode } from "react";
import { ClientAppShell } from "@/components/layout/ClientAppShell";

export default function ClientLayout({ children }: { children: ReactNode }) {
  return <ClientAppShell>{children}</ClientAppShell>;
}
