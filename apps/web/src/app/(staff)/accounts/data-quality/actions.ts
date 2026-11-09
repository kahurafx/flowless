"use server";

import type { DataQualityRuleKey } from "@flowless/shared-types";
import { runAction } from "@/data/run-action";
import { DUPLICATES_PAGE, FINDINGS_PAGE } from "@/data/data-quality";

/** The next page of one rule's findings (C-12). Reads only, so the page is not refreshed. */
export const loadFindingsAction = async (rule: DataQualityRuleKey, after: string) =>
  runAction((api) => api.accounts.dataQuality.findings({ rule, after, limit: FINDINGS_PAGE }), { refresh: false });

/** The next page of duplicate-customer groups. */
export const loadDuplicatesAction = async (after: { matchedOn: "national_id" | "registration_number" | "phone"; key: string }) =>
  runAction((api) => api.accounts.dataQuality.customerDuplicates({ after, limit: DUPLICATES_PAGE }), { refresh: false });
