import Link from "next/link";
import { Suspense } from "react";
import { ListFilters } from "@/components/list-filters";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listHandovers } from "@/data/metering";
import { getSession } from "@/data/session";
import { LinkClosingDialog } from "./link-closing";

export const metadata = { title: "Reading handovers" };

// C-08, C-10: a closing reading is owed when an account changes hands or holder.
export default function HandoversPage({ searchParams }: PageProps<"/metering/handovers">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Handovers searchParams={searchParams} />
    </Suspense>
  );
}

const one = (value: string | string[] | undefined) => (typeof value === "string" && value !== "" ? value : undefined);
const REASON = { succession: "Succession", change_name: "Change of name" } as const;

async function Handovers({ searchParams }: { searchParams: PageProps<"/metering/handovers">["searchParams"] }) {
  const params = await searchParams;
  const [data, session] = await Promise.all([listHandovers({ pending: one(params.pending) }), getSession()]);
  const account = (id: string) => {
    const l = data.labels[id];
    return l ? <Link href={`/accounts/${encodeURIComponent(l.number)}`} className="text-primary hover:underline">{l.number}</Link> : id.slice(0, 8);
  };
  return (
    <>
      <PageHeader
        title="Reading handovers"
        description="When an account is succeeded or its holder changes, the old holder is owed a closing reading on the effective date. A handover stays pending, with an exception, until an actual reading is linked."
      />
      <ListFilters filters={[{ param: "pending", label: "All handovers", options: [{ value: "1", label: "Waiting for a closing reading" }] }]} />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Effective</TableHead>
              <TableHead>Why</TableHead>
              <TableHead>From</TableHead>
              <TableHead>To</TableHead>
              <TableHead>Meter</TableHead>
              <TableHead>Closing reading</TableHead>
              {data.canLink && <TableHead className="w-0" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="h-24 text-center text-muted-foreground">
                  No handovers{params.pending === "1" ? " are waiting" : " yet"}.
                </TableCell>
              </TableRow>
            ) : (
              data.rows.map((h) => (
                <TableRow key={h.id}>
                  <TableCell className="whitespace-nowrap">{h.effectiveDate}</TableCell>
                  <TableCell>{REASON[h.reason]}</TableCell>
                  <TableCell>{account(h.fromAccountId)}</TableCell>
                  <TableCell>{account(h.toAccountId)}</TableCell>
                  <TableCell>
                    <Link href={`/metering/meters/${h.meterId}`} className="text-primary hover:underline">
                      {data.serials[h.meterId] ?? h.meterId.slice(0, 8)}
                    </Link>
                  </TableCell>
                  <TableCell>{h.pending ? <Badge variant="warning">Pending</Badge> : <Badge variant="success">Linked</Badge>}</TableCell>
                  {data.canLink && <TableCell>{h.pending && <LinkClosingDialog handoverId={h.id} meterId={h.meterId} locale={session.organization.settings.locale} />}</TableCell>}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
