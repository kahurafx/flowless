import { DATA_QUALITY_RULES } from "@flowless/shared-types";
import { ExternalLinkIcon, SettingsIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { getDataQualityPage } from "@/data/data-quality";
import { severityLabel } from "@/lib/account-settings";
import type { Tone } from "@/lib/data-quality-view";
import { cn } from "@/lib/utils";
import { DuplicatesList } from "./duplicates-list";
import { FindingsTable } from "./findings-table";

export const metadata = { title: "Data quality" };

// C-12: accounts with something missing or doubtful, by rule.
export default function DataQualityPage({ searchParams }: PageProps<"/accounts/data-quality">) {
  return (
    <>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <DataQuality searchParams={searchParams} />
      </Suspense>
    </>
  );
}

const textTone: Partial<Record<Tone, string>> = { success: "text-success", warning: "text-warning", info: "text-info", destructive: "text-destructive" };
const barTone: Partial<Record<Tone, string>> = { success: "bg-success", warning: "bg-warning", info: "bg-info", destructive: "bg-destructive" };
const edgeTone: Partial<Record<Tone, string>> = { warning: "border-l-warning", info: "border-l-info", destructive: "border-l-destructive", success: "border-l-success" };

async function DataQuality({ searchParams }: { searchParams: PageProps<"/accounts/data-quality">["searchParams"] }) {
  const params = await searchParams;
  const rule = typeof params.rule === "string" ? params.rule : undefined;
  const page = await getDataQualityPage(rule);
  const { headline } = page;
  const chosen = page.tiles.find((t) => t.key === page.chosen);

  return (
    <>
      <PageHeader
        title="Data quality"
        description="Accounts with something missing or doubtful, by rule, so they can be fixed before they cause a wrong bill or an unreachable customer."
        actions={
          page.canConfigure && (
            <Button variant="outline" render={<Link href="/settings/accounts" />}>
              <SettingsIcon />
              Rules and severity
            </Button>
          )
        }
      />

      <section aria-labelledby="clean" className="mb-6 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="clean" className="text-xs font-medium text-muted-foreground">
              Clean accounts
            </h2>
            <p className={cn("tabular text-4xl font-semibold", textTone[headline.tone])}>{headline.percent.toLocaleString("en", { minimumFractionDigits: 0, maximumFractionDigits: 1 })}%</p>
          </div>
          <p className="max-w-md text-sm text-muted-foreground">{headline.sentence} Terminated accounts are not examined.</p>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${headline.percent}% of examined accounts are clean`}>
          <div className={cn("h-full rounded-full", barTone[headline.tone])} style={{ width: `${Math.max(headline.percent, headline.examined === 0 ? 100 : 1)}%` }} />
        </div>
        {!page.categoriesChecked && <p className="mt-2 text-xs text-muted-foreground">Tariffs is not licensed, so the category rule only looks for a missing category, not an unknown one.</p>}
      </section>

      <section aria-labelledby="rules" className="mb-8">
        <h2 id="rules" className="sr-only">
          Rules
        </h2>
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {page.tiles.map((tile) => {
            const body = (
              <>
                <div className="flex items-start justify-between gap-2">
                  <span className="text-sm font-medium">{tile.label}</span>
                  <Badge variant={tile.severity === "critical" ? "destructive" : tile.severity === "warning" ? "warning" : "info"}>{severityLabel[tile.severity]}</Badge>
                </div>
                <div className="mt-2">
                  {tile.figure.kind === "count" ? (
                    <span className={cn("tabular text-3xl font-semibold", textTone[tile.tone])}>{tile.figure.count.toLocaleString("en")}</span>
                  ) : tile.figure.kind === "waiting" ? (
                    <Badge variant="secondary">Waiting</Badge>
                  ) : (
                    <Badge variant="outline">Disabled</Badge>
                  )}
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{tile.caption}</p>
              </>
            );
            const frame = cn("flex h-full flex-col rounded-xl border border-l-4 bg-card p-3", tile.figure.kind === "count" ? edgeTone[tile.tone] : "border-l-border", tile.key === page.chosen && "ring-2 ring-ring");
            return (
              <li key={tile.key} className="flex flex-col gap-1">
                {tile.browsable ? (
                  <Link href={`?rule=${tile.key}`} scroll={false} className={cn(frame, "transition-colors hover:bg-muted/40")} aria-current={tile.key === page.chosen ? "true" : undefined} title={tile.description}>
                    {body}
                  </Link>
                ) : (
                  <div className={cn(frame, tile.figure.kind !== "count" && "opacity-80")} title={tile.description}>
                    {body}
                  </div>
                )}
                {tile.raiseExceptions && page.canSeeExceptions && (
                  <Link href="/exceptions?type=DATA_QUALITY" className="inline-flex items-center gap-1 px-1 text-xs text-primary hover:underline">
                    Raised in the exception queue
                    <ExternalLinkIcon className="size-3" aria-hidden />
                  </Link>
                )}
                {tile.raiseExceptions && !page.canSeeExceptions && <span className="px-1 text-xs text-muted-foreground">Raised in the exception queue</span>}
              </li>
            );
          })}
        </ul>
      </section>

      <section aria-labelledby="findings" className="mb-10">
        <h2 id="findings" className="mb-1 text-lg font-semibold">
          {chosen ? chosen.label : "Findings"}
        </h2>
        {chosen && page.findings ? (
          <>
            <p className="mb-3 text-sm text-muted-foreground">{DATA_QUALITY_RULES.find((r) => r.key === chosen.key)?.description}</p>
            <FindingsTable key={chosen.key} rule={chosen.key} initial={page.findings.items} initialCursor={page.findings.nextCursor} />
          </>
        ) : (
          <p className="rounded-xl border bg-card p-6 text-center text-sm text-muted-foreground">Nothing is flagged by any running rule.</p>
        )}
      </section>

      <section aria-labelledby="duplicates">
        <h2 id="duplicates" className="mb-1 text-lg font-semibold">
          Duplicate customers
        </h2>
        <p className="mb-3 text-sm text-muted-foreground">The same person or organization entered twice shows up as two customers who share a phone number, national id or registration number.</p>
        <DuplicatesList initial={page.duplicates.items} initialCursor={page.duplicates.nextCursor} />
      </section>
    </>
  );
}
