import type { FlatBasis } from "@flowless/shared-types";
import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { ContentTable } from "@/components/tariffs/content-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getTariffPage } from "@/data/tariffs";
import { plainDate } from "@/lib/effective-date";
import { formatWhen } from "@/lib/dates";
import { flatBasisLabel, tariffTypeLabel } from "@/lib/tariff-labels";
import type { Content } from "@/lib/tariff-content";
import { versionStatusLabel, versionTimeline, type VersionStatus } from "@/lib/tariff-view";
import { NewVersion } from "./new-version";
import { TariffActions } from "./tariff-actions";

export const metadata = { title: "Tariff" };

export default function TariffPage({ params }: PageProps<"/tariffs/[id]">) {
  return (
    <>
      <Button variant="ghost" className="-ml-2.5 mb-2" render={<Link href="/tariffs" />}>
        <ArrowLeftIcon />
        Tariffs
      </Button>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Tariff params={params} />
      </Suspense>
    </>
  );
}

const statusTone: Record<VersionStatus, "success" | "info" | "outline" | "secondary"> = { in_force: "success", scheduled: "info", past: "outline", replaced: "secondary" };

async function Tariff({ params }: { params: PageProps<"/tariffs/[id]">["params"] }) {
  const { id } = await params;
  const page = await getTariffPage(id);
  const { tariff, currency, locale, timeZone } = page;
  const flatBasis = tariff.flatBasis as FlatBasis;
  const timeline = versionTimeline(page.versions, page.next.today);
  const basisNote = tariff.type === "flat_rate" ? ` · by ${flatBasisLabel[flatBasis].toLowerCase()}` : "";

  return (
    <>
      <PageHeader
        eyebrow="Tariff"
        title={tariff.name}
        description={
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant="secondary">
              {tariffTypeLabel[tariff.type]}
              {basisNote}
            </Badge>
            {timeline.inForce ? <Badge variant="success">Version {timeline.inForce.version.versionNo} in force</Badge> : <Badge variant="outline">Nothing in force yet</Badge>}
            {timeline.next && <Badge variant="info">Version {timeline.next.version.versionNo} from {plainDate(timeline.next.version.effectiveFrom, locale)}</Badge>}
            {!tariff.active && <Badge variant="outline">Inactive</Badge>}
          </div>
        }
        actions={page.canManage && <TariffActions id={tariff.id} name={tariff.name} active={tariff.active} />}
      />

      <div className="grid gap-6">
        <section aria-labelledby="in-force" className="rounded-xl border bg-card p-4">
          <h2 id="in-force" className="mb-1 font-semibold">
            In force today
          </h2>
          {timeline.inForce ? (
            <>
              <p className="mb-3 text-sm text-muted-foreground">
                Version {timeline.inForce.version.versionNo}, from {plainDate(timeline.inForce.version.effectiveFrom, locale)}
                {timeline.inForce.version.until ? ` until ${plainDate(timeline.inForce.version.until, locale)}` : ""}.
              </p>
              <ContentTable content={timeline.inForce.version.content as Content} basis={flatBasis} currency={currency} locale={locale} />
            </>
          ) : (
            <p className="text-sm text-muted-foreground">No version has started yet.{timeline.next ? ` Version ${timeline.next.version.versionNo} starts on ${plainDate(timeline.next.version.effectiveFrom, locale)}.` : ""}</p>
          )}
        </section>

        {timeline.next && (
          <section aria-labelledby="scheduled" className="rounded-xl border border-info/40 bg-card p-4">
            <h2 id="scheduled" className="mb-1 font-semibold">
              Scheduled next
            </h2>
            <p className="mb-3 text-sm text-muted-foreground">
              Version {timeline.next.version.versionNo} takes effect on {plainDate(timeline.next.version.effectiveFrom, locale)}. Until then billing keeps using the version above.
            </p>
            <ContentTable content={timeline.next.version.content as Content} basis={flatBasis} currency={currency} locale={locale} />
          </section>
        )}

        {page.canManage && (
          <NewVersion tariffId={tariff.id} type={tariff.type} flatBasis={flatBasis} seed={page.seedDraft} next={page.next} existing={page.existingDates} currency={currency} locale={locale} />
        )}

        <section aria-labelledby="history" className="rounded-xl border bg-card p-4">
          <h2 id="history" className="mb-1 font-semibold">
            Version history
          </h2>
          <p className="mb-4 text-sm text-muted-foreground">Versions are only ever added. A version is in force from its start until the next one starts.</p>
          <ol className="grid gap-3">
            {timeline.entries.map(({ version, status }) => (
              <li key={version.id} className="rounded-lg border p-3">
                <details className="group">
                  <summary className="flex cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1">
                    <span className="font-medium">Version {version.versionNo}</span>
                    <Badge variant={statusTone[status]}>{versionStatusLabel[status]}</Badge>
                    <span className="text-sm text-muted-foreground">
                      {status === "replaced"
                        ? `was dated ${plainDate(version.effectiveFrom, locale)}`
                        : `${plainDate(version.effectiveFrom, locale)} ${version.until ? `to ${plainDate(version.until, locale)}` : "onwards"}`}
                    </span>
                    <span className="ml-auto text-xs text-muted-foreground group-open:hidden">Show content</span>
                  </summary>
                  <div className="mt-3 grid gap-3">
                    <ContentTable content={version.content as Content} basis={flatBasis} currency={currency} locale={locale} />
                    <p className="text-xs text-muted-foreground">
                      Added by {version.by} on {formatWhen(version.createdAt, locale, timeZone)}
                      {version.note ? ` · ${version.note}` : ""}
                    </p>
                  </div>
                </details>
              </li>
            ))}
          </ol>
        </section>
      </div>
    </>
  );
}
