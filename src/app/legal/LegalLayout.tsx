// Shared shell for the two genuinely public, unauthenticated legal pages
// (/legal/privacy, /legal/data-deletion) — mirrors the same
// "Proactif System" header block already used by the other public,
// unauthenticated page in this app (src/app/partenaires/consentement/page.tsx's
// own local `Card` component), but wider: legal prose needs a readable
// measure, not a narrow confirmation-card width.
//
// Deliberately NOT a real <footer>/global layout refactor (task's own
// explicit instruction) — this repo has no footer component at all
// (confirmed by audit); these two pages simply link to each other and back
// to the product itself, inline.
import type { ReactNode } from "react";
import Link from "next/link";

export function LegalLayout({ title, updatedAt, children }: { title: string; updatedAt: string; children: ReactNode }) {
  return (
    <div className="min-h-dvh bg-canvas px-4 py-12">
      <div className="mx-auto max-w-2xl">
        <div className="mb-8 flex items-center gap-2">
          <div className="h-6 w-6 rounded-md bg-accent" />
          <span className="text-sm font-semibold text-ink">Proactif System</span>
        </div>

        <div className="rounded-xl border border-border bg-surface p-8 sm:p-10">
          <h1 className="mb-2 text-xl font-semibold text-ink">{title}</h1>
          <p className="mb-8 text-2xs text-body">Dernière mise à jour : {updatedAt}</p>

          <div className="space-y-6 text-xs leading-relaxed text-body [&_h2]:mt-8 [&_h2]:mb-2 [&_h2]:text-sm [&_h2]:font-semibold [&_h2]:text-ink [&_h2:first-child]:mt-0 [&_p]:mb-3 [&_ul]:mb-3 [&_ul]:list-disc [&_ul]:space-y-1 [&_ul]:pl-5 [&_strong]:text-ink">
            {children}
          </div>
        </div>

        <nav className="mt-6 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-body">
          <Link href="/" className="underline hover:text-ink">
            Accueil Proactif System
          </Link>
          <Link href="/politique-de-confidentialite" className="underline hover:text-ink">
            Politique de confidentialité
          </Link>
          <Link href="/conditions-utilisation" className="underline hover:text-ink">
            Conditions d&rsquo;utilisation
          </Link>
          <Link href="/suppression-donnees" className="underline hover:text-ink">
            Suppression des données
          </Link>
        </nav>
      </div>
    </div>
  );
}
