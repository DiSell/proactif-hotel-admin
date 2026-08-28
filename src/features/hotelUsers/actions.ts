"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { SupabaseClient } from "@supabase/supabase-js";
import { requireSuperadmin } from "@/lib/auth/session";
import { createAdminClient } from "@/lib/supabase/admin";
import { currentOrigin } from "@/lib/http/currentOrigin";
import { sendEmail } from "@/lib/email/sendEmail";
import { hotelInvitationTemplate } from "@/lib/email/templates/hotelInvitation";
import type { ActionResult } from "@/lib/actionResult";

const inviteSchema = z.object({
  firstName: z.string().trim().min(1, "Le prénom est requis.").max(100, "Prénom trop long (100 caractères maximum)."),
  lastName: z.string().trim().min(1, "Le nom est requis.").max(100, "Nom trop long (100 caractères maximum)."),
  email: z.string().trim().email("Entrez un email valide."),
});

export interface InviteHotelClientInput {
  firstName: string;
  lastName: string;
  email: string;
}

export type InviteOutcome = "invited" | "already_linked" | "linked_existing_user";

// Real, structured error codes from the installed @supabase/auth-js
// (node_modules/@supabase/auth-js/dist/module/lib/error-codes.d.ts) for a
// duplicate email on invite/signup — checked by .code, not by matching on
// error.message text (which is not a stable contract across versions).
const DUPLICATE_EMAIL_CODES = new Set(["email_exists", "user_already_exists"]);

// admin.auth.admin.listUsers() is PAGINATED (confirmed from the installed
// SDK's own types, node_modules/@supabase/auth-js/dist/module/lib/types.d.ts:
// `Pagination = { nextPage: number | null; lastPage: number; total: number }`)
// — a single unparameterized call only ever returns the first page. A user
// created on an earlier page than the most recent ones would otherwise be
// silently reported as "not found" purely because of where they happen to
// fall in listUsers' ordering, not because they don't exist. Paginates
// explicitly, page by page, with an exact (not fuzzy) comparison on the
// already-normalized email, until found or genuinely exhausted.
const LIST_USERS_PAGE_SIZE = 200;
// Bounds the loop — 50 pages * 200/page = 10,000 users, a generous ceiling
// for this project's realistic scale. Never an infinite loop even if the
// API's pagination metadata were ever malformed.
const LIST_USERS_MAX_PAGES = 50;

async function findAuthUserByEmail(admin: SupabaseClient, normalizedEmail: string): Promise<{ id: string; email: string } | null> {
  let page = 1;
  for (let i = 0; i < LIST_USERS_MAX_PAGES; i++) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: LIST_USERS_PAGE_SIZE });
    if (error) throw new Error(`listUsers failed: ${error.message}`);

    const match = data.users.find((user) => user.email?.toLowerCase() === normalizedEmail);
    if (match) return { id: match.id, email: match.email ?? normalizedEmail };

    if (!data.nextPage) return null; // exhausted every page, genuinely not found
    page = data.nextPage;
  }
  // Safety cap reached without finding or exhausting — treated the same as
  // "not found" by the caller (never silently guesses); logged so this
  // extremely unlikely case (10,000+ users) is visible if it ever happens.
  console.error("findAuthUserByEmail: LIST_USERS_MAX_PAGES reached without resolving", { normalizedEmail });
  return null;
}

