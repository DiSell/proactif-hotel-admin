import { notFound } from "next/navigation";
import { getHotel } from "@/features/hotels/queries";
import { createClient } from "@/lib/supabase/server";
import { listHotelPartners } from "@/features/partners/queries";
import { PartnersManager } from "@/features/partners/PartnersManager";
import { PARTNER_ACTIONS_BACKOFFICE } from "@/features/partners/actionBundles";

export default async function HotelPartnersPage({ params }: PageProps<"/etablissements/[id]/partenaires">) {
  const { id } = await params;
  const hotel = await getHotel(id);
  if (!hotel) notFound();

  // Back-office cookie scope, explicit — listHotelPartners is shared with
  // the client portal and has no default (lib/supabase/cookieScope.ts).
  const partners = await listHotelPartners(id, await createClient());

  return (
    <div className="flex flex-col gap-6 pb-8">
      <div>
        <h2 className="text-lg font-semibold text-ink">Partenaires</h2>
        <p className="mt-1 text-xs text-body">
          Gérez la liste des partenaires locaux pour le compte de {hotel.name} — restaurants, taxis, activités, commerces…
        </p>
      </div>
      <PartnersManager hotelId={id} partners={partners} actions={PARTNER_ACTIONS_BACKOFFICE} />
    </div>
  );
}
