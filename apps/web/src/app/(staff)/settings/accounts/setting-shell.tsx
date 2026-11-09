"use client";

import { AlertTriangleIcon, RefreshCwIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { formatWhen } from "@/lib/dates";
import type { FormResult } from "@/lib/account-settings";
import { saveAccountSettingAction } from "./actions";

export interface SettingMeta {
  key: string;
  version: number;
  latestVersion: number;
  isDefault: boolean;
  scheduled: { version: number; effectiveFrom: string; summary: string }[];
  history: { version: number; effectiveFrom: string; reason: string | null; by: string; inForce: boolean; scheduled: boolean; summary: string }[];
}

/** The refusal the configuration store gives when the setting changed after the form was opened. */
export const isConflict = (message: string) => message.startsWith("Someone changed this setting");

/**
 * The frame every Accounts setting form shares (K-10): the version in force and anything
 * scheduled, the fields, an optional future date and reason, Save (a new version, checked
 * against the newest version this form saw, so a change made meanwhile is a conflict and not
 * overwritten), and the history of versions.
 */
export function SettingShell({
  title,
  description,
  meta,
  dirty,
  build,
  onDiscard,
  today,
  locale,
  timeZone,
  children,
}: {
  title: string;
  description: string;
  meta: SettingMeta;
  dirty: boolean;
  /** The value to store from the fields, or what is wrong with them. */
  build: () => FormResult<unknown>;
  onDiscard: () => void;
  today: string;
  locale: string;
  timeZone: string;
  children: React.ReactNode;
}) {
  const router = useRouter();
  const [effectiveFrom, setEffectiveFrom] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const built = dirty ? build() : null;
  const problems = built && !built.ok ? built.problems : [];
  const when = (iso: string) => formatWhen(new Date(iso), locale, timeZone, "date");
  const conflict = error !== null && isConflict(error);
  const id = meta.key.replace(/\./g, "-");

  return (
    <section aria-labelledby={`${id}-title`} className="rounded-xl border bg-card p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 id={`${id}-title`} className="font-semibold">
          {title}
        </h2>
        <Badge variant={meta.isDefault ? "outline" : "secondary"}>{meta.isDefault ? "Built-in default" : `Version ${meta.version}`}</Badge>
        {meta.scheduled.map((s) => (
          <Badge key={s.version} variant="info" title={s.summary}>
            Version {s.version} from {when(s.effectiveFrom)}
          </Badge>
        ))}
      </div>
      <p className="mt-1 mb-4 max-w-prose text-sm text-muted-foreground">{description}</p>

      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          const value = build();
          if (!value.ok) return;
          setError(null);
          startTransition(async () => {
            const result = await saveAccountSettingAction({ key: meta.key, value: value.value, expectedVersion: meta.latestVersion, effectiveFrom, reason });
            if (result.error !== null) return setError(result.error);
            toast.success(result.data.changed ? (effectiveFrom ? "Change scheduled" : "Setting saved") : "Nothing changed");
          });
        }}
      >
        {children}

        {dirty && (
          <div className="grid gap-4 border-t pt-4">
            <div className="flex flex-wrap items-end gap-4">
              <div className="grid gap-1.5">
                <Label htmlFor={`${id}-when`}>Apply from (optional)</Label>
                <Input id={`${id}-when`} type="date" min={today} value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} className="w-auto" />
              </div>
              <div className="grid min-w-56 flex-1 gap-1.5">
                <Label htmlFor={`${id}-reason`}>Reason (optional)</Label>
                <Input id={`${id}-reason`} value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Board resolution 14/2026" />
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              {effectiveFrom ? `Takes effect at the start of that day in ${timeZone.replace(/_/g, " ")}; until then the version in force stays.` : "Takes effect as soon as it is saved. Older versions stay in the history."}
            </p>
            {meta.scheduled.length > 0 && !effectiveFrom && <p className="text-xs text-warning">A later change is already scheduled; this adds another version after it.</p>}
          </div>
        )}

        {problems.length > 0 && (
          <ul role="status" className="grid gap-1 text-sm text-destructive">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        {error && (
          <div role="alert" className="flex flex-wrap items-center gap-3 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            <AlertTriangleIcon className="size-4 shrink-0" aria-hidden />
            <span className="flex-1">{conflict ? "This setting was changed by someone else since you opened it. Reload to see their version, then make your change again." : error}</span>
            {conflict && (
              <Button type="button" size="sm" variant="outline" onClick={() => router.refresh()}>
                <RefreshCwIcon />
                Reload
              </Button>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button type="submit" disabled={!dirty || problems.length > 0 || pending}>
            {pending ? "Saving…" : effectiveFrom ? "Schedule change" : "Save"}
          </Button>
          {dirty && (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                onDiscard();
                setError(null);
                setEffectiveFrom("");
                setReason("");
              }}
              disabled={pending}
            >
              Discard changes
            </Button>
          )}
        </div>
      </form>

      {meta.history.length > 0 && (
        <details className="mt-5 border-t pt-4">
          <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Version history ({meta.history.length})</summary>
          <ol className="mt-3 grid gap-3 text-sm">
            {meta.history.map((v) => (
              <li key={v.version} className="grid gap-0.5">
                <span className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">Version {v.version}</span>
                  {v.inForce ? <Badge variant="success">In force</Badge> : v.scheduled ? <Badge variant="info">Scheduled</Badge> : <Badge variant="outline">Superseded</Badge>}
                  {v.summary && <span className="text-muted-foreground">{v.summary}</span>}
                </span>
                <span className="text-xs text-muted-foreground">
                  From {when(v.effectiveFrom)} · {v.by}
                  {v.reason ? ` · ${v.reason}` : ""}
                </span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}
