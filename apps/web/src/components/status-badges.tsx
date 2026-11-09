import type { AgeBucket, ApplicationStage, CommercialStatus, ExceptionType, ServiceStatus } from "@flowless/shared-types";
import { Badge } from "@/components/ui/badge";
import { applicationStageLabel } from "@/lib/account-labels";

type Tone = "success" | "warning" | "info" | "destructive" | "secondary" | "outline";

const commercial: Record<CommercialStatus, { label: string; tone: Tone }> = {
  NEW: { label: "New", tone: "info" },
  PENDING_PAYMENT: { label: "Pending payment", tone: "warning" },
  ACTIVE: { label: "Active", tone: "success" },
  DORMANT: { label: "Dormant", tone: "secondary" },
  TERMINATED: { label: "Terminated", tone: "outline" },
};

/** Commercial status (C-03). */
export function CommercialStatusBadge({ status }: { status: CommercialStatus }) {
  const { label, tone } = commercial[status];
  return <Badge variant={tone}>{label}</Badge>;
}

/** Service status: the second, independent axis (C-03). The reason is shown on hover. */
export function ServiceStatusBadge({ service }: { service: ServiceStatus }) {
  return service.state === "CONNECTED" ? (
    <Badge variant="outline">Connected</Badge>
  ) : (
    <Badge variant="destructive" title={service.reason}>
      Disconnected
    </Badge>
  );
}

const stageTone: Record<ApplicationStage, Tone> = {
  enquiry: "secondary",
  survey: "info",
  application: "info",
  invoice: "warning",
  payment: "warning",
  installation: "info",
  ready: "success",
  converted: "success",
  rejected: "destructive",
  cancelled: "outline",
};

/** Where an application for a new connection stands (C-05). */
export function ApplicationStageBadge({ stage }: { stage: ApplicationStage }) {
  return <Badge variant={stageTone[stage]}>{applicationStageLabel[stage]}</Badge>;
}

const age: Record<AgeBucket, Tone> = { fresh: "success", ageing: "warning", overdue: "destructive" };

/** Exception age, derived at read time (NF-24). */
export function AgeBadge({ days, bucket }: { days: number; bucket: AgeBucket }) {
  return (
    <Badge variant={age[bucket]} className="tabular">
      {days === 0 ? "Today" : days === 1 ? "1 day" : `${days} days`}
    </Badge>
  );
}

export const exceptionTypeLabel: Record<ExceptionType, string> = {
  UNBILLED_ACCOUNT: "Unbilled account",
  READING_EXCEPTION: "Reading",
  UNMATCHED_PAYMENT: "Unmatched payment",
  UNDELIVERED_MESSAGE: "Undelivered message",
  STALE_ACTIVATION: "Stale activation",
  DATA_QUALITY: "Data quality",
  STUCK_COMMITMENT: "Commitment",
  NO_BASELINE: "No baseline",
  JOB_FAILURE: "Job failure",
  EVENT_FAILURE: "Event delivery",
  APPROVAL_OVERDUE: "Approval overdue",
  WORK_ORDER_OVERDUE: "Work order overdue",
  ACCOUNT_NOT_ACTIVE_WITH_METER: "Meter installed, not active",
};
