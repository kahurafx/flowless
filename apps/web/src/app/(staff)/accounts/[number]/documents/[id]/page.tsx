import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { MoneyText } from "@/components/money-text";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { accountNumberFrom } from "@/data/accounts";
import { getDocumentPage } from "@/data/billing";
import { formatWhen } from "@/lib/dates";
import { asMoney, citedVersionIds, documentKindLabel, formatDay, lineTypeLabel, marksFor, servicePeriod, type DocumentKind } from "@/lib/billing-view";
import { RebillDialog, RequestNoteDialog, VoidDialog } from "../../billing-dialogs";
import { documentHref } from "../../statement-section";

export const metadata = { title: "Document" };

export default function DocumentPage({ params }: PageProps<"/accounts/[number]/documents/[id]">) {
  return (
    <Suspense fallback={<Skeleton className="h-96" />}>
      <Document params={params} />
    </Suspense>
  );
}

async function Document({ params }: { params: PageProps<"/accounts/[number]/documents/[id]">["params"] }) {
  const { number, id } = await params;
  const { account, doc, links, versions, by, access } = await getDocumentPage(accountNumberFrom(number), id);
  const { locale, timeZone } = access;
  const reversed = doc.reversedByDocumentId !== null;
  const marks = marksFor({ documentKind: doc.kind, reversed, finalBill: doc.finalBill });
  const money = (v: bigint) => <MoneyText value={asMoney(v, doc.currency)} locale={locale} />;
  const link = (docId: string | null, label: string) => {
    const l = docId ? links.get(docId) : undefined;
    if (!l) return null;
    return (
      <div className="flex flex-col gap-0.5">
        <dt className="text-xs text-muted-foreground">{label}</dt>
        <dd>
          <Link href={documentHref(account.number, l.id)} className="font-mono text-xs text-primary hover:underline">
            {l.number}
          </Link>{" "}
          <span className="text-xs text-muted-foreground">{documentKindLabel[l.kind as DocumentKind] ?? l.kind}</span>
        </dd>
      </div>
    );
  };
  // Void and re-bill are for an invoice that has not been reversed; the procedure decides the rest (live notes).
  const correctable = doc.kind === "invoice" && !reversed && access.canAdjust;
  const rebillable = correctable && doc.periodTo !== null;

  return (
    <>
      <Button variant="ghost" className="-ml-2.5 mb-2" render={<Link href={`/accounts/${encodeURIComponent(account.number)}#statement`} />}>
        <ArrowLeftIcon />
        Account {account.number}
      </Button>
      <PageHeader
        eyebrow={`${documentKindLabel[doc.kind]} for ${account.customerName}`}
        title={doc.number}
        description={
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {marks.map((m) => (
              <Badge key={m.label} variant={m.tone}>
                {m.label}
              </Badge>
            ))}
          </div>
        }
      />
      <div className="grid gap-6">
        {access.canAdjust && (
          <div className="flex flex-wrap gap-2">
            {correctable && <VoidDialog documentId={doc.id} number={doc.number} />}
            {rebillable && (
              <RebillDialog documentId={doc.id} number={doc.number} base={{ accountId: account.id, categoryId: account.categoryId, invoiceTypeId: doc.invoiceTypeId, periodTo: doc.periodTo }} />
            )}
            <RequestNoteDialog accountId={account.id} currency={doc.currency} relatedDocumentId={doc.id} />
          </div>
        )}
        <dl className="grid grid-cols-2 gap-4 rounded-xl border bg-card p-4 text-sm sm:grid-cols-4">
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Total</dt>
            <dd className="font-semibold">{money(doc.total)}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Service period</dt>
            <dd>{servicePeriod(doc.periodFrom, doc.periodTo, locale)}</dd>
          </div>
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Issued</dt>
            <dd>{formatDay(doc.issuedOn, locale)}</dd>
          </div>
          {doc.dueOn && (
            <div className="flex flex-col gap-0.5">
              <dt className="text-xs text-muted-foreground">Due</dt>
              <dd>{formatDay(doc.dueOn, locale)}</dd>
            </div>
          )}
          <div className="flex flex-col gap-0.5">
            <dt className="text-xs text-muted-foreground">Recorded</dt>
            <dd>
              {formatWhen(doc.createdAt, locale, timeZone)} by {by}
            </dd>
          </div>
          {link(doc.reversesDocumentId, "Reverses")}
          {link(doc.reversedByDocumentId, "Reversed by")}
          {link(doc.replacesDocumentId, "Replaces")}
          {link(doc.replacedByDocumentId, "Replaced by")}
          {link(doc.relatedDocumentId, "Refers to")}
        </dl>
        {doc.note && (
          <p className="rounded-xl border bg-card p-4 text-sm">
            <span className="block text-xs text-muted-foreground">Reason or note</span>
            {doc.note}
          </p>
        )}

        <section aria-labelledby="lines" className="grid gap-3 rounded-xl border bg-card p-4">
          <h2 id="lines" className="text-base font-semibold">
            Lines
          </h2>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Description</TableHead>
                  <TableHead>Service period</TableHead>
                  <TableHead className="text-right">Quantity</TableHead>
                  <TableHead>Tariff</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {doc.lines.map((l) => (
                  <TableRow key={l.position}>
                    <TableCell className="min-w-48 whitespace-normal">
                      {l.description}
                      <span className="block text-xs text-muted-foreground">{lineTypeLabel[l.lineType] ?? l.lineType}</span>
                    </TableCell>
                    <TableCell className="whitespace-nowrap">{servicePeriod(l.serviceFrom, l.serviceTo, locale)}</TableCell>
                    <TableCell className="text-right tabular">{l.quantity ?? "—"}</TableCell>
                    <TableCell className="min-w-40 whitespace-normal text-xs">
                      {citedVersionIds(l).length === 0
                        ? l.chargeItemId
                          ? "Charge catalog"
                          : "—"
                        : citedVersionIds(l).map((vid) => {
                            const v = versions.get(vid);
                            return v ? (
                              <Link key={vid} href={`/tariffs/${v.tariffId}`} className="block text-primary hover:underline">
                                {v.tariffName}, version {v.versionNo} from {formatDay(v.effectiveFrom, locale)}
                              </Link>
                            ) : (
                              <span key={vid} className="block font-mono text-muted-foreground">
                                Version {vid.slice(0, 8)}
                              </span>
                            );
                          })}
                    </TableCell>
                    <TableCell className="text-right">{money(l.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>

        {doc.notes.length > 0 && (
          <section aria-labelledby="notes" className="grid gap-2 rounded-xl border bg-card p-4">
            <h2 id="notes" className="text-base font-semibold">
              Notes against this document
            </h2>
            <ul className="grid gap-1 text-sm">
              {doc.notes.map((n) => (
                <li key={n.id} className="flex flex-wrap items-center gap-2">
                  <Link href={documentHref(account.number, n.id)} className="font-mono text-xs text-primary hover:underline">
                    {n.number}
                  </Link>
                  <span className="text-muted-foreground">{documentKindLabel[n.kind]}</span>
                  {money(n.total)}
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </>
  );
}
