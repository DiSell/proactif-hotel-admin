import type { ReactNode } from "react";
import Link from "next/link";

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  backHref?: string;
  backLabel?: string;
  actions?: ReactNode;
}

export function PageHeader({ title, subtitle, backHref, backLabel, actions }: PageHeaderProps) {
  return (
    <div className="flex flex-col gap-4">
      {backHref && (
        <Link href={backHref} className="flex w-fit items-center gap-2 text-xs font-medium text-accent">
          ← {backLabel ?? "Retour"}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold leading-tight text-ink">{title}</h1>
          {subtitle && <p className="mt-1 text-xs text-body">{subtitle}</p>}
        </div>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
    </div>
  );
}
