import { DOCUMENT_KINDS, REVENUE_CASE_KINDS } from "@flowless/db/schema/billing";
import { sql } from "drizzle-orm";
import { accountScope, dateFilter, defineAggregateReport, defineListReport, enumFilter, intFilter, textFilter, uuidFilter, type FilterDef } from "../../kernel/report-builder";
import { listableAccounts } from "./scope";

/*
 * Billing's reports (X-01, X-03): parameterized, metadata-driven (dimensions, measures, filters,
 * row caps), read from the append-only documents, ledger and cycle tables, never from stored
 * totals. Each is confined to the accounts the member may see (K-03), needs `billing:read` and
 * a licence for Billing (the engine checks both), and is planned by the X-04 guard in CI and
 * run by the isolation canary. Money columns are bigint minor units.
 */

const PERMISSIONS = ["billing:read"] as const;
const CYCLE_STATES = ["open", "reading_window", "validation", "estimation", "calculation", "review", "issue", "deliver", "completeness", "closed"] as const;
const scopeOn = (column: ReturnType<typeof sql.raw>) => accountScope(column, (ctx) => listableAccounts(ctx.tx, { userId: ctx.userId, scope: ctx.scope }));

const ym = (column: string) => sql.raw(`to_char(${column}, 'YYYY-MM')`);

/* ---------- billing register ---------- */

const documentStatus = sql`case when d.kind = 'reversal' then 'reversal' when rv.id is not null then 'reversed' when d.replaces_document_id is not null then 'replacement' else 'live' end`;

export const billingRegister = defineAggregateReport({
  key: "billing.register",
  module: "billing",
  label: "Billing register",
  permissions: PERMISSIONS,
  from: sql`billing.document d left join billing.document rv on rv.organization_id = d.organization_id and rv.reverses_document_id = d.id`,
  dimensions: [
    { key: "period", label: "Month issued", type: "text", expr: ym("d.issued_on") },
    { key: "kind", label: "Type", type: "text", expr: sql`d.kind` },
    { key: "status", label: "Status", type: "text", expr: documentStatus },
    { key: "invoiceTypeId", label: "Invoice type", type: "text", expr: sql`d.invoice_type_id::text` },
    { key: "source", label: "Source", type: "text", expr: sql`d.source` },
    { key: "accountId", label: "Account", type: "text", expr: sql`d.account_id::text` },
  ],
  measures: [
    { key: "documents", label: "Documents", type: "integer", expr: sql`count(*)::int` },
    { key: "total", label: "Total", type: "money", expr: sql`coalesce(sum(d.total), 0)` },
  ],
  defaultGroupBy: ["period", "kind", "status"],
  filters: [
    dateFilter("from", "Issued from", (v) => sql`d.issued_on >= ${v}::date`),
    dateFilter("to", "Issued to", (v) => sql`d.issued_on <= ${v}::date`),
    enumFilter("kind", "Type", DOCUMENT_KINDS, (v) => sql`d.kind = ${v}`),
    enumFilter("status", "Status", ["live", "reversed", "reversal", "replacement"] as const, (v) => sql`(${documentStatus}) = ${v}`),
  ],
  scope: scopeOn(sql.raw("d.account_id")),
});

/* ---------- receivables aging ---------- */

/**
 * What each account owes, split by the age of the charges that make it up. Payments and credits
 * settle the oldest charges first (the usual rule until Payments allocates), so the balance is
 * carried by the newest debits: a debit's outstanding part is what remains of the balance after
 * the newer debits, capped at the debit itself. Accounts in credit owe nothing and are left out.
 */
