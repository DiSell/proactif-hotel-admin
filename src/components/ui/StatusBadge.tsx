const TONES = {
  success: { bg: "rgba(47,107,79,.1)", fg: "var(--color-success)" },
  warning: { bg: "rgba(168,118,42,.12)", fg: "var(--color-warning)" },
  danger: { bg: "rgba(154,90,74,.12)", fg: "var(--color-danger)" },
  neutral: { bg: "rgba(74,78,72,.1)", fg: "var(--color-body)" },
} as const;

interface StatusBadgeProps {
  label: string;
  tone: keyof typeof TONES;
}

export function StatusBadge({ label, tone }: StatusBadgeProps) {
  const { bg, fg } = TONES[tone];
  return (
    <span
      className="inline-flex items-center rounded-full px-2 py-[3px] text-2xs font-medium"
      style={{ backgroundColor: bg, color: fg }}
    >
      {label}
    </span>
  );
}

interface StatusDotProps {
  tone: keyof typeof TONES;
  label: string;
}

export function StatusDot({ tone, label }: StatusDotProps) {
  return (
    <span className="inline-flex items-center gap-2 text-xs">
      <span
        className="h-[7px] w-[7px] rounded-full"
        style={{
          backgroundColor: tone === "neutral" ? "transparent" : TONES[tone].fg,
          border: tone === "neutral" ? "1px solid rgba(74,78,72,.4)" : undefined,
        }}
      />
      {label}
    </span>
  );
}
