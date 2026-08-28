import { notFound } from "next/navigation";
import { getHotel } from "@/features/hotels/queries";
import { createClient } from "@/lib/supabase/server";
import { getPhotosManagerData } from "@/features/photos/queries";
import { PhotosManager } from "@/features/photos/PhotosManager";
import { PHOTO_ACTIONS_BACKOFFICE } from "@/features/photos/actionBundles";

export default async function HotelPhotosPage({ params }: PageProps<"/etablissements/[id]/photos">) {
  const { id } = await params;
  const hotel = await getHotel(id);
  if (!hotel) notFound();

  // Back-office cookie scope, explicit — getPhotosManagerData is shared
  // with the client portal and has no default (lib/supabase/cookieScope.ts).
  const data = await getPhotosManagerData(id, await createClient());

  return (
    <div className="flex flex-col gap-6 pb-8">
      <div>
        <h2 className="text-lg font-semibold text-ink">Photos</h2>
        <p className="mt-1 text-xs text-body">
          {hotel.photo_management === "proactif"
            ? "Ce client a délégué la gestion des photos à Proactif System — vous pouvez sélectionner les photos à sa place."
            : "Ce client gère lui-même ses photos depuis son portail. Vous pouvez consulter ses choix ici, en lecture ou en ajustement ponctuel."}
        </p>
      </div>
      <PhotosManager hotelId={id} accommodations={data.accommodations} actions={PHOTO_ACTIONS_BACKOFFICE} />
    </div>
  );
}
