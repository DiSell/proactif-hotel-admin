import type { ReactNode } from "react";
import { createClientPortalClient } from "@/lib/supabase/server";
import { requireClientAccess } from "@/lib/auth/session";
import { ClientSidebarNav } from "./ClientSidebarNav";
import { ToastProvider } from "@/components/ui/Toast";

/**
 * Deliberately NOT a reuse of AppShell.tsx — that one calls
 * requireSuperadmin() unconditionally and renders superadmin-only
 * navigation (Établissements management). This is a structurally
 * separate space: same visual language (Card/Button/Toast/PageHeader),
 * different guard, different nav, no superadmin menu reachable from here
 * at all.
 */
export async function ClientAppShell({ children }: { children: ReactNode }) {
  const { hotelId, profile } = await requireClientAccess();
  const supabase = await createClientPortalClient();

  const { data: hotel } = await supabase.from("hotels").select("name").eq("id", hotelId).single<{ name: string }>();

  return (
    <ToastProvider>
      <div className="flex min-h-dvh bg-canvas">
        <ClientSidebarNav hotelName={hotel?.name ?? "—"} userEmail={profile.email} />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </ToastProvider>
  );
}
