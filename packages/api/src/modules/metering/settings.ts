import { z } from "zod";
import { defineSetting } from "../../kernel/config-store";

/**
 * How readings are validated at entry (M-05, NF-32). Versioned configuration, read when a
 * reading is recorded. The expected range is relative to the meter's own recent daily use.
 */
export const meteringValidationSchema = z.object({
  /** Flag a reading whose consumption exceeds this many times the expected consumption for the days since the previous one. */
  highFactor: z.number().min(1).max(1000).default(3),
  /** Flag one below this fraction of the expected consumption (0 switches the check off). */
  lowFactor: z.number().min(0).max(1).default(0),
  /** How many earlier intervals make the expected daily consumption. */
  historyIntervals: z.number().int().min(1).max(12).default(3),
  /** Hard ceiling in units a day, regardless of history; null for none. */
  maxUnitsPerDay: z.number().min(0).nullable().default(null),
  /** A drop in the dial is a rollover candidate (needs confirming) only when the wrapped consumption is below this fraction of the dial's range; otherwise it is plainly below the last reading. */
  rolloverMaxFraction: z.number().gt(0).max(1).default(0.5),
});
export type MeteringValidation = z.infer<typeof meteringValidationSchema>;

export const meteringValidationSetting = defineSetting({
  key: "metering.validation",
  module: "metering",
  label: "Reading validation",
  description: "The expected range, rollover and ceiling checks applied when a reading is recorded.",
  schema: meteringValidationSchema,
  default: { highFactor: 3, lowFactor: 0, historyIntervals: 3, maxUnitsPerDay: null, rolloverMaxFraction: 0.5 },
});
