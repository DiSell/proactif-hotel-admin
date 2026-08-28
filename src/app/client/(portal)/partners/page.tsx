import { requireClientAccess } from "@/lib/auth/session";
import { createClientPortalClient } from "@/lib/supabase/server";
import { listHotelPartners } from "@/features/partners/queries";
import { PartnersManager } from "@/features/partners/PartnersManager";
import { PARTNER_ACTIONS_CLIENT } from "@/features/partners/actionBundles";
import { PageHeader } from "@/components/layout/PageHeader";

export default async function ClientPartnersPage() {
  const { hotelId } = await requireClientAccess();
  // Client-portal cookie scope (lib/supabase/cookieScope.ts) — listHotelPartners
  // is shared with the back-office and defaults to the back-office scope
  // otherwise, which would find no session at all for a client-portal-only login.
  const partners = await listHotelPartners(hotelId, await createClientPortalClient());

  return (
    <div className="mx-auto flex max-w-[900px] flex-col gap-6 p-6 md:p-8">
      <PageHeader
        title="Partenaires"
        subtitle="Les restaurants, taxis, activités et commerces que votre chatbot peut recommander à vos visiteurs — vous seul(e) choisissez ce qui apparaît."
      />
      <PartnersManager hotelId={hotelId} partners={partners} actions={PARTNER_ACTIONS_CLIENT} />
    </div>
  );
}
