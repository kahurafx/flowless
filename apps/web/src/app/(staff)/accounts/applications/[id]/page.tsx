import { ArrowLeftIcon, CheckIcon, MinusIcon } from "lucide-react";
import Link from "next/link";
import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { ApplicationStageBadge } from "@/components/status-badges";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { getApplicationPage, type ApplicationPage } from "@/data/applications";
import { applicationStageLabel, surveyApprovalLabel, surveyFeasibilityLabel } from "@/lib/account-labels";
import { offersFor, stageBeforeEnd, stageLine, type StepState } from "@/lib/application-view";
import { formatWhen } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { accountHref } from "../../accounts-table";
import { ApplicationActions } from "./application-actions";

export const metadata = { title: "Application" };

export default function ApplicationPage({ params }: PageProps<"/accounts/applications/[id]">) {
  return (
    <>
      <Button variant="ghost" className="-ml-2.5 mb-2" render={<Link href="/accounts/applications" />}>
        <ArrowLeftIcon />
        Applications
      </Button>
      <Suspense fallback={<Skeleton className="h-96" />}>
        <Application params={params} />
      </Suspense>
    </>
  );
}

const stepText: Record<StepState, string> = { done: "Done", current: "Now", upcoming: "To come", skipped: "Skipped", stopped: "Stopped here" };

async function Application({ params }: { params: PageProps<"/accounts/applications/[id]">["params"] }) {
  const { id } = await params;
  const page = await getApplicationPage(id);
  const { application: a } = page;
  const line = stageLine(a.stage, page.stages, stageBeforeEnd(page.events));
  const offers = offersFor({ stage: a.stage, surveyApprovalState: a.survey?.approvalState ?? null, surveyFeasibility: a.survey?.feasibility ?? null }, page.stages, page.permissions);
  const surveyUsed = page.stages.includes("survey");
  const surveyJobHref = page.canRaiseSurveyJob && surveyUsed && a.stage === "enquiry" ? `/work-orders/new?kind=connection_survey&asset=${a.id}` : null;

  return (
    <>
      <PageHeader
        eyebrow="Application"
        title={a.customerName ?? "Customer"}
        description={
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <ApplicationStageBadge stage={a.stage} />
            <span>{a.address}</span>
          </div>
        }
      />
      <div className="grid gap-6">
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8" aria-label="Stages">
          {line.map((s) => (
            <li
              key={s.stage}
              aria-current={s.state === "current" ? "step" : undefined}
              className={cn(
                "grid gap-0.5 rounded-lg border p-2.5 text-sm",
                s.state === "current" && "border-primary bg-primary/5",
                s.state === "stopped" && "border-destructive/40 bg-destructive/5",
                s.state === "skipped" && "border-dashed text-muted-foreground",
              )}
            >
              <span className="flex items-center gap-1.5 font-medium">
                {s.state === "done" && <CheckIcon className="size-3.5 text-success" aria-hidden />}
                {s.state === "skipped" && <MinusIcon className="size-3.5" aria-hidden />}
                {applicationStageLabel[s.stage]}
              </span>
              <span className="text-xs text-muted-foreground">{stepText[s.state]}</span>
            </li>
          ))}
        </ol>
        {(a.stage === "rejected" || a.stage === "cancelled") && (
          <p role="status" className="rounded-xl bg-muted p-3 text-sm">
            This application was {a.stage} and can no longer change.
          </p>
        )}

        <ApplicationActions applicationId={a.id} offers={offers} surveyJobHref={surveyJobHref} />

        <div className="grid items-start gap-6 lg:grid-cols-2">
          <Details page={page} />
          <Survey page={page} surveyUsed={surveyUsed} />
        </div>
        <History page={page} />
      </div>
    </>
  );
}