/**
 * Invites a client user for a specific hotel — the ONLY place
 * auth.admin.generateLink is called from. requireSuperadmin() first,
 * always: no admin-API call happens before the caller is verified.
 *
 * Email is no longer sent by Supabase's own SMTP (see
 * supabase/migrations/ — no migration touched; this is a pure application-
 * level change). generateLink({type:"invite"}) creates the auth user AND
 * returns a hashed_token, but sends nothing itself — this function builds
 * its own activation URL from that token
 * (/client/login/reset-password?token_hash=...&type=invite — the CLIENT-
 * PORTAL activation page, ClientResetPasswordForm.tsx, which establishes
 * the resulting session under the client-portal cookie scope
 * (lib/supabase/cookieScope.ts). A hotel_admin is never a back-office
 * account, so activation must never land on /login/reset-password: that
 * page writes the back-office cookie, which requireClientAccess()/
 * requireHotelAccess(hotelId, "client") never read — the freshly-activated
 * account would appear logged out the moment it reached /client/dashboard.
 * ClientResetPasswordForm.tsx consumes this exact token_hash+type shape via
 * verifyOtp, same as the back-office page's own activation/recovery flow.)
 * and sends it via src/lib/email/sendEmail.ts.
 *
 * Not a single SQL transaction — generateLink (Supabase Auth), sendEmail
 * (an external provider), and the profiles/hotel_users writes (Postgres)
 * are separate operations. The algorithm below is deliberately idempotent
 * and safe to retry after a partial failure at any step:
 *
 *   1. try generateLink({type:"invite"})
 *      - success -> brand new auth user (CAS A) — but NOT yet considered
 *        "invited": see step 1bis.
 *      - fails with email_exists/user_already_exists -> look the user up by
 *        email instead (this ALSO recovers a previous partial failure where
 *        the auth user was created but profiles/hotel_users never got
 *        written — a retry naturally lands here and picks up where it left
 *        off, never creating a duplicate)
 *      - fails for any other reason -> nothing was written anywhere,
 *        return a generic error, safe to retry from scratch
 *   1bis. (new user only) send the activation email
 *      - success -> proceed to step 2, exactly as before
 *      - failure -> delete the auth.users row THIS call just created (never
 *        a pre-existing one — see the CAS A branch's own comment) and
 *        return an error WITHOUT writing profiles/hotel_users at all. No
 *        orphaned, never-notified account survives a failed send.
 *   2. upsert profiles (id=userId, ...) ON CONFLICT (id) DO NOTHING — never
 *      overwrites an already-existing profile's role/email
 *   3. read back the row's ACTUAL role — never trust what we just tried to
 *      write, since an existing profile's insert may have been ignored
 *      - role = 'superadmin' -> CAS D, refuse absolutely, no hotel_users write
 *   4. read the user's existing hotel_users link, if any
 *      - none -> insert the link -> done (CAS A/recovered-A)
 *      - same hotelId -> CAS B, idempotent, nothing recreated
 *      - different hotelId -> CAS C, refuse, no write
 *
 * Every branch returns a distinct, honest outcome — never a generic
 * "invitation envoyée" that could mask a refusal or a no-op.
 */
