/**
 * The trusted origin for Supabase Auth email links (password reset,
 * client invitation redirectTo) — src/features/auth/actions.ts's
 * requestPasswordReset and src/features/hotelUsers/actions.ts's
 * inviteHotelClient are the only two callers.
 *
 * Deliberately NEVER derived from the incoming request's own Host /
 * X-Forwarded-Host headers. Those are attacker-influenceable depending on
 * reverse-proxy configuration — a forged Host header on the request that
 * triggers a password reset or a client invitation could otherwise make
 * Supabase email a real, working recovery/invite link pointing at an
 * attacker-controlled domain instead of this app's own. A single trusted
 * value, configured once, closes that off structurally rather than relying
 * on every proxy in front of this app being configured perfectly.
 *
 * SITE_URL is server-only on purpose (no NEXT_PUBLIC_ prefix — this value
 * is never read by browser code, only by Server Actions building a
 * redirectTo string) and is UNRELATED to
 * features/widget/embedSnippet.ts's widgetPublicOrigin(): that one is the
 * public chat-widget's own embed host, a different concern that can
 * legitimately live on a different domain/subdomain than this admin/client
 * app.
 */
export async function currentOrigin(): Promise<string> {
  const configured = process.env.SITE_URL;
  if (configured) {
    return configured.replace(/\/+$/, "");
  }

  // Only in non-production: there is no meaningful "attacker" pointing a
  // Host header at a developer's own loopback interface, and requiring
  // SITE_URL for every local `npm run dev` would be pure friction. Any
  // production-like run (including a local `next build && next start`
  // without SITE_URL set) fails loudly instead — see the throw below.
  if (process.env.NODE_ENV !== "production") {
    return `http://localhost:${process.env.PORT || "3000"}`;
  }

  throw new Error(
    "SITE_URL is not set. Required in production to build trusted Supabase Auth email links (password reset, client invitations) — this value is never derived from a request's own Host header, by design."
  );
}
