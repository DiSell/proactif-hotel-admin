export default function Loading() {
  return (
    <div className="mx-auto flex max-w-[1440px] flex-col gap-6 p-6 md:p-8">
      <div className="h-8 w-64 animate-pulse rounded bg-ink/10" />
      <div className="h-64 animate-pulse rounded-xl bg-ink/5" />
    </div>
  );
}
