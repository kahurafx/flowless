import { z } from "zod";
import { defineSetting } from "./config-store";

const isTimeZone = (zone: string) => {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
};

const isLocale = (locale: string) => {
  try {
    return Intl.getCanonicalLocales(locale).length === 1;
  } catch {
    return false;
  }
};

/** Time zone and language (NF-33): billing periods, due dates and documents use them. */
export const regionalSetting = defineSetting({
  key: "kernel.regional",
  module: "kernel",
  label: "Time zone and language",
  description: "The time zone billing periods and due dates are counted in, and the language of documents and messages.",
  schema: z.object({
    timeZone: z.string().refine(isTimeZone, "Unknown time zone"),
    locale: z.string().refine(isLocale, "Unknown language code"),
  }),
  default: { timeZone: "Africa/Nairobi", locale: "en-KE" },
});
