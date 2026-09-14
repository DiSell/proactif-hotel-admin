import { notFound } from "next/navigation";
import { PageHeader } from "@/components/layout/PageHeader";
import { Card } from "@/components/ui/Card";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { AddCustomerStayForm } from "@/features/loyalty/AddCustomerStayForm";
import { CustomerCommunicationForm } from "@/features/loyalty/CustomerCommunicationForm";
import { getCustomerDetail } from "@/features/loyalty/queries";

export default async function CustomerPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const data = await getCustomerDetail(id);
  if (!data) notFound();
  const { customer, stays, deliveries } = data;
  const name = [customer.first_name, customer.last_name].filter(Boolean).join(" ") || "Client";

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6 p-6 md:p-8">
      <PageHeader title={name} subtitle="Fiche client" backHref="/client/customers" backLabel="Clients" />

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold">Identité</h2>
        <div className="grid gap-2 text-xs md:grid-cols-2">
          <p>Email : {customer.email || "—"}</p>
          <p>Téléphone : {customer.phone || "—"}</p>
          <p>Source : {customer.source}</p>
          <p>Référence : {customer.external_reference || "—"}</p>
        </div>
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold">Communication</h2>
        <CustomerCommunicationForm
          customerId={customer.id}
          marketingAllowed={customer.marketing_allowed}
          hotelExcluded={customer.hotel_excluded}
          customerUnsubscribed={customer.customer_unsubscribed}
          exclusionReason={customer.exclusion_reason}
        />
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold">Séjours</h2>
        <AddCustomerStayForm customerId={customer.id} />
        {stays.map((stay) => (
          <div key={stay.id} className="flex justify-between border-t border-border py-2 text-xs">
            <span>
              {stay.check_in || "?"} → {stay.check_out}
            </span>
            <StatusBadge label={stay.status} tone={stay.status === "completed" ? "success" : "neutral"} />
          </div>
        ))}
      </Card>

      <Card className="p-5">
        <h2 className="mb-3 text-sm font-semibold">Historique</h2>
        {deliveries.length === 0 ? (
          <p className="text-xs text-body">Aucune communication.</p>
        ) : (
          deliveries.map((delivery) => (
            <div key={delivery.id} className="grid grid-cols-3 border-t border-border py-2 text-xs">
              <span>{delivery.delivery_type}</span>
              <span>{delivery.created_at.slice(0, 10)}</span>
              <StatusBadge label={delivery.status} tone={delivery.status === "sent" ? "success" : delivery.status === "failed" ? "danger" : "neutral"} />
            </div>
          ))
        )}
      </Card>
    </div>
  );
}
