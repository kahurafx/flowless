import Link from "next/link";
import { MoneyText } from "@/components/money-text";
import { Badge } from "@/components/ui/badge";
import { getAccountStatement } from "@/data/billing";
import { formatWhen } from "@/lib/dates";
import { asMoney, balanceSummary, documentHref } from "@/lib/billing-view";
import { Section } from "./account-sections";
import { RequestNoteDialog } from "./billing-dialogs";
import { StatementTable } from "./statement-table";

export { documentHref };

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

      <StatementTable
        items={data.statement.items}
        currency={data.balance.currency}
        locale={locale}
        accountNumber={account.number}
        documents={[...data.documents.values()].map((d) => ({ id: d.id, number: d.number, periodFrom: d.periodFrom, periodTo: d.periodTo, finalBill: d.finalBill, reversesDocumentId: d.reversesDocumentId }))}
        reversed={[...data.reversed]}
      />
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