export async function inviteHotelClient(hotelId: string, input: InviteHotelClientInput): Promise<ActionResult<{ outcome: InviteOutcome }>> {
  await requireSuperadmin();

  const parsed = inviteSchema.safeParse(input);
  if (!parsed.success) {
    const fieldErrors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      fieldErrors[String(issue.path[0])] = issue.message;
    }
    return { ok: false, error: "Certains champs sont invalides.", fieldErrors };
  }

  const email = parsed.data.email.trim().toLowerCase();
  const { firstName, lastName } = parsed.data;

  // Everything below touches the network (Supabase Auth Admin API,
  // Postgres) — wrapped in one top-level try/catch so an UNEXPECTED
  // exception (connection reset, DNS failure, a hung/timed-out SMTP send
  // inside inviteUserByEmail — see this function's own algorithm comment)
  // always becomes a normal ActionResult instead of propagating as a raw
  // rejected Promise. Every EXPECTED Supabase outcome (rate limit,
  // duplicate email, superadmin refusal, different-hotel refusal) is still
  // handled by its own `return` below, entirely unaffected by this wrapper
  // — a `return` inside a try block does not trigger its `catch`, so none
  // of those specific messages change. Never logs anything beyond a
  // message string here — no service_role key, no SMTP password, no
  // invitation token/URL ever appears in `err`, and only `.message` is
  // extracted, same discipline as every other console.error in this file.
  try {
    const admin = createAdminClient();
    const origin = await currentOrigin();
    const redirectTo = `${origin}/client/login/reset-password`;

    let userId: string;
    let isNewInvite: boolean;

    const linkResult = await admin.auth.admin.generateLink({
      type: "invite",
      email,
      options: { data: { first_name: firstName, last_name: lastName }, redirectTo },
    });

    if (linkResult.error) {
      const code = (linkResult.error as { code?: string }).code;
      if (!code || !DUPLICATE_EMAIL_CODES.has(code)) {
        console.error("inviteHotelClient: generateLink failed", { message: linkResult.error.message, code });
        return { ok: false, error: "Impossible d'envoyer l'invitation pour le moment." };
      }

      // Duplicate email (a real pre-existing account, OR a retry after this
      // exact invite partially failed last time) — recover the user id by
      // email rather than treat it as a hard failure. Paginates through
      // ALL of listUsers' pages (see findAuthUserByEmail's own comment) —
      // never just the first one. No new email is sent on this path (same
      // behavior as before this change): generateLink already failed, so
      // there is no fresh token/link to send.
      let existingUser: { id: string; email: string } | null;
      try {
        existingUser = await findAuthUserByEmail(admin, email);
      } catch (err) {
        console.error("inviteHotelClient: findAuthUserByEmail failed", { message: (err as Error).message });
        return { ok: false, error: "Impossible de vérifier ce compte pour le moment." };
      }
      if (!existingUser) {
        console.error("inviteHotelClient: duplicate-email error but no matching user found across all pages", { email });
        return { ok: false, error: "Impossible d'envoyer l'invitation pour le moment." };
      }
      userId = existingUser.id;
      isNewInvite = false;
    } else {
      const newUser = linkResult.data.user;
      const properties = linkResult.data.properties;
      if (!newUser || !properties) {
        return { ok: false, error: "Impossible d'envoyer l'invitation pour le moment." };
      }

      // The exact shape ResetPasswordForm.tsx's extractSessionTokensFromUrl
      // already parses (token_hash + type query params -> verifyOtp) — see
      // that file's own doc comment. Never the raw action_link Supabase
      // itself would build (that points at Supabase's own /auth/v1/verify
      // endpoint, not this app's branded page).
      const activationUrl = `${redirectTo}?token_hash=${encodeURIComponent(properties.hashed_token)}&type=${properties.verification_type}`;
      const template = hotelInvitationTemplate({ recipientName: firstName || null, activationUrl });
      const emailResult = await sendEmail({ to: email, subject: template.subject, html: template.html, text: template.text });

      if (!emailResult.ok) {
        // ATOMICITY: this auth.users row was created by THIS call, seconds
        // ago (we're in the "new user" branch precisely because generateLink
        // succeeded without hitting the duplicate-email branch above) — never
        // a pre-existing account. No profile/hotel_users write happens for
        // it: cleaning it up now is what prevents a silent, never-notified,
        // orphaned account. If the cleanup itself fails, this is logged
        // (user_id + a safe message only — never a token, never a secret)
        // and the action still reports failure rather than a false success.
        const { error: cleanupError } = await admin.auth.admin.deleteUser(newUser.id);
        if (cleanupError) {
          console.error("inviteHotelClient: cleanup after email failure also failed", {
            userId: newUser.id,
            message: cleanupError.message,
          });
        }
        return { ok: false, error: "Impossible d'envoyer l'email d'invitation pour le moment. Réessayez." };
      }

      userId = newUser.id;
      isNewInvite = true;
    }

    // Idempotent — a profile that already exists (recovered/duplicate path)
    // is never touched: its role/email are never overwritten by this call.
    const { error: profileUpsertError } = await admin
      .from("profiles")
      .upsert({ id: userId, email, role: "hotel_admin", first_name: firstName, last_name: lastName }, { onConflict: "id", ignoreDuplicates: true });
    if (profileUpsertError) {
      console.error("inviteHotelClient: profiles upsert failed", { message: profileUpsertError.message });
      return {
        ok: false,
        error: "Le compte a été créé mais son profil n'a pas pu être enregistré. Relancez l'invitation avec le même email — l'opération est sûre à répéter.",
      };
    }

    const { data: profile, error: profileReadError } = await admin.from("profiles").select("role").eq("id", userId).single();
    if (profileReadError || !profile) {
      console.error("inviteHotelClient: profile read-back failed", { message: profileReadError?.message });
      return { ok: false, error: "Impossible de vérifier ce compte pour le moment." };
    }

    if (profile.role === "superadmin") {
      return { ok: false, error: "Cet email correspond à un compte superadmin existant — impossible de l'inviter comme client." };
    }

    const { data: existingLink, error: linkReadError } = await admin.from("hotel_users").select("hotel_id").eq("user_id", userId).maybeSingle();
    if (linkReadError) {
      console.error("inviteHotelClient: hotel_users read failed", { message: linkReadError.message });
      return { ok: false, error: "Impossible de vérifier les accès de ce compte pour le moment." };
    }

    if (existingLink) {
      if (existingLink.hotel_id === hotelId) {
        return { ok: true, data: { outcome: "already_linked" } };
      }
      return { ok: false, error: "Cet email est déjà associé à un autre hôtel." };
    }

    const { error: linkInsertError } = await admin.from("hotel_users").insert({ hotel_id: hotelId, user_id: userId });
    if (linkInsertError) {
      console.error("inviteHotelClient: hotel_users insert failed", { message: linkInsertError.message });
      return {
        ok: false,
        error: "Le compte existe mais n'a pas pu être rattaché à cet hôtel. Relancez l'invitation avec le même email — l'opération est sûre à répéter.",
      };
    }

    revalidatePath(`/etablissements/${hotelId}`);
    return { ok: true, data: { outcome: isNewInvite ? "invited" : "linked_existing_user" } };
  } catch (err) {
    console.error("inviteHotelClient: unexpected error", { message: (err as Error).message });
    return { ok: false, error: "Impossible d'envoyer l'invitation pour le moment. Vérifiez la configuration email et réessayez." };
  }
}

