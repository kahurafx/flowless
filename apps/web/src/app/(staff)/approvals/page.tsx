import Link from "next/link";
import { connection } from "next/server";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { listApprovals, type ApprovalView } from "@/data/approvals";
import { cn } from "@/lib/utils";
import { ApprovalsList } from "./approvals-list";

export const metadata = { title: "Approvals" };

const VIEWS: { view: ApprovalView; label: string }[] = [
  { view: "to_decide", label: "Waiting for me" },
  { view: "open", label: "Open" },
  { view: "closed", label: "Decided" },
];

// K-05: requests that need a decision, such as connection surveys and account write-offs.
export default function ApprovalsPage({ searchParams }: PageProps<"/approvals">) {
  return (
    <>
      <PageHeader title="Approvals" description="Requests that need someone's decision. You can't decide your own, and a second level waits for a different person." />
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Approvals searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function Approvals({ searchParams }: { searchParams: PageProps<"/approvals">["searchParams"] }) {
  // "Overdue" is derived from the clock.
  const [params] = await Promise.all([searchParams, connection()]);
  const view = VIEWS.find((v) => v.view === params.view)?.view ?? "to_decide";
  const data = await listApprovals(view);
  return (
    <>
      <nav aria-label="Approval views" className="mb-4 flex flex-wrap gap-1">
        {VIEWS.map((v) => (
          <Link
            key={v.view}
            href={`/approvals?view=${v.view}`}
            aria-current={v.view === view ? "page" : undefined}
            className={cn("rounded-lg px-3 py-1.5 text-sm", v.view === view ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-muted")}
          >
            {v.label}
          </Link>
        ))}
      </nav>
      <ApprovalsList rows={data.rows} view={view} currency={data.currency} locale={data.locale} timeZone={data.timeZone} />
    </>
  );
}
