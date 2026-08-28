"use client";

import { useState, type InputHTMLAttributes } from "react";
import { inputClassName } from "./FormField";

type PasswordInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, "type" | "className"> & {
  hasError?: boolean;
};

/** A password <input> with a show/hide toggle — same visual language as inputClassName(), just with room on the right for the eye button. Purely a display toggle: never changes what's submitted, the field stays a real password value either way. */
export function PasswordInput({ hasError, ...props }: PasswordInputProps) {
  const [visible, setVisible] = useState(false);

  return (
    <div className="relative">
      <input {...props} type={visible ? "text" : "password"} className={`${inputClassName(hasError)} pr-9`} />
      <button
        type="button"
        onClick={() => setVisible((current) => !current)}
        aria-label={visible ? "Masquer le mot de passe" : "Afficher le mot de passe"}
        aria-pressed={visible}
        tabIndex={-1}
        className="absolute right-0 top-0 flex h-10 w-9 items-center justify-center text-body/60 hover:text-ink"
      >
        {visible ? (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M17.94 17.94A10.94 10.94 0 0112 20c-7 0-11-8-11-8a21.6 21.6 0 015.06-6.06M9.9 4.24A10.4 10.4 0 0112 4c7 0 11 8 11 8a21.6 21.6 0 01-2.16 3.19m-6.72-1.07a3 3 0 11-4.24-4.24" />
            <path d="M1 1l22 22" />
          </svg>
        ) : (
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
            <circle cx="12" cy="12" r="3" />
          </svg>
        )}
      </button>
    </div>
  );
}
