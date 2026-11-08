"use client";

import { LifeBuoyIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import type { SupportGrantRow } from "@/data/support";
import { grantSupport, revokeSupport } from "./actions";

const DURATIONS = [
  { hours: 4, label: "4 hours" },
  { hours: 24, label: "1 day" },
  { hours: 72, label: "3 days" },
];

const STATUS = {
  active: { label: "Active", variant: "default" },
  expired: { label: "Ended", variant: "secondary" },
  revoked: { label: "Revoked", variant: "secondary" },
} as const;

export function SupportManager({ grants, locale, timeZone }: { grants: SupportGrantRow[]; locale: string; timeZone: string }) {
  const [hours, setHours] = useState(4);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const when = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short", timeZone });

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
      <section aria-labelledby="grant" className="self-start rounded-xl border bg-card p-4">
        <h2 id="grant" className="mb-1 font-semibold">
          Let Flowless support look
        </h2>
        <p className="mb-4 text-sm text-muted-foreground">
          The engineer can read, never change, for the time you choose. Every page they open is in the audit log.
        </p>
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            const form = e.currentTarget;
            const data = new FormData(form);
            startTransition(async () => {
              const result = await grantSupport({
                engineerEmail: String(data.get("email")),
                reason: String(data.get("reason")),
                hours,
              });
              setError(result.error);
              if (!result.error) form.reset();
            });
          }}
        >
          <div className="grid gap-2">
            <Label htmlFor="support-email">Engineer&apos;s email</Label>
            <Input id="support-email" name="email" type="email" required placeholder="name@flowless.co.ke" autoComplete="off" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="support-reason">What they need to look at</Label>
            <Textarea id="support-reason" name="reason" required minLength={10} maxLength={500} placeholder="Ticket 4411: November bills look doubled for route K-1" />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="support-hours">For</Label>
            <Select value={hours} onValueChange={(v) => setHours(Number(v))}>
              <SelectTrigger id="support-hours" className="w-full">
                <SelectValue>{(v: number) => DURATIONS.find((d) => d.hours === v)?.label}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {DURATIONS.map((d) => (
                  <SelectItem key={d.hours} value={d.hours}>
                    {d.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {error && (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          )}
          <div>
            <Button type="submit" size="sm" disabled={pending}>
              {pending ? "Granting…" : "Grant access"}
            </Button>
          </div>
        </form>
      </section>

      <section aria-labelledby="grants" className="rounded-xl border bg-card p-4">
        <h2 id="grants" className="mb-3 font-semibold">
          Access given
        </h2>
        {grants.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <LifeBuoyIcon className="size-6" />
            Flowless support has never had access to this organization.
          </div>
        ) : (
          <ul className="flex flex-col divide-y">
            {grants.map((g) => (
              <li key={g.id} className="flex flex-wrap items-start justify-between gap-3 py-3 first:pt-0 last:pb-0">
                <div className="flex min-w-0 flex-col gap-0.5 text-sm">
                  <span className="flex flex-wrap items-center gap-2">
                    <span className="truncate font-medium">{g.engineerEmail}</span>
                    <Badge variant={STATUS[g.status].variant}>{STATUS[g.status].label}</Badge>
                  </span>
                  <span className="text-muted-foreground">{g.reason}</span>
                  <span className="text-xs text-muted-foreground">
                    {g.grantedBy} · {when.format(g.startsAt)} to {when.format(g.revokedAt ?? g.expiresAt)}
                    {g.revokedBy ? ` · revoked by ${g.revokedBy}` : ""}
                  </span>
                </div>
                {g.status === "active" && <RevokeButton id={g.id} />}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RevokeButton({ id }: { id: string }) {
  const [pending, startTransition] = useTransition();
  return (
    <Button variant="outline" size="sm" disabled={pending} onClick={() => startTransition(async () => void (await revokeSupport(id)))}>
      {pending ? "Revoking…" : "Revoke now"}
    </Button>
  );
}
