import { Suspense } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { Skeleton } from "@/components/ui/skeleton";
import { getAuth } from "@/server/auth";
import { OrganizationPicker } from "./organization-picker";

export const metadata = { title: "Choose organization" };

export default function SelectOrganizationPage() {
  return (
    <main className="flex min-h-svh items-center justify-center px-4 py-12">
      <div className="flex w-full max-w-sm flex-col gap-6">
        <div className="flex flex-col gap-1 text-center">
          <h1 className="text-2xl font-semibold">Choose an organization</h1>
          <p className="text-sm text-muted-foreground">You can switch at any time from the sidebar.</p>
        </div>
        <Suspense fallback={<Skeleton className="h-40" />}>
          <Organizations />
        </Suspense>
      </div>
    </main>
  );
}

async function Organizations() {
  const requestHeaders = await headers();
  const auth = getAuth();
  const session = await auth.api.getSession({ headers: requestHeaders });
  if (!session) redirect("/sign-in");
  const organizations = await auth.api.listOrganizations({ headers: requestHeaders });
  return <OrganizationPicker organizations={organizations.map(({ id, name }) => ({ id, name }))} />;
}
