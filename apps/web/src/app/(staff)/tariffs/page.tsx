import { PlusIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listTariffs } from "@/data/tariffs";
import { plainDate } from "@/lib/effective-date";
import { tariffTypeLabel } from "@/lib/tariff-labels";

export const metadata = { title: "Tariffs" };

// T-01, T-03: how consumption (or a flat amount) is priced, with versions that never overwrite.
export default function TariffsPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Tariffs />
    </Suspense>
  );
}

async function Tariffs() {
  const data = await listTariffs();
  return (
    <>
      <PageHeader
        title="Tariffs"
        description="Each tariff is a history of versions: a change adds a version from a date and never edits an old one, so any past bill can be explained."
        actions={
          data.canManage && (
            <Button render={<Link href="/tariffs/new" />}>
              <PlusIcon />
              New tariff
            </Button>
          )
        }
      />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Tariff</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>In force</TableHead>
              <TableHead>Next change</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                  No tariffs yet.{data.canManage ? " Add the first one to price consumption." : ""}
                </TableCell>
              </TableRow>
            ) : (
              data.rows.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="max-w-72">
                    <Link href={`/tariffs/${t.id}`} className="truncate font-medium text-primary hover:underline">
                      {t.name}
                    </Link>
                    {!t.active && (
                      <Badge variant="outline" className="ml-2">
                        Inactive
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Badge variant="secondary">{tariffTypeLabel[t.type]}</Badge>
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {t.current ? (
                      <>
                        <span className="font-medium">Version {t.current.versionNo}</span> <span className="text-muted-foreground">from {plainDate(t.current.effectiveFrom, data.locale)}</span>
                      </>
                    ) : (
                      <span className="text-muted-foreground">{t.versionCount === 0 ? "No version" : "Not started yet"}</span>
                    )}
                  </TableCell>
                  <TableCell className="whitespace-nowrap">
                    {t.nextChangeOn ? <Badge variant="info">Scheduled {plainDate(t.nextChangeOn, data.locale)}</Badge> : <span className="text-muted-foreground">None scheduled</span>}
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
