import { money } from "@flowless/shared-types";
import { Suspense } from "react";
import { MoneyText } from "@/components/money-text";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getChargeCatalog } from "@/data/tariffs";
import { formatWhen } from "@/lib/dates";
import { plainDate } from "@/lib/effective-date";
import { chargeRecurrenceLabel, chargeTypeLabel, revenueKindLabel } from "@/lib/tariff-labels";
import { versionStatus, versionStatusLabel } from "@/lib/tariff-view";
import { AddAmount, EditChargeItem, NewChargeItem } from "./charge-actions";

export const metadata = { title: "Charge catalog" };

// T-07: every charge an invoice can carry, with dated amounts.
export default function ChargesPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Charges />
    </Suspense>
  );
}

async function Charges() {
  const page = await getChargeCatalog();
  const { currency, locale, timeZone } = page;
  return (
    <>
      <PageHeader
        title="Charge catalog"
        description="Fees, deposits, rent and the other things an invoice can carry. A deposit is held as a liability, not revenue, and a transfer between accounts is not revenue either."
        actions={page.canManage && <NewChargeItem next={page.next} currency={currency} locale={locale} />}
      />
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Item</TableHead>
              <TableHead>Type</TableHead>
              <TableHead className="text-right">Amount now</TableHead>
              <TableHead>Next</TableHead>
              {page.canManage && <TableHead className="text-right">
                <span className="sr-only">Actions</span>
              </TableHead>}
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.items.length === 0 ? (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                  The catalog is empty.
                </TableCell>
              </TableRow>
            ) : (
              page.items.map((item) => (
                <TableRow key={item.id} className={item.active ? undefined : "opacity-60"}>
                  <TableCell className="min-w-56 align-top">
                    <div className="font-medium">
                      {item.name}
                      {!item.active && <Badge variant="outline" className="ml-2">Inactive</Badge>}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">{item.code}</div>
                    {item.amounts.length > 0 && (
                      <details className="mt-2">
                        <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">Amount history ({item.amounts.length})</summary>
                        <ol className="mt-2 grid gap-1.5 text-xs">
                          {[...item.amounts].reverse().map((a) => {
                            const status = versionStatus({ effectiveFrom: a.effectiveFrom, until: a.until }, page.next.today);
                            return (
                              <li key={a.id} className="flex flex-wrap items-baseline gap-x-2">
                                <MoneyText value={money(a.amount, currency)} locale={locale} className="font-medium" />
                                <span className="text-muted-foreground">
                                  {status === "replaced" ? `dated ${plainDate(a.effectiveFrom, locale)}` : `${plainDate(a.effectiveFrom, locale)} ${a.until ? `to ${plainDate(a.until, locale)}` : "onwards"}`}
                                </span>
                                <Badge variant={status === "in_force" ? "success" : status === "scheduled" ? "info" : "outline"}>{versionStatusLabel[status]}</Badge>
                                <span className="text-muted-foreground">
                                  {a.by}, {formatWhen(a.createdAt, locale, timeZone, "date")}
                                  {a.reason ? ` · ${a.reason}` : ""}
                                </span>
                              </li>
                            );
                          })}
                        </ol>
                      </details>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    <div className="flex flex-wrap items-center gap-1">
                      <Badge variant="secondary">{chargeTypeLabel[item.type]}</Badge>
                      {item.recurrence && <Badge variant="outline">{chargeRecurrenceLabel[item.recurrence]}</Badge>}
                    </div>
                    {item.revenueKind !== "revenue" && (
                      <Badge variant="warning" className="mt-1">
                        {revenueKindLabel[item.revenueKind]}
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-right align-top">
                    {item.amount ? (
                      <MoneyText value={money(item.amount.amount, currency)} locale={locale} className="font-medium" />
                    ) : item.type === "usage" ? (
                      <span className="text-muted-foreground">Priced by a tariff</span>
                    ) : (
                      <span className="text-muted-foreground">Not priced yet</span>
                    )}
                  </TableCell>
                  <TableCell className="align-top">
                    {item.upcoming.length === 0 ? (
                      <span className="text-muted-foreground">None scheduled</span>
                    ) : (
                      <ul className="grid gap-1">
                        {item.upcoming.map((u) => (
                          <li key={u.id} className="flex flex-wrap items-center gap-1.5 text-sm">
                            <MoneyText value={money(u.amount, currency)} locale={locale} />
                            <Badge variant="info">from {plainDate(u.effectiveFrom, locale)}</Badge>
                          </li>
                        ))}
                      </ul>
                    )}
                  </TableCell>
                  {page.canManage && (
                    <TableCell className="align-top">
                      <div className="flex flex-wrap justify-end gap-1">
                        {item.type !== "usage" && item.active && <AddAmount id={item.id} name={item.name} currency={currency} history={item.amounts.map((a) => a.effectiveFrom)} next={page.next} locale={locale} />}
                        <EditChargeItem id={item.id} name={item.name} type={item.type} recurrence={item.recurrence} active={item.active} />
                      </div>
                    </TableCell>
                  )}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
