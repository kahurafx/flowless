import { defineApproval } from "../../kernel/approval-store";

/** The approval kind for a connection survey (C-05, K-05). */
export const SURVEY_APPROVAL_KIND = "accounts.connection_survey";

/**
 * Approving a connection survey (C-05, K-05). Recording a feasible survey asks for it; the
 * outcome moves the application on (`application-approvals.ts`). The request's subject is
 * the application id. The default policy has ONE level, holders of `accounts:change_status`
 * (manager, admin, owner). For two approvals the organization adds a second level in the
 * policy `approvals.accounts.connection_survey`, for example `billing:approve` (the
 * accountant); with no level at all a recorded survey is approved at once. As everywhere in
 * K-05, the person who recorded the survey cannot decide it, and one person decides only one
 * level of a request.
 */
export const surveyApproval = defineApproval({
  key: SURVEY_APPROVAL_KIND,
  module: "accounts",
  label: "Connection survey",
  description: "Approval of a connection survey's findings before the application for a new connection goes ahead.",
  reasonCodes: [],
  policy: { levels: [{ label: "Manager", permission: "accounts:change_status" }], slaHours: 72 },
});
