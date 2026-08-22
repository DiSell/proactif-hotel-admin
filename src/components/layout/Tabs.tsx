"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

export interface TabItem {
  href: string;
  label: string;
}

export function Tabs({ items }: { items: TabItem[] }) {
  const pathname = usePathname();

  return (
    <div className="flex gap-6 overflow-x-auto border-b border-border">
      {items.map((item) => {
        const isActive = pathname === item.href;
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`whitespace-nowrap pb-3 text-xs ${
              isActive ? "border-b-2 border-ink font-medium text-ink" : "border-b-2 border-transparent text-body hover:text-ink"
            }`}
          >
            {item.label}
          </Link>
        );
      })}
    </div>
  );
}
