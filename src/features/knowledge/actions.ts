"use server";

import { revalidatePath } from "next/cache";
import { createClient } from "@/lib/supabase/server";
import { requireSuperadmin } from "@/lib/auth/session";
import { ingestSource } from "@/features/rag/ingest";
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
import type { KnowledgeSource } from "@/types/database";

function fieldErrorsFrom(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {};
  for (const issue of issues) errors[String(issue.path[0])] = issue.message;
  return errors;
}

export interface InsertSourceResult {
  status: KnowledgeSource["status"];
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
): Promise<ActionResult<InsertSourceResult>> {
  await requireSuperadmin();
  const supabase = await createClient();

  // Created as "pending" — ingestSource() is the only thing allowed to mark
  // it "indexed", and only once chunks + embeddings have actually been
  // written. Never fake a success here.
  const { data: inserted, error } = await supabase
    .from("knowledge_sources")
    .insert({ hotel_id: hotelId, status: "pending", is_active: true, ...row })
    .select("id")
    .single();

  if (error || !inserted) {
    console.error("insertSource: supabase insert failed", { message: error?.message });
    return { ok: false, error: "Impossible d’ajouter cette source." };
  }

  const ingestResult = await ingestSource(hotelId, inserted.id);

  revalidatePath(`/etablissements/${hotelId}/connaissances`);
  return { ok: true, data: { status: ingestResult.ok ? "indexed" : "error" } };
}

export async function addUrlSource(hotelId: string, input: AddUrlSourceInput): Promise<ActionResult<InsertSourceResult>> {
  const parsed = addUrlSourceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  return insertSource(hotelId, { type: "url", title: parsed.data.title, source_url: parsed.data.source_url });
}

export async function addTextSource(hotelId: string, input: AddTextSourceInput): Promise<ActionResult<InsertSourceResult>> {
  const parsed = addTextSourceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  return insertSource(hotelId, { type: "text", title: parsed.data.title, content: parsed.data.content });
}

export async function addFaqSource(hotelId: string, input: AddFaqSourceInput): Promise<ActionResult<InsertSourceResult>> {
  const parsed = addFaqSourceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: "Champs invalides.", fieldErrors: fieldErrorsFrom(parsed.error.issues) };
  return insertSource(hotelId, { type: "faq", title: parsed.data.title, content: parsed.data.content });
}

export async function addDocumentSource(hotelId: string, input: AddDocumentSourceInput): Promise<ActionResult<InsertSourceResult>> {
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

export async function reindexSource(hotelId: string, sourceId: string): Promise<ActionResult<InsertSourceResult>> {
  await requireSuperadmin();
  const supabase = await createClient();

  const { data: source, error } = await supabase
    .from("knowledge_sources")
    .select("id")
    .eq("id", sourceId)
    .eq("hotel_id", hotelId)
    .maybeSingle();
  if (error || !source) {
    return { ok: false, error: "Source introuvable." };
  }

  await supabase.from("knowledge_sources").update({ status: "pending" }).eq("id", sourceId);
  const ingestResult = await ingestSource(hotelId, sourceId);

  revalidatePath(`/etablissements/${hotelId}/connaissances`);
  return { ok: true, data: { status: ingestResult.ok ? "indexed" : "error" } };
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
