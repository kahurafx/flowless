"use client";

import type { CommercialStatus, DataQualityRuleKey } from "@flowless/shared-types";
import Link from "next/link";
import { useState, useTransition } from "react";
import { CommercialStatusBadge } from "@/components/status-badges";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import type { FindingRow } from "@/data/data-quality";
import { loadFindingsAction } from "./actions";

/** The accounts one rule flags, in number order, each linking to its account; "Load more" fetches the next page with the cursor. */
export function FindingsTable({ rule, initial, initialCursor }: { rule: DataQualityRuleKey; initial: FindingRow[]; initialCursor: string | null }) {
  const [rows, setRows] = useState(initial);
  const [cursor, setCursor] = useState(initialCursor);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div>
      <div className="overflow-x-auto rounded-xl border bg-card">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>Account</TableHead>
              <TableHead>Customer</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Place</TableHead>
              <TableHead>What is wrong</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((f) => (
              <TableRow key={f.accountId}>
                <TableCell className="whitespace-nowrap">
                  <Link href={`/accounts/${encodeURIComponent(f.number)}`} className="font-mono text-xs font-medium text-primary hover:underline">
                    {f.number}
                  </Link>
                </TableCell>
                <TableCell className="max-w-64">
                  <Link href={`/accounts/customers/${f.customerId}`} className="block truncate hover:underline" title={f.customerName}>
                    {f.customerName}
                  </Link>
                </TableCell>
                <TableCell>
                  <CommercialStatusBadge status={f.commercialStatus as CommercialStatus} />
                </TableCell>
                <TableCell className="min-w-40 text-sm">
                  {f.areaLabel || f.routeLabel ? [f.areaLabel, f.routeLabel].filter(Boolean).join(" · ") : <span className="text-muted-foreground">No place</span>}
                </TableCell>
                <TableCell className="min-w-56 text-sm text-muted-foreground">{f.why}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      {error && (
        <p role="alert" className="mt-3 text-sm text-destructive">
          {error}
        </p>
      )}
      <div className="mt-3 flex items-center justify-between text-sm text-muted-foreground">
        <span>
          Showing {rows.length.toLocaleString("en")} {rows.length === 1 ? "account" : "accounts"}
          {cursor ? ", more available" : ""}
        </span>
        {cursor && (
          <Button
            variant="outline"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                setError(null);
                const result = await loadFindingsAction(rule, cursor);
                if (result.error !== null) return setError(result.error);
                setRows((current) => [...current, ...result.data.items.filter((i) => !current.some((c) => c.accountId === i.accountId))]);
                setCursor(result.data.nextCursor);
              })
            }
          >
            {pending ? "Loading…" : "Load more"}
          </Button>
        )}
      </div>
    </div>
  );
}
