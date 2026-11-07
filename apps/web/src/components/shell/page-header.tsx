/** Every screen answers "where am I?" with the same header (apple-design: wayfinding). */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
}) {
  return (
    <header className="mb-6 flex flex-wrap items-end justify-between gap-4">
      <div className="flex min-w-0 flex-col gap-1">
        {eyebrow && <p className="label-caps text-muted-foreground">{eyebrow}</p>}
        <h1 className="text-2xl font-semibold break-words sm:text-3xl">{title}</h1>
        {description && <div className="max-w-prose text-sm text-muted-foreground">{description}</div>}
      </div>
      {actions && <div className="flex shrink-0 gap-2">{actions}</div>}
    </header>
  );
}
