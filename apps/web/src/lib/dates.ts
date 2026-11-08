/** A moment in the organization's time zone and language (K-10). */
export function formatWhen(value: Date | string, locale: string, timeZone: string, style: "short" | "date" = "short"): string {
  const date = typeof value === "string" ? new Date(value) : value;
  return new Intl.DateTimeFormat(locale, style === "date" ? { dateStyle: "medium", timeZone } : { dateStyle: "medium", timeStyle: "short", timeZone }).format(date);
}

/** "3 hours ago", "in 2 days": for ages and due times next to the exact moment. */
export function relativeTo(value: Date | string, now: Date, locale: string): string {
  const date = typeof value === "string" ? new Date(value) : value;
  const seconds = Math.round((date.getTime() - now.getTime()) / 1000);
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ["day", 86_400],
    ["hour", 3_600],
    ["minute", 60],
  ];
  const format = new Intl.RelativeTimeFormat(locale, { numeric: "auto" });
  for (const [unit, size] of units) if (Math.abs(seconds) >= size) return format.format(Math.round(seconds / size), unit);
  return format.format(0, "second");
}
