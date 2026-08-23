import { z } from "zod";
import { zodTextFormat } from "openai/helpers/zod";
import { getOpenAIClient } from "@/lib/openai/client";
import { openaiChatModel } from "@/lib/openai/env";
import type { StayRequestState } from "./types";

export interface HistoryInputItem {
  role: "user" | "assistant";
  content: string;
}

export interface ExtractStayRequestContext {
  /** "Today" from the hotel's perspective, ISO YYYY-MM-DD — used to resolve relative dates ("demain", "ce week-end"). */
  referenceDate: string;
  /** Hotel's configured timezone if available/exploitable; otherwise a documented fallback (see answer.ts) — no migration added for this in Phase A. */
  timeZone: string;
  locale?: string;
}

const stayRequestStateSchema = z.object({
  checkIn: z.string().nullable(),
  checkOut: z.string().nullable(),
  adults: z.number().int().nullable(),
  childrenCount: z.number().int().nullable(),
  childrenAges: z.array(z.number().int()).nullable(),
  rooms: z.number().int().nullable(),
});

function buildExtractionInstructions(context: ExtractStayRequestContext): string {
  return [
    "Tu extrais l'état COURANT d'une demande de séjour hôtelier à partir d'une conversation — tu ne réponds PAS au visiteur, tu structures uniquement ce qui est déjà connu.",
    `Date de référence ("aujourd'hui") : ${context.referenceDate}, fuseau ${context.timeZone}. Résous toute date relative ("demain", "ce week-end", "vendredi prochain", "dans deux nuits") à partir de cette date de référence.`,
    "Produis des dates au format ISO YYYY-MM-DD uniquement. Si une date reste ambiguë ou n'est pas déterminable avec confiance à partir du texte, laisse le champ à null — n'invente JAMAIS une date.",
    "IMPORTANT — les messages ASSISTANT sont du CONTEXTE, jamais un fait acquis pour le VISITEUR : si l'assistant a proposé une date ou une valeur ('Vous souhaitez arriver le 12 septembre ?'), ne la retiens dans l'état QUE si le visiteur l'a ensuite confirmée ou corrigée clairement dans un message ultérieur. Une proposition de l'assistant restée sans réponse claire du visiteur ne doit jamais devenir une valeur retenue.",
    "childrenCount = 0 signifie explicitement « aucun enfant » — distingue-le de « inconnu » (null).",
    "Ne devine jamais une valeur non exprimée dans la conversation : chaque champ non déterminable reste null.",
  ].join("\n");
}

/**
 * The only probabilistic step in this pipeline (see stayRequest.ts for the
 * deterministic validation that MUST run on its output before it's used
 * anywhere). One responses.parse call resolves the CURRENT state directly
 * from history — no separate "previousState + patch" merge (see the plan:
 * simulating determinism there without persistence added no real value).
 */
export async function resolveStayRequestFromHistory(messages: HistoryInputItem[], context: ExtractStayRequestContext): Promise<StayRequestState> {
  const client = getOpenAIClient();
  const model = openaiChatModel();

  const response = await client.responses.parse({
    model,
    instructions: buildExtractionInstructions(context),
    input: messages.map((m) => ({ role: m.role, content: m.content })),
    text: { format: zodTextFormat(stayRequestStateSchema, "stay_request_state") },
  });

  if (!response.output_parsed) {
    throw new Error("resolveStayRequestFromHistory: response did not match the expected structured schema");
  }
  return response.output_parsed;
}
