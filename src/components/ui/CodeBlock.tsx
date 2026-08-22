import type { ReactNode } from "react";

export function CodeBlock({ children }: { children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-lg bg-ink p-4">
      <pre className="whitespace-pre font-mono text-2xs leading-relaxed text-canvas">{children}</pre>
    </div>
  );
}
