import { formatMoney, type Money } from "@flowless/shared-types";
import { cn } from "@/lib/utils";

/**
 * Money in the organization's locale (NF-33), tabular so columns align. A negative amount
 * is a credit; it keeps its sign and gets the success tone, never a bare red minus.
 */
export function MoneyText({
  value,
  locale,
  className,
  tone = "auto",
}: {
  value: Money;
  locale: string;
  className?: string;
  tone?: "auto" | "plain";
}) {
  const credit = value.amountMinor < 0n;
  return (
    <span className={cn("tabular whitespace-nowrap", tone === "auto" && credit && "text-success", className)}>
      {formatMoney(value, locale)}
    </span>
  );
}
