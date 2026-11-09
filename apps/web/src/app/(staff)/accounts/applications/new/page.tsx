import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAccountFormOptions } from "@/data/customers";
import { NewApplicationForm } from "./new-application-form";

export const metadata = { title: "New enquiry" };

// C-05: log an enquiry for a new connection.
export default function NewApplicationPage() {
  return (
    <>
      <PageHeader title="New enquiry" description="Log someone asking for a new connection. The survey, invoice and installation follow from the application page." />
      <Suspense fallback={<Skeleton className="h-96 max-w-2xl" />}>
        <Form />
      </Suspense>
    </>
  );
}

async function Form() {
  return <NewApplicationForm options={await getAccountFormOptions()} />;
}
