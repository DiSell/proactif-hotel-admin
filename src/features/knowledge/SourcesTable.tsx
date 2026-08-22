"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { DataTable, type DataTableColumn } from "@/components/ui/DataTable";
import { StatusBadge } from "@/components/ui/StatusBadge";
import { Toggle } from "@/components/ui/Toggle";
import { ConfirmDialog } from "@/components/ui/ConfirmDialog";
import { EmptyState } from "@/components/ui/EmptyState";
import { useToast } from "@/components/ui/Toast";
import { toggleSourceActive, deleteSource } from "./actions";
import type { KnowledgeSource } from "@/types/database";

const TYPE_LABEL: Record<KnowledgeSource["type"], string> = {
  url: "Page web",
  text: "Texte",
  document: "Document",
  faq: "FAQ",
  internal_note: "Note interne",
};

const STATUS_LABEL: Record<KnowledgeSource["status"], { label: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  indexed: { label: "Indexé", tone: "success" },
  pending: { label: "En cours…", tone: "warning" },
  error: { label: "Erreur", tone: "danger" },
  disabled: { label: "Désactivée", tone: "neutral" },
};

function relativeTime(iso: string | null): string {
  if (!iso) return "—";
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (minutes < 1) return "à l’instant";
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `il y a ${hours} h`;
  return `il y a ${Math.floor(hours / 24)} j`;
}

function formatSize(bytes: number | null): string {
  if (!bytes) return "—";
  if (bytes < 1024) return `${bytes} o`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} Ko`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} Mo`;
}

export function SourcesTable({ hotelId, sources }: { hotelId: string; sources: KnowledgeSource[] }) {
  const router = useRouter();
  const toast = useToast();
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [, startTransition] = useTransition();

  function handleToggle(source: KnowledgeSource) {
    setPendingId(source.id);
    startTransition(async () => {
      const result = await toggleSourceActive(hotelId, source.id, !source.is_active);
      setPendingId(null);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      router.refresh();
    });
  }

  function handleDelete() {
    if (!confirmDeleteId) return;
    const id = confirmDeleteId;
    startTransition(async () => {
      const result = await deleteSource(hotelId, id);
      setConfirmDeleteId(null);
      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      toast.show("Source supprimée.");
      router.refresh();
    });
  }

  if (sources.length === 0) {
    return <EmptyState title="Aucune connaissance pour l’instant." description="Ajoutez une première source ci-dessus." />;
  }

  const columns: DataTableColumn<KnowledgeSource>[] = [
    { header: "Source", render: (s) => <span className="text-sm font-medium">{s.title}</span> },
    { header: "Type", width: "110px", render: (s) => <span className="text-xs text-body">{TYPE_LABEL[s.type]}</span> },
    {
      header: "Indexation",
      width: "130px",
      render: (s) => <StatusBadge label={STATUS_LABEL[s.status].label} tone={STATUS_LABEL[s.status].tone} />,
    },
    { header: "Synchro", width: "100px", render: (s) => <span className="text-xs text-body">{relativeTime(s.last_synced_at)}</span> },
    { header: "Taille", width: "70px", render: (s) => <span className="text-xs text-body">{formatSize(s.file_size_bytes)}</span> },
    {
      header: "Actif",
      width: "56px",
      render: (s) => (
        <Toggle checked={s.is_active} onChange={() => handleToggle(s)} label={`Actif — ${s.title}`} disabled={pendingId === s.id} />
      ),
    },
    {
      header: "",
      width: "36px",
      render: (s) => (
        <button
          type="button"
          onClick={() => setConfirmDeleteId(s.id)}
          aria-label={`Supprimer ${s.title}`}
          className="text-body/60 hover:text-danger"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z" />
          </svg>
        </button>
      ),
    },
  ];

  return (
    <>
      <DataTable columns={columns} rows={sources} rowKey={(s) => s.id} />
      <ConfirmDialog
        open={Boolean(confirmDeleteId)}
        title="Supprimer cette source ?"
        description="L’assistant ne pourra plus s’appuyer sur cette connaissance. Cette action est irréversible."
        onConfirm={handleDelete}
        onCancel={() => setConfirmDeleteId(null)}
      />
    </>
  );
}
