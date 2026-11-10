"use client";

import Link from "next/link";
import { useState } from "react";
import type { StatementLineType } from "@flowless/shared-types";
import { MoneyText } from "@/components/money-text";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import {
  asMoney,
  documentHref,
  formatDay,
  marksFor,
  newestFirst,
  servicePeriod,
  statementRowsFor,
  STATEMENT_TYPE_MARK,
  STATEMENT_VIEW_LABEL,
  type StatementView,
} from "@/lib/billing-view";

interface Item {
  transactionId: string;
  effectiveOn: string;
  entryType: string;
  documentId: string | null;
  documentKind: string | null;
  documentNumber: string | null;
  description: string | null;
  amount: bigint;
  runningBalance: bigint;
  lineType: StatementLineType;
  key: string;
  linkedTo: string | null;
  pair: { pairId: string; role: "original" | "offset"; settled: boolean } | null;
}
interface DocSummary {
  id: string;
  number: string;
  periodFrom: string | null;
  periodTo: string | null;
  finalBill: boolean;
  reversesDocumentId: string | null;
}

/**
 * The statement table with a Customer view / Office view toggle (B-17). The office sees every
 * posting, with linked pairs marked; the customer view collapses settled pairs (a voided invoice
 * and its reversal). The running balance is Billing's, derived over the whole history, so it is
 * the same in both views.
 */
export function StatementTable({
  items,
  documents,
  reversed,
  currency,
  locale,
  accountNumber,
}: {
  items: Item[];
  documents: DocSummary[];
  reversed: string[];
  currency: string;
  locale: string;
  accountNumber: string;
}) {
  const [view, setView] = useState<StatementView>("office");
  const docs = new Map(documents.map((d) => [d.id, d]));
  const reversedSet = new Set(reversed);
  const rows = newestFirst(statementRowsFor(items, view));
  const hidden = items.length - rows.length;

  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center gap-2" role="group" aria-label="Statement view">
        {(["office", "customer"] as const).map((v) => (
          <Button key={v} type="button" size="sm" variant={view === v ? "default" : "outline"} aria-pressed={view === v} onClick={() => setView(v)}>
            {STATEMENT_VIEW_LABEL[v]}
          </Button>
        ))}
        {view === "customer" && hidden > 0 && <span className="text-xs text-muted-foreground">{hidden} offsetting rows collapsed</span>}
      </div>
      {rows.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing has been posted to this account yet.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Date</TableHead>
                <TableHead>Document</TableHead>
                <TableHead>Service period</TableHead>
                <TableHead className="text-right">Amount</TableHead>
                <TableHead className="text-right">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => {
                const doc = r.documentId ? docs.get(r.documentId) : undefined;
                const isReversed = r.documentId ? reversedSet.has(r.documentId) : false;
                const marks = marksFor({ entryType: r.entryType, documentKind: r.documentKind, reversed: isReversed, finalBill: doc?.finalBill ?? false });
                const typeMark = STATEMENT_TYPE_MARK[r.lineType];
                // The type badge replaces the kind badge; reversed and final-bill marks stay.
                const extra = marks.filter((m) => m.label === "Reversed" || m.label === "Final bill");
                const reverses = doc?.reversesDocumentId ? docs.get(doc.reversesDocumentId) : undefined;
                return (
                  <TableRow key={r.transactionId} className={isReversed ? "text-muted-foreground" : undefined}>
                    <TableCell className="whitespace-nowrap">{formatDay(r.effectiveOn, locale)}</TableCell>
                    <TableCell className="min-w-56 whitespace-normal">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {r.documentId && r.documentNumber ? (
                          <Link href={documentHref(accountNumber, r.documentId)} className="font-mono text-xs text-primary hover:underline">
                            {r.documentNumber}
                          </Link>
                        ) : null}
                        <Badge variant={typeMark.tone}>{typeMark.label}</Badge>
                        {extra.map((m) => (
                          <Badge key={m.label} variant={m.tone}>
                            {m.label}
                          </Badge>
                        ))}
                        {view === "office" && r.pair && <Badge variant="outline">{r.pair.settled ? "Pair, nets to zero" : "Linked"}</Badge>}
                      </div>
                      {reverses && (
                        <span className="block text-xs text-muted-foreground">
                          Reverses{" "}
                          <Link href={documentHref(accountNumber, reverses.id)} className="text-primary hover:underline">
                            {reverses.number}
                          </Link>
                        </span>
                      )}
                      {r.description && <span className="block text-xs text-muted-foreground">{r.description}</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{doc ? servicePeriod(doc.periodFrom, doc.periodTo, locale) : "—"}</TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={asMoney(r.amount, currency)} locale={locale} />
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      <MoneyText value={asMoney(r.runningBalance, currency)} locale={locale} tone="plain" />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
