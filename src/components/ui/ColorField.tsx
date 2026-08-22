"use client";

import { inputClassName } from "./FormField";

interface ColorFieldProps {
  id: string;
  name: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
}

export function ColorField({ id, name, value, onChange, error }: ColorFieldProps) {
  return (
    <div className="flex items-center gap-2">
      <input
        type="color"
        aria-label={`Sélecteur de couleur pour ${name}`}
        value={/^#[0-9a-fA-F]{6}$/.test(value) ? value : "#000000"}
        onChange={(event) => onChange(event.target.value)}
        className="h-10 w-10 shrink-0 cursor-pointer rounded-lg border border-border bg-surface p-1"
      />
      <input
        id={id}
        name={name}
        type="text"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder="#1A1D1A"
        className={inputClassName(Boolean(error))}
      />
    </div>
  );
}
