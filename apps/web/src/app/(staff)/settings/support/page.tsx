import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { listSupportGrants } from "@/data/support";
import { SupportManager } from "./support-manager";

export const metadata = { title: "Support access" };

export default function SupportPage() {
  return (
    <>
      <PageHeader
        title="Support access"
        description="Flowless support can't see your data unless you let them, for a reason and a few hours at most."
      />
      <Suspense fallback={<Skeleton className="h-72" />}>
        <Grants />
      </Suspense>
    </>
  );
}

async function Grants() {
  return <SupportManager {...await listSupportGrants()} />;
}
