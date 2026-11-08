import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { listCrews } from "@/data/work-orders";
import { CrewsManager } from "./crews-manager";

export const metadata = { title: "Crews" };

// W-02: crews belong to the Work Orders module (level full). A crew's members see and work its jobs.
export default function CrewsPage() {
  return (
    <>
      <PageHeader title="Crews" description="People who work together. Give a job to a crew and every member can see and work it." />
      <Suspense fallback={<Skeleton className="h-72" />}>
        <Crews />
      </Suspense>
    </>
  );
}

async function Crews() {
  return <CrewsManager {...await listCrews()} />;
}
