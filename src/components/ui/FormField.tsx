import type { ReactNode } from "react";
import clsx from "clsx";

interface FormFieldProps {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  children: ReactNode;
}

export function FormField({ label, htmlFor, error, hint, required, children }: FormFieldProps) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-2 block text-xs font-medium text-ink">
        {label}
        {required && " *"}
      </label>
      {children}
      {hint && !error && <p className="mt-1 text-2xs text-body/70">{hint}</p>}
      {error && (
        <p className="mt-1 text-2xs text-danger" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

const controlBase =
  "w-full h-10 rounded-lg border border-border bg-surface px-3 text-xs text-ink outline-none focus:border-ink focus:ring-2 focus:ring-accent/15";

export function inputClassName(hasError?: boolean) {
  return clsx(controlBase, hasError && "border-danger");
}

export function textareaClassName(hasError?: boolean) {
  return clsx(controlBase, "h-auto py-2.5 leading-relaxed resize-none", hasError && "border-danger");
}
