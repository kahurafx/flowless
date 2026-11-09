import { z } from "zod";
import { ACTIVATION_GATE_KEYS, ACTIVATION_MODES, CHECK_DIGIT_SCHEMES, type CommercialStatus, type ServiceState } from "./accounts";
import { DATA_QUALITY_SEVERITIES } from "./data-quality";
import { CHARGE_TYPES, type ChargeType } from "./tariffs";

/*
 * The stored shapes of the Accounts configuration settings (K-10, C-02, C-04 to C-07, C-12).
 * One contract for the API (which registers each with `defineSetting` and validates every
 * save) and the web forms (which map a stored value to fields and back, typed with
 * `z.infer`), so a change to a shape is a type error on both sides. Pure zod, no I/O. Every
 * field has a default so a version stored earlier still reads (NF-32).
 */

/* ---------- accounts.numbering (C-02) ---------- */

/** The organization's account number format. A change applies to numbers issued from then on. */
export const numberingFormatSchema = z.object({
  /** Upper-case letters and digits put before the sequence ("" for none). */
  prefix: z
    .string()
    .regex(/^[A-Z0-9]{0,8}$/, "Use up to 8 capital letters or digits")
    .default(""),
  /** The sequence is padded with zeros to at least this many digits. */
  width: z.number().int().min(1).max(12).default(4),
  /** The first sequence number; raising it moves an existing counter forward, never back. */
  start: z.number().int().min(1).max(2_000_000_000).default(1001),
  checkDigit: z.enum(CHECK_DIGIT_SCHEMES).default("luhn"),
  /** Put between prefix, sequence and check digit. Empty for none. */
  separator: z.enum(["", "-", "/", "."]).default(""),
  /** How a child account's number extends its parent's; letters only for now (A, B, ... Z, AA). */
  childSuffix: z.enum(["letters"]).default("letters"),
});
export type NumberingFormat = z.infer<typeof numberingFormatSchema>;

/* ---------- accounts.status_rules (C-04) ---------- */

const chargeType = z.enum(CHARGE_TYPES);

/** One cell of the table. `usage` is billed exactly when consumption is billed. */
export const statusRuleCellSchema = z
  .object({
    billsConsumption: z.boolean().default(false),
    chargeTypes: z
      .array(chargeType)
      .default([])
      .refine((types) => new Set(types).size === types.length, "List each charge type once"),
  })
  .refine((cell) => cell.chargeTypes.includes("usage") === cell.billsConsumption, {
    message: "Usage is billed exactly when consumption is billed",
    path: ["chargeTypes"],
  });
export type StatusRuleCell = z.infer<typeof statusRuleCellSchema>;

const cell = (billsConsumption: boolean, types: readonly ChargeType[]): StatusRuleCell => ({
  billsConsumption,
  chargeTypes: CHARGE_TYPES.filter((t) => types.includes(t)),
});

const rowSchema = (fallback: Record<ServiceState, StatusRuleCell>) =>
  z
    .object({
      CONNECTED: statusRuleCellSchema.default(fallback.CONNECTED),
      DISCONNECTED: statusRuleCellSchema.default(fallback.DISCONNECTED),
    })
    .default(fallback);

const nothing = cell(false, []);
/** A new connection is invoiced before it has service: one-off charges, nothing recurring or metered. */
const oneOff = cell(false, ["fee", "deposit", "material", "labour", "adjustment"]);

export const DEFAULT_STATUS_RULES = {
  NEW: { CONNECTED: oneOff, DISCONNECTED: oneOff },
  PENDING_PAYMENT: { CONNECTED: oneOff, DISCONNECTED: oneOff },
  // Live: everything. Disconnected but active: standing charges and rent still run, consumption does not.
  ACTIVE: {
    CONNECTED: cell(true, CHARGE_TYPES),
    DISCONNECTED: cell(false, CHARGE_TYPES.filter((t) => t !== "usage")),
  },
  // Dormant bills nothing until the organization turns something on.
  DORMANT: { CONNECTED: nothing, DISCONNECTED: nothing },
  // Only what can still follow an account's closing.
  TERMINATED: { CONNECTED: cell(false, ["fee", "penalty", "adjustment"]), DISCONNECTED: cell(false, ["fee", "penalty", "adjustment"]) },
} as const satisfies Record<CommercialStatus, Record<ServiceState, StatusRuleCell>>;

export const statusRulesSchema = z.object({
  NEW: rowSchema(DEFAULT_STATUS_RULES.NEW),
  PENDING_PAYMENT: rowSchema(DEFAULT_STATUS_RULES.PENDING_PAYMENT),
  ACTIVE: rowSchema(DEFAULT_STATUS_RULES.ACTIVE),
  DORMANT: rowSchema(DEFAULT_STATUS_RULES.DORMANT),
  TERMINATED: rowSchema(DEFAULT_STATUS_RULES.TERMINATED),
});
export type StatusRules = z.infer<typeof statusRulesSchema>;

