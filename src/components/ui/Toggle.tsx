"use client";

interface ToggleProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: string;
  disabled?: boolean;
}

export function Toggle({ checked, onChange, label, disabled }: ToggleProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className="relative h-5 w-8 shrink-0 rounded-full transition-colors disabled:opacity-50"
      style={{ backgroundColor: checked ? "var(--color-success)" : "var(--color-border)" }}
    >
      <span
        className="absolute top-0.5 h-4 w-4 rounded-full bg-surface transition-all"
        style={{ left: checked ? "18px" : "2px" }}
      />
    </button>
  );
}
