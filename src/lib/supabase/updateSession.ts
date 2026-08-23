import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { supabasePublishableKey, supabaseUrl } from "./env";

const PUBLIC_PATHS = ["/login"];
// The public widget — embed script, its config/chat API, and the standalone
// chat page rendered inside the embed iframe — must be reachable by an
// anonymous visitor on a hotel's own site. Nobody browsing a hotel's
// website is expected to hold a Proactif admin session; without this, every
// widget request would be redirected to /login below, same as any other
// unauthenticated page in this app. See features/widget/publicHotel.ts for
// how tenant isolation is enforced instead (never through auth here).
const PUBLIC_PATH_PREFIXES = ["/widget/", "/api/widget/"];
const PUBLIC_EXACT_PATHS = ["/widget.js"];

export function isPublicPath(pathname: string) {
  if (PUBLIC_PATHS.some((path) => pathname === path || pathname.startsWith(`${path}/`))) return true;
  if (PUBLIC_EXACT_PATHS.includes(pathname)) return true;
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

/**
 * Refreshes the Supabase session cookie on every request and gates access
 * to the dashboard. Verifies the JWT locally via getClaims() rather than
 * round-tripping to the Auth server on every navigation.
 */
export async function updateSession(request: NextRequest) {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl(), supabasePublishableKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => response.cookies.set(name, value, options));
      },
    },
  });

  const { data } = await supabase.auth.getClaims();
  const isAuthenticated = Boolean(data?.claims);

  const { pathname } = request.nextUrl;

  if (!isAuthenticated && !isPublicPath(pathname)) {
    const loginUrl = request.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("redirectTo", pathname);
    return NextResponse.redirect(loginUrl);
  }

  if (isAuthenticated && pathname === "/login") {
    const dashboardUrl = request.nextUrl.clone();
    dashboardUrl.pathname = "/dashboard";
    dashboardUrl.search = "";
    return NextResponse.redirect(dashboardUrl);
  }

  return response;
}