/* ---------- accounts.activation (C-06) ---------- */

const gate = {
  /** A disabled gate is not part of this organization's activation at all (waived). */
  enabled: z.boolean().default(true),
  /** An enabled gate that is not required is shown but does not hold activation back. */
  required: z.boolean().default(true),
};

export const officeItemSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,39}$/, "Keys are 2 to 40 lower-case letters, digits or _, starting with a letter")
    .refine((k) => !(ACTIVATION_GATE_KEYS as readonly string[]).includes(k), "That key belongs to a built-in gate"),
  label: z.string().trim().min(1).max(120),
  ...gate,
});

export const activationConfigSchema = z
  .object({
    /** `checklist`: the office activates once the gates are met. `auto`: activation happens by itself when the last fact arrives. */
    mode: z.enum(ACTIVATION_MODES).default("checklist"),
    /** NEW or PENDING_PAYMENT for longer than this many days raises an exception (C-06, X-02). */
    staleAfterDays: z.number().int().min(1).max(365).default(14),
    gates: z
      .object({
        /** The share of the new-connection invoice that must be paid, or a fixed minimum in minor units. Billing's source reads these. */
        payment_threshold: z
          .object({
            ...gate,
            basis: z.enum(["percent", "fixed"]).default("percent"),
            percent: z.number().int().min(1).max(100).default(100),
            fixedAmount: z.string().regex(/^\d+$/, "Amounts are whole minor units").default("0"),
          })
          .default({ enabled: true, required: true, basis: "percent", percent: 100, fixedAmount: "0" }),
        meter_installed: z.object(gate).default({ enabled: true, required: true }),
        initial_reading: z.object(gate).default({ enabled: true, required: true }),
      })
      .default({
        payment_threshold: { enabled: true, required: true, basis: "percent", percent: 100, fixedAmount: "0" },
        meter_installed: { enabled: true, required: true },
        initial_reading: { enabled: true, required: true },
      }),
    /** Extra items the office ticks by hand, such as "Site visit signed off". */
    officeChecklist: z
      .array(officeItemSchema)
      .max(20)
      .default([])
      .refine((items) => new Set(items.map((i) => i.key)).size === items.length, "Each checklist item needs its own key"),
  })
  .default({
    mode: "checklist",
    staleAfterDays: 14,
    gates: {
      payment_threshold: { enabled: true, required: true, basis: "percent", percent: 100, fixedAmount: "0" },
      meter_installed: { enabled: true, required: true },
      initial_reading: { enabled: true, required: true },
    },
    officeChecklist: [],
  });
export type ActivationConfig = z.infer<typeof activationConfigSchema>;

/* ---------- accounts.application (C-05, C-09) ---------- */

const used = z.object({ required: z.boolean().default(true) });

export const applicationConfigSchema = z.object({
  /** A survey (with its approval, set by the K-05 policy `approvals.accounts.connection_survey`) before the application. */
  survey: used.default({ required: true }),
  /** The new-connection invoice and its payment. Waived: the application goes on without an invoice. */
  invoice: used.default({ required: true }),
  /** Installation before the connection is ready. */
  installation: used.default({ required: true }),
  /** C-09: a survey must be recorded before a relocation can be completed. */
  relocation: z.object({ surveyRequired: z.boolean().default(true) }).default({ surveyRequired: true }),
});
export type ApplicationConfig = z.infer<typeof applicationConfigSchema>;

/* ---------- accounts.membership (C-07) ---------- */

export const membershipClassSchema = z.object({
  /** Stable key stored on the account. */
  key: z.string().regex(/^[a-z][a-z0-9_]{1,29}$/, "Use 2 to 30 lower-case letters, digits or _, starting with a letter"),
  label: z.string().trim().min(1).max(80),
  /** The charge catalog item (T-07) whose amount is the connection fee for this class. */
  connectionFeeChargeItemCode: z.string().trim().min(1).max(40).optional(),
});

export const membershipConfigSchema = z
  .object({ classes: z.array(membershipClassSchema).max(30).default([]) })
  .refine((c) => new Set(c.classes.map((k) => k.key)).size === c.classes.length, "Each class needs its own key");

export type MembershipConfig = z.infer<typeof membershipConfigSchema>;
export type MembershipClass = z.infer<typeof membershipClassSchema>;

/* ---------- accounts.data_quality (C-12) ---------- */

export const dataQualityRuleSettingsSchema = z.object({
  enabled: z.boolean().optional(),
  severity: z.enum(DATA_QUALITY_SEVERITIES).optional(),
  raiseExceptions: z.boolean().optional(),
});

/** Keys are not limited to the catalogue's: a retired rule in an old version is ignored rather than failing the read. */
export const dataQualityConfigSchema = z.object({
  rules: z.record(z.string(), dataQualityRuleSettingsSchema).default({}),
});
export type DataQualityConfig = z.infer<typeof dataQualityConfigSchema>;
