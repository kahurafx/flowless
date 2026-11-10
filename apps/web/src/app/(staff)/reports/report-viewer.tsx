"use client";

import { DownloadIcon, PlayIcon } from "lucide-react";
import { useState, useTransition } from "react";
import { toast } from "sonner";
import { FieldSelect } from "@/components/field-select";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { buildReportParams, dimensionsOf, emptyReportForm, exportBytes, formatCell, isAggregate, isNumeric, measuresOf, type ReportColumnView, type ReportDescription, type ReportForm } from "@/lib/report-view";
import { exportReportAction, runReportAction } from "./actions";

interface Result {
  columns: ReportColumnView[];
  rows: Record<string, unknown>[];
  truncated: boolean;
  rowCap: number;
}

/**
 * Runs one report with its filters, grouping and measures, shows the capped result, and
 * downloads the same parameters as CSV or Excel (the export has its own, larger cap).
 * Ids in the filters and the result are not resolved to names yet.
 */
export function ReportViewer({ report, canExport, currency, locale, timeZone }: { report: ReportDescription & { rowCap: number; exportRowCap: number }; canExport: boolean; currency: string; locale: string; timeZone: string }) {
  const [form, setForm] = useState<ReportForm>(() => emptyReportForm(report));
  const [result, setResult] = useState<Result | null>(null);
  const [problems, setProblems] = useState<string[]>([]);
  const [pending, start] = useTransition();
  const aggregate = isAggregate(report);

  const params = () => {
    const built = buildReportParams(report, form);
    setProblems(built.ok ? [] : built.problems);
    return built.ok ? built.params : null;
  };

  const run = () =>
    start(async () => {
      const p = params();
      if (!p) return;
      const res = await runReportAction({ key: report.key, params: p });
      if (res.error !== null) return setProblems([res.error]);
      setResult({ columns: res.data.columns as ReportColumnView[], rows: res.data.rows as Record<string, unknown>[], truncated: res.data.truncated, rowCap: res.data.rowCap });
    });

  const download = (format: "csv" | "xlsx") =>
    start(async () => {
      const p = params();
      if (!p) return;
      const res = await exportReportAction({ key: report.key, params: p, format });
      if (res.error !== null) return setProblems([res.error]);
      const file = res.data;
      const url = URL.createObjectURL(new Blob([exportBytes(file)], { type: file.contentType }));
      const link = document.createElement("a");
      link.href = url;
      link.download = file.filename;
      link.click();
      URL.revokeObjectURL(url);
      toast.success(`${file.filename}: ${file.rows} rows${file.truncated ? " (cut at the export limit)" : ""}`);
    });

  const toggle = (list: string[], key: string) => (list.includes(key) ? list.filter((k) => k !== key) : [...list, key]);

  return (
    <section aria-labelledby="viewer-title" className="grid gap-4">
      <h2 id="viewer-title" className="text-lg font-semibold">
        {report.label}
      </h2>
      <form
        className="grid gap-4 rounded-xl border bg-card p-4"
        onSubmit={(e) => {
          e.preventDefault();
          run();
        }}
      >
        {report.filters.length > 0 && (
          <div className="flex flex-wrap gap-3">
            {report.filters.map((f) => (
              <div key={f.key} className="grid gap-1.5">
                <Label htmlFor={`rf-${f.key}`}>{f.label}</Label>
                {f.type === "enum" && f.options ? (
                  <FieldSelect id={`rf-${f.key}`} value={form.filters[f.key] ?? ""} onChange={(v) => setForm({ ...form, filters: { ...form.filters, [f.key]: v } })} options={f.options.map((o) => ({ value: o, label: o.replace(/_/g, " ") }))} placeholder="Any" none="Any" className="w-44" />
                ) : (
                  <Input
                    id={`rf-${f.key}`}
                    type={f.type === "date" ? "date" : "text"}
                    inputMode={f.type === "integer" ? "numeric" : undefined}
                    value={form.filters[f.key] ?? ""}
                    onChange={(e) => setForm({ ...form, filters: { ...form.filters, [f.key]: e.target.value } })}
                    placeholder={f.type === "uuid" ? "Id" : undefined}
                    className={f.type === "date" ? "w-auto" : "w-44"}
                  />
                )}
              </div>
            ))}
          </div>
        )}
        {aggregate && (
          <div className="grid gap-3 sm:grid-cols-2">
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Group by</legend>
              {dimensionsOf(report).map((d) => (
                <label key={d.key} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={form.groupBy.includes(d.key)} onCheckedChange={() => setForm({ ...form, groupBy: toggle(form.groupBy, d.key) })} />
                  {d.label}
                </label>
              ))}
              <p className="text-xs text-muted-foreground">Nothing chosen uses the report&apos;s own grouping.</p>
            </fieldset>
            <fieldset className="grid gap-2">
              <legend className="mb-1 text-sm font-medium">Measures</legend>
              {measuresOf(report).map((m) => (
                <label key={m.key} className="flex items-center gap-2 text-sm">
                  <Checkbox checked={form.measures.includes(m.key)} onCheckedChange={() => setForm({ ...form, measures: toggle(form.measures, m.key) })} />
                  {m.label}
                </label>
              ))}
            </fieldset>
          </div>
        )}
        {problems.length > 0 && (
          <ul role="alert" className="grid gap-1 rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending}>
            <PlayIcon />
            {pending ? "Working…" : "Run"}
          </Button>
          {canExport ? (
            <>
              <Button type="button" variant="outline" disabled={pending} onClick={() => download("csv")}>
                <DownloadIcon />
                CSV
              </Button>
              <Button type="button" variant="outline" disabled={pending} onClick={() => download("xlsx")}>
                <DownloadIcon />
                Excel
              </Button>
            </>
          ) : (
            <span className="self-center text-xs text-muted-foreground">Downloading needs permission to export reports.</span>
          )}
        </div>
      </form>

      {result && (
        <div className="grid gap-2">
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
            <span>{result.rows.length} rows</span>
            {result.truncated && <Badge variant="warning">Cut at {result.rowCap} rows: narrow the filters, or download for up to {report.exportRowCap}</Badge>}
          </div>
          <div className="overflow-x-auto rounded-xl border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {result.columns.map((c) => (
                    <TableHead key={c.key} className={isNumeric(c) ? "text-right" : undefined}>
                      {c.label}
                    </TableHead>
                  ))}
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.rows.length === 0 ? (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={Math.max(result.columns.length, 1)} className="h-20 text-center text-muted-foreground">
                      Nothing matches these filters.
                    </TableCell>
                  </TableRow>
                ) : (
                  result.rows.map((row, i) => (
                    <TableRow key={i}>
                      {result.columns.map((c) => (
                        <TableCell key={c.key} className={isNumeric(c) ? "text-right tabular" : undefined}>
                          {formatCell(row[c.key], c, currency, locale, timeZone)}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </div>
      )}
    </section>
  );
}
