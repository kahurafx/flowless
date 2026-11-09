import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getSurveyJobPrefill } from "@/data/applications";
import { getNewJobForm } from "@/data/work-orders";
import { NewJobForm } from "./new-job-form";

export const metadata = { title: "New job" };

export default function NewJobPage({ searchParams }: PageProps<"/work-orders/new">) {
  return (
    <>
      <PageHeader title="New job" description="Raise a job for a person or crew, or for something you found in the field." />
      <Suspense fallback={<Skeleton className="h-96 max-w-2xl" />}>
        <Form searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function Form({ searchParams }: { searchParams: PageProps<"/work-orders/new">["searchParams"] }) {
  const params = await searchParams;
  const form = await getNewJobForm();
  // An application's "Raise survey job" link: ?kind=connection_survey&asset=<application id>.
  const kind = typeof params.kind === "string" ? params.kind : undefined;
  const asset = typeof params.asset === "string" && UUID.test(params.asset) ? params.asset : undefined;
  const prefill = kind === "connection_survey" && asset && form.kinds.some((k) => k.key === kind) ? await getSurveyJobPrefill(asset) : null;
  return <NewJobForm {...form} initial={prefill ? { kind: "connection_survey", assetId: asset!, ...prefill } : null} />;
}