/**
 * Revokes a client's access to a hotel WITHOUT deleting their account —
 * removes only the hotel_users link (service_role now holds DELETE on
 * that table, added by 0012_hotel_client_access_management.sql
 * specifically for this). The auth user and profile survive untouched;
 * conversations/messages stay attributed to the hotel (they key off
 * hotel_id, never off the hotel_admin's user_id, so revoking access never
 * touches history). A revoked account simply has no hotel_users row left:
 * signing in still works, but requireClientAccess() (src/lib/auth/session.ts)
 * finds no link and sends them to /login rather than guessing a hotel —
 * same as any other incomplete/misconfigured account. Re-inviting the same
 * email later (inviteHotelClient) recreates the link cleanly.
 *
 * `hotelId` is required and checked alongside `hotelUserId` (`.eq("id",
 * hotelUserId).eq("hotel_id", hotelId)`) — defense in depth so this can
 * never delete a link belonging to a different hotel, even given a
 * stale/forged hotelUserId.
 */
export async function revokeHotelClientAccess(hotelUserId: string, hotelId: string): Promise<ActionResult<void>> {
  await requireSuperadmin();

  const admin = createAdminClient();
  const { error } = await admin.from("hotel_users").delete().eq("id", hotelUserId).eq("hotel_id", hotelId);
  if (error) {
    console.error("revokeHotelClientAccess: delete failed", { message: error.message });
    return { ok: false, error: "Impossible de révoquer cet accès pour le moment." };
  }

  revalidatePath(`/etablissements/${hotelId}`);
  return { ok: true };
}

/**
 * Permanently deletes a client's account via admin.auth.admin.deleteUser —
 * the Supabase Auth Admin API, not a Data API write. profiles.id and
 * hotel_users.user_id both reference auth.users(id) ON DELETE CASCADE
 * (0001_init.sql, 0011_hotel_client_portal.sql), so this cascades to both
 * automatically at the database level; no separate cleanup and no extra
 * grant needed for it (see 0012_hotel_client_access_management.sql).
 * Irreversible — unlike revokeHotelClientAccess, there is no account left
 * to re-link afterwards.
 *
 * Re-checks the user is ACTUALLY linked to hotelId before deleting
 * anything — never trusts a userId without confirming it belongs to the
 * hotel the caller is managing (the UI only ever supplies one taken from
 * that hotel's own listHotelUsers() result, but this guards against a
 * stale/forged one being submitted anyway, same discipline as
 * requireHotelAccess()).
 */
export async function deleteHotelClient(userId: string, hotelId: string): Promise<ActionResult<void>> {
  await requireSuperadmin();

  const admin = createAdminClient();

  const { data: link, error: linkError } = await admin.from("hotel_users").select("hotel_id").eq("user_id", userId).maybeSingle();
  if (linkError) {
    console.error("deleteHotelClient: hotel_users read failed", { message: linkError.message });
    return { ok: false, error: "Impossible de vérifier ce compte pour le moment." };
  }
  if (!link || link.hotel_id !== hotelId) {
    return { ok: false, error: "Ce compte n'est pas rattaché à cet hôtel." };
  }

  const { error: deleteError } = await admin.auth.admin.deleteUser(userId);
  if (deleteError) {
    console.error("deleteHotelClient: deleteUser failed", { message: deleteError.message });
    return { ok: false, error: "Impossible de supprimer ce client pour le moment." };
  }

  revalidatePath(`/etablissements/${hotelId}`);
  return { ok: true };
}