const agingFrom = (p: Record<string, unknown>) => {
  const asOf = (p.asOf as string | undefined) ?? null;
  return sql`(
    with entries as (
      select e.id, e.account_id, e.zone_id, e.category_id, t.effective_on, e.side, e.amount
        from billing.ledger_entry e
        join billing.ledger_transaction t on t.organization_id = e.organization_id and t.id = e.transaction_id
       where e.ledger_account = 'receivable' and t.effective_on <= coalesce(${asOf}::date, current_date)
    ), balances as (
      select account_id, sum(case side when 'debit' then amount else -amount end) as balance from entries group by account_id
    ), debits as (
      select en.*, sum(en.amount) over (partition by en.account_id order by en.effective_on desc, en.id desc rows between unbounded preceding and 1 preceding) as newer
        from entries en where en.side = 'debit'
    )
    select d.account_id, d.zone_id, d.category_id,
           case when coalesce(${asOf}::date, current_date) - d.effective_on <= 30 then '0-30'
                when coalesce(${asOf}::date, current_date) - d.effective_on <= 60 then '31-60'
                when coalesce(${asOf}::date, current_date) - d.effective_on <= 90 then '61-90' else '90+' end as bucket,
           least(d.amount, greatest(b.balance - coalesce(d.newer, 0), 0)) as outstanding
      from debits d join balances b on b.account_id = d.account_id
     where b.balance > 0
  ) ag`;
};

export const receivablesAging = defineAggregateReport({
  key: "billing.receivables_aging",
  module: "billing",
  label: "Receivables aging",
  permissions: PERMISSIONS,
  from: agingFrom,
  baseWhere: sql`ag.outstanding > 0`,
  dimensions: [
    { key: "bucket", label: "Age (days)", type: "text", expr: sql`ag.bucket` },
    { key: "zoneId", label: "Zone", type: "text", expr: sql`ag.zone_id::text` },
    { key: "categoryId", label: "Category", type: "text", expr: sql`ag.category_id::text` },
    { key: "accountId", label: "Account", type: "text", expr: sql`ag.account_id::text` },
  ],
  measures: [
    { key: "outstanding", label: "Outstanding", type: "money", expr: sql`coalesce(sum(ag.outstanding), 0)` },
    { key: "accounts", label: "Accounts", type: "integer", expr: sql`count(distinct ag.account_id)::int` },
  ],
  defaultGroupBy: ["bucket"],
  filters: [
    dateFilter("asOf", "As of", () => sql`true`),
    uuidFilter("zoneId", "Zone", (v) => sql`ag.zone_id = ${v}::uuid`),
    uuidFilter("categoryId", "Category", (v) => sql`ag.category_id = ${v}::uuid`),
  ],
  scope: scopeOn(sql.raw("ag.account_id")),
});

/* ---------- cycles ---------- */

/** One row per account of a cycle, with its newest outcome. */
const cycleOutcomes = sql`billing.cycle c
  join billing.cycle_account ca on ca.organization_id = c.organization_id and ca.cycle_id = c.id
  left join lateral (
    select o.outcome, o.reason, o.exception_id, o.document_id
      from billing.cycle_outcome o
     where o.organization_id = ca.organization_id and o.cycle_id = ca.cycle_id and o.account_id = ca.account_id
     order by o.seq desc limit 1
  ) o on true`;

const cycleFilters: FilterDef[] = [
  textFilter("period", "Period (YYYY-MM)", (v) => sql`c.period = ${v}`),
  uuidFilter("routeId", "Route", (v) => sql`c.route_id = ${v}::uuid`),
  enumFilter("state", "Cycle state", CYCLE_STATES, (v) => sql`c.state = ${v}`),
];

