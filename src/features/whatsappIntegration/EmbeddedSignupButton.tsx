"use client";

import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { useToast } from "@/components/ui/Toast";
import { loadMetaSdk, type MetaSdkWindow } from "./metaSdk";
import { META_EMBEDDED_SIGNUP_ORIGIN, classifyEmbeddedSignupOutcome, parseEmbeddedSignupMessage } from "./embeddedSignupMessage";
import { receiveWhatsAppEmbeddedSignupCodeFromActivation } from "./actions";
import type { EmbeddedSignupMessage, EmbeddedSignupStatus } from "./types";

// Confirmed against Meta's own current Embedded Signup implementation docs
// (checked 2026-08-29) — bump this periodically per Meta's own Graph API
// changelog; it is only the JS SDK's own init version, not a
// security-sensitive value, so a stale value degrades gracefully rather
// than failing outright.
const META_GRAPH_API_VERSION = "v23.0";

/**
 * Public, non-secret Meta identifiers (task section 3 — Meta requires both
 * in the BROWSER to call FB.init()/FB.login(), so NEXT_PUBLIC_ is the
 * correct, intentional exposure here, unlike every server-only
 * WHATSAPP_META_* variable in src/lib/notifications/whatsapp/, which must
 * NEVER gain a NEXT_PUBLIC_ prefix). See .env.example for the full
 * rationale recorded next to these two names.
 */
const META_APP_ID = process.env.NEXT_PUBLIC_META_APP_ID;
const META_WHATSAPP_CONFIG_ID = process.env.NEXT_PUBLIC_META_WHATSAPP_CONFIG_ID;

interface FacebookLoginAuthResponse {
  code?: string;
}
interface FacebookLoginResponse {
  status?: string;
  authResponse?: FacebookLoginAuthResponse;
}

/**
 * "Connecter mon WhatsApp Business" — rendered EXCLUSIVELY on the public
 * activation page (/whatsapp/connect/[token]), reached by a hotel's own
 * WhatsApp Business owner who has NO Proactif account — never from the
 * admin dashboard (which only generates/copies the activation link, and
 * never imports this component at all) and never from the client portal
 * (that screen and its ClientSidebarNav entry have been removed entirely).
 *
 * `activationToken` is the page's own [token] route param, forwarded
 * as-is to the server action — this component never decides or enforces
 * authorization itself. The token IS the authorization:
 * receiveWhatsAppEmbeddedSignupCodeFromActivation() (actions.ts) derives
 * hotelId EXCLUSIVELY from an atomic, server-side claim of this token,
 * never from any value this component could supply.
 *
 * Reaches the real "connected" state ONLY after that action returns a
 * genuine server-side success (Meta re-verification + encryption + atomic
 * DB persistence via 0026's own RPC) — never from the browser's own
 * postMessage/FB.login response alone, and never displayed optimistically
 * before that server round-trip resolves. A failure at any step (Meta
 * cancellation/error, crypto, RPC) never consumes the activation token —
 * the same link can be retried until it is used, expires, or is revoked.
 *
 * Wires together TWO independent Meta channels (confirmed by
 * documentation, see embeddedSignupMessage.ts's own doc comment):
 *   - the `code` arrives via the FB.login() JS callback's own
 *     response.authResponse.code, never via postMessage;
 *   - the WABA id / phone number id / event classification arrive via a
 *     window `message` event Meta's popup posts separately.
 * classifyEmbeddedSignupOutcome() (a pure, DOM-free function) is the ONLY
 * place these two channels are reconciled — see its own doc comment.
 */
