import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth/session";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

export default async function DashboardPage() {
  const { profile } = await requireSuperadmin();
  const supabase = await createClient();

  const { count: hotelsCount } = await supabase.from("hotels").select("*", { count: "exact", head: true });
  const { count: activeCount } = await supabase
    .from("hotels")
    .select("*", { count: "exact", head: true })
    .eq("status", "active");

  const firstName = profile.email.split("@")[0];

  return (
    <div className="mx-auto flex max-w-[1440px] flex-col gap-8 p-6 md:p-8">
      <PageHeader
        title={`Bonjour ${firstName}`}
        actions={
          <Button variant="primary" href="/etablissements/nouveau">
            + Ajouter un établissement
          </Button>
        }
      />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Card className="flex flex-col gap-2 p-6">
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Établissements</span>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold">{hotelsCount ?? 0}</span>
            <span className="text-xs text-body">· {activeCount ?? 0} actifs</span>
          </div>
        </Card>
        <Card className="flex flex-col gap-2 p-6">
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Conversations</span>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold">—</span>
            <span className="text-xs text-body">pas encore disponible</span>
          </div>
        </Card>
      </div>

      <Card className="p-6">
        <p className="text-sm text-body">
          Le tableau de bord complet (alertes, activité récente) arrive avec le moteur conversationnel. Pour l’instant,
          gérez vos établissements depuis le menu.
        </p>
      </Card>
    </div>
  );
}
