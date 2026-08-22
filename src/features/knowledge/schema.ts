import { z } from "zod";

export const addUrlSourceSchema = z.object({
  title: z.string().trim().min(1, "Le titre est obligatoire."),
  source_url: z.string().trim().url("Entrez une URL valide."),
});
export type AddUrlSourceInput = z.infer<typeof addUrlSourceSchema>;

export const addTextSourceSchema = z.object({
  title: z.string().trim().min(1, "Le titre est obligatoire."),
  content: z.string().trim().min(1, "Le contenu est obligatoire."),
});
export type AddTextSourceInput = z.infer<typeof addTextSourceSchema>;

export const addFaqSourceSchema = z.object({
  title: z.string().trim().min(1, "La question est obligatoire."),
  content: z.string().trim().min(1, "La réponse est obligatoire."),
});
export type AddFaqSourceInput = z.infer<typeof addFaqSourceSchema>;

export const addDocumentSourceSchema = z.object({
  title: z.string().trim().min(1, "Le titre est obligatoire."),
  storage_path: z.string().trim().min(1),
  file_size_bytes: z.number().int().positive(),
  mime_type: z.string().trim().min(1),
});
export type AddDocumentSourceInput = z.infer<typeof addDocumentSourceSchema>;

/** Contract for the (not yet implemented) site-analysis crawler. */
export interface AnalyzeSiteResponse {
  status: "not_implemented";
  message: string;
}
