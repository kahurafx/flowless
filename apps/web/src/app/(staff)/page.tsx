import type { ExceptionType } from "@flowless/shared-types";
import { ArrowRightIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { exceptionTypeLabel } from "@/components/status-badges";
import { Skeleton } from "@/components/ui/skeleton";
import { exceptionCounts } from "@/data/exceptions";
import { getSession } from "@/data/session";

export const metadata = { title: "Overview" };

export default function OverviewPage() {
  return (
    <>
      <Suspense fallback={<Skeleton className="mb-6 h-16 w-72" />}>
        <Greeting />
      </Suspense>
      <Suspense fallback={<CountsSkeleton />}>
        <Counts />
      </Suspense>
    </>
  );
}

async function Greeting() {
  const { user, organization } = await getSession();
  return (
    <PageHeader
      eyebrow={organization.name}
      title={`Good to see you, ${user.name.split(" ")[0]}`}
      description="Work the queues from the top. Everything that needs a person is here."
    />
  );
}

async function Counts() {
  const counts = await exceptionCounts();
  const types = Object.entries(counts.byType) as [ExceptionType, number][];
  return (
    <div className="flex flex-col gap-6">
      {/* Summary first: the one number that matters, then how much of it is overdue. */}
      <section aria-labelledby="summary" className="grid gap-3 sm:grid-cols-4">
        <h2 id="summary" className="sr-only">
          Summary
        </h2>
        <Stat label="Open exceptions" value={counts.total} href="/exceptions" />
        <Stat label="Overdue" value={counts.byBucket.overdue} tone="text-age-overdue" href="/exceptions?age=overdue" />
        <Stat label="Ageing" value={counts.byBucket.ageing} tone="text-age-ageing" href="/exceptions?age=ageing" />
        <Stat label="Unassigned" value={counts.unowned} href="/exceptions?owner=Unassigned" />
      </section>

      <section aria-labelledby="queues" className="flex flex-col gap-3">
        <h2 id="queues" className="text-lg font-semibold">
          Queues
        </h2>
        {types.length === 0 ? (
          <p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">
            No open exceptions. Every account, payment and message is accounted for.
          </p>
        ) : (
          <ul className="divide-y overflow-hidden rounded-xl border bg-card">
            {types
              .sort((a, b) => b[1] - a[1])
              .map(([type, count]) => (
                <li key={type}>
                  <Link
                    href={`/exceptions?type=${type}`}
                    className="group flex items-center gap-3 px-4 py-3 text-sm transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none active:bg-accent"
                  >
                    <span className="font-medium">{exceptionTypeLabel[type]}</span>
                    <span className="tabular ml-auto text-muted-foreground">{count}</span>
                    <ArrowRightIcon className="size-4 text-muted-foreground transition-transform duration-150 ease-out group-hover:translate-x-0.5" />
                  </Link>
                </li>
              ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function Stat({ label, value, href, tone }: { label: string; value: number; href: string; tone?: string }) {
  return (
    <Link
      href={href}
      className="flex flex-col gap-1 rounded-xl border bg-card p-4 transition-[background-color,scale] duration-100 ease-out hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring/50 focus-visible:outline-none active:scale-[0.98]"
    >
      <span className="text-sm text-muted-foreground">{label}</span>
      <span className={`tabular text-3xl font-semibold tracking-tight ${tone ?? ""}`}>{value}</span>
    </Link>
  );
}

function CountsSkeleton() {
  return (
    <div className="grid gap-3 sm:grid-cols-4">
      {[0, 1, 2, 3].map((i) => (
        <Skeleton key={i} className="h-24" />
      ))}
    </div>
  );
}
