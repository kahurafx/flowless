import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { listJobs } from "@/data/work-orders";
import { JobsGrid } from "./jobs-grid";

export const metadata = { title: "Work orders" };

// W-01, W-02: one queue for every kind of job. Members who only execute see their own jobs.
export default function WorkOrdersPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Jobs />
    </Suspense>
  );
}

async function Jobs() {
  const data = await listJobs();
  return (
    <>
      <PageHeader
        title={data.mineOnly ? "My jobs" : "Work orders"}
        description={
          data.mineOnly
            ? "Jobs given to you or your crews, and what you finished in the last two weeks."
            : "Every job in your scope: filter by status, kind, priority, who has it, or what is overdue."
        }
        actions={
          data.canRaise && (
            <Button render={<Link href="/work-orders/new" />}>
              <PlusIcon />
              New job
            </Button>
          )
        }
      />
      <JobsGrid {...data} />
    </>
  );
}
