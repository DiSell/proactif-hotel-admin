"use server";

import { redirect } from "next/navigation";
import { createClient, createClientPortalClient } from "@/lib/supabase/server";
import { createAdminClient } from "@/lib/supabase/admin";
import { currentOrigin } from "@/lib/http/currentOrigin";
import { sendEmail } from "@/lib/email/sendEmail";
import { passwordRecoveryTemplate } from "@/lib/email/templates/passwordRecovery";

export interface LoginState {
  error: string | null;
}

export interface RequestPasswordResetState {
  error: string | null;
  sent: boolean;
}

/**
 * Back-office login — writes ONLY the back-office session cookie (the
 * default scope, lib/supabase/server's createClient()). A hotel_admin
 * credential accepted here would establish a session under that cookie,
 * but every client-portal page/action reads the CLIENT-PORTAL cookie
 * instead (requireClientAccess()/requireHotelAccess(hotelId, "client")) —
 * that session would be invisible there, and the user would bounce back to
 * /login forever. Rejected explicitly instead, with the stray back-office
 * session signed back out immediately so nothing useless lingers. See
 * clientLogin() below for the client-portal counterpart — the two never
 * accept the other's role.
 */
export async function login(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email et mot de passe requis." };
  }

  const supabase = await createClient();
  const { data: signInData, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    console.error("login: signInWithPassword failed", { message: error.message, code: (error as { code?: string }).code, status: error.status });
    return { error: "Identifiants incorrects." };
  }

  const userId = signInData.user?.id;
  const { data: profile } = userId ? await supabase.from("profiles").select("role").eq("id", userId).maybeSingle() : { data: null };

  if (profile?.role !== "superadmin") {
    await supabase.auth.signOut();
    return { error: "Ce compte est un compte client — connectez-vous depuis l'espace client (/client/login)." };
  }

  redirect("/dashboard");
}

/** Back-office logout — signs out of the back-office scope only. See clientLogout() below for the independent client-portal counterpart; neither ever touches the other's cookie. */
export async function logout() {
  const supabase = await createClient();
  await supabase.auth.signOut();
  redirect("/login");
}

/**
 * Client-portal login — the exact mirror of login() above, but bound to the
 * client-portal cookie scope throughout (createClientPortalClient()) and
 * rejecting a superadmin credential the same way login() rejects a
 * hotel_admin one. Never shares a code path with login() beyond the shape
 * of the check, so the two scopes can never accidentally cross.
 */
export async function clientLogin(_prevState: LoginState, formData: FormData): Promise<LoginState> {
  const email = String(formData.get("email") ?? "").trim();
  const password = String(formData.get("password") ?? "");

  if (!email || !password) {
    return { error: "Email et mot de passe requis." };
  }

  const supabase = await createClientPortalClient();
  const { data: signInData, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    console.error("clientLogin: signInWithPassword failed", { message: error.message, code: (error as { code?: string }).code, status: error.status });
    return { error: "Identifiants incorrects." };
  }

  const userId = signInData.user?.id;
  const { data: profile } = userId ? await supabase.from("profiles").select("role").eq("id", userId).maybeSingle() : { data: null };

  if (profile?.role === "superadmin") {
    await supabase.auth.signOut();
    return { error: "Ce compte est un compte back-office — connectez-vous depuis /login." };
  }
  if (profile?.role !== "hotel_admin") {
    await supabase.auth.signOut();
    return { error: "Identifiants incorrects." };
  }

  redirect("/client/dashboard");
}

/** Client-portal logout — signs out of the client-portal scope only. See logout() above. */
export async function clientLogout() {
  const supabase = await createClientPortalClient();
  await supabase.auth.signOut();
  redirect("/client/login");
}

/**
 * Shared anti-enumeration core for BOTH requestPasswordReset() (back-office)
 * and requestClientPasswordReset() (client portal) below — same delicate
 * discipline either way (see the two callers' own doc comments for why),
 * parameterized only by where the emailed link should point. Always reports
 * the exact same outcome regardless of whether the email actually belongs
 * to an account — the ONLY acceptable behavior for a public, unauthenticated
 * "forgot password" endpoint. generateLink({type:"recovery"}) does NOT
 * create a user and DOES return an explicit error for an email with no
 * matching account, so that guarantee is enforced here, explicitly: ANY
 * failure from generateLink — "no such user", a genuine Supabase outage,
 * anything — collapses to the exact same return value as success. Only a
 * real, existing account (generateLink succeeds) ever actually gets an
 * email sent. The whole call is wrapped in try/catch for the same reason:
 * even an unexpected thrown exception must never produce a different
 * response than the normal "not found" case, or the response shape itself
 * becomes the oracle.
 *
 * generateLink is an Admin API method — requires the service-role client
 * (createAdminClient()), never exposed to the browser, called only from
 * this server-side module.
 */
