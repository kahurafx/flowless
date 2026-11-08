import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { getBranchPreview } from "@/data/gis";
import { BranchReview } from "./branch-review";

export const metadata = { title: "Review branch" };

export default function BranchPage({ params }: PageProps<"/map/reconcile/[branch]">) {
  return (
    <>
      <Link href="/map/reconcile" className="mb-4 inline-flex min-h-9 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon className="size-4" />
        Pending changes
      </Link>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Review params={params} />
      </Suspense>
    </>
  );
}

async function Review({ params }: { params: PageProps<"/map/reconcile/[branch]">["params"] }) {
  const { branch } = await params;
  return <BranchReview preview={await getBranchPreview(decodeURIComponent(branch))} />;
}
