"use client";

import { useRef, useState, type DragEvent } from "react";
import { Button } from "./Button";

interface FileDropProps {
  onFileSelected: (file: File) => void;
  accept?: string;
  previewUrl?: string | null;
  hint?: string;
}

export function FileDrop({ onFileSelected, accept = "image/*", previewUrl, hint }: FileDropProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragOver(false);
    const file = event.dataTransfer.files[0];
    if (file) onFileSelected(file);
  }

  return (
    <div
      onDragOver={(event) => {
        event.preventDefault();
        setIsDragOver(true);
      }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
      className="flex items-center gap-4 rounded-lg border border-dashed p-4"
      style={{ borderColor: isDragOver ? "var(--color-accent)" : "var(--color-border-hover)", background: "var(--color-canvas)" }}
    >
      <div className="flex h-14 w-14 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-surface">
        {previewUrl ? (
          // eslint-disable-next-line @next/next/no-img-element -- arbitrary user-uploaded image, no static optimization needed
          <img src={previewUrl} alt="" className="h-full w-full object-cover" />
        ) : (
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--color-body)" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" opacity={0.55}>
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <circle cx="8.5" cy="8.5" r="1.5" />
            <path d="M21 15l-5-5L5 21" />
          </svg>
        )}
      </div>
      <div className="flex-1">
        <p className="text-xs">Glisser une image ou parcourir</p>
        {hint && <p className="text-2xs text-body/70">{hint}</p>}
      </div>
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onFileSelected(file);
        }}
      />
      <Button type="button" size="sm" onClick={() => inputRef.current?.click()}>
        Importer
      </Button>
    </div>
  );
}
