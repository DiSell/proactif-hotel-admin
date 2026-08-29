import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabasePublishableKey, supabaseUrl } from "./env";
import { CLIENT_PORTAL_COOKIE_NAME, isClientScopedPath } from "./cookieScope";

// /partenaires/consentement: the partner has no account in this app at
// all (see features/partners/consentLookup.ts's own doc comment) — the
// one-time token in its own ?token= query param is the sole
// authorization, same principle as a Supabase Auth magic link.
// /whatsapp/connect: same posture — the hotel's own WhatsApp Business
// owner has no account either, and the [token] route param (not a query
// param here) is the sole authorization (see
// features/whatsappIntegration/activationTokenPersistence.ts's own doc
// comments).
const PUBLIC_PATHS = ["/login", "/client/login", "/partenaires/consentement", "/whatsapp/connect"];
// The public widget — embed script, its config/chat API, and the standalone
// chat page rendered inside the embed iframe — must be reachable by an
// anonymous visitor on a hotel's own site. Nobody browsing a hotel's
// website is expected to hold a Proactif admin session; without this, every
// widget request would be redirected to /login below, same as any other
// unauthenticated page in this app. See features/widget/publicHotel.ts for
// how tenant isolation is enforced instead (never through auth here).
// /api/webhooks/whatsapp: called directly by Meta, with no Supabase session
// at all — authorization is the webhook's own signature/verify-token check
// (see lib/notifications/whatsapp/webhook.ts), never this middleware.
const PUBLIC_PATH_PREFIXES = ["/widget/", "/api/widget/", "/api/webhooks/"];
const PUBLIC_EXACT_PATHS = ["/widget.js"];

export function isPublicPath(pathname: string) {
  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) return true;
  if (PUBLIC_EXACT_PATHS.includes(pathname)) return true;
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Probes ONE cookie scope (back-office by default, client-portal when
 * `cookieName` is CLIENT_PORTAL_COOKIE_NAME — see cookieScope.ts) for an
 * authenticated session, writing any refreshed token back onto
 * `responseHolder.current` exactly like the single-scope version this
 * replaced did. Returns whether that scope is authenticated.
 */
async function probeAuthenticated(request: NextRequest, responseHolder: { current: NextResponse }, cookieName?: string): Promise<boolean> {
  const supabase = createServerClient(supabaseUrl(), supabasePublishableKey(), {
    ...(cookieName ? { cookieOptions: { name: cookieName } } : null),
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        responseHolder.current = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => responseHolder.current.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  return Boolean(data?.claims);
}

/**
 * Refreshes the Supabase session cookie on every request and gates access
 * to the dashboard. Verifies the JWT locally via getClaims() rather than
 * round-tripping to the Auth server on every navigation.
 *
 * Back-office (/etablissements/*, /dashboard, /login) and the client portal
 * (/client/*, /api/client/*) use DIFFERENT session cookies (see
 * cookieScope.ts) so both can stay signed in at once in the same browser —
 * this function picks EXACTLY ONE scope to check, based on the request's
 * own path (isClientScopedPath), never both. There is no longer a route
 * genuinely reachable from either space: the chat routes were split
 * (/api/hotels/[id]/chat vs /api/client/hotels/[id]/chat) specifically so
 * this coarse gate — and requireHotelAccess() itself — never has to guess
 * or try a fallback scope.
 */
export async function updateSession(request: NextRequest) {
  const responseHolder = { current: NextResponse.next({ request }) };
  const { pathname } = request.nextUrl;
  const clientScoped = isClientScopedPath(pathname);

  const isAuthenticated = await probeAuthenticated(request, responseHolder, clientScoped ? CLIENT_PORTAL_COOKIE_NAME : undefined);
  const loginPath = clientScoped ? "/client/login" : "/login";
  const homePath = clientScoped ? "/client/dashboard" : "/dashboard";

  if (!isAuthenticated && !isPublicPath(pathname)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = loginPath;
    loginUrl.searchParams.set("redirectTo", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isAuthenticated && pathname === loginPath) {
    const homeUrl = request.nextUrl.clone();
    homeUrl.pathname = homePath;
    homeUrl.search = "";
    return NextResponse.redirect(homeUrl);
  }

  return responseHolder.current;
}
