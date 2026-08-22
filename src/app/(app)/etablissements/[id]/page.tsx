import { notFound } from "next/navigation";
import { getHotel } from "@/features/hotels/queries";
import { HotelInfoForm } from "@/features/hotels/HotelInfoForm";
import { Card } from "@/components/ui/Card";
import { Button } from "@/components/ui/Button";

export default async function HotelOverviewPage({ params }: PageProps<"/etablissements/[id]">) {
  const { id } = await params;
  const hotel = await getHotel(id);
  if (!hotel) notFound();

  return (
    <div className="grid grid-cols-1 gap-6 pb-8 lg:grid-cols-[1fr_360px]">
      <Card className="p-6">
        <h2 className="mb-4 text-sm font-medium text-ink">Informations générales</h2>
        <HotelInfoForm hotel={hotel} />
      </Card>

      <div className="flex flex-col gap-6">
        <Card className="p-6">
          <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Assistant</span>
          <p className="mt-2 text-sm">{hotel.assistant_name || "Non configuré"}</p>
          <Button href={`/etablissements/${hotel.id}/assistant`} variant="ghost" className="mt-2 w-fit px-0">
            Configurer →
          </Button>
        </Card>

        {(hotel.booking_url || hotel.spa_booking_url) && (
          <Card className="p-6">
            <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Liens de réservation</span>
            <div className="mt-2 flex flex-col gap-1">
              {hotel.booking_url && (
                <a href={hotel.booking_url} target="_blank" rel="noreferrer" className="text-xs font-medium text-accent">
                  Réservation ↗
                </a>
              )}
              {hotel.spa_booking_url && (
                <a href={hotel.spa_booking_url} target="_blank" rel="noreferrer" className="text-xs font-medium text-accent">
                  Spa ↗
                </a>
              )}
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
