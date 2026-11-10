import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getReportsPage } from "@/data/reports";
import { cn } from "@/lib/utils";
import { ReportViewer } from "./report-viewer";

export const metadata = { title: "Reports" };

// X-01, X-03: reports over read models, with CSV and Excel download.
export default function ReportsPage({ searchParams }: PageProps<"/reports">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Reports searchParams={searchParams} />
    </Suspense>
  );
}

async function Reports({ searchParams }: { searchParams: PageProps<"/reports">["searchParams"] }) {
  const params = await searchParams;
  const data = await getReportsPage();
  const chosen = data.reports.find((r) => r.key === params.report) ?? null;
  return (
    <>
      <PageHeader
        title="Reports"
        description="Reports for the modules your organization uses and the permissions you hold. Results respect the areas and routes you are limited to; every download is recorded in the audit log."
      />
      {data.reports.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-sm text-muted-foreground">No reports are available for your organization&apos;s modules and your permissions.</p>
      ) : (
        <div className="grid items-start gap-6 lg:grid-cols-[16rem_1fr]">
          <nav aria-label="Reports" className="grid gap-1">
            {data.reports.map((r) => (
              <Link
                key={r.key}
                href={`/reports?report=${encodeURIComponent(r.key)}`}
                aria-current={chosen?.key === r.key ? "page" : undefined}
                className={cn("rounded-lg px-3 py-2 text-sm hover:bg-muted", chosen?.key === r.key && "bg-muted font-medium")}
              >
                {r.label}
                <span className="block text-xs text-muted-foreground">{r.module}</span>
              </Link>
            ))}
          </nav>
          {chosen ? (
            <ReportViewer key={chosen.key} report={chosen} canExport={data.canExport} currency={data.currency} locale={data.locale} timeZone={data.timeZone} />
          ) : (
            <p className="text-sm text-muted-foreground">Choose a report to set its filters and run it.</p>
          )}
        </div>
      )}
    </>
  );
}
