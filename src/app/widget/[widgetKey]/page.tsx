// The standalone page rendered inside the embed iframe (see public/widget.js)
// — also directly reachable on its own, e.g. for testing a widget_key
// without embedding it anywhere. No session, no admin dependency: resolves
// everything from widgetKey via the same public resolver the API routes
// use, never a hotelId from the client.
import { createAdminClient } from "@/lib/supabase/admin";
import { resolvePublicWidgetContext, buildPublicWidgetConfig } from "@/features/widget/publicHotel";
import { PublicWidgetChat } from "@/features/widget/PublicWidgetChat";

function UnavailableState() {
  return (
    <div style={{ display: "flex", height: "100vh", alignItems: "center", justifyContent: "center", padding: 24, fontFamily: "system-ui, sans-serif" }}>
      <p style={{ fontSize: 13, color: "#6b6b6b", textAlign: "center" }}>Ce widget n&rsquo;est pas disponible actuellement.</p>
    </div>
  );
}

export default async function PublicWidgetPage({ params }: PageProps<"/widget/[widgetKey]">) {
  const { widgetKey } = await params;

  let widgetContext;
  try {
    const supabase = createAdminClient();
    widgetContext = await resolvePublicWidgetContext(widgetKey, supabase);
  } catch (err) {
    // A genuine service error (missing env var, DB unreachable, ...)
    // renders the same friendly unavailable state as an unknown widget_key
    // — this page has no API contract to keep a 503 vs 404 distinction
    // meaningful for, unlike the JSON routes. Logged server-side only.
    console.error("PublicWidgetPage: failed to resolve widget", { message: (err as Error).message });
    return <UnavailableState />;
  }

  if (!widgetContext) {
    return <UnavailableState />;
  }

  const config = buildPublicWidgetConfig(widgetContext);

  return <PublicWidgetChat widgetKey={widgetKey} config={config} />;
}
