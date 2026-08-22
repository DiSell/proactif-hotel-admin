// Same lazy-getter pattern as lib/supabase/env.ts: values are read only when
// actually needed, so importing this module never throws just because a
// route that doesn't use OpenAI happens to pull it in transitively.

function required(name: string, value: string | undefined): string {
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Set it in .env.local (server-only — never exposed to the browser, never logged).`
    );
  }
  return value;
}

export const openaiApiKey = () => required("OPENAI_API_KEY", process.env.OPENAI_API_KEY);
export const openaiChatModel = () => required("OPENAI_CHAT_MODEL", process.env.OPENAI_CHAT_MODEL);

/** vector(1536) in supabase/migrations/0002_rag.sql — changing this requires a new migration. */
export const EMBEDDING_DIMENSIONS = 1536;

export function openaiEmbeddingModel(): string {
  return process.env.OPENAI_EMBEDDING_MODEL || "text-embedding-3-small";
}