export const cycleCompleteness = defineAggregateReport({
  key: "billing.cycle_completeness",
  module: "billing",
  label: "Billing cycle completeness",
  permissions: PERMISSIONS,
  from: cycleOutcomes,
  dimensions: [
    { key: "period", label: "Period", type: "text", expr: sql`c.period` },
    { key: "cycleId", label: "Cycle", type: "text", expr: sql`c.id::text` },
    { key: "routeId", label: "Route", type: "text", expr: sql`c.route_id::text` },
    { key: "state", label: "Cycle state", type: "text", expr: sql`c.state` },
  ],
  measures: [
    { key: "accounts", label: "Accounts looked at", type: "integer", expr: sql`count(*)::int` },
    { key: "expected", label: "Expected", type: "integer", expr: sql`(count(*) filter (where ca.expected))::int` },
    { key: "billed", label: "Billed", type: "integer", expr: sql`(count(*) filter (where ca.expected and o.outcome = 'billed'))::int` },
    { key: "billedEstimate", label: "Billed on estimate", type: "integer", expr: sql`(count(*) filter (where ca.expected and o.outcome = 'billed_estimate'))::int` },
    { key: "exception", label: "In exception", type: "integer", expr: sql`(count(*) filter (where ca.expected and o.outcome = 'exception'))::int` },
    { key: "excluded", label: "Excluded", type: "integer", expr: sql`(count(*) filter (where ca.expected and o.outcome = 'excluded'))::int` },
    { key: "unexplained", label: "Unexplained", type: "integer", expr: sql`(count(*) filter (where ca.expected and o.outcome is null))::int` },
  ],
  defaultGroupBy: ["period", "cycleId", "routeId", "state"],
  filters: cycleFilters,
  scope: scopeOn(sql.raw("ca.account_id")),
});

export const unbilledAccounts = defineListReport({
  key: "billing.unbilled_accounts",
  module: "billing",
  label: "Unbilled accounts",
  permissions: PERMISSIONS,
  from: cycleOutcomes,
  baseWhere: sql`ca.expected and (o.outcome is null or o.outcome in ('exception', 'excluded'))`,
  columns: [
    { key: "period", label: "Period", type: "text", expr: sql`c.period` },
    { key: "cycleId", label: "Cycle", type: "text", expr: sql`c.id::text` },
    { key: "routeId", label: "Route", type: "text", expr: sql`c.route_id::text` },
    { key: "cycleState", label: "Cycle state", type: "text", expr: sql`c.state` },
    { key: "accountId", label: "Account", type: "text", expr: sql`ca.account_id::text` },
    { key: "status", label: "Status", type: "text", expr: sql`coalesce(o.outcome, 'no_outcome')` },
    { key: "reason", label: "Reason", type: "text", expr: sql`o.reason` },
    { key: "exceptionId", label: "Exception", type: "text", expr: sql`o.exception_id::text` },
  ],
  filters: [...cycleFilters, enumFilter("status", "Status", ["no_outcome", "exception", "excluded"] as const, (v) => sql`coalesce(o.outcome, 'no_outcome') = ${v}`)],
  orderBy: sql`c.period desc, c.route_id, ca.account_id`,
  scope: scopeOn(sql.raw("ca.account_id")),
});

export const estimatesShare = defineAggregateReport({
  key: "billing.estimates_share",
  module: "billing",
  label: "Estimates share by route",
  permissions: PERMISSIONS,
  from: cycleOutcomes,
  baseWhere: sql`ca.expected and o.outcome in ('billed', 'billed_estimate')`,
  dimensions: [
    { key: "period", label: "Period", type: "text", expr: sql`c.period` },
    { key: "routeId", label: "Route", type: "text", expr: sql`c.route_id::text` },
  ],
  measures: [
    { key: "bills", label: "Bills", type: "integer", expr: sql`count(*)::int` },
    { key: "estimated", label: "On estimate", type: "integer", expr: sql`(count(*) filter (where o.outcome = 'billed_estimate'))::int` },
    { key: "sharePercent", label: "Estimate share (%)", type: "percent", expr: sql`round(100.0 * count(*) filter (where o.outcome = 'billed_estimate') / nullif(count(*), 0), 1)::text` },
  ],
  defaultGroupBy: ["period", "routeId"],
  filters: cycleFilters.slice(0, 2),
  scope: scopeOn(sql.raw("ca.account_id")),
});

/* ---------- cases and corrections ---------- */

const caseDecisions = ["no_action", "false_positive", "back_billed", "penalty_applied", "referred"] as const;

