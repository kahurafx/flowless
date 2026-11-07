import { formatMoney, money } from "@flowless/shared-types";
import { Button } from "@/components/ui/button";

// Design token preview (/design): palette, type and status colours in both themes.
// Literal class names so Tailwind's scanner sees them.
const surfaces = [
  ["background", "bg-background"],
  ["card", "bg-card"],
  ["popover", "bg-popover"],
  ["muted", "bg-muted"],
  ["secondary", "bg-secondary"],
  ["accent", "bg-accent"],
  ["sidebar", "bg-sidebar"],
] as const;
const statuses = [
  ["text-success", "Clean bill"],
  ["text-age-ageing", "Ageing · 3 days"],
  ["text-age-overdue", "Overdue · 9 days"],
  ["text-info", "Estimated"],
] as const;

export default function TokenPreview() {
  return (
    <main className="mx-auto flex max-w-4xl flex-col gap-10 px-4 py-12 sm:px-8">
      <header className="flex flex-col gap-2">
        <p className="label-caps text-muted-foreground">Design tokens</p>
        <h1 className="text-4xl font-semibold">Flowless</h1>
        <p className="max-w-prose text-muted-foreground">
          Water blue and amber, light-first with a slate dark theme. Inter for text, Geist Mono for codes.
        </p>
      </header>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Surfaces</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {surfaces.map(([name, bg]) => (
            <div key={name} className={`rounded-xl border p-4 text-sm ${bg}`}>
              {name}
            </div>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Actions</h2>
        <div className="flex flex-wrap gap-2">
          <Button>Issue bills</Button>
          <Button variant="secondary">Save filter</Button>
          <Button variant="outline">Export CSV</Button>
          <Button variant="ghost">Cancel</Button>
          <Button variant="destructive">Void reading</Button>
        </div>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Status</h2>
        <ul className="flex flex-wrap gap-4 text-sm font-medium">
          {statuses.map(([tone, label]) => (
            <li key={label} className={tone}>
              {label}
            </li>
          ))}
          <li className="rounded-md bg-highlight px-2 text-highlight-foreground">Needs review</li>
        </ul>
      </section>

      <section className="flex flex-col gap-3">
        <h2 className="text-xl font-semibold">Figures</h2>
        <dl className="grid max-w-sm grid-cols-[1fr_auto] gap-x-6 gap-y-1 rounded-xl border bg-card p-4 text-sm">
          <dt>Consumption, 20 units</dt>
          <dd className="tabular text-right">{formatMoney(money(183900n, "KES"), "en-KE")}</dd>
          <dt>Standing charge</dt>
          <dd className="tabular text-right">{formatMoney(money(15000n, "KES"), "en-KE")}</dd>
          <dt className="font-semibold">Total</dt>
          <dd className="tabular text-right font-semibold">{formatMoney(money(198900n, "KES"), "en-KE")}</dd>
        </dl>
        <p className="font-mono text-sm text-muted-foreground">Account 1008-7 · Meter SN 4471920</p>
      </section>
    </main>
  );
}
