import OpenAI from "openai";
import { openaiApiKey } from "./env";

let client: OpenAI | null = null;

/**
 * Server-only singleton. Never import this from a Client Component — the
 * API key is only ever read here, lazily, and OpenAI({apiKey}) never logs
 * or echoes it back.
 */
export function getOpenAIClient(): OpenAI {
  if (!client) {
    client = new OpenAI({ apiKey: openaiApiKey() });
  }
  return client;
}
