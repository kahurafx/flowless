"use server";

import { runAction } from "@/data/run-action";
import { getSession } from "@/data/session";
import { SETTING_KEYS, effectiveFromOf } from "@/lib/account-settings";
import { optionalText } from "@/lib/optional-text";
import { POLICY_KEY_LIST } from "@/lib/policy-settings";

// The Accounts settings, and the Billing and Metering ones (`/settings/billing`, `/settings/metering`) that share this form frame.
const KEYS: readonly string[] = [...Object.values(SETTING_KEYS), ...POLICY_KEY_LIST];

/**
 * Saves one Accounts setting as a new configuration version (K-10). `expectedVersion` is the
 * newest version the editor saw: if someone changed it since, the store refuses with a
 * conflict and the form says so. A date makes it a scheduled change (midnight in the
 * organization's time zone); no date applies it now. The procedure checks `settings:manage`
 * and validates the value against the setting's schema, whatever the form sent.
 */
export async function saveAccountSettingAction(input: { key: string; value: unknown; expectedVersion: number; effectiveFrom: string; reason: string }) {
  if (!KEYS.includes(input.key)) return { error: "That setting is not edited here" } as { error: string; data?: undefined };
  const { organization } = await getSession();
  const today = new Intl.DateTimeFormat("en-CA", { timeZone: organization.settings.timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
  const when = effectiveFromOf(input.effectiveFrom, today, organization.settings.timeZone);
  if (!when.ok) return { error: when.problems.join(". ") } as { error: string; data?: undefined };
  return runAction((api) =>
    api.config
      .set({
        key: input.key,
        value: input.value,
        expectedVersion: input.expectedVersion,
        ...(when.value ? { effectiveFrom: when.value } : {}),
        ...optionalText("reason", input.reason),
      })
      .then((r) => ({ version: r.version, changed: r.changed })),
  );
}
