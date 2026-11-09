import { ACTIVATION_GATE_KEYS, ACTIVATION_MODES, type ActivationGateKey } from "@flowless/shared-types";
import { z } from "zod";

/*
 * Activation gates (C-06), pure: the organization's configuration (`accounts.activation`) and
 * `evaluateGates`, which says for each gate whether it is met, unmet or waived, and whether
 * the account is ready to activate. The facts come from other modules through the gate
 * source registry (`sources.ts`); a gate no module can speak for yet is met only by the
 * office ticking it on the checklist.
 */

const gate = {
  /** A disabled gate is not part of this organization's activation at all (waived). */
  enabled: z.boolean().default(true),
  /** An enabled gate that is not required is shown but does not hold activation back. */
  required: z.boolean().default(true),
};

export const GATE_LABELS: Record<ActivationGateKey, string> = {
  payment_threshold: "Payment threshold met",
  meter_installed: "Meter installed and confirmed in inventory",
  initial_reading: "Initial reading captured",
};

export const officeItemSchema = z.object({
  key: z
    .string()
    .regex(/^[a-z][a-z0-9_]{1,39}$/, "Keys are 2 to 40 lower-case letters, digits or _, starting with a letter")
    .refine((k) => !(ACTIVATION_GATE_KEYS as readonly string[]).includes(k), "That key belongs to a built-in gate"),
  label: z.string().trim().min(1).max(120),
  ...gate,
});

/** Every field has a default, so older stored values keep reading (NF-32). */
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

/** What a module's gate source says about one account. */
export interface GateFact {
  met: boolean;
  detail?: string | undefined;
}

export type GateState = "met" | "unmet" | "waived";

export interface GateResult {
  key: string;
  label: string;
  /** A built-in gate, or an office item the organization defined. */
  kind: "builtin" | "office";
  state: GateState;
  /** Does an unmet state hold activation back? */
  required: boolean;
  /** Who decided the state: a module's source, the office checklist, or the configuration (a disabled gate). */
  via: "source" | "checklist" | "disabled";
  detail?: string | undefined;
}

export interface GateEvaluation {
  gates: GateResult[];
  /** Keys of required gates that are unmet. */
  unmet: string[];
  /** Every required gate is met or waived. */
  ready: boolean;
}

/** The gates in force, built-in first, in a fixed order. */
export function gateList(config: ActivationConfig): { key: string; label: string; kind: "builtin" | "office"; enabled: boolean; required: boolean }[] {
  return [
    ...ACTIVATION_GATE_KEYS.map((key) => ({ key, label: GATE_LABELS[key], kind: "builtin" as const, ...pick(config.gates[key]) })),
    ...config.officeChecklist.map((item) => ({ key: item.key, label: item.label, kind: "office" as const, ...pick(item) })),
  ];
}
const pick = (g: { enabled: boolean; required: boolean }) => ({ enabled: g.enabled, required: g.required });

/** Does this organization take payment before activation? (an enabled, required payment gate) */
export const hasPaymentGate = (config: ActivationConfig) => config.gates.payment_threshold.enabled && config.gates.payment_threshold.required;

/**
 * Evaluates the gates for one account.
 * - `facts[key]`: what the module that can speak for that gate says, or null/absent when
 *   nothing can ("no source yet"). A source's answer is the answer; a tick cannot override it.
 * - `checks[key]`: the gate is ticked on the office checklist right now.
 * - A disabled gate is `waived`. An office item has no source and is met by its tick.
 */
export function evaluateGates(
  config: ActivationConfig,
  facts: Readonly<Record<string, GateFact | null | undefined>>,
  checks: Readonly<Record<string, boolean | undefined>>,
): GateEvaluation {
  const gates = gateList(config).map((g): GateResult => {
    if (!g.enabled) return { key: g.key, label: g.label, kind: g.kind, state: "waived", required: false, via: "disabled" };
    const fact = g.kind === "builtin" ? facts[g.key] : null;
    if (fact) {
      return { key: g.key, label: g.label, kind: g.kind, state: fact.met ? "met" : "unmet", required: g.required, via: "source", detail: fact.detail };
    }
    return { key: g.key, label: g.label, kind: g.kind, state: checks[g.key] ? "met" : "unmet", required: g.required, via: "checklist" };
  });
  const unmet = gates.filter((g) => g.required && g.state === "unmet").map((g) => g.key);
  return { gates, unmet, ready: unmet.length === 0 };
}
