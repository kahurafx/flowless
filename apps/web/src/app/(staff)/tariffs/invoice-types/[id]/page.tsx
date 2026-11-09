import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getInvoiceTypePage } from "@/data/tariffs";
import { appliesToLabel } from "@/lib/tariff-labels";
import { LateFeePanel } from "./late-fee-panel";
import { LinesEditor } from "./lines-editor";
import { SettingsForm } from "./settings-form";

export const metadata = { title: "Invoice type" };

/** A value as text, so a form can remount when what the server holds changes (bigints included). */
const stamp = (value: unknown) => JSON.stringify(value, (_key, x: unknown) => (typeof x === "bigint" ? x.toString() : x));

export default function InvoiceTypePage({ params }: PageProps<"/tariffs/invoice-types/[id]">) {
  return (
    <>
      <Button variant="ghost" className="-ml-2.5 mb-2" render={<Link href="/tariffs/invoice-types" />}>
        <ArrowLeftIcon />
        Invoice types
      </Button>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <InvoiceType params={params} />
      </Suspense>
    </>
  );
}

async function InvoiceType({ params }: { params: PageProps<"/tariffs/invoice-types/[id]">["params"] }) {
  const { id } = await params;
  const page = await getInvoiceTypePage(id);
  const { type, currency, locale, canManage } = page;
  return (
    <>
      <PageHeader
        eyebrow="Invoice type"
        title={type.name}
        description={
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className="font-mono text-xs">{type.code}</span>
            <Badge variant={type.appliesTo === "application" ? "info" : "secondary"}>{appliesToLabel[type.appliesTo]}</Badge>
            {!type.active && <Badge variant="outline">Inactive</Badge>}
            {!canManage && <Badge variant="outline">Read only</Badge>}
          </div>
        }
      />
      <div className="grid gap-6">
        <SettingsForm
          // A saved change re-renders with new server values; remount so the form starts from them.
          key={stamp([type.name, type.numbering, type.dueDays, type.terms, type.overdue, type.active])}
          type={{
            id: type.id,
            name: type.name,
            appliesTo: type.appliesTo,
            numbering: type.numbering,
            dueDays: type.dueDays,
            terms: type.terms,
            overdue: type.overdue,
            active: type.active,
          }}
          nextNumber={type.nextNumber}
          currency={currency}
          canManage={canManage}
        />
        <LinesEditor
          key={stamp(type.lines)}
          id={type.id}
          lines={type.lines.map((l) => ({ code: l.code, quantity: l.quantity, amountOverride: l.amountOverride, optional: l.optional }))}
          catalog={page.chargeItems.map((c) => ({ code: c.code, name: c.name, type: c.type, active: c.active, amount: c.amount === null ? null : c.amount.toString() }))}
          currency={currency}
          locale={locale}
          canManage={canManage}
        />
        <LateFeePanel
          key={stamp(type.lateFeeRule)}
          id={type.id}
          rule={type.lateFeeRule}
          currency={currency}
          locale={locale}
          canManage={canManage}
        />
      </div>
    </>
  );
}
