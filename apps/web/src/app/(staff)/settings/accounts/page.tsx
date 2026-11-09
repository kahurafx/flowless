import { Suspense } from "react";
import { PageHeader } from "@/components/shell/page-header";
import { Skeleton } from "@/components/ui/skeleton";
import { getAccountsSettings, type SettingData } from "@/data/account-settings";
import { SETTING_KEYS, type ActivationValue, type ApplicationValue, type ApprovalPolicyValue, type DataQualityValue, type MembershipValue, type NumberingValue, type StatusRulesValue } from "@/lib/account-settings";
import { ActivationSettingForm } from "./activation-form";
import { ApprovalPolicySettingForm } from "./approval-policy-form";
import { NumberingSettingForm } from "./numbering-form";
import type { SettingMeta } from "./setting-shell";
import { ApplicationSettingForm, DataQualitySettingForm, MembershipSettingForm } from "./simple-forms";
import { StatusRulesSettingForm } from "./status-rules-form";

export const metadata = { title: "Accounts settings" };

// K-10: the Accounts configuration, one new version per save.
export default function AccountsSettingsPage() {
  return (
    <>
      <PageHeader
        title="Accounts settings"
        description="How accounts are numbered, billed by status, activated and applied for, which membership classes exist, which data-quality rules run and who approves what. Every save is a new version with its history; nothing is overwritten."
      />
      <Suspense fallback={<Skeleton className="h-96 max-w-4xl" />}>
        <Settings />
      </Suspense>
    </>
  );
}

const metaOf = (s: SettingData): SettingMeta => ({ key: s.key, version: s.version, latestVersion: s.latestVersion, isDefault: s.isDefault, scheduled: s.scheduled, history: s.history });

async function Settings() {
  const data = await getAccountsSettings();
  const frame = { today: data.today, locale: data.locale, timeZone: data.timeZone, currency: data.currency };
  const s = data.settings;
  // A form remounts when a newer version arrives (its own save, or a reload after a conflict), so it starts from what is stored.
  const at = (key: string) => s[key]?.latestVersion ?? 0;
  const present = (key: string) => s[key] ?? null;
  const numbering = present(SETTING_KEYS.numbering);
  const rules = present(SETTING_KEYS.statusRules);
  const activation = present(SETTING_KEYS.activation);
  const application = present(SETTING_KEYS.application);
  const membership = present(SETTING_KEYS.membership);
  const quality = present(SETTING_KEYS.dataQuality);
  const survey = present(SETTING_KEYS.surveyApproval);
  const writeOff = present(SETTING_KEYS.writeOffApproval);

  return (
    <div className="grid max-w-4xl gap-6">
      {numbering && <NumberingSettingForm key={at(numbering.key)} meta={metaOf(numbering)} value={numbering.value as NumberingValue} nextNumber={data.nextNumber} frame={frame} />}
      {rules && <StatusRulesSettingForm key={at(rules.key)} meta={metaOf(rules)} value={rules.value as StatusRulesValue} frame={frame} />}
      {activation && <ActivationSettingForm key={at(activation.key)} meta={metaOf(activation)} value={activation.value as ActivationValue} frame={frame} />}
      {application && <ApplicationSettingForm key={at(application.key)} meta={metaOf(application)} value={application.value as ApplicationValue} frame={frame} />}
      {survey && (
        <ApprovalPolicySettingForm
          key={at(survey.key)}
          meta={metaOf(survey)}
          value={survey.value as ApprovalPolicyValue}
          frame={frame}
          title="Approval: connection survey"
          description="Who approves a connection survey's findings before an application goes ahead. One level by default; add a second, or remove every level to approve at once."
          amountHint="for surveys"
        />
      )}
      {membership && <MembershipSettingForm key={at(membership.key)} meta={metaOf(membership)} value={membership.value as MembershipValue} frame={frame} chargeItems={data.chargeItems} />}
      {quality && <DataQualitySettingForm key={at(quality.key)} meta={metaOf(quality)} value={quality.value as DataQualityValue} frame={frame} />}
      {writeOff && (
        <ApprovalPolicySettingForm
          key={at(writeOff.key)}
          meta={metaOf(writeOff)}
          value={writeOff.value as ApprovalPolicyValue}
          frame={frame}
          title="Approval: write-off"
          description="Who approves writing off an account's balance before it is terminated. A level with a minimum amount applies only to write-offs of at least that much; smaller ones skip it."
          amountHint="for write-offs"
        />
      )}
    </div>
  );
}
