import { getClientAccount } from "@/features/client/queries";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { ChangePasswordForm } from "@/features/auth/ChangePasswordForm";

export default async function ClientAccountPage() {
  const account = await getClientAccount();
  const fullName = [account.firstName, account.lastName].filter(Boolean).join(" ") || "—";

  return (
    <div className="mx-auto flex max-w-[700px] flex-col gap-6 p-6 md:p-8">
      <PageHeader title="Mon compte" />

      <Card className="flex flex-col gap-4 p-6">
        <div>
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Nom</span>
          <p className="mt-1 text-sm text-ink">{fullName}</p>
        </div>
        <div>
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Email</span>
          <p className="mt-1 text-sm text-ink">{account.email}</p>
        </div>
        <div>
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Établissement</span>
          <p className="mt-1 text-sm text-ink">{account.hotelName}</p>
        </div>
      </Card>

      <Card className="p-6">
        <span className="mb-4 block text-2xs font-medium uppercase tracking-wide text-body/65">Changer de mot de passe</span>
        <ChangePasswordForm />
      </Card>
    </div>
  );
}
