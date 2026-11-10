"use client";

import type { FlatBasis, TariffType } from "@flowless/shared-types";
import { FlaskConicalIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { FieldSelect } from "@/components/field-select";
import { MoneyText } from "@/components/money-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { SimulationOptions } from "@/data/billing-ops";
import { asMoney } from "@/lib/billing-view";
import { deltaDirection, percentChange, selectionProblem } from "@/lib/simulation-view";
import { parseDraft, type ContentDraft } from "@/lib/tariff-content";
import { simulateTariffAction } from "@/app/(staff)/tariffs/actions";

type Outcome = Extract<Awaited<ReturnType<typeof simulateTariffAction>>, { error: null }>["data"];

/**
 * T-06: "What would this do to real bills?" Prices each chosen account's last billed consumption
 * spans under the draft and under the tariff in force, and shows the totals and the accounts that
 * move most. Nothing is written. It sits inside the tariff form, so it has no form of its own.
 */
export function SimulateDialog({ type, flatBasis, draft, currency, options }: { type: TariffType; flatBasis: FlatBasis; draft: ContentDraft; currency: string; options: SimulationOptions }) {
  const [open, setOpen] = useState(false);
  const [routeId, setRouteId] = useState("");
  const [categoryId, setCategoryId] = useState("");
  const [accountNumbers, setAccountNumbers] = useState("");
  const [spans, setSpans] = useState("3");
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome | null>(null);
  const [pending, start] = useTransition();
  const check = type === "flat_rate" ? null : parseDraft(draft, { type, flatBasis: "none" }, currency);
  const money = (n: bigint) => <MoneyText value={asMoney(n, options.currency)} locale={options.locale} tone="plain" />;

  const run = () =>
    start(async () => {
      setError(null);
      const result = await simulateTariffAction({ type, flatBasis, draft, routeId, categoryId, accountNumbers, spans: Number.parseInt(spans, 10) || 3 });
      if (result.error !== null) {
        setOutcome(null);
        return setError(result.error);
      }
      setOutcome(result.data);
    });

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger render={<Button type="button" variant="outline" disabled={type === "flat_rate"} title={type === "flat_rate" ? "A flat-rate tariff does not price consumption" : undefined} />}>
        <FlaskConicalIcon />
        Simulate on real bills
      </DialogTrigger>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Simulate this tariff</DialogTitle>
          <DialogDescription>Prices the last billed consumption spans of the accounts you choose, under this draft and under the tariff in force then. Nothing is saved or billed.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          {check && !check.ok && <p className="rounded-lg bg-warning/10 p-3 text-sm text-warning">The draft is not valid yet: {check.problems.join(". ")}</p>}
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-1.5">
              <Label htmlFor="sim-route">Route</Label>
              <FieldSelect id="sim-route" value={routeId} onChange={setRouteId} options={options.routes} placeholder="Any route" none="Any route" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="sim-category">Category</Label>
              {options.categories.length > 0 ? (
                <FieldSelect id="sim-category" value={categoryId} onChange={setCategoryId} options={options.categories} placeholder="Any category" none="Any category" />
              ) : (
                <p className="text-xs text-muted-foreground">Categories need permission to read tariffs.</p>
              )}
            </div>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="sim-accounts">Account numbers (optional)</Label>
            <Textarea id="sim-accounts" value={accountNumbers} onChange={(e) => setAccountNumbers(e.target.value)} rows={2} placeholder="Separated by commas or new lines" />
          </div>
          <div className="flex flex-wrap items-end gap-3">
            <div className="grid gap-1.5">
              <Label htmlFor="sim-spans">Billed spans per account</Label>
              <Input id="sim-spans" value={spans} onChange={(e) => setSpans(e.target.value)} inputMode="numeric" className="w-24" />
            </div>
            <Button type="button" onClick={run} disabled={pending || !check?.ok || selectionProblem({ routeId, categoryId, accountNumbers }) !== null}>
              {pending ? "Pricing…" : "Run simulation"}
            </Button>
          </div>
          {error && (
            <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </p>
          )}
          {outcome && (
            <div className="grid gap-3 text-sm" aria-live="polite">
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">{outcome.totals.accounts} accounts</Badge>
                <Badge variant={outcome.totals.affected > 0 ? "warning" : "outline"}>{outcome.totals.affected} would change</Badge>
                <span className="text-muted-foreground">{outcome.totals.spans} spans priced{outcome.totals.skippedSpans ? `, ${outcome.totals.skippedSpans} skipped (no tariff in force or no category)` : ""}</span>
                {outcome.truncated && <Badge variant="warning">First {outcome.cap} accounts only</Badge>}
              </div>
              <dl className="grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  ["Billed", outcome.totals.billed],
                  ["In force", outcome.totals.current],
                  ["Draft", outcome.totals.draft],
                  ["Change", outcome.totals.delta],
                ].map(([label, value]) => (
                  <div key={String(label)} className="rounded-lg border p-2">
                    <dt className="text-xs text-muted-foreground">{String(label)}</dt>
                    <dd className="font-semibold">{money(value as bigint)}</dd>
                  </div>
                ))}
              </dl>
              <p className="text-xs text-muted-foreground">
                Change against the tariff in force: {percentChange(outcome.totals.current, outcome.totals.draft) ?? "not available"}. Consumption only: standing charges, fees and flat rates are not priced.
              </p>
              {outcome.topMovers.length > 0 && (
                <div>
                  <h3 className="mb-1 font-medium">Accounts that move most</h3>
                  <ul className="grid gap-1">
                    {outcome.topMovers.map((m) => (
                      <li key={m.accountId} className="flex flex-wrap items-center gap-x-3">
                        <span className="font-medium">{outcome.labels[m.accountId]?.number ?? m.accountId.slice(0, 8)}</span>
                        <span className="text-muted-foreground">
                          {money(m.current)} to {money(m.draft)}
                        </span>
                        <Badge variant={deltaDirection(m.delta) === "up" ? "warning" : deltaDirection(m.delta) === "down" ? "success" : "outline"}>{money(m.delta)}</Badge>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