export function EmbeddedSignupButton({ activationToken }: { activationToken: string }) {
  const toast = useToast();
  const [status, setStatus] = useState<EmbeddedSignupStatus>("not_connected");
  const lastMessageRef = useRef<EmbeddedSignupMessage | null>(null);

  useEffect(() => {
    if (!META_APP_ID || !META_WHATSAPP_CONFIG_ID) return;

    function handleMessage(event: MessageEvent) {
      const parsed = parseEmbeddedSignupMessage(event, META_EMBEDDED_SIGNUP_ORIGIN);
      if (parsed) lastMessageRef.current = parsed;
    }

    window.addEventListener("message", handleMessage);
    return () => window.removeEventListener("message", handleMessage);
  }, []);

  // Config absent (task section 16's own first required test) — render
  // nothing actionable rather than a button that can never work.
  if (!META_APP_ID || !META_WHATSAPP_CONFIG_ID) {
    return (
      <div>
        <p className="text-xs font-medium text-ink">WhatsApp Business non connecté</p>
        <p className="mt-1 text-2xs text-body">La connexion WhatsApp n&rsquo;est pas encore disponible pour cet environnement.</p>
      </div>
    );
  }

  async function handleClick() {
    lastMessageRef.current = null;
    setStatus("loading_sdk");

    try {
      await loadMetaSdk({ appId: META_APP_ID as string, version: META_GRAPH_API_VERSION });
    } catch {
      setStatus("error");
      toast.show("Impossible de charger le module Meta. Réessayez dans un instant.", "danger");
      return;
    }

    setStatus("opening");
    const fb = (window as unknown as MetaSdkWindow).FB;
    if (!fb) {
      setStatus("error");
      return;
    }

    fb.login(
      (response: unknown) => {
        void handleLoginResponse(response as FacebookLoginResponse);
      },
      {
        config_id: META_WHATSAPP_CONFIG_ID,
        response_type: "code",
        override_default_response_type: true,
        extras: { setup: {} },
      }
    );
  }

  async function handleLoginResponse(response: FacebookLoginResponse) {
    const code = response.status === "connected" ? response.authResponse?.code : undefined;
    const outcome = classifyEmbeddedSignupOutcome(lastMessageRef.current, Boolean(code));

    if (outcome.status === "cancelled") {
      setStatus("cancelled");
      return;
    }
    if (outcome.status === "unsupported_flow") {
      // POINT CRITIQUE (task section 7): FINISH_OBO_MIGRATION could not be
      // confirmed as non-destructive to an existing WhatsApp Business App
      // registration — stop here, never send the code to the server, never
      // continue silently.
      setStatus("unsupported_flow");
      toast.show(
        "Ce parcours Meta nécessite une migration qui ne peut pas être confirmée comme sûre pour ce numéro existant. Contactez le support avant de continuer.",
        "danger"
      );
      return;
    }
    if (outcome.status === "error") {
      setStatus("error");
      toast.show("La connexion Meta n'a pas pu être finalisée. Réessayez.", "danger");
      return;
    }

    // outcome.status === "awaiting_finalization" — code and a safe FINISH
    // event both present. The hint ids travel alongside the code as
    // `signupResult` (task section 5) — the server treats them as
    // untrusted until it independently re-verifies each one against Meta.
    // `activationToken` is this component's own prop, resolved by the
    // public page from its own [token] route param — never chosen by this
    // component, and hotelId is never sent at all (the server derives it
    // from the token itself).
    const result = await receiveWhatsAppEmbeddedSignupCodeFromActivation(activationToken, code as string, {
      event: outcome.event,
      wabaId: outcome.wabaId,
      phoneNumberId: outcome.phoneNumberId,
      businessId: outcome.businessId,
    });
    if (!result.ok) {
      setStatus("error");
      toast.show(result.error ?? "Erreur", "danger");
      return;
    }
    setStatus("connected");
  }

  if (status === "connected") {
    return <p className="text-xs font-medium text-ink">WhatsApp Business est maintenant connecté à votre établissement.</p>;
  }

  return (
    <div>
      {status === "cancelled" && <p className="mb-2 text-2xs text-body">Connexion annulée. Vous pouvez réessayer.</p>}
      <Button variant="secondary" size="sm" onClick={handleClick} disabled={status === "loading_sdk" || status === "opening"}>
        {status === "loading_sdk" ? "Chargement…" : status === "opening" ? "Connexion en cours…" : "Connecter mon WhatsApp Business"}
      </Button>
    </div>
  );
}
