import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { OverdueBadge, outcomeLabel, PriorityBadge, WorkStatusBadge } from "@/components/work-badges";
import { Badge } from "@/components/ui/badge";
import type { JobPage } from "@/data/work-orders";
import { formatWhen } from "@/lib/dates";
import { formatPosition } from "@/lib/use-position";
import { JobActions } from "./job-actions";
import { JobPhotos } from "./job-photos";
import { JobComments, JobHistory } from "./job-timeline";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="grid gap-3 rounded-xl border bg-card p-4">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

export function JobDetail({ page }: { page: JobPage }) {
  const { job, kind, can, children, locale, timeZone } = page;
  const when = (d: Date) => formatWhen(d, locale, timeZone);
  const capture = job.capture && typeof job.capture === "object" ? Object.entries(job.capture as Record<string, unknown>) : [];
  const humanize = (key: string) => key.replace(/([A-Z])/g, " $1").toLowerCase().replace(/^./, (c) => c.toUpperCase());

  return (
    <div className="grid gap-6">
      <header className="grid gap-3">
        <p className="label-caps text-muted-foreground">
          <span className="font-mono">{job.code}</span> · {kind?.label ?? job.kind}
        </p>
        <h1 className="text-2xl font-semibold break-words sm:text-3xl">{job.title}</h1>
        <div className="flex flex-wrap items-center gap-2">
          <WorkStatusBadge status={job.status} />
          <PriorityBadge priority={job.priority} />
          {job.overdue && <OverdueBadge />}
          {job.review !== "none" && <Badge variant="outline">{job.review === "required" ? "Needs review" : "Review optional"}</Badge>}
        </div>
        <JobActions page={page} />
      </header>

      {job.hold && (
        <p className="rounded-xl bg-warning/12 p-3 text-sm text-warning" role="status">
          On hold since {when(job.hold.at)}: {job.hold.reason}
          {job.hold.note && ` (${job.hold.note})`}
        </p>
      )}
      {job.submission && (
        <p className="rounded-xl bg-info/12 p-3 text-sm text-info" role="status">
          Submitted {when(job.submission.at)}: {outcomeLabel[job.submission.outcome]}.{job.submission.note && ` ${job.submission.note}`}
        </p>
      )}
      {job.reviewed && job.status !== "completed" && (
        <p className="rounded-xl bg-warning/12 p-3 text-sm text-warning" role="status">
          Returned {when(job.reviewed.at)}: {job.reviewed.note}
        </p>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="grid min-w-0 gap-6">
          {job.description && (
            <Section title="Details">
              <p className="text-sm whitespace-pre-wrap">{job.description}</p>
            </Section>
          )}
          {job.completion && (
            <Section title="Completion">
              <p className="text-sm">
                {outcomeLabel[job.completion.outcome ?? "done"]} on {when(job.completion.at)}
                {job.completion.note && `. ${job.completion.note}`}
              </p>
              {job.reviewed && <p className="text-sm text-muted-foreground">Approved {when(job.reviewed.at)}{job.reviewed.note && `: ${job.reviewed.note}`}</p>}
            </Section>
          )}
          {capture.length > 0 && (
            <Section title="Captured at completion">
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
                {capture.map(([key, value]) => (
                  <div key={key} className="contents">
                    <dt className="text-muted-foreground">{humanize(key)}</dt>
                    <dd className="break-words whitespace-pre-wrap">{String(value)}</dd>
                  </div>
                ))}
              </dl>
            </Section>
          )}
          {job.assets.length > 0 && (
            <Section title="Assets">
              <ul className="grid gap-2 text-sm">
                {job.assets.map((a) => (
                  <li key={a.assetId} className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{a.name ?? "Asset no longer available"}</span>
                    {a.type && <span className="text-muted-foreground">{a.type.replaceAll("_", " ")}</span>}
                    {a.state === "proposed" && <Badge variant="info">Proposed</Badge>}
                    {a.status === "done" && <Badge variant="success">Done</Badge>}
                    {a.possibleDuplicateOf && <Badge variant="warning">Possible duplicate</Badge>}
                  </li>
                ))}
              </ul>
            </Section>
          )}
          {children.length > 0 && (
            <Section title="Child jobs">
              <ul className="grid gap-2">
                {children.map((c) => (
                  <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
                    <Link href={`/work-orders/${c.id}`} className="font-medium hover:underline">
                      <span className="font-mono text-xs">{c.code}</span> {c.title}
                    </Link>
                    <WorkStatusBadge status={c.status} />
                  </li>
                ))}
              </ul>
            </Section>
          )}
          <Section title="Photos">
            <JobPhotos
              workOrderId={job.id}
              files={page.files}
              required={kind?.evidence.photos ?? 0}
              canAdd={can.act || (job.status !== "cancelled" && can.assign)}
              locale={locale}
              timeZone={timeZone}
            />
          </Section>
          <Section title="Discussion">
            <JobComments page={page} />
          </Section>
          <Section title="History">
            <JobHistory page={page} />
          </Section>
        </div>

        <aside className="grid gap-3 rounded-xl border bg-card p-4 lg:sticky lg:top-20">
          <h2 className="text-base font-semibold">About this job</h2>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2.5 text-sm">
            <dt className="text-muted-foreground">Assigned to</dt>
            <dd>{job.assignee ?? "Unassigned"}</dd>
            {job.crewName && (
              <>
                <dt className="text-muted-foreground">Crew</dt>
                <dd>{job.crewName}</dd>
              </>
            )}
            <dt className="text-muted-foreground">Due</dt>
            <dd className="tabular">{when(job.dueAt)}</dd>
            {job.areaName && (
              <>
                <dt className="text-muted-foreground">Area</dt>
                <dd>{job.areaName}</dd>
              </>
            )}
            {job.location && (
              <>
                <dt className="text-muted-foreground">Position</dt>
                <dd className="break-words">
                  <a
                    className="inline-flex items-center gap-1 tabular hover:underline"
                    href={`https://www.openstreetmap.org/?mlat=${job.location.latitude}&mlon=${job.location.longitude}#map=18/${job.location.latitude}/${job.location.longitude}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {formatPosition(job.location)}
                    <ExternalLinkIcon className="size-3" aria-hidden />
                  </a>
                  {job.locationNote && <span className="block text-muted-foreground">{job.locationNote}</span>}
                </dd>
              </>
            )}
            <dt className="text-muted-foreground">Source</dt>
            <dd>{job.source}</dd>
            <dt className="text-muted-foreground">Raised</dt>
            <dd className="tabular">{when(job.createdAt)}</dd>
            {job.startedAt && (
              <>
                <dt className="text-muted-foreground">Started</dt>
                <dd className="tabular">{when(job.startedAt)}</dd>
              </>
            )}
            {job.branch && (
              <>
                <dt className="text-muted-foreground">Network branch</dt>
                <dd className="font-mono text-xs break-all">{job.branch}</dd>
              </>
            )}
          </dl>
        </aside>
      </div>
    </div>
  );
}
