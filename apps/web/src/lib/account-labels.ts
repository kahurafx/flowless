import type {
  AccountCommandKind,
  ApplicationStage,
  CommercialStatus,
  ContactChannel,
  ContactKind,
  CustomerType,
  RelocationStatus,
  ServicePointStatus,
  ServiceState,
  SuccessionBasis,
  SurveyApprovalState,
  SurveyFeasibility,
} from "@flowless/shared-types";

/** Plain-language names for the Accounts vocabulary (C-01 to C-12), in one place so screens agree. */

export const commercialStatusLabel: Record<CommercialStatus, string> = {
  NEW: "New",
  PENDING_PAYMENT: "Pending payment",
  ACTIVE: "Active",
  DORMANT: "Dormant",
  TERMINATED: "Terminated",
};

export const serviceStateLabel: Record<ServiceState, string> = { CONNECTED: "Connected", DISCONNECTED: "Disconnected" };

/** What each logged command is called in the account's history. */
export const commandKindLabel: Record<AccountCommandKind, string> = {
  activate: "Activated",
  mark_pending_payment: "Marked pending payment",
  make_dormant: "Made dormant",
  reactivate: "Reactivated",
  terminate: "Terminated",
  disconnect_service: "Service disconnected",
  reconnect_service: "Service reconnected",
  write_off_decided: "Write-off decided",
  succeed: "Succeeded by a new account",
  change_name: "Change of name",
  relocate: "Service point relocated",
};

export const customerTypeLabel: Record<CustomerType, string> = { person: "Person", organization: "Organization" };
export const contactChannelLabel: Record<ContactChannel, string> = { phone: "Phone", email: "Email" };
export const contactKindLabel: Record<ContactKind, string> = {
  personal: "Personal",
  home: "Home",
  work: "Work",
  billing: "Billing",
  next_of_kin: "Next of kin",
  other: "Other",
};

export const servicePointStatusLabel: Record<ServicePointStatus, string> = {
  PLANNED: "Planned",
  CONNECTED: "Connected",
  DISCONNECTED: "Disconnected",
  DECOMMISSIONED: "Decommissioned",
};

export const applicationStageLabel: Record<ApplicationStage, string> = {
  enquiry: "Enquiry",
  survey: "Survey approved",
  application: "Application",
  invoice: "Invoiced",
  payment: "Paid",
  installation: "Installation",
  ready: "Ready",
  converted: "Converted",
  rejected: "Rejected",
  cancelled: "Cancelled",
};

export const surveyFeasibilityLabel: Record<SurveyFeasibility, string> = { feasible: "Feasible", not_feasible: "Not feasible" };
export const surveyApprovalLabel: Record<SurveyApprovalState, string> = {
  pending: "Approval pending",
  approved: "Approved",
  rejected: "Approval rejected",
};

export const relocationStatusLabel: Record<RelocationStatus, string> = {
  requested: "Requested",
  surveyed: "Surveyed",
  completed: "Completed",
  cancelled: "Cancelled",
};

export const successionBasisLabel: Record<SuccessionBasis, string> = {
  full_membership: "Child becomes a full member",
  change_of_name: "Change of name with a new number",
  relocation_new_number: "Relocation with a new number",
};

/** The write-off reasons the approval offers (`modules/accounts/approvals.ts`); the API checks the code. */
export const WRITE_OFF_REASONS = [
  { code: "UNCOLLECTABLE", label: "Uncollectable" },
  { code: "ABSCONDED", label: "Customer absconded" },
  { code: "DISPUTED_SETTLED", label: "Dispute settled" },
  { code: "DECEASED", label: "Customer deceased" },
  { code: "OTHER", label: "Other (explain in the note)" },
] as const;

/** Reasons the office picks from when disconnecting; free text is still allowed. */
export const DISCONNECT_REASONS = ["Arrears", "Customer request", "Illegal connection", "Tampering", "Maintenance"] as const;
