import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getCategoriesPage } from "@/data/tariffs";
import { formatWhen } from "@/lib/dates";
import { plainDate } from "@/lib/effective-date";
import { assignmentKeyLabel, ASSIGNMENT_KEYS, type AssignmentFields } from "@/lib/tariff-view";
import { AssignTariff, CategoryButtons, NewCategory } from "./category-actions";

export const metadata = { title: "Categories" };

// T-02: customer categories and what each is priced with, from which date.
export default function CategoriesPage() {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Categories />
    </Suspense>
  );
}

async function Categories() {
  const page = await getCategoriesPage();
  const { locale, timeZone } = page;
  const name = (id: string | null, key: keyof AssignmentFields) =>
    id === null ? <span className="text-muted-foreground">None</span> : key === "tariffId" ? <Link href={`/tariffs/${id}`} className="text-primary hover:underline">{page.tariffNames[id] ?? "Unknown"}</Link> : (page.itemNames[id] ?? "Unknown");

  return (
    <>
      <PageHeader
        title="Categories"
        description="What each kind of customer is priced with: a tariff, a standing charge, meter rent and a discount. A change is dated and added to the history, never edited."
        actions={page.canManage && <NewCategory />}
      />
      {page.categories.length === 0 ? (
        <p className="rounded-xl border bg-card p-6 text-center text-muted-foreground">No categories yet.</p>
      ) : (
        <ul className="grid gap-4">
          {page.categories.map((c) => (
            <li key={c.id} className="rounded-xl border bg-card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="flex flex-wrap items-center gap-2 font-semibold">
                    {c.name}
                    <span className="font-mono text-xs font-normal text-muted-foreground">{c.code}</span>
                    {!c.active && <Badge variant="outline">Inactive</Badge>}
                  </h2>
                </div>
                {page.canManage && (
                  <div className="flex flex-wrap gap-1">
                    {c.active && (
                      <AssignTariff
                        categoryId={c.id}
                        categoryName={c.name}
                        history={c.history.map((h) => ({ versionNo: h.versionNo, effectiveFrom: h.effectiveFrom, tariffId: h.tariffId, standingChargeItemId: h.standingChargeItemId, meterRentItemId: h.meterRentItemId, discountItemId: h.discountItemId }))}
                        tariffs={page.tariffs}
                        standing={page.standing}
                        discounts={page.discounts}
                        names={{ ...page.tariffNames, ...page.itemNames }}
                        next={page.next}
                        locale={locale}
                      />
                    )}
                    <CategoryButtons id={c.id} name={c.name} active={c.active} />
                  </div>
                )}
              </div>

              {c.current ? (
                <dl className="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2 lg:grid-cols-4">
                  {ASSIGNMENT_KEYS.map((key) => (
                    <div key={key}>
                      <dt className="text-xs text-muted-foreground">{assignmentKeyLabel[key]}</dt>
                      <dd>{name(c.current![key], key)}</dd>
                    </div>
                  ))}
                </dl>
              ) : (
                <p className="mt-3 text-sm text-muted-foreground">Not priced yet: accounts in this category cannot be billed until a tariff is assigned.</p>
              )}
              {c.current && <p className="mt-2 text-xs text-muted-foreground">In force since {plainDate(c.current.effectiveFrom, locale)}.</p>}
              {c.upcoming.length > 0 && (
                <p className="mt-2 flex flex-wrap items-center gap-1.5 text-xs">
                  {c.upcoming.map((u) => (
                    <Badge key={u.id} variant="info">
                      Change from {plainDate(u.effectiveFrom, locale)}
                    </Badge>
                  ))}
                </p>
              )}

              <details className="mt-3 border-t pt-3">
                <summary className="cursor-pointer text-sm text-muted-foreground hover:text-foreground">Assignment history ({c.history.length})</summary>
                <div className="mt-3 overflow-x-auto rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow className="hover:bg-transparent">
                        <TableHead>Version</TableHead>
                        <TableHead>From</TableHead>
                        <TableHead>Tariff</TableHead>
                        <TableHead>Standing charge</TableHead>
                        <TableHead>Meter rent</TableHead>
                        <TableHead>Discount</TableHead>
                        <TableHead>Added</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {c.history.length === 0 ? (
                        <TableRow className="hover:bg-transparent">
                          <TableCell colSpan={7} className="h-16 text-center text-muted-foreground">
                            No assignment yet.
                          </TableCell>
                        </TableRow>
                      ) : (
                        [...c.history].reverse().map((h) => (
                          <TableRow key={h.id}>
                            <TableCell className="tabular">{h.versionNo}</TableCell>
                            <TableCell className="whitespace-nowrap">{plainDate(h.effectiveFrom, locale)}</TableCell>
                            <TableCell>{name(h.tariffId, "tariffId")}</TableCell>
                            <TableCell>{name(h.standingChargeItemId, "standingChargeItemId")}</TableCell>
                            <TableCell>{name(h.meterRentItemId, "meterRentItemId")}</TableCell>
                            <TableCell>{name(h.discountItemId, "discountItemId")}</TableCell>
                            <TableCell className="min-w-40 text-xs text-muted-foreground">
                              {h.by}, {formatWhen(h.createdAt, locale, timeZone, "date")}
                              {h.reason ? ` · ${h.reason}` : ""}
                            </TableCell>
                          </TableRow>
                        ))
                      )}
                    </TableBody>
                  </Table>
                </div>
              </details>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
