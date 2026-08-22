import type { WidgetIcon, WidgetPosition } from "@/types/database";

const POSITION_STYLE: Record<WidgetPosition, { top?: number; bottom?: number; left?: number; right?: number }> = {
  "bottom-right": { bottom: 16, right: 16 },
  "bottom-left": { bottom: 16, left: 16 },
  "top-right": { top: 16, right: 16 },
  "top-left": { top: 16, left: 16 },
};

function WidgetIconGlyph({ icon }: { icon: WidgetIcon }) {
  if (icon === "help") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="12" cy="12" r="9" />
        <path d="M9.5 9.5a2.5 2.5 0 013-2.4c1.2.25 2 1.3 2 2.4 0 1.6-2 1.8-2 3.5" />
        <circle cx="12" cy="17" r="0.6" fill="currentColor" stroke="none" />
      </svg>
    );
  }
  if (icon === "message") {
    return (
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
        <path d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.4-4 8-9 8a10 10 0 01-4-.8L3 20l1-3.8A7.6 7.6 0 013 12c0-4.4 4-8 9-8s9 3.6 9 8z" />
      </svg>
    );
  }
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 5h16v11H8l-4 4V5z" />
    </svg>
  );
}

interface WidgetPreviewProps {
  position: WidgetPosition;
  icon: WidgetIcon;
  welcomeMessage: string;
  primaryColor: string;
  secondaryColor: string;
  assistantName: string;
}

export function WidgetPreview({ position, icon, welcomeMessage, primaryColor, secondaryColor, assistantName }: WidgetPreviewProps) {
  return (
    <div className="overflow-hidden rounded-xl border border-border bg-surface">
      <div className="flex items-center gap-2 bg-canvas px-3 py-2.5">
        <span className="h-2.5 w-2.5 rounded-full bg-border" />
        <span className="h-2.5 w-2.5 rounded-full bg-border" />
        <span className="h-2.5 w-2.5 rounded-full bg-border" />
      </div>
      <div className="relative h-[420px] overflow-hidden bg-[#FBFAF7]">
        <div className="flex flex-col gap-3 p-6">
          <div className="h-4 w-2/5 rounded bg-border" />
          <div className="h-2.5 w-4/5 rounded bg-[#EDE8DF]" />
          <div className="h-2.5 w-3/5 rounded bg-[#EDE8DF]" />
        </div>

        <div className="absolute w-64 overflow-hidden rounded-xl shadow-lg" style={POSITION_STYLE[position]}>
          <div className="flex items-center gap-2 px-3 py-2.5" style={{ backgroundColor: primaryColor }}>
            <div
              className="flex h-6 w-6 items-center justify-center rounded-full text-2xs font-semibold"
              style={{ backgroundColor: secondaryColor, color: primaryColor }}
            >
              <WidgetIconGlyph icon={icon} />
            </div>
            <span className="text-2xs font-medium" style={{ color: secondaryColor }}>
              {assistantName}
            </span>
          </div>
          <div className="bg-surface p-3">
            <div className="rounded-lg bg-canvas px-3 py-2 text-2xs">{welcomeMessage}</div>
          </div>
        </div>
      </div>
    </div>
  );
}
