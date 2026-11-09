"use client";

import { LATE_FEE_BASES, LATE_FEE_FREQUENCIES, money, type LateFeeBase, type LateFeeFrequency, type LateFeeRule } from "@flowless/shared-types";
import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { FieldSelect } from "@/components/field-select";
import { MoneyText } from "@/components/money-text";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { lateFeeDraft, lateFeeFromDraft, lateFeeReasonLabel, type LateFeeDraft } from "@/lib/invoice-type-form";
import { lateFeeBaseLabel, lateFeeFrequencyLabel } from "@/lib/tariff-labels";
import { setLateFeeRuleAction, simulateLateFeeAction } from "../../actions";

interface Simulated {
  amount: bigint;
  perApplication: bigint;
  applications: number;
  suggested: bigint;
  reason: string;
}

/** The late-fee rule of an invoice type (T-10) with a live simulation: what it would charge for an example invoice. */
export function LateFeePanel({ id, rule, currency, locale, canManage }: { id: string; rule: LateFeeRule | null; currency: string; locale: string; canManage: boolean }) {
  const initial = lateFeeDraft(rule, currency);
  const [draft, setDraft] = useState<LateFeeDraft>(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const changed = JSON.stringify(draft) !== JSON.stringify(initial);
  const checked = lateFeeFromDraft(draft, currency);
  const set = <K extends keyof LateFeeDraft>(key: K, value: LateFeeDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));
  const off = !canManage;

  return (
    <section aria-labelledby="late-fee" className="grid gap-4 rounded-xl border bg-card p-4">
      <div>
        <h2 id="late-fee" className="font-semibold">
          Late fee
        </h2>
        <p className="text-sm text-muted-foreground">A fee for an invoice that stays unpaid. The rule says how much; applying it is Billing and Collections’ job.</p>
      </div>
      <div className="flex items-center gap-2">
        <Checkbox id="lf-enabled" checked={draft.enabled} onCheckedChange={(v) => set("enabled", v === true)} disabled={off} />
        <Label htmlFor="lf-enabled" className="font-normal">
          This invoice type charges a late fee
        </Label>
      </div>

      {draft.enabled && (
        <fieldset className="grid gap-4" disabled={off}>
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="lf-trigger">Starts (days after the due date)</Label>
              <Input id="lf-trigger" value={draft.triggerDays} onChange={(e) => set("triggerDays", e.target.value)} inputMode="numeric" className="w-28" />
            </div>
            <div className="grid gap-1.5">
              <Label htmlFor="lf-frequency">Charged</Label>
              <FieldSelect id="lf-frequency" value={draft.frequency} onChange={(v) => set("frequency", v as LateFeeFrequency)} options={LATE_FEE_FREQUENCIES.map((f) => ({ value: f, label: lateFeeFrequencyLabel[f] }))} placeholder="Choose" className="w-56" />
            </div>
          </div>
          <div className="flex flex-wrap items-end gap-4">
            <div className="grid gap-1.5">
              <Label htmlFor="lf-mode">The fee is</Label>
              <FieldSelect id="lf-mode" value={draft.mode} onChange={(v) => set("mode", v as "rate" | "flat")} options={[{ value: "rate", label: "A percentage" }, { value: "flat", label: "A flat amount" }]} placeholder="Choose" className="w-44" />
            </div>
            {draft.mode === "rate" ? (
              <>
                <div className="grid gap-1.5">
                  <Label htmlFor="lf-percent">Percentage</Label>
                  <Input id="lf-percent" value={draft.percent} onChange={(e) => set("percent", e.target.value)} inputMode="decimal" className="w-24" />
                </div>
                <div className="grid gap-1.5">
                  <Label htmlFor="lf-base">Of the</Label>
                  <FieldSelect id="lf-base" value={draft.base} onChange={(v) => set("base", v as LateFeeBase)} options={LATE_FEE_BASES.map((b) => ({ value: b, label: lateFeeBaseLabel[b] }))} placeholder="Choose" className="w-48" />
                </div>
              </>
            ) : (
              <div className="grid gap-1.5">
                <Label htmlFor="lf-flat">Amount ({currency})</Label>
                <Input id="lf-flat" value={draft.flatAmount} onChange={(e) => set("flatAmount", e.target.value)} inputMode="decimal" className="w-36" placeholder="500.00" />
              </div>
            )}
            <div className="grid gap-1.5">
              <Label htmlFor="lf-cap">Cap per invoice ({currency}, optional)</Label>
              <Input id="lf-cap" value={draft.cap} onChange={(e) => set("cap", e.target.value)} inputMode="decimal" className="w-44" placeholder="no cap" />
            </div>
          </div>
        </fieldset>
      )}

      {changed && !checked.ok && (
        <ul role="status" className="grid gap-1 text-sm text-destructive">
          {checked.problems.map((p) => (
            <li key={p}>{p}</li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {error}
        </p>
      )}
      {canManage && (
        <div className="flex gap-2">
          <Button
            disabled={!changed || !checked.ok || pending}
            onClick={() => {
              setError(null);
              startTransition(async () => {
                const result = await setLateFeeRuleAction({ id, draft });
                if (result.error !== null) return setError(result.error);
                toast.success(draft.enabled ? "Late-fee rule saved" : "Late-fee rule removed");
              });
            }}
          >
            {pending ? "Saving…" : draft.enabled ? "Save rule" : "Remove rule"}
          </Button>
          {changed && (
            <Button variant="ghost" onClick={() => setDraft(initial)} disabled={pending}>
              Discard changes
            </Button>
          )}
        </div>
      )}

      {draft.enabled && <Simulate draft={draft} currency={currency} locale={locale} />}
    </section>
  );
}

/** Simulates the rule as drafted (T-10): the answer comes from `tariffs.simulateLateFee`, so it is the same arithmetic Billing will use. */
function Simulate({ draft, currency, locale }: { draft: LateFeeDraft; currency: string; locale: string }) {
  const [balance, setBalance] = useState("12000");
  const [total, setTotal] = useState("");
  const [days, setDays] = useState("45");
  const [already, setAlready] = useState("");
  const [result, setResult] = useState<{ ok: true; value: Simulated } | { ok: false; message: string } | null>(null);
  const latest = useRef(0);
  const input = JSON.stringify([draft, balance, total, days, already]);

  useEffect(() => {
    const ticket = ++latest.current;
    const timer = setTimeout(async () => {
      const answer = await simulateLateFeeAction({ draft, balance, invoiceTotal: total, daysOverdue: days, alreadyCharged: already });
      if (ticket !== latest.current) return;
      setResult(answer.error !== null ? { ok: false, message: answer.error } : { ok: true, value: answer.data });
    }, 400);
    return () => clearTimeout(timer);
    // `input` is the serialised dependency list: draft and the four fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [input]);

  return (
    <div className="grid gap-3 rounded-lg border bg-muted/30 p-4" aria-live="polite">
      <h3 className="text-sm font-medium">Simulate</h3>
      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-1.5">
          <Label htmlFor="sim-balance" className="text-xs text-muted-foreground">
            Overdue balance ({currency})
          </Label>
          <Input id="sim-balance" value={balance} onChange={(e) => setBalance(e.target.value)} inputMode="decimal" className="w-36" />
        </div>
        {draft.mode === "rate" && draft.base === "invoice_total" && (
          <div className="grid gap-1.5">
            <Label htmlFor="sim-total" className="text-xs text-muted-foreground">
              Invoice total ({currency})
            </Label>
            <Input id="sim-total" value={total} onChange={(e) => setTotal(e.target.value)} inputMode="decimal" placeholder="the balance" className="w-36" />
          </div>
        )}
        <div className="grid gap-1.5">
          <Label htmlFor="sim-days" className="text-xs text-muted-foreground">
            Days overdue
          </Label>
          <Input id="sim-days" value={days} onChange={(e) => setDays(e.target.value)} inputMode="numeric" className="w-24" />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="sim-already" className="text-xs text-muted-foreground">
            Late fees already charged ({currency})
          </Label>
          <Input id="sim-already" value={already} onChange={(e) => setAlready(e.target.value)} inputMode="decimal" placeholder="none" className="w-40" />
        </div>
      </div>
      {result === null ? (
        <p className="text-sm text-muted-foreground">Working it out…</p>
      ) : !result.ok ? (
        <p className="text-sm text-destructive">{result.message}</p>
      ) : (
        <div className="grid gap-1 text-sm">
          <p>
            Fee due now: <MoneyText value={money(result.value.amount, currency)} locale={locale} className="text-lg font-semibold" />
          </p>
          <p className="text-muted-foreground">
            {lateFeeReasonLabel[result.value.reason] ?? result.value.reason} One application comes to <MoneyText value={money(result.value.perApplication, currency)} locale={locale} tone="plain" />; {result.value.applications} {result.value.applications === 1 ? "application is" : "applications are"} due so far
            {result.value.suggested !== result.value.amount ? (
              <>
                ; staff applying it by hand would add <MoneyText value={money(result.value.suggested, currency)} locale={locale} tone="plain" />
              </>
            ) : null}
            .
          </p>
        </div>
      )}
    </div>
  );
}
