import { ArrowLeftIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getMeterPage } from "@/data/metering";
import { formatWhen } from "@/lib/dates";
import { METER_KIND_LABELS, METER_STATUS_LABELS, flagMarks, unitsText } from "@/lib/metering-view";
import { InstallDialog, RemoveDialog, ReplaceDialog, StatusDialog } from "../meter-dialogs";

export const metadata = { title: "Meter" };

export default function MeterPageRoute({ params }: PageProps<"/metering/meters/[id]">) {
  return (
    <>
      <Button variant="ghost" className="-ml-2.5 mb-2" render={<Link href="/metering/meters" />}>
        <ArrowLeftIcon />
        Meters
      </Button>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Meter params={params} />
      </Suspense>
    </>
  );
}

async function Meter({ params }: { params: PageProps<"/metering/meters/[id]">["params"] }) {
  const { id } = await params;
  const p = await getMeterPage(id);
  const { meter } = p;
  const when = (d: Date) => formatWhen(d, p.locale, p.timeZone);
  const installed = p.installation !== null;
  return (
    <>
      <PageHeader
        eyebrow={`${METER_KIND_LABELS[meter.kind]} meter`}
        title={meter.serial}
        description={
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <Badge variant={meter.status === "installed" ? "success" : "secondary"}>{METER_STATUS_LABELS[meter.status]}</Badge>
            <span>
              {meter.dialDigits}-digit dial{meter.model ? `, ${meter.model}` : ""}
            </span>
          </div>
        }
        actions={
          p.canManage && (
            <>
              {installed ? (
                <>
                  <ReplaceDialog meterId={meter.id} dialDigits={meter.dialDigits} />
                  <RemoveDialog meterId={meter.id} dialDigits={meter.dialDigits} />
                </>
              ) : (
                meter.status !== "disposed" && meter.status !== "replaced" && <InstallDialog meterId={meter.id} dialDigits={meter.dialDigits} />
              )}
              <StatusDialog meterId={meter.id} status={meter.status} />
            </>
          )
        }
      />
      <div className="grid gap-6">
        {p.installation && (
          <p className="text-sm">
            Installed on service point <span className="font-mono text-xs">{p.installation.servicePointId.slice(0, 8)}</span> since {when(p.installation.installedAt)}.
          </p>
        )}
        {meter.note && <p className="max-w-prose text-sm text-muted-foreground">{meter.note}</p>}

        <section aria-labelledby="readings-title">
          <h2 id="readings-title" className="mb-2 font-semibold">
            Recent readings
          </h2>
          {!p.canRead ? (
            <p className="text-sm text-muted-foreground">Reading history needs permission to read readings.</p>
          ) : (
            <div className="overflow-x-auto rounded-xl border bg-card">
              <Table>
                <TableHeader>
                  <TableRow className="hover:bg-transparent">
                    <TableHead>Read</TableHead>
                    <TableHead className="text-right">Dial</TableHead>
                    <TableHead className="text-right">Units</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Account</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {p.readings.length === 0 ? (
                    <TableRow className="hover:bg-transparent">
                      <TableCell colSpan={5} className="h-16 text-center text-muted-foreground">
                        No readings yet.
                      </TableCell>
                    </TableRow>
                  ) : (
                    p.readings.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="whitespace-nowrap">{when(r.readAt)}</TableCell>
                        <TableCell className="text-right tabular">{r.value}</TableCell>
                        <TableCell className="text-right tabular">{unitsText(r)}</TableCell>
                        <TableCell>
                          {r.status !== "valid" ? <Badge variant="outline">{r.status}</Badge> : r.cleared ? <Badge variant="success">Cleared</Badge> : <Badge variant="warning">Needs review</Badge>}
                          {flagMarks(r.flags).map((f) => (
                            <Badge key={f.code} variant={f.blocking ? "destructive" : "secondary"} className="ml-1" title={f.label}>
                              {f.code}
                            </Badge>
                          ))}
                        </TableCell>
                        <TableCell>{r.accountId && p.labels[r.accountId] ? <Link href={`/accounts/${encodeURIComponent(p.labels[r.accountId]!.number)}`} className="text-primary hover:underline">{p.labels[r.accountId]!.number}</Link> : "-"}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          )}
        </section>

        <div className="grid items-start gap-6 lg:grid-cols-2">
          <section aria-labelledby="installs-title">
            <h2 id="installs-title" className="mb-2 font-semibold">
              Installations
            </h2>
            <ul className="grid gap-1.5 text-sm">
              {p.installations.length === 0 && <li className="text-muted-foreground">Never installed.</li>}
              {p.installations.map((i) => (
                <li key={i.id}>
                  {when(i.installedAt)} to {i.removedAt ? when(i.removedAt) : "now"}
                  {i.removalReason ? <span className="text-muted-foreground"> · {i.removalReason}</span> : null}
                </li>
              ))}
            </ul>
          </section>
          <section aria-labelledby="log-title">
            <h2 id="log-title" className="mb-2 font-semibold">
              Status log
            </h2>
            <ol className="grid gap-2 text-sm">
              {p.events.map((e) => (
                <li key={e.id}>
                  <span className="font-medium">{e.to ? METER_STATUS_LABELS[e.to] : e.kind}</span>
                  {e.from && <span className="text-muted-foreground"> from {METER_STATUS_LABELS[e.from]}</span>}
                  <span className="block text-xs text-muted-foreground">
                    {p.actors[e.id]} · {when(e.occurredAt)}
                    {e.reason ? ` · ${e.reason}` : ""}
                  </span>
                </li>
              ))}
            </ol>
          </section>
        </div>
      </div>
    </>
  );
}
