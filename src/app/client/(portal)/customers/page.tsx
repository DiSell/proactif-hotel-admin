import Link from "next/link";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { CreateCustomerForm } from "@/features/loyalty/CreateCustomerForm";
import { CsvImportWizard } from "@/features/loyalty/CsvImportWizard";
import { getCustomers } from "@/features/loyalty/queries";

export default async function CustomersPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const search = typeof params.q === "string" ? params.q : "";
  const { customers, lastStay } = await getCustomers(search);

  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-6 p-6 md:p-8">
      <PageHeader title="Clients" subtitle="Fichier clients, séjours et préférences de communication." />

      <Card className="p-5">
        <form className="flex gap-2">
          <input name="q" defaultValue={search} placeholder="Rechercher un nom ou un email" className="h-10 flex-1 rounded-lg border border-border px-3 text-xs" />
          <button className="rounded-lg bg-ink px-4 text-xs text-canvas">Rechercher</button>
        </form>
      </Card>

      <Card className="p-5">
        <h2 className="mb-4 text-sm font-semibold">Nouveau client</h2>
        <CreateCustomerForm />
      </Card>

      <Card className="p-5">
        <h2 className="mb-4 text-sm font-semibold">Import CSV</h2>
        <CsvImportWizard />
      </Card>

      <Card className="overflow-hidden">
        {customers.length === 0 ? (
          <p className="p-5 text-xs text-body">Aucun client.</p>
        ) : (
          customers.map((customer) => (
            <Link key={customer.id} href={`/client/customers/${customer.id}`} className="grid grid-cols-2 gap-3 border-b border-border px-5 py-4 last:border-0 md:grid-cols-5">
              <span className="text-xs font-medium">{[customer.first_name, customer.last_name].filter(Boolean).join(" ") || "Sans nom"}</span>
              <span className="text-xs">{customer.email || "—"}</span>
              <span className="text-xs">{customer.phone || "—"}</span>
              <span className="text-xs">{lastStay[customer.id] || "—"}</span>
              <span>
                {customer.customer_unsubscribed ? (
                  <StatusBadge label="Désinscrit" tone="danger" />
                ) : customer.hotel_excluded ? (
                  <StatusBadge label="Exclu" tone="warning" />
                ) : customer.marketing_allowed ? (
                  <StatusBadge label="Marketing autorisé" tone="success" />
                ) : (
                  <StatusBadge label="Non autorisé" tone="neutral" />
                )}
              </span>
            </Link>
          ))
        )}
      </Card>
    </div>
  );
}
