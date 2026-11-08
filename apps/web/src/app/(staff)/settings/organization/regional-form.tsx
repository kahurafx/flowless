"use client";

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { LANGUAGES } from "@/lib/languages";
import { saveRegional } from "./actions";

/** African time zones plus UTC; the current one is always offered. */
function timeZones(current: string): string[] {
  const all = Intl.supportedValuesOf("timeZone").filter((z) => z.startsWith("Africa/"));
  return [...new Set([current, ...all, "UTC"])].sort();
}

export function RegionalForm(props: { timeZone: string; locale: string; latestVersion: number }) {
  const [timeZone, setTimeZone] = useState(props.timeZone);
  const [locale, setLocale] = useState(props.locale);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const changed = timeZone !== props.timeZone || locale !== props.locale;
  const languages = { [props.locale]: LANGUAGES[props.locale] ?? props.locale, ...LANGUAGES };

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        startTransition(async () => {
          const result = await saveRegional({ timeZone, locale, reason, expectedVersion: props.latestVersion });
          setError(result.error);
          if (!result.error) setReason("");
        });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="grid gap-2">
          <Label htmlFor="time-zone">Time zone</Label>
          <Select value={timeZone} onValueChange={(v) => setTimeZone(String(v))}>
            <SelectTrigger id="time-zone" className="w-full">
              <SelectValue>{(v: string) => v.replace(/_/g, " ")}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {timeZones(props.timeZone).map((z) => (
                <SelectItem key={z} value={z}>
                  {z.replace(/_/g, " ")}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-2">
          <Label htmlFor="language">Language</Label>
          <Select value={locale} onValueChange={(v) => setLocale(String(v))}>
            <SelectTrigger id="language" className="w-full">
              <SelectValue>{(v: string) => languages[v] ?? v}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {Object.entries(languages).map(([code, label]) => (
                <SelectItem key={code} value={code}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {changed && (
        <div className="grid gap-2">
          <Label htmlFor="regional-reason">Reason (optional)</Label>
          <Input id="regional-reason" value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder="Board resolution 14/2026" />
        </div>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <div>
        <Button type="submit" size="sm" disabled={!changed || pending}>
          {pending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
