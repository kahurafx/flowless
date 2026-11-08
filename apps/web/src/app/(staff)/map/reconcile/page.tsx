import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { listPendingBranches } from "@/data/gis";
import { PendingList } from "./pending-list";

export const metadata = { title: "Pending changes" };

// G-02: edits wait on branches until someone with `gis:post` reviews and posts them.
export default function ReconcilePage() {
  return (
    <>
      <PageHeader title="Pending changes" description="Network edits that are not live yet: who made them, which job they belong to, and what posting would do." />
      <Suspense fallback={<Skeleton className="h-72" />}>
        <Pending />
      </Suspense>
    </>
  );
}

async function Pending() {
  return <PendingList {...await listPendingBranches()} />;
}
