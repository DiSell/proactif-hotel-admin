"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FormField, inputClassName, textareaClassName } from "@/components/ui/FormField";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { ChatPreview } from "@/features/assistant/ChatPreview";
import { updateChatbotPersonalization } from "./actions";
import { DEFAULT_ASSISTANT_NAME } from "./schema";
import { DEFAULT_WELCOME_MESSAGE } from "@/features/widget/publicHotel";

interface ChatbotPersonalizationFormProps {
  hotelId: string;
  initialAssistantName: string;
  initialWelcomeMessage: string;
}

/**
 * The client-facing "PERSONNALISATION" section of /client/chatbot —
 * assistant name + welcome message ONLY. Deliberately does not expose the
 * system prompt, security instructions, model, RAG threshold, API keys,
 * hotel_id, or any other chatbot_settings field — see
 * features/client/schema.ts's clientChatbotPersonalizationSchema, the only
 * shape this form can submit.
 */
export function ChatbotPersonalizationForm({ hotelId, initialAssistantName, initialWelcomeMessage }: ChatbotPersonalizationFormProps) {
  const router = useRouter();
  const toast = useToast();
  const [assistantName, setAssistantName] = useState(initialAssistantName);
  const [welcomeMessage, setWelcomeMessage] = useState(initialWelcomeMessage);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [isPending, startTransition] = useTransition();

  function handleReset() {
    // Resets the FORM fields only — nothing is saved until "Enregistrer"
    // is clicked, so a reset never overwrites the live chatbot by itself.
    setAssistantName(DEFAULT_ASSISTANT_NAME);
    setWelcomeMessage(DEFAULT_WELCOME_MESSAGE);
    setErrors({});
  }

  function handleSubmit() {
    startTransition(async () => {
      const result = await updateChatbotPersonalization({ assistant_name: assistantName, welcome_message: welcomeMessage });
      if (!result.ok) {
        setErrors(result.fieldErrors ?? {});
        toast.show(result.error ?? "Erreur", "danger");
        return;
      }
      setErrors({});
      toast.show("Modifications enregistrées.");
      router.refresh();
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-[360px_1fr]">
      <div className="flex flex-col gap-4">
        <span className="text-2xs font-medium uppercase tracking-wide text-body/65">Personnalisation</span>
        <FormField label="Nom de l’assistant" htmlFor="assistant_name" required error={errors.assistant_name}>
          <input
            id="assistant_name"
            value={assistantName}
            onChange={(event) => setAssistantName(event.target.value)}
            placeholder={DEFAULT_ASSISTANT_NAME}
            className={inputClassName(Boolean(errors.assistant_name))}
          />
        </FormField>
        <FormField label="Message d’accueil" htmlFor="welcome_message" required error={errors.welcome_message}>
          <textarea
            id="welcome_message"
            value={welcomeMessage}
            onChange={(event) => setWelcomeMessage(event.target.value)}
            rows={3}
            className={textareaClassName(Boolean(errors.welcome_message))}
          />
        </FormField>
        <div className="flex gap-2">
          <Button variant="primary" onClick={handleSubmit} disabled={isPending}>
            {isPending ? "Enregistrement…" : "Enregistrer"}
          </Button>
          <Button variant="ghost" onClick={handleReset} disabled={isPending}>
            Réinitialiser la valeur par défaut
          </Button>
        </div>
      </div>

      <div className="h-[560px]">
        <ChatPreview
          key={`${assistantName}::${welcomeMessage}`}
          hotelId={hotelId}
          assistantName={assistantName || DEFAULT_ASSISTANT_NAME}
          welcomeMessage={welcomeMessage || DEFAULT_WELCOME_MESSAGE}
          fullScreen
          showSources={false}
          apiPath={`/api/client/hotels/${hotelId}/chat`}
        />
      </div>
    </div>
  );
}
