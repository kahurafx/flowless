import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getPolicySettings, type PolicySettingData } from "@/data/policy-settings";
import { BILLING_KEYS, METERING_KEYS, POLICY_KEYS } from "@/lib/policy-settings";
import type { SettingMeta } from "./accounts/setting-shell";
import { BulkSchedulesForm, OutcomesSettingForm, PolicySettingForm } from "./policy-forms";

const metaOf = (s: PolicySettingData): SettingMeta => ({ key: s.key, version: s.version, latestVersion: s.latestVersion, isDefault: s.isDefault, scheduled: s.scheduled, history: s.history });

async function Settings({ area }: { area: "billing" | "metering" }) {
  const data = await getPolicySettings(area);
  const frame = { today: data.today, locale: data.locale, timeZone: data.timeZone, currency: data.currency };
  const keys = area === "billing" ? BILLING_KEYS : METERING_KEYS;
  return (
    <div className="grid max-w-4xl gap-6">
      {keys.map((key) => {
        const s = data.settings[key];
        if (!s) return null;
        // A form remounts when a newer version arrives (its own save, or a reload after a conflict), so it starts from what is stored.
        const formKey = `${key}@${s.latestVersion}`;
        if (key === POLICY_KEYS.meteringOutcomes) return <OutcomesSettingForm key={formKey} meta={metaOf(s)} value={s.value} frame={frame} />;
        if (key === POLICY_KEYS.meteringBulk) return <BulkSchedulesForm key={formKey} meta={metaOf(s)} value={s.value} frame={frame} dmas={data.dmas} />;
        return <PolicySettingForm key={formKey} settingKey={key} meta={metaOf(s)} value={s.value} frame={frame} />;
      })}
    </div>
  );
}

/** The Billing or Metering settings page (K-10): every save is a new version with its history. */
export function PolicySettingsPage({ area }: { area: "billing" | "metering" }) {
  return (
    <>
      <PageHeader
        title={area === "billing" ? "Billing settings" : "Metering settings"}
        description={
          area === "billing"
            ? "How bills are priced and estimated, when and how often routes are billed, how bills are reviewed and how corrections and back-billing are controlled. Every save is a new version with its history; nothing is overwritten."
            : "How readings are validated, what each visit outcome means for billing, when missed readings escalate, zero consumption and bulk meter schedules. Every save is a new version with its history."
        }
      />
      <Suspense fallback={<Skeleton className="h-96 max-w-4xl" />}>
        <Settings area={area} />
      </Suspense>
    </>
  );
}
