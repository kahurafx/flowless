import { PhoneOffIcon } from "lucide-react";
import Link from "next/link";
import { displayPhone } from "@/lib/account-forms";
import { CommercialStatusBadge, ServiceStatusBadge } from "@/components/status-badges";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { AccountListRow } from "@/data/accounts";

export const accountHref = (number: string) => `/accounts/${encodeURIComponent(number)}`;

/** The accounts of one page. Rows are links, so the list works without script and with the keyboard. */
export function AccountsTable({ rows, showCategory, searched }: { rows: AccountListRow[]; showCategory: boolean; searched: boolean }) {
  return (
    <div className="overflow-x-auto rounded-xl border bg-card">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Account</TableHead>
            <TableHead>Customer</TableHead>
            {showCategory && <TableHead>Category</TableHead>}
            <TableHead>Status</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.length === 0 ? (
            <TableRow className="hover:bg-transparent">
              <TableCell colSpan={showCategory ? 4 : 3} className="h-24 text-center text-muted-foreground">
                {searched ? "No account matches that search." : "No accounts here yet."}
              </TableCell>
            </TableRow>
          ) : (
            rows.map((a) => (
              <TableRow key={a.id}>
                <TableCell className="whitespace-nowrap">
                  <Link href={accountHref(a.number)} className="font-mono text-xs font-medium text-primary hover:underline">
                    {a.number}
                  </Link>
                  {a.parentAccountId && (
                    <Badge variant="outline" className="ml-2">
                      Child
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex min-w-48 max-w-80 flex-col">
                    <Link href={accountHref(a.number)} className="truncate font-medium hover:underline" title={a.customerName}>
                      {a.customerName}
                    </Link>
                    {a.phone ? (
                      <span className="tabular text-xs text-muted-foreground">{displayPhone(a.phone)}</span>
                    ) : (
                      // C-01, C-12: a missing or placeholder phone is a data-quality flag, not a blank.
                      <span className="inline-flex items-center gap-1 text-xs text-warning">
                        <PhoneOffIcon className="size-3" /> No phone
                      </span>
                    )}
                  </div>
                </TableCell>
                {showCategory && <TableCell>{a.categoryName ?? <span className="text-muted-foreground">None</span>}</TableCell>}
                <TableCell>
                  <div className="flex flex-wrap gap-1">
                    <CommercialStatusBadge status={a.commercialStatus} />
                    <ServiceStatusBadge service={a.serviceStatus === "CONNECTED" ? { state: "CONNECTED" } : { state: "DISCONNECTED", reason: a.serviceStatusReason ?? "" }} />
                  </div>
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}
