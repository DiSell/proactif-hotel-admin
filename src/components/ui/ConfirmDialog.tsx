"use client";

import { Button } from "./Button";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  pending?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel = "Supprimer",
  onConfirm,
  onCancel,
  pending,
}: ConfirmDialogProps) {
  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-ink/40 p-4" role="dialog" aria-modal="true">
      <div className="w-full max-w-sm rounded-xl border border-border bg-surface p-6 shadow-lg">
        <h2 className="text-base font-semibold text-ink">{title}</h2>
        <p className="mt-2 text-xs text-body">{description}</p>
        <div className="mt-6 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel} disabled={pending}>
            Annuler
          </Button>
          <Button variant="danger" onClick={onConfirm} disabled={pending}>
            {pending ? "…" : confirmLabel}
          </Button>
        </div>
      </div>
    </div>
  );
}
