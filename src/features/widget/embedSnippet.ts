/**
 * Single source of truth for the public embed script's domain and the
 * exact snippet shown to hotels/clients — both the back-office
 * (WidgetSettingsForm.tsx) and the client portal (ClientWidgetInfo.tsx)
 * call these instead of each hardcoding the same string independently.
 */
export function widgetPublicOrigin(): string {
  // A plain constant for now — reproduces exactly the value that used to
  // be hardcoded inline in WidgetSettingsForm.tsx before this module
  // existed. Swap this single line for an env-var read later if the
  // domain ever needs to vary per environment; no caller changes either
  // way.
  return "https://chat.proactifsystem.fr";
}

export function buildWidgetSnippet(widgetKey: string): string {
  return `<script\n  src="${widgetPublicOrigin()}/widget.js"\n  data-key="${widgetKey}">\n</script>`;
}
