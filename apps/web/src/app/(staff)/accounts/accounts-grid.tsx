"use client";

import type { AccountSummary, CommercialStatus } from "@flowless/shared-types";
import { PhoneOffIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { DataGrid, gridColumnHelper } from "@/components/data-grid";
import { MoneyText } from "@/components/money-text";
import { CommercialStatusBadge, ServiceStatusBadge } from "@/components/status-badges";

const col = gridColumnHelper<AccountSummary>();
const href = (number: string) => `/accounts/${encodeURIComponent(number)}`;

const statusLabels: Record<CommercialStatus, string> = {
  NEW: "New",
  PENDING_PAYMENT: "Pending payment",
  ACTIVE: "Active",
  DORMANT: "Dormant",
  TERMINATED: "Terminated",
};

function columnsFor(locale: string) {
  return col.columns([
    col.accessor("number", {
      header: "Account",
      sortFn: "alphanumeric",
      cell: (info) => (
        <Link href={href(info.getValue())} className="font-mono text-xs font-medium text-primary hover:underline" tabIndex={-1}>
          {info.getValue()}
        </Link>
      ),
    }),
    col.accessor("customerName", {
      header: "Customer",
      sortFn: "text",
      cell: (info) => (
        <div className="flex min-w-48 max-w-80 flex-col">
          <span className="truncate font-medium" title={info.getValue()}>
            {info.getValue()}
          </span>
          {info.row.original.phone ? (
            <span className="tabular text-xs text-muted-foreground">{info.row.original.phone}</span>
          ) : (
            // C-01, C-12: missing phone is a data-quality flag, not a blank.
            <span className="inline-flex items-center gap-1 text-xs text-warning">
              <PhoneOffIcon className="size-3" /> No phone
            </span>
          )}
        </div>
      ),
    }),
    col.accessor("category", { header: "Category", sortFn: "text", filterFn: "equalsString" }),
    col.accessor("zone", {
      header: "Zone · route",
      sortFn: "text",
      filterFn: "equalsString",
      cell: (info) => (
        <span className="whitespace-nowrap">
          {info.getValue()} <span className="text-muted-foreground">· {info.row.original.route}</span>
        </span>
      ),
    }),
    col.accessor("commercialStatus", {
      header: "Status",
      filterFn: "equalsString",
      cell: (info) => (
        <div className="flex flex-wrap gap-1">
          <CommercialStatusBadge status={info.getValue()} />
          <ServiceStatusBadge service={info.row.original.service} />
        </div>
      ),
    }),
    col.accessor((row) => row.balance.amountMinor, {
      id: "balance",
      header: "Balance",
      sortFn: "bigint",
      enableGlobalFilter: false,
      meta: { align: "end" },
      cell: (info) => <MoneyText value={info.row.original.balance} locale={locale} />,
    }),
  ]);
}

export function AccountsGrid({ accounts, locale }: { accounts: AccountSummary[]; locale: string }) {
  const router = useRouter();
  const unique = (values: string[]) => [...new Set(values)].sort().map((v) => ({ value: v, label: v }));
  return (
    <DataGrid
      data={accounts}
      columns={columnsFor(locale)}
      getRowId={(a) => a.id}
      searchPlaceholder="Search number, customer or zone"
      viewsKey="accounts"
      emptyMessage="No accounts yet."
      onOpenRow={(a) => router.push(href(a.number))}
      initialSorting={[{ id: "number", desc: false }]}
      facets={[
        {
          columnId: "commercialStatus",
          label: "Statuses",
          options: unique(accounts.map((a) => a.commercialStatus)).map((o) => ({
            ...o,
            label: statusLabels[o.value as CommercialStatus],
          })),
        },
        { columnId: "category", label: "Categories", options: unique(accounts.map((a) => a.category)) },
        { columnId: "zone", label: "Zones", options: unique(accounts.map((a) => a.zone)) },
      ]}
    />
  );
}