export const revenueCases = defineListReport({
  key: "billing.revenue_cases",
  module: "billing",
  label: "Revenue-protection case register",
  permissions: PERMISSIONS,
  from: sql`billing.revenue_case oc
    left join lateral (select r.decision, r.created_at, r.document_id from billing.revenue_case r
                        where r.organization_id = oc.organization_id and r.case_id = oc.case_id and r.event = 'resolved' limit 1) res on true
    left join lateral (select count(*)::int as n from billing.revenue_case v
                        where v.organization_id = oc.organization_id and v.case_id = oc.case_id and v.event = 'evidence') ev on true`,
  baseWhere: sql`oc.event = 'opened'`,
  columns: [
    { key: "caseId", label: "Case", type: "text", expr: sql`oc.case_id::text` },
    { key: "kind", label: "Kind", type: "text", expr: sql`oc.kind` },
    { key: "accountId", label: "Account", type: "text", expr: sql`oc.account_id::text` },
    { key: "title", label: "Title", type: "text", expr: sql`oc.title` },
    { key: "status", label: "Status", type: "text", expr: sql`case when res.created_at is null then 'open' else 'resolved' end` },
    { key: "decision", label: "Decision", type: "text", expr: sql`res.decision` },
    { key: "evidence", label: "Evidence items", type: "integer", expr: sql`ev.n` },
    { key: "openedAt", label: "Opened", type: "timestamp", expr: sql`oc.created_at` },
    { key: "resolvedAt", label: "Resolved", type: "timestamp", expr: sql`res.created_at` },
    { key: "backBillDocumentId", label: "Back-billing document", type: "text", expr: sql`res.document_id::text` },
  ],
  filters: [
    enumFilter("kind", "Kind", REVENUE_CASE_KINDS, (v) => sql`oc.kind = ${v}`),
    enumFilter("status", "Status", ["open", "resolved"] as const, (v) => sql`(res.created_at is not null) = ${v === "resolved"}`),
    enumFilter("decision", "Decision", caseDecisions, (v) => sql`res.decision = ${v}`),
    dateFilter("from", "Opened from", (v) => sql`oc.created_at >= ${v}::date`),
    dateFilter("to", "Opened to", (v) => sql`oc.created_at < (${v}::date + 1)`),
  ],
  orderBy: sql`oc.created_at desc, oc.case_id`,
  scope: scopeOn(sql.raw("oc.account_id")),
});

export const correctionsRegister = defineListReport({
  key: "billing.corrections",
  module: "billing",
  label: "Correction register",
  permissions: PERMISSIONS,
  from: sql`billing.document d left join billing.document o on o.organization_id = d.organization_id and o.id = d.related_document_id`,
  baseWhere: sql`(d.idempotency_key like 'correction:%' or d.idempotency_key like 'backbill:%')`,
  columns: [
    { key: "number", label: "Number", type: "text", expr: sql`d.number` },
    { key: "type", label: "Type", type: "text", expr: sql`case when d.idempotency_key like 'backbill:%' then 'back_billing' else 'correction' end` },
    { key: "kind", label: "Document", type: "text", expr: sql`d.kind` },
    { key: "accountId", label: "Account", type: "text", expr: sql`d.account_id::text` },
    { key: "originalNumber", label: "Corrects", type: "text", expr: sql`o.number` },
    { key: "periodFrom", label: "From", type: "date", expr: sql`d.period_from::text` },
    { key: "periodTo", label: "To", type: "date", expr: sql`d.period_to::text` },
    { key: "issuedOn", label: "Issued", type: "date", expr: sql`d.issued_on::text` },
    { key: "total", label: "Total", type: "money", expr: sql`d.total` },
  ],
  filters: [
    dateFilter("from", "Issued from", (v) => sql`d.issued_on >= ${v}::date`),
    dateFilter("to", "Issued to", (v) => sql`d.issued_on <= ${v}::date`),
    intFilter("minAbsTotal", "Minimum size (minor units)", (v) => sql`abs(d.total) >= ${v}`),
  ],
  orderBy: sql`d.issued_on desc, d.number`,
  scope: scopeOn(sql.raw("d.account_id")),
});

export const billingReports = [billingRegister, receivablesAging, cycleCompleteness, unbilledAccounts, estimatesShare, revenueCases, correctionsRegister];
