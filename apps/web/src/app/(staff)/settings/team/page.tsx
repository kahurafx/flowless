import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { listTeam } from "@/data/team";
import { TeamManager } from "./team-manager";

export const metadata = { title: "Team and permissions" };

export default function TeamPage() {
  return (
    <>
      <PageHeader
        title="Team and permissions"
        description="Each role comes with a set of permissions. Give someone more when their work needs it, whatever their role."
      />
      <Suspense fallback={<Skeleton className="h-72" />}>
        <Team />
      </Suspense>
    </>
  );
}

async function Team() {
  return <TeamManager {...await listTeam()} />;
}
