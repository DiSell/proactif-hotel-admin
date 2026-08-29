"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { clientLogout } from "@/features/auth/actions";

interface ClientSidebarNavProps {
  hotelName: string;
  userEmail: string;
}

const NAV_ITEMS = [
  {
    href: "/client/dashboard",
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
    href: "/client/conversations",
    label: "Conversations",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12c0 4.4-4 8-9 8a10 10 0 01-4-.8L3 20l1-3.8A7.6 7.6 0 013 12c0-4.4 4-8 9-8s9 3.6 9 8z" />
      </svg>
    ),
  },
  {
    href: "/client/chatbot",
    label: "Chatbot",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="4" y="4" width="16" height="12" rx="2" />
        <path d="M9 20h6M12 16v4" />
      </svg>
    ),
  },
  {
    href: "/client/photos",
    label: "Photos",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="5" width="18" height="14" rx="2" />
        <circle cx="8.5" cy="10" r="1.5" />
        <path d="M21 15l-5-5-9 9" />
      </svg>
    ),
  },
  {
    href: "/client/partners",
    label: "Partenaires",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 3.13a4 4 0 010 7.75M21 21v-2a4 4 0 00-3-3.87" />
        <circle cx="9" cy="7" r="4" />
        <path d="M2 21v-2a4 4 0 013-3.87M23 21v-2a4 4 0 00-3-3.87" />
      </svg>
    ),
  },
  {
    href: "/client/requests",
    label: "Demandes partenaires",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M14 3H6a2 2 0 00-2 2v14a2 2 0 002 2h12a2 2 0 002-2V9z" />
        <path d="M14 3v6h6" />
        <path d="M9 13l2 2 4-4" />
      </svg>
    ),
  },
  {
    href: "/client/widget",
    label: "Installation",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M16 18l6-6-6-6M8 6l-6 6 6 6" />
      </svg>
    ),
  },
  {
    href: "/client/whatsapp",
    label: "WhatsApp",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <path d="M21 12c0 4.4-4 8-9 8a10 10 0 01-4-.8L3 20l1-3.8A7.6 7.6 0 013 12c0-4.4 4-8 9-8s9 3.6 9 8z" />
        <path d="M9.5 9.5c0 3 2.5 5.5 5.5 5.5" />
      </svg>
    ),
  },
  {
    href: "/client/account",
    label: "Mon compte",
    icon: (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7" />
      </svg>
    ),
  },
];

function NavContent({ hotelName, userEmail }: ClientSidebarNavProps) {
  const pathname = usePathname();

  return (
    <div className="flex h-full flex-col bg-ink py-6">
      <div className="mb-1 flex items-center gap-2 px-6">
        <div className="h-[22px] w-[22px] shrink-0 rounded-md bg-accent" />
        <span className="text-sm font-semibold text-canvas">Proactif System</span>
      </div>
      <p className="mb-7 truncate px-6 text-xs text-canvas/60">{hotelName}</p>

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
            </Link>
          );
        })}
      </nav>

      <div className="flex-1" />

      <div className="px-3">
        <form action={clientLogout}>
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
            <p className="text-2xs text-canvas/50">Client</p>
          </div>
        </div>
      </div>
    </div>
  );
}

export function ClientSidebarNav(props: ClientSidebarNavProps) {
  const [isOpen, setIsOpen] = useState(false);

  return (
    <>
      <aside className="hidden w-16 shrink-0 lg:block xl:w-[248px]">
        <div className="fixed inset-y-0 w-16 xl:w-[248px]">
          <NavContent {...props} />
        </div>
      </aside>

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
        <span className="text-xs font-semibold">{props.hotelName}</span>
        <div className="w-9" />
      </div>

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
