"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth/session";
import {
  addUrlSourceSchema,
  addTextSourceSchema,
  addFaqSourceSchema,
  addDocumentSourceSchema,
  type AddUrlSourceInput,
  type AddTextSourceInput,
  type AddFaqSourceInput,
  type AddDocumentSourceInput,
} from "./schema";
import type { ActionResult } from "@/lib/actionResult";

function fieldErrorsFrom(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) errors[String(issue.path[0])] = issue.message;
  return errors;
}

async function insertSource(
  hotelId: string,
  row: {
    type: "url" | "text" | "document" | "faq";
    title: string;
    content?: string | null;
    source_url?: string | null;
    storage_path?: string | null;
    file_size_bytes?: number | null;
    mime_type?: string | null;
  }
): Promise<ActionResult<null>> {
  await requireSuperadmin();
  const supabase = await createClient();

  // No real indexing pipeline yet this milestone — the row is created and
  // immediately marked indexed/synced so the UI reflects "this source is
  // part of the knowledge base", per the approved plan. The future RAG
  // pipeline will drive status/last_synced_at for real.
  const { error } = await supabase.from("knowledge_sources").insert({
    hotel_id: hotelId,
    status: "indexed",
    is_active: true,
    last_synced_at: new Date().toISOString(),
    ...row,
  });

  if (error) {
    console.error("insertSource: supabase insert failed", { message: error.message });
    return { ok: false, error: "Impossible d’ajouter cette source." };
  }

  revalidatePath(`/etablissements/${hotelId}/connaissances`);
  return { ok: true, data: null };
}

export async function addUrlSource(hotelId: string, input: AddUrlSourceInput): Promise<ActionResult<null>> {
  const parsed = addUrlSourceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  return insertSource(hotelId, { type: "url", title: parsed.data.title, source_url: parsed.data.source_url });
}

export async function addTextSource(hotelId: string, input: AddTextSourceInput): Promise<ActionResult<null>> {
  const parsed = addTextSourceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  return insertSource(hotelId, { type: "text", title: parsed.data.title, content: parsed.data.content });
}

export async function addFaqSource(hotelId: string, input: AddFaqSourceInput): Promise<ActionResult<null>> {
  const parsed = addFaqSourceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  return insertSource(hotelId, { type: "faq", title: parsed.data.title, content: parsed.data.content });
}

export async function addDocumentSource(hotelId: string, input: AddDocumentSourceInput): Promise<ActionResult<null>> {
  const parsed = addDocumentSourceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  return insertSource(hotelId, {
    type: "document",
    title: parsed.data.title,
    storage_path: parsed.data.storage_path,
    file_size_bytes: parsed.data.file_size_bytes,
    mime_type: parsed.data.mime_type,
  });
}

export async function toggleSourceActive(hotelId: string, sourceId: string, isActive: boolean): Promise<ActionResult<null>> {
  await requireSuperadmin();
  const supabase = await createClient();
  const { error } = await supabase.from("knowledge_sources").update({ is_active: isActive }).eq("id", sourceId);

  if (error) {
    console.error("toggleSourceActive: supabase update failed", { message: error.message });
    return { ok: false, error: "Impossible de changer le statut." };
  }

  revalidatePath(`/etablissements/${hotelId}/connaissances`);
  return { ok: true, data: null };
}

export async function deleteSource(hotelId: string, sourceId: string): Promise<ActionResult<null>> {
  await requireSuperadmin();
  const supabase = await createClient();

  const { data: source } = await supabase
    .from("knowledge_sources")
    .select("storage_path")
    .eq("id", sourceId)
    .maybeSingle();

  if (source?.storage_path) {
    await supabase.storage.from("hotel-knowledge").remove([source.storage_path]);
  }

  const { error } = await supabase.from("knowledge_sources").delete().eq("id", sourceId);

  if (error) {
    console.error("deleteSource: supabase delete failed", { message: error.message });
    return { ok: false, error: "Impossible de supprimer cette source." };
  }

  revalidatePath(`/etablissements/${hotelId}/connaissances`);
  return { ok: true, data: null };
}
