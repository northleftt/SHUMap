export function PlaceholderPage({
  title,
  subtitle,
}: {
  title: string;
  subtitle: string;
}) {
  return (
    <div className="flex h-full flex-col items-center justify-center px-8 text-center">
      <div className="w-full max-w-[320px] rounded-[32px] bg-white/92 p-8 shadow-[var(--shadow-sheet)]">
        <div className="mx-auto mb-5 grid size-16 place-items-center rounded-full bg-[var(--color-primary-soft)]">
          <div className="size-5 rounded-full bg-[var(--color-primary)]" />
        </div>
        <h1 className="mb-3 text-[28px] font-semibold text-[var(--color-text)]">{title}</h1>
        <p className="text-[15px] leading-7 text-[var(--color-text-muted)]">{subtitle}</p>
      </div>
    </div>
  );
}
