"use client";

import { useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import type { Hotel } from "@/types/database";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { EmptyState } from "@/components/ui/EmptyState";
import { StatusDot } from "@/components/ui/StatusBadge";
import { LanguagePills } from "@/components/ui/LanguagePills";
import { Button } from "@/components/ui/Button";

const STATUS_LABEL: Record<Hotel["status"], { label: string; tone: "success" | "neutral" | "warning" }> = {
  active: { label: "Actif", tone: "success" },
  inactive: { label: "Inactif", tone: "neutral" },
  draft: { label: "Brouillon", tone: "warning" },
};

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(diffMs / 60000);
  if (minutes < 1) return "à l’instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  const days = Math.floor(hours / 24);
  return `il y a ${days} j`;
}

export function HotelsExplorer({ hotels }: { hotels: Hotel[] }) {
  const router = useRouter();
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"all" | Hotel["status"]>("all");
  const [languageFilter, setLanguageFilter] = useState<string>("all");

  const availableLanguages = useMemo(() => {
    const set = new Set<string>();
    hotels.forEach((hotel) => hotel.languages.forEach((lang) => set.add(lang)));
    return Array.from(set).sort();
  }, [hotels]);

  const filtered = useMemo(() => {
    return hotels.filter((hotel) => {
      const matchesSearch =
        search.trim().length === 0 ||
        hotel.name.toLowerCase().includes(search.toLowerCase()) ||
        (hotel.city ?? "").toLowerCase().includes(search.toLowerCase());
      const matchesStatus = statusFilter === "all" || hotel.status === statusFilter;
      const matchesLanguage = languageFilter === "all" || hotel.languages.includes(languageFilter);
      return matchesSearch && matchesStatus && matchesLanguage;
    });
  }, [hotels, search, statusFilter, languageFilter]);

  if (hotels.length === 0) {
    return (
      <EmptyState
        title="Aucun établissement pour l’instant."
        description="Ajoutez votre premier hôtel pour configurer son assistant."
        action={
          <Button variant="primary" href="/etablissements/nouveau">
            + Ajouter un établissement
          </Button>
        }
      />
    );
  }

  const columns: DataTableColumn<Hotel>[] = [
    {
      header: "Établissement",
      render: (hotel) => (
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-[10px] bg-ink/5 text-xs font-semibold text-ink">
            {hotel.logo_url ? (
              // eslint-disable-next-line @next/next/no-img-element -- external, per-hotel logo
              <img src={hotel.logo_url} alt="" className="h-full w-full object-cover" />
            ) : (
              hotel.name.slice(0, 2).toUpperCase()
            )}
          </div>
          <div className="min-w-0">
            <p className="truncate text-sm font-medium">{hotel.name}</p>
            <p className="truncate text-2xs text-body/70">{(hotel.website ?? "").replace(/^https?:\/\//, "")}</p>
          </div>
        </div>
      ),
    },
    { header: "Ville", width: "130px", render: (hotel) => <span className="text-xs text-body">{hotel.city ?? "—"}</span> },
    { header: "Langues", width: "160px", render: (hotel) => <LanguagePills languages={hotel.languages} /> },
    {
      header: "Assistant",
      width: "110px",
      render: (hotel) => <StatusDot tone={STATUS_LABEL[hotel.status].tone} label={STATUS_LABEL[hotel.status].label} />,
    },
    { header: "Activité", width: "90px", align: "right", render: (hotel) => (
      <span className="text-xs text-body">{relativeTime(hotel.updated_at)}</span>
    ) },
  ];

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative max-w-[280px] flex-1">
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="var(--color-body)"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 opacity-60"
          >
            <circle cx="11" cy="11" r="7" />
            <path d="M21 21l-4.3-4.3" />
          </svg>
          <input
            type="text"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Rechercher…"
            className="h-10 w-full rounded-lg border border-border bg-surface pl-9 pr-3 text-xs outline-none focus:border-ink focus:ring-2 focus:ring-accent/15"
          />
        </div>
        <select
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.target.value as typeof statusFilter)}
          className="h-10 rounded-lg border border-border bg-surface px-3 text-xs"
        >
          <option value="all">Tous les statuts</option>
          <option value="active">Actif</option>
          <option value="inactive">Inactif</option>
          <option value="draft">Brouillon</option>
        </select>
        <select
          value={languageFilter}
          onChange={(event) => setLanguageFilter(event.target.value)}
          className="h-10 rounded-lg border border-border bg-surface px-3 text-xs"
        >
          <option value="all">Toutes les langues</option>
          {availableLanguages.map((lang) => (
            <option key={lang} value={lang}>
              {lang.toUpperCase()}
            </option>
          ))}
        </select>
      </div>

      {filtered.length === 0 ? (
        <EmptyState title="Aucun résultat" description="Essayez une autre recherche ou d’autres filtres." />
      ) : (
        <DataTable
          columns={columns}
          rows={filtered}
          rowKey={(hotel) => hotel.id}
          onRowClick={(hotel) => router.push(`/etablissements/${hotel.id}`)}
        />
      )}
    </div>
  );
}