async function sendPasswordResetEmail(email: string, redirectTo: string): Promise<RequestPasswordResetState> {
  const GENERIC_RESULT: RequestPasswordResetState = { error: null, sent: true };

  try {
    const admin = createAdminClient();

    const linkResult = await admin.auth.admin.generateLink({
      type: "recovery",
      email,
      options: { redirectTo },
    });

    if (linkResult.error || !linkResult.data.properties) {
      // Routine, expected outcome for a typo'd or never-registered email —
      // logged for operational visibility, never surfaced to the caller
      // differently from the success path (see this function's own doc
      // comment on anti-enumeration).
      console.error("sendPasswordResetEmail: generateLink did not produce a link", {
        message: linkResult.error?.message,
        code: (linkResult.error as { code?: string } | null)?.code,
      });
      return GENERIC_RESULT;
    }

    const { hashed_token, verification_type } = linkResult.data.properties;
    // Same shape ResetPasswordForm.tsx/ClientResetPasswordForm.tsx's
    // extractSessionTokensFromUrl already parses (token_hash + type ->
    // verifyOtp).
    const resetUrl = `${redirectTo}?token_hash=${encodeURIComponent(hashed_token)}&type=${verification_type}`;
    const template = passwordRecoveryTemplate({ resetUrl });

    const emailResult = await sendEmail({ to: email, subject: template.subject, html: template.html, text: template.text });
    if (!emailResult.ok) {
      // The account IS real and generateLink DID succeed — a genuine
      // provider failure, worth logging distinctly — but the user-visible
      // response still never changes.
      console.error("sendPasswordResetEmail: sendEmail failed", { message: emailResult.error });
    }

    return GENERIC_RESULT;
  } catch (err) {
    console.error("sendPasswordResetEmail: unexpected error", { message: (err as Error).message });
    return GENERIC_RESULT;
  }
}

/** Back-office "forgot password" — link points to /login/reset-password (back-office scope). See sendPasswordResetEmail's own doc comment. */
export async function requestPasswordReset(_prevState: RequestPasswordResetState, formData: FormData): Promise<RequestPasswordResetState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) {
    return { error: "Entrez votre email.", sent: false };
  }

  const origin = await currentOrigin();
  return sendPasswordResetEmail(email, `${origin}/login/reset-password`);
}

/**
 * Client-portal "forgot password" — the exact mirror of requestPasswordReset()
 * above, but the link points to /client/login/reset-password
 * (ClientResetPasswordForm.tsx, client-portal cookie scope) instead of the
 * back-office reset page.
 */
export async function requestClientPasswordReset(
  _prevState: RequestPasswordResetState,
  formData: FormData
): Promise<RequestPasswordResetState> {
  const email = String(formData.get("email") ?? "").trim();
  if (!email) {
    return { error: "Entrez votre email.", sent: false };
  }

  const origin = await currentOrigin();
  return sendPasswordResetEmail(email, `${origin}/client/login/reset-password`);
}

export interface UpdatePasswordState {
  error: string | null;
  success: boolean;
}

/**
 * Called from ResetPasswordForm.tsx (back-office password recovery AND
 * first-time superadmin activation) AFTER the browser client has already
 * established a session from the emailed link (manual setSession/verifyOtp
 * — see that file's own doc comment) under the BACK-OFFICE cookie scope
 * (lib/supabase/client's createClient()). This Server Action mirrors that
 * exact scope with its own createClient() (server.ts) because updateUser
 * operates on "the currently authenticated user", read from cookies — using
 * any other scope here would find no session at all.
 *
 * Deliberately does NOT redirect() itself — the caller decides
 * (ResetPasswordForm.tsx redirects to /dashboard on success).
 *
 * See updateClientPassword() below for the client-portal counterpart, used
 * by ClientResetPasswordForm.tsx AND ChangePasswordForm.tsx (/client/account) —
 * never this function, which would silently fail for either (no back-office
 * session to update).
 */
export async function updatePassword(_prevState: UpdatePasswordState, formData: FormData): Promise<UpdatePasswordState> {
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (!password || password.length < 8) {
    return { error: "Le mot de passe doit contenir au moins 8 caractères.", success: false };
  }
  if (password !== confirmPassword) {
    return { error: "Les mots de passe ne correspondent pas.", success: false };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    console.error("updatePassword: supabase call failed", { message: error.message });
    return { error: "Impossible de mettre à jour le mot de passe. Le lien a peut-être expiré — recommencez la procédure.", success: false };
  }

  return { error: null, success: true };
}

/**
 * Client-portal counterpart of updatePassword() above — same validation,
 * same shape, but reads/writes the CLIENT-PORTAL session
 * (createClientPortalClient()) so it actually finds a session established
 * either by ClientResetPasswordForm.tsx's manual setSession/verifyOtp (via
 * lib/supabase/client's createClientPortalBrowserClient()) or by an
 * already-normal, already-logged-in /client/account visit.
 */
export async function updateClientPassword(_prevState: UpdatePasswordState, formData: FormData): Promise<UpdatePasswordState> {
  const password = String(formData.get("password") ?? "");
  const confirmPassword = String(formData.get("confirmPassword") ?? "");

  if (!password || password.length < 8) {
    return { error: "Le mot de passe doit contenir au moins 8 caractères.", success: false };
  }
  if (password !== confirmPassword) {
    return { error: "Les mots de passe ne correspondent pas.", success: false };
  }

  const supabase = await createClientPortalClient();
  const { error } = await supabase.auth.updateUser({ password });

  if (error) {
    console.error("updateClientPassword: supabase call failed", { message: error.message });
    return { error: "Impossible de mettre à jour le mot de passe. Le lien a peut-être expiré — recommencez la procédure.", success: false };
  }

  return { error: null, success: true };
}
