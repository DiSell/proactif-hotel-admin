const STEPS = ["Informations", "Identité", "Langues & réservation", "Assistant"];

export function Stepper({ current }: { current: number }) {
  return (
    <div className="flex items-center gap-2">
      {STEPS.map((label, index) => {
        const stepNumber = index + 1;
        const isActive = stepNumber === current;
        const isDone = stepNumber < current;
        return (
          <div key={label} className="flex flex-1 items-center gap-2">
            <div className="flex items-center gap-2">
              <div
                className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold"
                style={{
                  backgroundColor: isActive || isDone ? "var(--color-ink)" : "transparent",
                  color: isActive || isDone ? "var(--color-canvas)" : "var(--color-body)",
                  border: isActive || isDone ? "none" : "1px solid rgba(74,78,72,.4)",
                }}
              >
                {stepNumber}
              </div>
              <span
                className="hidden text-xs sm:inline"
                style={{ color: isActive ? "var(--color-ink)" : "var(--color-body)", fontWeight: isActive ? 500 : 400 }}
              >
                {label}
              </span>
            </div>
            {stepNumber < STEPS.length && <div className="h-px flex-1 bg-border" />}
          </div>
        );
      })}
    </div>
  );
}
