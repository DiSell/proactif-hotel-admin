"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { FormField, inputClassName, textareaClassName } from "@/components/ui/FormField";
import { useToast } from "@/components/ui/Toast";
import { addUrlSource, addTextSource, addFaqSource, addDocumentSource } from "./actions";
import type { AnalyzeSiteResponse } from "./schema";

type Mode = null | "menu" | "url" | "text" | "document" | "faq";

const MENU_ITEMS: { mode: Mode; label: string }[] = [
  { mode: null, label: "Analyser le site web" }, // handled specially below
  { mode: "url", label: "Ajouter une URL" },
  { mode: "document", label: "Importer un document" },
  { mode: "text", label: "Ajouter du texte" },
  { mode: "faq", label: "Créer une FAQ" },
];

export function AddSourceMenu({ hotelId, websiteUrl }: { hotelId: string; websiteUrl: string }) {
  const router = useRouter();
  const toast = useToast();
  const [mode, setMode] = useState<Mode>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [fields, setFields] = useState({ title: "", value: "" });
  const [uploadedFile, setUploadedFile] = useState<File | null>(null);

  function reset() {
    setMode(null);
    setFields({ title: "", value: "" });
    setUploadedFile(null);
  }

  async function handleAnalyze() {
    setMenuOpen(false);
    try {
      const response = await fetch(`/api/hotels/${hotelId}/analyze`, { method: "POST" });
      const data: AnalyzeSiteResponse = await response.json();
      toast.show(data.message, "danger");
    } catch {
      toast.show("L’analyse automatique n’est pas encore disponible.", "danger");
    }
  }

  function handleSubmit() {
    startTransition(async () => {
      let result;
      if (mode === "url") {
        result = await addUrlSource(hotelId, { title: fields.title, source_url: fields.value });
      } else if (mode === "text") {
        result = await addTextSource(hotelId, { title: fields.title, content: fields.value });
      } else if (mode === "faq") {
        result = await addFaqSource(hotelId, { title: fields.title, content: fields.value });
      } else if (mode === "document" && uploadedFile) {
        const supabase = createClient();
        const path = `${hotelId}/${crypto.randomUUID()}-${uploadedFile.name}`;
        const { error: uploadError } = await supabase.storage.from("hotel-knowledge").upload(path, uploadedFile);
        if (uploadError) {
          toast.show("Échec de l’upload du document.", "danger");
          return;
        }
        result = await addDocumentSource(hotelId, {
          title: fields.title || uploadedFile.name,
          storage_path: path,
          file_size_bytes: uploadedFile.size,
          mime_type: uploadedFile.type || "application/octet-stream",
        });
      } else {
        return;
      }

      if (!result.ok) {
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      toast.show("Source ajoutée.");
      reset();
      router.refresh();
    });
  }

  return (
    <div className="relative">
      <Button variant="primary" onClick={() => setMenuOpen((v) => !v)}>
        + Ajouter une source
      </Button>

      {menuOpen && (
        <Card className="absolute right-0 top-12 z-10 w-64 p-2 shadow-lg">
          {MENU_ITEMS.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => {
                setMenuOpen(false);
                if (item.mode === null) {
                  void handleAnalyze();
                } else {
                  setMode(item.mode);
                }
              }}
              className="flex w-full items-center rounded-lg px-3 py-2.5 text-left text-xs hover:bg-canvas"
            >
              {item.label}
            </button>
          ))}
        </Card>
      )}

      {mode && (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-ink/40 p-4">
          <Card className="w-full max-w-md p-6">
            <h2 className="mb-4 text-sm font-semibold text-ink">
              {mode === "url" && "Ajouter une URL"}
              {mode === "text" && "Ajouter du texte"}
              {mode === "faq" && "Créer une FAQ"}
              {mode === "document" && "Importer un document"}
            </h2>
            <div className="flex flex-col gap-4">
              <FormField label={mode === "faq" ? "Question" : "Titre"} htmlFor="title" required>
                <input
                  id="title"
                  value={fields.title}
                  onChange={(event) => setFields((f) => ({ ...f, title: event.target.value }))}
                  className={inputClassName()}
                />
              </FormField>

              {mode === "url" && (
                <FormField label="URL" htmlFor="value" required>
                  <input
                    id="value"
                    value={fields.value}
                    onChange={(event) => setFields((f) => ({ ...f, value: event.target.value }))}
                    placeholder={websiteUrl || "https://"}
                    className={inputClassName()}
                  />
                </FormField>
              )}

              {(mode === "text" || mode === "faq") && (
                <FormField label={mode === "faq" ? "Réponse" : "Contenu"} htmlFor="value" required>
                  <textarea
                    id="value"
                    rows={4}
                    value={fields.value}
                    onChange={(event) => setFields((f) => ({ ...f, value: event.target.value }))}
                    className={textareaClassName()}
                  />
                </FormField>
              )}

              {mode === "document" && (
                <FormField label="Fichier" htmlFor="file" required>
                  <input
                    id="file"
                    type="file"
                    onChange={(event) => setUploadedFile(event.target.files?.[0] ?? null)}
                    className="text-xs"
                  />
                </FormField>
              )}
            </div>
            <div className="mt-6 flex justify-end gap-2">
              <Button variant="ghost" onClick={reset} disabled={isPending}>
                Annuler
              </Button>
              <Button variant="primary" onClick={handleSubmit} disabled={isPending}>
                {isPending ? "Ajout…" : "Ajouter"}
              </Button>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
