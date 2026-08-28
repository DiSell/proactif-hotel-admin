/**
 * Back-office (/etablissements/*, /dashboard, /login) and the client portal
 * (/client/*) used to share the SAME Supabase auth cookie (the default,
 * project-derived name @supabase/ssr picks when no `cookieOptions.name` is
 * given) — logging into one in a browser silently overwrote the session for
 * the other in every other tab of that same browser. This constant is what
 * lets the client portal use its OWN cookie so both can stay signed in at
 * once. Back-office keeps the default (unnamed) scope — see
 * lib/supabase/server.ts's createClient() — so no existing back-office
 * session is invalidated by this change.
 */
export const CLIENT_PORTAL_COOKIE_NAME = "sb-client-portal-auth-token";

/**
 * Every function/route that needs a Supabase session must be told
 * EXPLICITLY which cookie to read/write — never inferred, never tried as a
 * fallback. See requireHotelAccess() (lib/auth/session.ts): trying
 * back-office then client silently let a shared action run under whichever
 * identity happened to have a session first, independent of which space the
 * caller actually came from — the exact bug this scope parameter exists to
 * rule out structurally.
 */
export type AuthScope = "backoffice" | "client";

/**
 * True for "/client" and everything under it, page or API — a single
 * consistent prefix convention for anything that must read/write the
 * client-portal cookie: page routes (/client/dashboard, /client/login/...)
 * AND the dedicated client-scoped API routes (/api/client/hotels/[id]/chat).
 * Used only by the middleware's coarse "is this request authenticated"
 * check (updateSession.ts) — actual authorization always happens again,
 * scope-explicit, inside each page/action via requireClientAccess()/
 * requireHotelAccess(hotelId, "client").
 */
export function isClientScopedPath(pathname: string): boolean {
  return pathname === "/client" || pathname.startsWith("/client/") || pathname.startsWith("/api/client/");
}
