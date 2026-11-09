"use client";

import { COMMERCIAL_STATUSES, SERVICE_STATES, type StatusRules } from "@flowless/shared-types";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import { commercialStatusLabel, serviceStateLabel } from "@/lib/account-labels";
import { OTHER_CHARGE_TYPES, statusRulesFromForm, statusRulesToForm, toggleChargeType, toggleConsumption } from "@/lib/account-settings";
import { chargeTypeLabel } from "@/lib/tariff-labels";
import { SettingShell, type SettingMeta } from "./setting-shell";
import { useDraft, type FormFrame } from "./use-draft";

/** `accounts.status_rules` (C-04): for each commercial and service status, whether consumption is billed and which charge types apply. */
export function StatusRulesSettingForm({ meta, value, frame }: { meta: SettingMeta; value: StatusRules; frame: FormFrame }) {
  const draft = useDraft(statusRulesToForm(value));
  const form = draft.value;
  return (
    <SettingShell
      title="Charges by account status"
      description="What is billed while an account is in each status. Consumption (usage) is billed or not; the other charge types, such as standing charges and fees, are each switched on or off. Billing reads this table; it does not change any invoice already issued."
      meta={meta}
      dirty={draft.dirty}
      build={() => ({ ok: true, value: statusRulesFromForm(draft.value) })}
      onDiscard={draft.reset}
      {...frame}
    >
      <div className="grid gap-4">
        {COMMERCIAL_STATUSES.map((status) => (
          <fieldset key={status} className="grid gap-3 rounded-lg border p-3">
            <legend className="px-1 text-sm font-medium">{commercialStatusLabel[status]}</legend>
            <div className="grid gap-4 lg:grid-cols-2">
              {SERVICE_STATES.map((service) => {
                const cell = form[status][service];
                const prefix = `sr-${status}-${service}`;
                return (
                  <div key={service} className="grid gap-2">
                    <p className="text-xs font-medium text-muted-foreground">{serviceStateLabel[service]}</p>
                    <div className="flex items-center gap-2">
                      <Checkbox id={`${prefix}-usage`} checked={cell.billsConsumption} onCheckedChange={(v) => draft.set(toggleConsumption(form, status, service, v === true))} />
                      <Label htmlFor={`${prefix}-usage`} className="font-medium">
                        Consumption billed
                      </Label>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                      {OTHER_CHARGE_TYPES.map((type) => (
                        <div key={type} className="flex items-center gap-1.5">
                          <Checkbox id={`${prefix}-${type}`} checked={cell.chargeTypes.includes(type)} onCheckedChange={(v) => draft.set(toggleChargeType(form, status, service, type, v === true))} />
                          <Label htmlFor={`${prefix}-${type}`} className="font-normal">
                            {chargeTypeLabel[type]}
                          </Label>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
      </div>
    </SettingShell>
  );
}
