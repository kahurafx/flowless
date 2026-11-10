import Link from "next/link";
import { MoneyText } from "@/components/money-text";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getAccountStatement } from "@/data/billing";
import { formatWhen } from "@/lib/dates";
import { asMoney, balanceSummary, entryTypeLabel, formatDay, marksFor, newestFirst, servicePeriod } from "@/lib/billing-view";
import { Section } from "./account-sections";
import { RequestNoteDialog } from "./billing-dialogs";

export const documentHref = (accountNumber: string, documentId: string) => `/accounts/${encodeURIComponent(accountNumber)}/documents/${documentId}`;

const APPROVAL_TONE = { pending: "warning", approved: "success", rejected: "destructive", cancelled: "outline" } as const;
const APPROVAL_TEXT = { pending: "Pending", approved: "Approved", rejected: "Rejected", cancelled: "Withdrawn" } as const;

/** The account's balance and statement (B-11, B-17), derived from the ledger by Billing. Hidden detail, clear empty states. */
export async function StatementSection({ account }: { account: { id: string; number: string } }) {
  const { access, data } = await getAccountStatement(account.id);
  const { locale, timeZone, currency } = access;

  if (!data) {
    return (
      <Section id="statement" title="Statement">
        <p className="text-sm text-muted-foreground">
          {access.state === "unlicensed"
            ? "Billing is not licensed for this organization, so accounts hold no ledger. Terminating an account asks you to confirm that nothing is owing."
            : "You do not have access to billing, so the balance and statement are not shown."}
        </p>
      </Section>
    );
  }

  const owed = data.balance.balance;
  const summary = balanceSummary(owed);
  const rows = newestFirst(data.statement.items);
  return (
    <Section
      id="statement"
      title="Statement"
      aside={
        <div className="flex flex-wrap items-center gap-2">
          {access.canExceptions && (
            <Link href="/exceptions?type=UNBILLED_ACCOUNT" className="text-xs text-primary hover:underline">
              Held bills in the exception queue
            </Link>
          )}
          {access.canAdjust && <RequestNoteDialog accountId={account.id} currency={currency} />}
        </div>
      }
    >
      <dl className="flex flex-wrap items-baseline gap-x-6 gap-y-1 text-sm">
        <div>
          <dt className="text-xs text-muted-foreground">{summary.label}</dt>
          <dd className="text-2xl font-semibold">
            <MoneyText value={asMoney(owed, data.balance.currency)} locale={locale} tone="plain" />
          </dd>
        </div>
        {data.statement.openingBalance !== 0n && data.statement.items.length > 0 && (
          <div>
            <dt className="text-xs text-muted-foreground">Opening</dt>
            <dd>
              <MoneyText value={asMoney(data.statement.openingBalance, data.balance.currency)} locale={locale} />
            </dd>
          </div>
        )}
      </dl>

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
                const doc = r.documentId ? data.documents.get(r.documentId) : undefined;
                const reversed = r.documentId ? data.reversed.has(r.documentId) : false;
                const marks = marksFor({ entryType: r.entryType, documentKind: r.documentKind, reversed, finalBill: doc?.finalBill ?? false });
                const reverses = doc?.reversesDocumentId ? data.documents.get(doc.reversesDocumentId) : undefined;
                return (
                  <TableRow key={r.transactionId} className={reversed ? "text-muted-foreground" : undefined}>
                    <TableCell className="whitespace-nowrap">{formatDay(r.effectiveOn, locale)}</TableCell>
                    <TableCell className="min-w-56 whitespace-normal">
                      <div className="flex flex-wrap items-center gap-1.5">
                        {r.documentId && r.documentNumber ? (
                          <Link href={documentHref(account.number, r.documentId)} className="font-mono text-xs text-primary hover:underline">
                            {r.documentNumber}
                          </Link>
                        ) : (
                          <span className="text-xs">{entryTypeLabel(r.entryType)}</span>
                        )}
                        {marks.map((m) => (
                          <Badge key={m.label} variant={m.tone}>
                            {m.label}
                          </Badge>
                        ))}
                      </div>
                      {reverses && (
                        <span className="block text-xs text-muted-foreground">
                          Reverses{" "}
                          <Link href={documentHref(account.number, reverses.id)} className="text-primary hover:underline">
                            {reverses.number}
                          </Link>
                        </span>
                      )}
                      {r.description && <span className="block text-xs text-muted-foreground">{r.description}</span>}
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{doc ? servicePeriod(doc.periodFrom, doc.periodTo, locale) : "—"}</TableCell>
                    <TableCell className="text-right">
                      <MoneyText value={asMoney(r.amount, data.balance.currency)} locale={locale} />
                    </TableCell>
                    <TableCell className="text-right font-medium">
                      <MoneyText value={asMoney(r.runningBalance, data.balance.currency)} locale={locale} tone="plain" />
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      )}
      {data.truncated && <p className="text-xs text-muted-foreground">Showing the first {data.statement.items.length} postings; the running balance still covers the whole history.</p>}

      {data.adjustments.length > 0 && (
        <div className="grid gap-2">
          <h3 className="text-sm font-medium">Credit and debit note requests</h3>
          <ul className="grid gap-1 text-sm">
            {data.adjustments.map((a) => (
              <li key={a.id} className="flex flex-wrap items-center gap-2">
                <Badge variant={APPROVAL_TONE[a.status]}>{APPROVAL_TEXT[a.status]}</Badge>
                <span>{a.kind === "debit_note" ? "Debit note" : "Credit note"}</span>
                {a.amount !== null && <MoneyText value={asMoney(a.amount, data.balance.currency)} locale={locale} tone="plain" />}
                <span className="text-muted-foreground">
                  {a.reason}, asked {formatWhen(a.requestedAt, locale, timeZone, "date")}
                </span>
                <Link href={a.status === "pending" ? "/approvals?view=open" : "/approvals?view=closed"} className="text-xs text-primary hover:underline">
                  Approvals
                </Link>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">An approved request is issued as a note citing it; the note then appears on the statement.</p>
        </div>
      )}
    </Section>
  );
}
