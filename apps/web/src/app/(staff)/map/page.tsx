import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { branchFrom, getNetworkMap } from "@/data/gis";
import { MapLoader } from "./map-loader";

export const metadata = { title: "Network map" };

// G-01 to G-03: the network of one branch (the live network, a job's, or your own), with edit tools that save.
export default function MapPage({ searchParams }: PageProps<"/map">) {
  return (
    <>
      <PageHeader title="Network map" description="Nodes, pipes, structures and DMAs. Edits are proposals on a branch until someone posts them to the live network." />
      <Suspense fallback={<Skeleton className="h-[60dvh] min-h-80" />}>
        <NetworkMapView searchParams={searchParams} />
      </Suspense>
    </>
  );
}

async function NetworkMapView({ searchParams }: { searchParams: PageProps<"/map">["searchParams"] }) {
  const params = await searchParams;
  const job = typeof params.job === "string" ? params.job : undefined;
  const dma = typeof params.dma === "string" ? params.dma : undefined;
  return <MapLoader data={await getNetworkMap({ branch: branchFrom(params.branch), jobId: job, dmaId: dma })} />;
}
