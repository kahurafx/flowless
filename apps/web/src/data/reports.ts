import { connection } from "next/server";
import { getApi, requirePermission } from "./session";

/**
 * The reports the member may run (X-01): licensed modules only, and only those whose own
 * permissions they hold (the API filters). Running needs `reports:read`, downloading `reports:export`.
 */
export async function getReportsPage() {
  await connection();
  const session = await requirePermission("reports:read");
  const { api } = await getApi();
  const reports = await api.reports.list();
  return {
    reports: reports.map((r) => ({
      key: r.key,
      label: r.label,
      module: r.module,
      columns: r.columns.map((c) => ({ key: c.key, label: c.label, type: c.type, role: c.role })),
      filters: r.filters.map((f) => ({ key: f.key, label: f.label, type: f.type, options: f.options })),
      rowCap: r.rowCap,
      exportRowCap: r.exportRowCap,
    })),
    canExport: session.access.permissions.includes("reports:export"),
    currency: session.organization.settings.currency,
    locale: session.organization.settings.locale,
    timeZone: session.organization.settings.timeZone,
  };
}
