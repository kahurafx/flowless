import { APPLICATION_STAGES, type ApplicationStage } from "@flowless/shared-types";
import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { ListFilters, NextPage } from "@/components/list-filters";
import { PageHeader } from "@/components/shell/page-header";
import { ApplicationStageBadge } from "@/components/status-badges";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listApplications } from "@/data/applications";
import { applicationStageLabel, surveyApprovalLabel } from "@/lib/account-labels";
import { formatWhen } from "@/lib/dates";

export const metadata = { title: "Applications" };

// C-05: enquiries for new connections, from first contact to an account.
export default function ApplicationsPage({ searchParams }: PageProps<"/accounts/applications">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Applications searchParams={searchParams} />
    </Suspense>
  );
}

async function Applications({ searchParams }: { searchParams: PageProps<"/accounts/applications">["searchParams"] }) {
  const params = await searchParams;
  const text = (v: string | string[] | undefined) => (typeof v === "string" && v !== "" ? v : undefined);
  const stage = APPLICATION_STAGES.find((s) => s === text(params.stage)) as ApplicationStage | undefined;
  const data = await listApplications({ stage, after: text(params.after) });
  return (
    <>
      <PageHeader
        title="Applications"
        description="New-connection enquiries, oldest first. Open one to record the survey, move it along, or turn it into an account."
        actions={
          data.canCreate && (
            <Button render={<Link href="/accounts/applications/new" />}>
              <PlusIcon />
              New enquiry
            </Button>
          )
        }
      />
      <ListFilters filters={[{ param: "stage", label: "All stages", options: APPLICATION_STAGES.map((s) => ({ value: s, label: applicationStageLabel[s] })) }]} />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Customer</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Place</TableHead>
              {data.showCategory && <TableHead>Category</TableHead>}
              <TableHead>Logged</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={data.showCategory ? 5 : 4} className="h-24 text-center text-muted-foreground">
                  {stage ? `No application at the ${applicationStageLabel[stage].toLowerCase()} stage.` : "No applications yet."}
                </TableCell>
              </TableRow>
            ) : (
              data.rows.map((a) => (
                <TableRow key={a.id}>
                  <TableCell className="max-w-72">
                    <Link href={`/accounts/applications/${a.id}`} className="truncate font-medium text-primary hover:underline">
                      {a.customerName ?? "Customer"}
                    </Link>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-1">
                      <ApplicationStageBadge stage={a.stage} />
                      {a.stage === "enquiry" && a.survey?.approvalState === "pending" && <span className="text-xs text-muted-foreground">{surveyApprovalLabel.pending.toLowerCase()}</span>}
                    </div>
                  </TableCell>
                  <TableCell className="min-w-48">
                    <span className="block truncate">{a.address}</span>
                    <span className="text-xs text-muted-foreground">{[a.placeName, a.routeName].filter(Boolean).join(" · ") || "No area set"}</span>
                  </TableCell>
                  {data.showCategory && <TableCell>{a.categoryName ?? <span className="text-muted-foreground">None</span>}</TableCell>}
                  <TableCell className="tabular whitespace-nowrap">{formatWhen(a.createdAt, data.locale, data.timeZone, "date")}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
      <NextPage cursor={data.nextCursor} />
    </>
  );
}
