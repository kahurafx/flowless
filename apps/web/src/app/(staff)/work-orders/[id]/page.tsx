import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { getJob } from "@/data/work-orders";
import { JobDetail } from "./job-detail";

export const metadata = { title: "Job" };

export default function JobPage({ params }: PageProps<"/work-orders/[id]">) {
  return (
    <>
      <Link href="/work-orders" className="mb-4 inline-flex min-h-9 items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground">
        <ArrowLeftIcon className="size-4" />
        Work orders
      </Link>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Detail params={params} />
      </Suspense>
    </>
  );
}

async function Detail({ params }: { params: PageProps<"/work-orders/[id]">["params"] }) {
  const { id } = await params;
  return <JobDetail page={await getJob(id)} />;
}
