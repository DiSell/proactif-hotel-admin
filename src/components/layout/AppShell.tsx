import type { ReactNode } from "react";
import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth/session";
import { SidebarNav } from "./SidebarNav";
import { ToastProvider } from "@/components/ui/Toast";

export async function AppShell({ children }: { children: ReactNode }) {
  const { profile } = await requireSuperadmin();
  const supabase = await createClient();

  const [{ count: hotelsCount }, { data: recentHotels }] = await Promise.all([
    supabase.from("hotels").select("*", { count: "exact", head: true }),
    supabase
      .from("hotels")
      .select("id, name, status")
      .order("updated_at", { ascending: false })
      .limit(3),
  ]);

  return (
    <ToastProvider>
      <div className="flex min-h-dvh bg-canvas">
        <SidebarNav
          hotelsCount={hotelsCount ?? 0}
          recentHotels={recentHotels ?? []}
          userEmail={profile.email}
        />
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    </ToastProvider>
  );
}
