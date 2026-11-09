import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAccountFormOptions } from "@/data/customers";
import { NewAccountForm } from "./new-account-form";

export const metadata = { title: "New account" };

// C-01, C-02, C-07: a customer, an account with the next number, and the place it is served.
export default function NewAccountPage() {
  return (
    <>
      <PageHeader title="New account" description="Choose or add the customer, say what kind of account it is, and where the connection is. The account starts new and disconnected." />
      <Suspense fallback={<Skeleton className="h-96 max-w-2xl" />}>
        <Form />
      </Suspense>
    </>
  );
}

async function Form() {
  return <NewAccountForm options={await getAccountFormOptions()} />;
}
