export function LanguagePills({ languages }: { languages: string[] }) {
  if (languages.length === 0) {
    return <span className="text-2xs text-body/60">—</span>;
  }
  return (
    <div className="flex flex-wrap gap-1">
      {languages.map((lang) => (
        <span
          key={lang}
          className="rounded-full bg-ink/5 px-2 py-[3px] text-2xs font-medium text-body"
        >
          {lang.toUpperCase()}
        </span>
      ))}
    </div>
  );
}
