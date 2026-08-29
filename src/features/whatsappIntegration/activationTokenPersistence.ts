import { createAdminClient } from "@/lib/supabase/admin";
import { currentOrigin } from "@/lib/http/currentOrigin";
import { generateActivationToken, hashActivationToken } from "./activationToken";

const ACTIVATION_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days — see task's own rationale; no prior repo convention for link expiry exists (Supabase Auth links use its own unconfigured default).
const ACTIVATION_LEASE_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes — see 0029's own column comment on processing_started_at.

const TABLE = "hotel_whatsapp_activation_tokens";

export interface ActivationLink {
  url: string;
  expiresAt: string;
}

export type CreateActivationLinkErrorCode = "activation_link_creation_failed" | "activation_in_progress";

export type CreateActivationLinkResult =
  | { ok: true; data: ActivationLink }
  | { ok: false; errorCode: CreateActivationLinkErrorCode };

/**
 * Called ONLY from generateWhatsAppActivationLinkBackoffice (actions.ts),
 * itself guarded by requireHotelAccess(hotelId, "backoffice") — this
 * function performs no authorization of its own.
 *
 * Revokes any still-active (not used, not revoked) token for this hotel
 * BEFORE inserting the replacement, so at most one activation link is ever
 * usable per hotel at a time (task section 9) — never touches a token that
 * already has used_at set (a completed activation is never invalidated).
 *
 * NEVER revokes a token currently held by a genuinely in-progress claim: the
 * revoke's own WHERE clause excludes any row whose `processing_started_at`
 * lease is still fresh (the exact same ACTIVATION_LEASE_TIMEOUT_MS threshold
 * claimActivationToken uses to decide reclaimability) — pulling that token
 * out from under a finalization chain that may still succeed would silently
 * strand it. When such an in-progress token is the reason nothing got
 * revoked, this function refuses to create a second one and reports
 * "activation_in_progress" instead of leaving two active links —
 * 0029's own hotel_whatsapp_activation_tokens_one_current_per_hotel_idx
 * unique index is the schema-level backstop if a race ever slips past this
 * check (surfaced here as the same error code, never a raw 23505).
 *
 * The raw token exists ONLY in the returned `url`, for this one response —
 * never persisted, never logged, never re-derivable afterward. A caller
 * that loses it (e.g. a page reload) must generate a new link.
 */
export async function createActivationLink(hotelId: string): Promise<CreateActivationLinkResult> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();
  const leaseThresholdIso = new Date(Date.now() - ACTIVATION_LEASE_TIMEOUT_MS).toISOString();

  const { error: revokeError } = await supabase
    .from(TABLE)
    .update({ revoked_at: nowIso })
    .eq("hotel_id", hotelId)
    .is("used_at", null)
    .is("revoked_at", null)
    .or(`processing_started_at.is.null,processing_started_at.lt.${leaseThresholdIso}`);

  if (revokeError) {
    console.error("createActivationLink: revoking previous tokens failed", { message: revokeError.message });
    return { ok: false, errorCode: "activation_link_creation_failed" };
  }

  const { data: stillActive, error: checkError } = await supabase
    .from(TABLE)
    .select("id")
    .eq("hotel_id", hotelId)
    .is("used_at", null)
    .is("revoked_at", null)
    .maybeSingle();

  if (checkError) {
    console.error("createActivationLink: in-progress check failed", { message: checkError.message });
    return { ok: false, errorCode: "activation_link_creation_failed" };
  }
  if (stillActive) {
    return { ok: false, errorCode: "activation_in_progress" };
  }

  const { token, tokenHash } = generateActivationToken();
  const expiresAt = new Date(Date.now() + ACTIVATION_TOKEN_TTL_MS).toISOString();

  const { error: insertError } = await supabase.from(TABLE).insert({
    hotel_id: hotelId,
    token_hash: tokenHash,
    expires_at: expiresAt,
  });

  if (insertError) {
    // 23505 = unique_violation — 0029's own
    // hotel_whatsapp_activation_tokens_one_current_per_hotel_idx caught a
    // race the check above couldn't fully close (e.g. two concurrent
    // "Régénérer" clicks). Same user-facing outcome either way.
    if (insertError.code === "23505") {
      return { ok: false, errorCode: "activation_in_progress" };
    }
    console.error("createActivationLink: insert failed", { message: insertError.message });
    return { ok: false, errorCode: "activation_link_creation_failed" };
  }

  const origin = await currentOrigin();
  return { ok: true, data: { url: `${origin}/whatsapp/connect/${token}`, expiresAt } };
}

/**
 * Read-only, non-mutating check used ONLY to decide what the public
 * activation page (src/app/whatsapp/connect/[token]/page.tsx) renders on
 * load — never claims the lease, never distinguishes "unknown" from
 * "expired" from "revoked" from "used" to the visitor (task section 1:
 * "ne jamais révéler l'état interne précis à un visiteur non authentifié").
 */
