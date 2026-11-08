import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getNewJobForm } from "@/data/work-orders";
import { NewJobForm } from "./new-job-form";

export const metadata = { title: "New job" };

export default function NewJobPage() {
  return (
    <>
      <PageHeader title="New job" description="Raise a job for a person or crew, or for something you found in the field." />
      <Suspense fallback={<Skeleton className="h-96 max-w-2xl" />}>
        <Form />
      </Suspense>
    </>
  );
}

async function Form() {
  return <NewJobForm {...await getNewJobForm()} />;
}