function Card({ id, title, children }: { id: string; title: string; children: React.ReactNode }) {
  return (
    <section aria-labelledby={id} className="grid gap-3 rounded-xl border bg-card p-4">
      <h2 id={id} className="text-base font-semibold">
        {title}
      </h2>
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[8.5rem_1fr] gap-2 text-sm">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

function Details({ page }: { page: ApplicationPage }) {
  const { application: a } = page;
  return (
    <Card id="details" title="Details">
      <dl className="grid gap-2">
        <Row label="Customer">
          <Link href={`/accounts/customers/${a.customerId}`} className="text-primary hover:underline">
            {a.customerName ?? "Customer"}
          </Link>
        </Row>
        <Row label="Address">{a.address}</Row>
        <Row label="Area">{page.area ?? <span className="text-muted-foreground">Not set</span>}</Row>
        <Row label="Route">{page.route ?? <span className="text-muted-foreground">Not set</span>}</Row>
        <Row label="GPS">{a.location ? <span className="tabular">{a.location.lat.toFixed(5)}, {a.location.lng.toFixed(5)}</span> : <span className="text-muted-foreground">Not set</span>}</Row>
        {page.showCategory && <Row label="Category wanted">{page.categoryName ?? <span className="text-muted-foreground">Not decided</span>}</Row>}
        {page.parentNumber && (
          <Row label="Child of">
            <Link href={accountHref(page.parentNumber)} className="font-mono text-xs text-primary hover:underline">
              {page.parentNumber}
            </Link>
            {a.membershipClass && <span className="text-muted-foreground"> · {a.membershipClass}</span>}
          </Row>
        )}
        {a.invoiceRef && <Row label="Invoice">{a.invoiceRef}</Row>}
        {a.paymentRef && <Row label="Payment">{a.paymentRef}</Row>}
        {page.accountNumber && (
          <Row label="Account">
            <Link href={accountHref(page.accountNumber)} className="font-mono text-xs text-primary hover:underline">
              {page.accountNumber}
            </Link>
          </Row>
        )}
        {a.notes && <Row label="Notes">{a.notes}</Row>}
        <Row label="Logged">
          {formatWhen(a.createdAt, page.locale, page.timeZone)}
          {page.createdBy && ` by ${page.createdBy}`}
        </Row>
      </dl>
    </Card>
  );
}

function Survey({ page, surveyUsed }: { page: ApplicationPage; surveyUsed: boolean }) {
  const { application: a, approval } = page;
  return (
    <Card id="survey" title="Survey">
      {!surveyUsed ? (
        <p className="text-sm text-muted-foreground">This organization does not require a survey.</p>
      ) : !a.survey ? (
        <p className="text-sm text-muted-foreground">No survey recorded yet.</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            <Badge variant={a.survey.feasibility === "feasible" ? "success" : "destructive"}>{surveyFeasibilityLabel[a.survey.feasibility]}</Badge>
            {a.survey.approvalState && <Badge variant={a.survey.approvalState === "approved" ? "success" : a.survey.approvalState === "rejected" ? "destructive" : "warning"}>{surveyApprovalLabel[a.survey.approvalState]}</Badge>}
            <span className="text-xs text-muted-foreground">
              {a.survey.source === "work_order" ? "From a survey job" : "Recorded by the office"}
              {page.surveyBy && ` · ${page.surveyBy}`}
              {a.survey.recordedAt && ` · ${formatWhen(a.survey.recordedAt, page.locale, page.timeZone)}`}
            </span>
          </div>
          <p className="text-sm whitespace-pre-wrap">{a.survey.findings}</p>
          {a.survey.materialsNote && (
            <p className="text-sm">
              <span className="text-muted-foreground">Materials: </span>
              {a.survey.materialsNote}
            </p>
          )}
          {approval && (
            <div className="grid gap-1 rounded-lg border p-3 text-sm">
              <p className="font-medium">
                Approval: {approval.status}
                {approval.waitingFor ? `, waiting for ${approval.waitingFor}` : ""}
              </p>
              {approval.decisions.map((d, i) => (
                <p key={i} className="text-xs text-muted-foreground">
                  {d.by}: {d.decision}
                  {d.note ? ` (${d.note})` : ""}
                </p>
              ))}
              {approval.canDecide && (
                <Link href="/approvals" className="text-sm text-primary hover:underline">
                  You can decide this in Approvals
                </Link>
              )}
            </div>
          )}
        </>
      )}
    </Card>
  );
}

function History({ page }: { page: ApplicationPage }) {
  return (
    <Card id="app-history" title="History">
      <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>When</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Reason</TableHead>
              <TableHead>By</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {page.events.map((e) => (
              <TableRow key={e.id}>
                <TableCell className="tabular whitespace-nowrap">{formatWhen(e.occurredAt, page.locale, page.timeZone)}</TableCell>
                <TableCell className="whitespace-nowrap">
                  {e.kind === "created"
                    ? "Enquiry logged"
                    : e.kind === "survey_recorded"
                      ? "Survey recorded"
                      : e.kind === "survey_decided"
                        ? "Survey decision"
                        : `${e.fromStage ? applicationStageLabel[e.fromStage] : "Start"} to ${applicationStageLabel[e.toStage].toLowerCase()}`}
                </TableCell>
                <TableCell className="min-w-48 whitespace-normal">{e.reason}</TableCell>
                <TableCell className="whitespace-nowrap">{e.actor}</TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </Card>
  );
}
