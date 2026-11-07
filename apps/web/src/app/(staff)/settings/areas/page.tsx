import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getHierarchy } from "@/data/hierarchy";
import { AreasManager } from "./areas-manager";

export const metadata = { title: "Areas and routes" };

export default function AreasPage() {
  return (
    <>
      <PageHeader
        title="Areas and routes"
        description="Schemes, zones, sub-zones and DMAs, and the routes your readers walk. Members can be limited to any of them."
      />
      <Suspense fallback={<Skeleton className="h-80" />}>
        <Hierarchy />
      </Suspense>
    </>
  );
}

async function Hierarchy() {
  const { areas, routes, canManage } = await getHierarchy();
  return <AreasManager areas={areas} routes={routes} canManage={canManage} />;
}
