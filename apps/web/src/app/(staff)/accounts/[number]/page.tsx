import type { StatementLineType } from "@flowless/shared-types";
import { ArrowLeftIcon, LinkIcon } from "lucide-react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { MoneyText } from "@/components/money-text";
import { PageHeader } from "@/components/shell/page-header";
import { CommercialStatusBadge, ServiceStatusBadge } from "@/components/status-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getAccount } from "@/data/accounts";
import { getSession } from "@/data/session";
import { money } from "@flowless/shared-types";

export default function AccountPage({ params }: PageProps<"/accounts/[number]">) {
  return (
    <>
      <Button variant="ghost" className="-ml-2.5 mb-2" render={<Link href="/accounts" />}>
        <ArrowLeftIcon />
        Accounts
      </Button>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Account params={params} />
      </Suspense>
    </>
  );
}

const lineLabel: Record<StatementLineType, string> = {
  invoice: "Invoice",
  payment: "Payment",
  adjustment: "Adjustment",
  credit_note: "Credit note",
  transfer: "Transfer",
};

async function Account({ params }: { params: PageProps<"/accounts/[number]">["params"] }) {
  const [{ number }, { organization }] = await Promise.all([params, getSession()]);
  const found = await getAccount(decodeURIComponent(number));
  if (!found) notFound();

  const { account, statement, opening } = found;
  const { locale, timeZone, currency } = organization.settings;
  const date = new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeZone });

  return (
    <>
      <PageHeader
        eyebrow={`Account ${account.number}`}
        title={account.customerName}
        description={
          <div className="mt-1 flex flex-wrap gap-1.5">
            <CommercialStatusBadge status={account.commercialStatus} />
            <ServiceStatusBadge service={account.service} />
            {account.service.state === "DISCONNECTED" && (
              <span className="text-xs text-muted-foreground">{account.service.reason}</span>
            )}
          </div>
        }
        actions={
          <div className="text-right">
            <p className="text-xs text-muted-foreground">Balance</p>
            <MoneyText value={account.balance} locale={locale} className="text-2xl font-semibold tracking-tight" />
          </div>
        }
      />

      <dl className="mb-8 grid grid-cols-2 gap-4 rounded-xl border bg-card p-4 text-sm sm:grid-cols-4">
        <Detail label="Category">{account.category}</Detail>
        <Detail label="Zone">{account.zone}</Detail>
        <Detail label="Route">{account.route}</Detail>
        <Detail label="Phone">
          {account.phone ?? <Badge variant="warning">No phone</Badge>}
        </Detail>
      </dl>

      <section aria-labelledby="statement" className="flex flex-col gap-3">
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="statement" className="text-lg font-semibold">
            Statement
          </h2>
          <p className="text-xs text-muted-foreground">Running balance is computed from the entries (B-17).</p>
        </div>
        <div className="overflow-x-auto rounded-xl border bg-card">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead>Date</TableHead>
                <TableHead>Entry</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {opening !== 0n && (
                <TableRow className="text-muted-foreground hover:bg-transparent">
                  <TableCell colSpan={4}>Opening balance</TableCell>
                  <TableCell className="text-right">
                    <MoneyText value={money(opening, currency)} locale={locale} tone="plain" />
                  </TableCell>
                </TableRow>
              )}
              {statement.length === 0 && opening === 0n ? (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={5} className="h-20 text-center text-muted-foreground">
                    No entries yet.
                  </TableCell>
                </TableRow>
              ) : (
                statement.map((row) => (
                  <TableRow key={row.id}>
                    <TableCell className="tabular whitespace-nowrap">{date.format(row.postedAt)}</TableCell>
                    <TableCell>
                      <div className="flex flex-col">
                        <span className="font-medium">{lineLabel[row.type]}</span>
                        <span className="font-mono text-xs text-muted-foreground">{row.reference}</span>
                      </div>
                    </TableCell>
                    <TableCell className="min-w-64 whitespace-normal">
                      {row.description}
                      {row.linkedLineId && (
                        <span className="ml-1.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
                          <LinkIcon className="size-3" /> linked pair
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={row.amount} locale={locale} />
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      <MoneyText value={row.runningBalance} locale={locale} tone="plain" />
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>
    </>
  );
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-medium">{children}</dd>
    </div>
  );
}
