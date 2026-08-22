"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { logout } from "@/features/auth/actions";

interface RecentHotel {
  id: string;
  name: string;
  status: string;
}

interface SidebarNavProps {
  hotelsCount: number;
  recentHotels: RecentHotel[];
  userEmail: string;
}

const NAV_ITEMS = [
  {
    href: "/dashboard",
    label: "Tableau de bord",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="3" width="7" height="7" rx="1.5" />
        <rect x="14" y="14" width="7" height="7" rx="1.5" />
        <rect x="3" y="14" width="7" height="7" rx="1.5" />
      </svg>
    ),
  },
  {
    href: "/etablissements",
    label: "Établissements",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="3" width="11" height="18" rx="1" />
        <path d="M8 8h3M8 12h3M8 16h3" />
        <path d="M15 21v-7h5v7" />
      </svg>
    ),
  },
];

function NavContent({ hotelsCount, recentHotels, userEmail }: SidebarNavProps) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col bg-ink py-6">
      <div className="mb-8 flex items-center gap-2 px-6">
        <div className="h-[22px] w-[22px] shrink-0 rounded-md bg-accent" />
        <span className="text-sm font-semibold text-canvas">Proactif System</span>
      </div>

      <nav className="flex flex-col gap-0.5 px-3">
        {NAV_ITEMS.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(`${item.href}/`);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex items-center gap-2 rounded-lg border-l-2 py-2 pl-3 pr-3 text-xs font-medium text-canvas ${
                isActive ? "border-accent bg-white/6 opacity-100" : "border-transparent opacity-70 hover:bg-white/3 hover:opacity-90"
              }`}
            >
              {item.icon}
              <span className="hidden xl:inline">{item.label}</span>
              {item.href === "/etablissements" && (
                <span className="ml-auto hidden text-2xs opacity-70 xl:inline">{hotelsCount}</span>
              )}
            </Link>
          );
        })}
      </nav>

      <div className="mt-6 hidden px-6 xl:block">
        <p className="mb-3 text-2xs font-medium uppercase tracking-wide text-canvas/40">Établissements</p>
        <div className="flex flex-col gap-0.5">
          {recentHotels.map((hotel) => (
            <Link
              key={hotel.id}
              href={`/etablissements/${hotel.id}`}
              className="flex items-center gap-2 py-1.5 text-xs text-canvas/85"
            >
              <span
                className="h-1.5 w-1.5 shrink-0 rounded-full"
                style={{
                  backgroundColor: hotel.status === "active" ? "var(--color-success)" : "transparent",
                  border: hotel.status === "active" ? undefined : "1px solid rgba(246,243,238,.5)",
                }}
              />
              <span className="truncate">{hotel.name}</span>
            </Link>
          ))}
          {recentHotels.length === 0 && <p className="text-2xs text-canvas/40">Aucun établissement pour l’instant</p>}
        </div>
        <Link href="/etablissements" className="mt-2 block text-xs text-canvas/50">
          Voir les {hotelsCount} →
        </Link>
      </div>

      <div className="flex-1" />

      <div className="px-3">
        <form action={logout}>
          <button
            type="submit"
            className="flex w-full items-center gap-2 rounded-lg py-2 pl-3 pr-3 text-xs font-medium text-canvas opacity-70 hover:bg-white/3 hover:opacity-90"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4" />
              <path d="M16 17l5-5-5-5M21 12H9" />
            </svg>
            <span className="hidden xl:inline">Se déconnecter</span>
          </button>
        </form>
        <div className="mt-3 hidden items-center gap-2 rounded-lg bg-white/4 px-3 py-2 xl:flex">
          <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-accent text-2xs font-semibold text-canvas">
            {userEmail.slice(0, 2).toUpperCase()}
          </div>
          <div className="min-w-0 leading-tight">
            <p className="truncate text-xs font-medium text-canvas">{userEmail}</p>
            <p className="text-2xs text-canvas/50">Admin</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function SidebarNav(props: SidebarNavProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      {/* Desktop rail: full width >=1280px, icon-only 1024–1279px */}
      <aside className="hidden w-16 shrink-0 lg:block xl:w-[248px]">
        <div className="fixed inset-y-0 w-16 xl:w-[248px]">
          <NavContent {...props} />
        </div>
      </aside>

      {/* Mobile top bar */}
      <div className="flex items-center justify-between border-b border-border bg-surface px-4 py-3 lg:hidden">
        <button
          type="button"
          onClick={() => setIsOpen(true)}
          aria-label="Ouvrir le menu"
          className="flex h-9 w-9 items-center justify-center rounded-lg text-ink"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 6h16M4 12h16M4 18h16" />
          </svg>
        </button>
        <span className="text-xs font-semibold">Proactif System</span>
        <div className="w-9" />
      </div>

      {/* Mobile drawer */}
      {isOpen && (
        <div className="fixed inset-0 z-50 lg:hidden">
          <div className="absolute inset-0 bg-ink/40" onClick={() => setIsOpen(false)} />
          <div className="absolute inset-y-0 left-0 w-[248px]">
            <NavContent {...props} />
          </div>
          <button
            type="button"
            onClick={() => setIsOpen(false)}
            aria-label="Fermer le menu"
            className="absolute right-4 top-4 flex h-8 w-8 items-center justify-center rounded-lg bg-surface text-ink"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </>
  );
}
