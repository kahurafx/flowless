import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { listInvoiceTypes } from "@/data/tariffs";
import { lateFeeText, overdueText, termsText } from "@/lib/invoice-type-form";
import { appliesToLabel } from "@/lib/tariff-labels";

export const metadata = { title: "Invoice types" };

// T-08 to T-10: numbering, terms, overdue policy, line templates and late fees per kind of invoice.
export default function InvoiceTypesPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <InvoiceTypes />
    </Suspense>
  );
}

async function InvoiceTypes() {
  const data = await listInvoiceTypes();
  return (
    <>
      <PageHeader title="Invoice types" description="Each kind of invoice has its own numbering, payment terms, what happens when it is overdue, the lines a new one carries and its late-fee rule." />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Invoice type</TableHead>
              <TableHead>Bills</TableHead>
              <TableHead>Terms</TableHead>
              <TableHead>When overdue</TableHead>
              <TableHead>Late fee</TableHead>
              <TableHead className="text-right">Lines</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.rows.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={6} className="h-24 text-center text-muted-foreground">
                  No invoice types yet.
                </TableCell>
              </TableRow>
            ) : (
              data.rows.map((t) => (
                <TableRow key={t.id} className={t.active ? undefined : "opacity-60"}>
                  <TableCell className="min-w-48">
                    <Link href={`/tariffs/invoice-types/${t.id}`} className="font-medium text-primary hover:underline">
                      {t.name}
                    </Link>
                    {!t.active && <Badge variant="outline" className="ml-2">Inactive</Badge>}
                    <div className="font-mono text-xs text-muted-foreground">{t.code}</div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={t.appliesTo === "application" ? "info" : "secondary"}>{appliesToLabel[t.appliesTo]}</Badge>
                  </TableCell>
                  <TableCell className="min-w-44 text-sm">
                    {termsText(t.terms, data.currency)}
                    <div className="text-xs text-muted-foreground">Due in {t.dueDays} days</div>
                  </TableCell>
                  <TableCell className="min-w-44 text-sm">{overdueText(t.overdue)}</TableCell>
                  <TableCell className="min-w-44 text-sm">{lateFeeText(t.lateFeeRule, data.currency)}</TableCell>
                  <TableCell className="tabular text-right">{t.lines.length}</TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
