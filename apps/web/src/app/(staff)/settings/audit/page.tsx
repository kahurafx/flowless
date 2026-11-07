import { CheckCircle2Icon, TriangleAlertIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { listAudit } from "@/data/audit";
import { getSession } from "@/data/session";
import { AUDIT_FILTERS, auditActionLabel, auditSourceLabel } from "@/lib/audit-labels";

export const metadata = { title: "Audit log" };

export default function AuditPage({ searchParams }: PageProps<"/settings/audit">) {
  return (
    <>
      <PageHeader
        title="Audit log"
        description="Every sign-in, permission, coverage and setting change: who, when, from where, and what changed. Entries can't be edited or removed."
      />
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Entries searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const one = (value: string | string[] | undefined) => (Array.isArray(value) ? value[0] : value);

async function Entries({ searchParams }: { searchParams: PageProps<"/settings/audit">["searchParams"] }) {
  const params = await searchParams;
  const filter = AUDIT_FILTERS.find((f) => f.key === one(params.filter)) ?? AUDIT_FILTERS[0];
  const beforeParam = one(params.before);
  const before = beforeParam && /^\d+$/.test(beforeParam) ? BigInt(beforeParam) : undefined;

  const [{ entries, next, chain, names }, { organization }] = await Promise.all([
    listAudit({ actionPrefix: filter.prefix, before }),
    getSession(),
  ]);
  const when = new Intl.DateTimeFormat(organization.settings.locale, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: organization.settings.timeZone,
  });
  const href = (changes: Record<string, string | undefined>) => {
    const query = new URLSearchParams();
    const merged = { filter: filter.key === "all" ? undefined : filter.key, ...changes };
    for (const [k, v] of Object.entries(merged)) if (v) query.set(k, v);
    const qs = query.toString();
    return qs ? `/settings/audit?${qs}` : "/settings/audit";
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <nav aria-label="Filter" className="flex flex-wrap gap-1.5">
          {AUDIT_FILTERS.map((f) => (
            <Link
              key={f.key}
              href={href({ filter: f.key === "all" ? undefined : f.key, before: undefined })}
              aria-current={f.key === filter.key ? "page" : undefined}
              className="rounded-full border px-3 py-1 text-sm transition-colors hover:bg-accent aria-[current=page]:border-primary aria-[current=page]:bg-primary aria-[current=page]:text-primary-foreground pointer-coarse:py-2"
            >
              {f.label}
            </Link>
          ))}
        </nav>
        <p className="ml-auto flex items-center gap-1.5 text-sm">
          {chain.firstBroken === null ? (
            <>
              <CheckCircle2Icon className="size-4 text-success" aria-hidden />
              <span className="text-muted-foreground">
                Chain intact · <span className="tabular">{chain.checked.toString()}</span> entries checked
              </span>
            </>
          ) : (
            <>
              <TriangleAlertIcon className="size-4 text-destructive" aria-hidden />
              <span className="font-medium text-destructive">
                Chain broken at entry <span className="tabular">{chain.firstBroken.toString()}</span>. Contact Flowless support.
              </span>
            </>
          )}
        </p>
      </div>

      {entries.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">Nothing recorded here yet.</p>
      ) : (
        <ol className="divide-y overflow-hidden rounded-xl border bg-card">
          {entries.map((e) => {
            const subject = e.subjectId ? (names.get(e.subjectId) ?? null) : null;
            const hasDetails = e.before != null || e.after != null || e.reason || e.ipAddress;
            return (
              <li key={e.id}>
                <details className="group">
                  <summary
                    className={`flex list-none flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3 text-sm [&::-webkit-details-marker]:hidden ${hasDetails ? "cursor-pointer hover:bg-accent focus-visible:bg-accent focus-visible:outline-none" : ""}`}
                  >
                    <span className="font-medium">{auditActionLabel[e.action] ?? e.action}</span>
                    {subject && <span className="text-muted-foreground">{subject}</span>}
                    <span className="ml-auto flex items-baseline gap-2 text-xs text-muted-foreground">
                      <span>{e.actorLabel ?? "Unknown"}</span>
                      <Badge variant={e.source === "system" ? "secondary" : "outline"}>{auditSourceLabel[e.source] ?? e.source}</Badge>
                      <time dateTime={e.occurredAt.toISOString()} className="tabular">
                        {when.format(e.occurredAt)}
                      </time>
                    </span>
                  </summary>
                  {hasDetails && (
                    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 border-t bg-muted/40 px-4 py-3 text-xs">
                      {e.reason && <Detail label="Reason">{e.reason}</Detail>}
                      {e.before != null && <Detail label="Before">{describe(e.before, names)}</Detail>}
                      {e.after != null && <Detail label="After">{describe(e.after, names)}</Detail>}
                      {e.ipAddress && (
                        <Detail label="Address">
                          <span className="font-mono">{e.ipAddress}</span>
                        </Detail>
                      )}
                      <Detail label="Entry">
                        <span className="tabular font-mono">#{e.index.toString()}</span>
                      </Detail>
                    </dl>
                  )}
                </details>
              </li>
            );
          })}
        </ol>
      )}

      {(before || next) && (
        <div className="flex gap-3 text-sm">
          {before && (
            <Link href={href({ before: undefined })} className="text-primary underline-offset-4 hover:underline">
              Newest
            </Link>
          )}
          {next && (
            <Link href={href({ before: next.toString() })} className="ml-auto text-primary underline-offset-4 hover:underline">
              Older entries
            </Link>
          )}
        </div>
      )}
    </div>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </>
  );
}

/** A before/after value as readable text, with ids replaced by names where known. */
function describe(value: unknown, names: ReadonlyMap<string, string>): string {
  const show = (v: unknown): string => {
    if (v === null || v === undefined || v === "") return "none";
    if (typeof v === "string") return names.get(v) ?? v;
    if (Array.isArray(v)) return v.length ? v.map(show).join(", ") : "none";
    if (typeof v === "object") {
      return Object.entries(v as Record<string, unknown>)
        .filter(([k]) => k !== "id")
        .map(([k, inner]) => `${k.replace(/Ids?$/, (m) => (m === "Ids" ? "s" : "")).replace(/([A-Z])/g, " $1").toLowerCase()}: ${show(inner)}`)
        .join(" · ");
    }
    return String(v);
  };
  return show(value);
}
