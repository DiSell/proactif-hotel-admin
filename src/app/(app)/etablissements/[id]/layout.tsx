import { notFound } from "next/navigation";
import { getHotel } from "@/features/hotels/queries";
import { StatusToggle } from "@/features/hotels/StatusToggle";
import { StatusDot } from "@/components/ui/StatusBadge";
import { Button } from "@/components/ui/Button";
import { Tabs } from "@/components/layout/Tabs";

const STATUS_LABEL = { active: "Assistant actif", inactive: "Assistant inactif", draft: "Brouillon" } as const;

export default async function HotelLayout({ children, params }: LayoutProps<"/etablissements/[id]">) {
  const { id } = await params;
  const hotel = await getHotel(id);
  if (!hotel) notFound();

  const tone = hotel.status === "active" ? "success" : hotel.status === "draft" ? "warning" : "neutral";

  return (
    <div className="mx-auto flex max-w-[1440px] flex-col gap-6 p-6 md:p-8">
      <Button href="/etablissements" variant="ghost" className="w-fit px-0">
        ← Établissements
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-ink/5 text-sm font-semibold text-ink">
            {hotel.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element -- external, per-hotel logo
              <img src={hotel.logo_url} alt="" className="h-full w-full object-cover" />
            ) : (
              hotel.name.slice(0, 2).toUpperCase()
            )}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h1 className="text-xl font-semibold text-ink">{hotel.name}</h1>
              <StatusDot tone={tone} label={STATUS_LABEL[hotel.status]} />
              <StatusToggle hotelId={hotel.id} status={hotel.status} />
            </div>
            <p className="mt-1 text-xs text-body">
              {[hotel.city, hotel.country].filter(Boolean).join(", ") || "Ville non renseignée"} ·{" "}
              <a href={hotel.website ?? "#"} target="_blank" rel="noreferrer" className="text-accent">
                {(hotel.website ?? "").replace(/^https?:\/\//, "")} ↗
              </a>{" "}
              · {hotel.languages.map((lang) => lang.toUpperCase()).join(" ")}
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button href={`/etablissements/${hotel.id}/assistant/test`} variant="secondary">
            Tester l’assistant
          </Button>
          <Button href={`/etablissements/${hotel.id}/widget`} variant="secondary">
            Widget
          </Button>
        </div>
      </div>

      <Tabs
        items={[
          { href: `/etablissements/${hotel.id}`, label: "Vue générale" },
          { href: `/etablissements/${hotel.id}/assistant`, label: "Assistant" },
          { href: `/etablissements/${hotel.id}/connaissances`, label: "Connaissances" },
          { href: `/etablissements/${hotel.id}/photos`, label: "Photos" },
          { href: `/etablissements/${hotel.id}/partenaires`, label: "Partenaires" },
          { href: `/etablissements/${hotel.id}/widget`, label: "Widget" },
          { href: `/etablissements/${hotel.id}/whatsapp`, label: "WhatsApp" },
        ]}
      />

      {children}
    </div>
  );
}
