import type {
  ChargeRecurrence,
  ChargeType,
  FlatBasis,
  InvoiceAppliesTo,
  LateFeeBase,
  LateFeeFrequency,
  OverdueAction,
  PaymentTermsKind,
  RevenueKind,
  TariffType,
} from "@flowless/shared-types";

/** Plain-language names for the Tariffs vocabulary (T-01 to T-10), in one place so screens agree. */

export const tariffTypeLabel: Record<TariffType, string> = {
  increasing_block: "Increasing block",
  decreasing_block: "Decreasing block",
  uniform: "Uniform rate",
  flat_rate: "Flat rate",
};

export const tariffTypeHint: Record<TariffType, string> = {
  increasing_block: "Each band of units costs more than the one before.",
  decreasing_block: "Each band of units costs less than the one before.",
  uniform: "One rate for every unit consumed.",
  flat_rate: "A fixed amount per billing month, whatever is consumed.",
};

export const flatBasisLabel: Record<FlatBasis, string> = {
  property: "Property type",
  pipe_size: "Pipe size",
  taps: "Number of taps",
  none: "One amount for everyone",
};

/** What the key column of a flat-rate table is called, per basis. */
export const flatKeyLabel: Record<FlatBasis, string> = {
  property: "Property type",
  pipe_size: "Pipe size",
  taps: "Taps",
  none: "Applies to",
};

export const chargeTypeLabel: Record<ChargeType, string> = {
  usage: "Usage",
  recurring: "Recurring",
  fee: "Fee",
  penalty: "Penalty",
  deposit: "Deposit",
  material: "Material",
  labour: "Labour",
  transfer: "Transfer",
  adjustment: "Adjustment",
};

export const chargeRecurrenceLabel: Record<ChargeRecurrence, string> = { monthly: "Monthly", quarterly: "Quarterly", annually: "Annually" };

export const revenueKindLabel: Record<RevenueKind, string> = {
  revenue: "Revenue",
  liability: "Liability, not revenue",
  non_revenue: "Non-revenue",
};

export const appliesToLabel: Record<InvoiceAppliesTo, string> = { application: "New-connection applications", account: "Accounts" };

export const termsKindLabel: Record<PaymentTermsKind, string> = { full: "Full amount", minimum_deposit: "Minimum deposit first", installments: "Installments" };

export const overdueActionLabel: Record<OverdueAction, string> = {
  none: "Nothing happens",
  disconnect: "Disconnect the service",
  pause_application: "Pause the application",
  cancel_application: "Cancel the application",
};

export const lateFeeBaseLabel: Record<LateFeeBase, string> = { overdue_balance: "Overdue balance", invoice_total: "Invoice total" };

export const lateFeeFrequencyLabel: Record<LateFeeFrequency, string> = {
  once: "Once",
  monthly: "Every 30 days",
  manual_only: "Only when staff apply it",
};
