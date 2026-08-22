/**
 * SIMULATED response generator — not connected to any AI model or network
 * call. Only demonstrates the chat panel's visual behavior before the real
 * conversational engine (OpenAI + RAG) is built in a later milestone.
 */
const CANNED_REPLIES = (assistantName: string) => [
  `Merci pour votre message ! Je suis ${assistantName} — ceci est une réponse simulée, le moteur IA n’est pas encore branché.`,
  "Je note votre question. Une fois le moteur conversationnel branché, je répondrai à partir des connaissances réelles de l’établissement.",
  "(Réponse de démonstration — aucune IA n’a traité ce message dans ce jalon.)",
];

export function getSimulatedReply(userMessage: string, assistantName: string): string {
  const replies = CANNED_REPLIES(assistantName);
  const index = userMessage.length % replies.length;
  return replies[index];
}
