import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { listReviews } from "@/data/work-orders";
import { ReviewsGrid } from "./reviews-grid";

export const metadata = { title: "Job reviews" };

// W-01: submitted jobs wait here for `work_orders:review`. Approving closes the job; network edits are posted separately.
export default function ReviewsPage() {
  return (
    <>
      <PageHeader title="Job reviews" description="Work that was submitted and needs a second person's decision, oldest first." />
      <Suspense fallback={<Skeleton className="h-72" />}>
        <Reviews />
      </Suspense>
    </>
  );
}

async function Reviews() {
  return <ReviewsGrid {...await listReviews()} />;
}