export async function peekActivationTokenStatus(token: string): Promise<"valid" | "invalid"> {
  if (!token) return "invalid";

  const tokenHash = hashActivationToken(token);
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from(TABLE)
    .select("id")
    .eq("token_hash", tokenHash)
    .is("used_at", null)
    .is("revoked_at", null)
    .gt("expires_at", nowIso)
    .maybeSingle();

  if (error) {
    console.error("peekActivationTokenStatus: lookup failed", { message: error.message });
    return "invalid";
  }
  return data ? "valid" : "invalid";
}

export interface ClaimedActivationToken {
  tokenId: string;
  hotelId: string;
}

export type ClaimActivationTokenResult = { ok: true; data: ClaimedActivationToken } | { ok: false };

/**
 * The ONLY authorization for receiveWhatsAppEmbeddedSignupCodeFromActivation
 * (actions.ts) — hotelId is obtained EXCLUSIVELY from this claim, never
 * from any client-supplied parameter (task section 5).
 *
 * A single, atomic `UPDATE ... RETURNING` — deliberately NOT a SELECT
 * followed by an UPDATE (task section 5's own explicit requirement) — so
 * exactly one concurrent caller for the same token can ever acquire the
 * lease. Must be called BEFORE any Meta HTTP call is made.
 *
 * Reclaimable when `processing_started_at` is null (never claimed, or
 * already released after a failure) OR older than
 * ACTIVATION_LEASE_TIMEOUT_MS (a previous attempt crashed without
 * releasing — see 0029's own column comment on why 10 minutes is safe).
 */
export async function claimActivationToken(token: string): Promise<ClaimActivationTokenResult> {
  if (!token) return { ok: false };

  const tokenHash = hashActivationToken(token);
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();
  const leaseThresholdIso = new Date(Date.now() - ACTIVATION_LEASE_TIMEOUT_MS).toISOString();

  const { data, error } = await supabase
    .from(TABLE)
    .update({ processing_started_at: nowIso })
    .eq("token_hash", tokenHash)
    .is("used_at", null)
    .is("revoked_at", null)
    .gt("expires_at", nowIso)
    .or(`processing_started_at.is.null,processing_started_at.lt.${leaseThresholdIso}`)
    .select("id, hotel_id")
    .maybeSingle<{ id: string; hotel_id: string }>();

  if (error) {
    console.error("claimActivationToken: claim query failed", { message: error.message });
    return { ok: false };
  }
  if (!data) {
    return { ok: false };
  }

  return { ok: true, data: { tokenId: data.id, hotelId: data.hotel_id } };
}

/**
 * Called when the finalization chain fails at any step AFTER a successful
 * claim (Meta cancellation/error, crypto failure, RPC 0026 failure) — never
 * called after success. Only releases a lease that is still genuinely
 * pending (never touches a token that became used/revoked concurrently,
 * e.g. via an admin's "Régénérer" between claim and this release).
 */
export async function releaseActivationTokenLease(tokenId: string): Promise<void> {
  const supabase = createAdminClient();
  const { error } = await supabase
    .from(TABLE)
    .update({ processing_started_at: null })
    .eq("id", tokenId)
    .is("used_at", null)
    .is("revoked_at", null);

  if (error) {
    console.error("releaseActivationTokenLease: release failed", { message: error.message });
  }
}

/**
 * Called ONLY after finalizeWhatsAppEmbeddedSignupForHotel() and the 0026
 * RPC have both succeeded. Scoped by `used_at is null and revoked_at is
 * null` so it can never re-mark an already-used token, or resurrect one
 * revoked concurrently. Returns false in that (extremely unlikely, since
 * the claim already guaranteed exclusivity) case — callers must not treat
 * false as fatal to the connection itself, which is already persisted.
 */
export async function markActivationTokenUsed(tokenId: string): Promise<boolean> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from(TABLE)
    .update({ used_at: new Date().toISOString(), processing_started_at: null })
    .eq("id", tokenId)
    .is("used_at", null)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();

  if (error) {
    console.error("markActivationTokenUsed: update failed", { message: error.message });
    return false;
  }
  return Boolean(data);
}

export type ActivationLinkStatus = { status: "none" } | { status: "pending"; expiresAt: string };

/**
 * Admin-facing read (getHotelWhatsAppActivationLinkStatus, queries.ts) —
 * NEVER returns the raw token or its hash. A token that exists but is
 * expired/used/revoked is reported as "none", prompting the admin to
 * generate a fresh link rather than surfacing a distinct "expired" state
 * the task's own 3-state UI (Non connecté / Activation en attente /
 * Connecté) has no room for.
 */
export async function getActiveActivationLinkStatus(hotelId: string): Promise<ActivationLinkStatus> {
  const supabase = createAdminClient();
  const nowIso = new Date().toISOString();

  const { data, error } = await supabase
    .from(TABLE)
    .select("expires_at")
    .eq("hotel_id", hotelId)
    .is("used_at", null)
    .is("revoked_at", null)
    .gt("expires_at", nowIso)
    .order("created_at", { ascending: false })
    .limit(1)
    .maybeSingle<{ expires_at: string }>();

  if (error) {
    console.error("getActiveActivationLinkStatus: lookup failed", { message: error.message });
    return { status: "none" };
  }
  return data ? { status: "pending", expiresAt: data.expires_at } : { status: "none" };
}
