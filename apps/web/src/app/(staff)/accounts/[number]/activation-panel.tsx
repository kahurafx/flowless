"use client";

import { CheckCircle2Icon, CircleDashedIcon, CircleSlashIcon, PowerIcon, SquareCheckIcon, SquareIcon } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { ActionDialog } from "@/components/action-dialog";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type { AccountPage } from "@/data/accounts";
import { canOverrideGates } from "@/lib/account-lifecycle";
import { formatWhen } from "@/lib/dates";
import { runLifecycle, tickGateAction, untickGateAction } from "../actions";

type Activation = NonNullable<AccountPage["activation"]>;
type Gate = Activation["gates"][number];

const stateBadge = {
  met: { label: "Met", variant: "success", icon: CheckCircle2Icon },
  unmet: { label: "Not met", variant: "warning", icon: CircleDashedIcon },
  waived: { label: "Not used", variant: "outline", icon: CircleSlashIcon },
} as const;

const viaText = { source: "Decided by the system", checklist: "Ticked by the office", disabled: "Switched off for this organization" } as const;

/**
 * Activation (C-06): each gate with its state and who decides it, the office checklist the
 * member can tick or untick with a note, and the Activate button. Overriding unmet gates is
 * offered only to members with `settings:manage` and is recorded; the procedure checks it too.
 */
export function ActivationPanel({ page }: { page: AccountPage }) {
  const activation = page.activation;
  if (!activation) return null;
  const canChange = page.permissions.includes("accounts:change_status");
  const { locale, timeZone } = page;
  return (
    <section aria-labelledby="activation" className="grid gap-4 rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="activation" className="text-base font-semibold">
            Activation
          </h2>
          <p className="text-sm text-muted-foreground">
            {activation.mode === "auto" ? "The account activates by itself when every required gate is met." : "The office activates the account once the required gates are met."}
          </p>
        </div>
        {activation.ready ? <Badge variant="success">Ready to activate</Badge> : <Badge variant="warning">{activation.unmet.length} required gate{activation.unmet.length === 1 ? "" : "s"} unmet</Badge>}
      </div>

      <ul className="grid gap-2">
        {activation.gates.map((g) => {
          const s = stateBadge[g.state];
          return (
            <li key={g.key} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border p-3">
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <s.icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {g.label} {!g.required && g.state !== "waived" && <span className="text-xs font-normal text-muted-foreground">(optional)</span>}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {viaText[g.via]}
                    {g.detail ? ` · ${g.detail}` : ""}
                  </p>
                  {g.ticked && g.tickedAt && (
                    <p className="text-xs text-muted-foreground">
                      Ticked by {g.tickedBy ?? "a colleague"} on {formatWhen(g.tickedAt, locale, timeZone)}
                      {g.note ? `: ${g.note}` : ""}
                    </p>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2">
                <Badge variant={s.variant}>{s.label}</Badge>
                {canChange && g.via === "checklist" && g.state !== "waived" && <TickButton accountId={page.account.id} gate={g} />}
              </div>
            </li>
          );
        })}
      </ul>

      {activation.needsPendingPaymentFirst && (
        <p className="text-sm text-muted-foreground" role="note">
          This organization takes payment before activation: mark the account pending payment first.
        </p>
      )}
      {canChange && <Activate page={page} activation={activation} />}
    </section>
  );
}

function TickButton({ accountId, gate }: { accountId: string; gate: Gate }) {
  const ticked = gate.ticked;
  const [note, setNote] = useState("");
  return (
    <ActionDialog
      label={ticked ? "Untick" : "Tick"}
      icon={ticked ? <SquareIcon /> : <SquareCheckIcon />}
      title={`${ticked ? "Untick" : "Tick"}: ${gate.label}`}
      description={ticked ? "The tick is withdrawn and the history keeps both." : "Confirm this has been done. You can add a note for whoever checks later."}
      submitLabel={ticked ? "Untick" : "Tick"}
      success={ticked ? "Tick withdrawn" : "Ticked"}
      onSubmit={async () => {
        const result = ticked ? await untickGateAction(accountId, gate.key, note) : await tickGateAction(accountId, gate.key, note);
        if (result.error === null && result.data === true) toast.success("All gates met: the account was activated");
        return { error: result.error };
      }}
    >
      <div className="grid gap-2">
        <Label htmlFor={`tick-${gate.key}`}>Note (optional)</Label>
        <Textarea id={`tick-${gate.key}`} value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} />
      </div>
    </ActionDialog>
  );
}

function Activate({ page, activation }: { page: AccountPage; activation: Activation }) {
  const [id, setId] = useState(() => crypto.randomUUID());
  const [reason, setReason] = useState("");
  const [connect, setConnect] = useState(true);
  const [serviceReason, setServiceReason] = useState("");
  const [override, setOverride] = useState(false);
  const mayOverride = canOverrideGates(page.permissions);
  return (
    <div>
      <ActionDialog
        label="Activate account"
        icon={<PowerIcon />}
        variant="default"
        title="Activate this account"
        description={activation.ready ? "All required gates are met." : "Some required gates are not met yet."}
        submitLabel="Activate"
        success="Account activated"
        onOpen={() => setId(crypto.randomUUID())}
        canSubmit={reason.trim() !== "" && (connect || serviceReason.trim() !== "")}
        onSubmit={async () => {
          const result = await runLifecycle({
            kind: "activate",
            id,
            accountId: page.account.id,
            reason: reason.trim(),
            ...(connect ? {} : { connect: false, serviceReason: serviceReason.trim() }),
            ...(override && !activation.ready ? { override: true } : {}),
          });
          return { error: result.error };
        }}
      >
        <div className="grid gap-2">
          <Label htmlFor="activate-reason">Reason</Label>
          <Textarea id="activate-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} maxLength={500} required />
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="activate-connect" checked={connect} onCheckedChange={(v) => setConnect(v === true)} />
          <Label htmlFor="activate-connect" className="font-normal">
            Connect the service now
          </Label>
        </div>
        {!connect && (
          <div className="grid gap-2">
            <Label htmlFor="activate-service-reason">Why the service stays disconnected</Label>
            <Input id="activate-service-reason" value={serviceReason} onChange={(e) => setServiceReason(e.target.value)} maxLength={500} required />
          </div>
        )}
        {!activation.ready && mayOverride && (
          <div className="flex items-start gap-2 rounded-xl bg-warning/12 p-3">
            <Checkbox id="activate-override" checked={override} onCheckedChange={(v) => setOverride(v === true)} />
            <Label htmlFor="activate-override" className="font-normal leading-snug text-warning">
              Activate although required gates are unmet. This is recorded against your name.
            </Label>
          </div>
        )}
        {!activation.ready && !mayOverride && <p className="text-sm text-muted-foreground">Activating past unmet gates needs the settings permission. Ask an administrator, or meet the gates first.</p>}
      </ActionDialog>
    </div>
  );
}
