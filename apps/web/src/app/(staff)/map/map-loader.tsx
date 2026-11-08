"use client";

import dynamic from "next/dynamic";
import { Skeleton } from "@/components/ui/skeleton";
import type { NetworkMapData } from "@/data/gis";

// MapLibre needs the browser (WebGL), so the map is loaded on the client only.
const NetworkMap = dynamic(() => import("./network-map").then((m) => m.NetworkMap), {
  ssr: false,
  loading: () => <Skeleton className="h-[60dvh] min-h-80" />,
});

export function MapLoader({ data }: { data: NetworkMapData }) {
  // A different branch is a different network: start the map afresh.
  return <NetworkMap key={data.branch} data={data} />;
}
