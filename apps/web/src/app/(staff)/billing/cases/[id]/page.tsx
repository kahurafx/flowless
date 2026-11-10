import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { MoneyText } from "@/components/money-text";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getRevenueCase } from "@/data/revenue-cases";
import { asMoney } from "@/lib/billing-view";
import { CASE_DECISION_LABELS, CASE_EVENT_LABELS, CASE_KIND_LABELS } from "@/lib/case-view";
import { formatWhen } from "@/lib/dates";
import { EvidenceDialog, RequestBackBillingDialog, ResolveDialog } from "./case-dialogs";

export const metadata = { title: "Revenue case" };

export default function CasePageRoute({ params }: PageProps<"/billing/cases/[id]">) {
  return (
    <>
      <Button variant="ghost" className="-ml-2.5 mb-2" render={<Link href="/billing/cases" />}>
        <ArrowLeftIcon />
        Revenue cases
      </Button>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Case params={params} />
      </Suspense>
    </>
  );
}

async function Case({ params }: { params: PageProps<"/billing/cases/[id]">["params"] }) {
  const { id } = await params;
  const p = await getRevenueCase(id);
  const c = p.case;
  const open = c.status === "open";
  return (
    <>
      <PageHeader
        eyebrow={CASE_KIND_LABELS[c.kind]}
        title={c.title ?? "Revenue case"}
        description={
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {open ? <Badge variant="warning">Open</Badge> : <Badge variant="outline">{c.decision ? CASE_DECISION_LABELS[c.decision] : "Resolved"}</Badge>}
            {p.label && (
              <Link href={`/accounts/${encodeURIComponent(p.label.number)}`} className="text-primary hover:underline">
                {p.label.number} · {p.label.customerName}
              </Link>
            )}
            {c.documentId && p.label && (
              <Link href={`/accounts/${encodeURIComponent(p.label.number)}/documents/${c.documentId}`} className="text-primary hover:underline">
                Debit note
              </Link>
            )}
          </div>
        }
        actions={
          p.canRun &&
          open && (
            <>
              <EvidenceDialog caseId={c.id} />
              <RequestBackBillingDialog caseId={c.id} currency={p.currency} />
              <ResolveDialog caseId={c.id} currency={p.currency} invoiceTypes={p.invoiceTypes} approvals={p.approvals} requiresApproval={p.protection?.backBillRequiresApproval ?? null} />
            </>
          )
        }
      />
      <div className="grid max-w-3xl gap-6">
        {p.protection && (
          <p className="text-sm text-muted-foreground">
            Back-billing may reach back {p.protection.backBillMaxMonths} month{p.protection.backBillMaxMonths === 1 ? "" : "s"} and {p.protection.backBillRequiresApproval ? "needs an approved request" : "needs no approval"}.
          </p>
        )}
        {p.approvals.length > 0 && (
          <section aria-labelledby="approvals-title">
            <h2 id="approvals-title" className="mb-2 font-semibold">
              Back-billing requests
            </h2>
            <ul className="grid gap-1.5 text-sm">
              {p.approvals.map((a) => (
                <li key={a.id} className="flex flex-wrap items-center gap-2">
                  <Badge variant={a.status === "approved" ? "success" : a.status === "pending" ? "warning" : "outline"}>{a.status}</Badge>
                  {a.amount !== null && <MoneyText value={asMoney(a.amount, p.currency)} locale={p.locale} tone="plain" />}
                  <Link href="/approvals?view=open" className="text-muted-foreground hover:underline">
                    Approvals
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section aria-labelledby="log-title">
          <h2 id="log-title" className="mb-2 font-semibold">
            Log
          </h2>
          <ol className="grid gap-3">
            {c.events.map((e) => (
              <li key={e.id} className="rounded-lg border bg-card p-3 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{CASE_EVENT_LABELS[e.event] ?? e.event}</span>
                  {e.decision && <Badge variant="outline">{CASE_DECISION_LABELS[e.decision]}</Badge>}
                  <span className="text-xs text-muted-foreground">
                    {p.actors[e.id]} · {formatWhen(e.createdAt, p.locale, p.timeZone)}
                  </span>
                </div>
                {e.detail && <p className="mt-1 whitespace-pre-wrap">{e.detail}</p>}
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
