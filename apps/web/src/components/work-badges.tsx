import type { WorkOrderOutcome, WorkOrderStatus, WorkPriority } from "@flowless/shared-types";
import { Badge } from "@/components/ui/badge";

type Tone = "success" | "warning" | "info" | "destructive" | "secondary" | "outline";

export const statusLabel: Record<WorkOrderStatus, string> = {
  pending: "Pending",
  in_progress: "In progress",
  blocked: "On hold",
  submitted: "In review",
  completed: "Completed",
  cancelled: "Cancelled",
};
const statusTone: Record<WorkOrderStatus, Tone> = {
  pending: "secondary",
  in_progress: "info",
  blocked: "warning",
  submitted: "info",
  completed: "success",
  cancelled: "outline",
};

export const priorityLabel: Record<WorkPriority, string> = { low: "Low", normal: "Normal", high: "High", urgent: "Urgent" };
const priorityTone: Record<WorkPriority, Tone> = { low: "outline", normal: "secondary", high: "warning", urgent: "destructive" };

export const outcomeLabel: Record<WorkOrderOutcome, string> = { done: "Done", partial: "Partly done", no_fault: "No fault found" };

export function WorkStatusBadge({ status }: { status: WorkOrderStatus }) {
  return <Badge variant={statusTone[status]}>{statusLabel[status]}</Badge>;
}

export function PriorityBadge({ priority }: { priority: WorkPriority }) {
  return <Badge variant={priorityTone[priority]}>{priorityLabel[priority]}</Badge>;
}

/** A job is overdue when it is open and past its due time. The API derives it; this only shows it. */
export function OverdueBadge() {
  return <Badge variant="destructive">Overdue</Badge>;
}
