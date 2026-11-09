import { money, type FlatBasis, type TariffContent } from "@flowless/shared-types";
import { MoneyText } from "@/components/money-text";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { flatKeyLabel } from "@/lib/tariff-labels";
import { contentTable } from "@/lib/tariff-view";

/**
 * A tariff version's content as a table: bands with the units each covers and the rate per
 * unit, a single uniform rate, or the flat amounts per basis value. Money stays bigint.
 */
export function ContentTable({ content, basis, currency, locale, unit = "per unit" }: { content: TariffContent; basis: FlatBasis; currency: string; locale: string; unit?: string }) {
  const table = contentTable(content, basis);
  if (table.kind === "uniform") {
    return (
      <p className="text-sm">
        <MoneyText value={money(table.rate, currency)} locale={locale} className="text-lg font-semibold" /> <span className="text-muted-foreground">{unit}, whatever is consumed</span>
      </p>
    );
  }
  if (table.kind === "flat") {
    return (
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              <TableHead>{flatKeyLabel[basis]}</TableHead>
              <TableHead className="text-right">Per month</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {table.rows.map((row, i) => (
              <TableRow key={i}>
                <TableCell>{row.key}</TableCell>
                <TableCell className="text-right">
                  <MoneyText value={money(row.amount, currency)} locale={locale} />
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    );
  }
  return (
    <div className="overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow className="hover:bg-transparent">
            <TableHead>Band</TableHead>
            <TableHead>Covers</TableHead>
            <TableHead className="text-right">Rate {unit}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {table.rows.map((row) => (
            <TableRow key={row.position}>
              <TableCell className="tabular text-muted-foreground">{row.position + 1}</TableCell>
              <TableCell>{row.range}</TableCell>
              <TableCell className="text-right">
                <MoneyText value={money(row.rate, currency)} locale={locale} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}
