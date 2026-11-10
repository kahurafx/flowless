import { periodFromIndex, periodIndex, type TariffVersion } from "@flowless/billing-engine";
import { bandsFor, validateTariffContent } from "../tariffs";
import { TARIFF_TYPES } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { sql } from "drizzle-orm";
import { z } from "zod";
import type { ActionEnv } from "../../kernel/action-env";
import { readSetting } from "../../kernel/config-store";
import { routeServicePointFacts } from "../accounts";
import { periodOf } from "./mapping";
import { billingPolicySetting } from "./settings";
import { simulate, type SimSpan, type SimulationResult } from "./simulation-core";
import { organizationCurrency, pricing } from "./usage";

/*
 * Tariff simulation (T-06): what the last N billed consumption spans of a selection of accounts
 * would have cost under a draft tariff, against the tariff in force in each span's months. It is
 * a read: no documents, no ledger entries, no exceptions. The draft is checked with Tariffs'
 * published `validateTariffContent`; the tariff in force comes from Tariffs' published reads
 * (`pricing`); spans come from Billing's own documents (live, not reversed, usage lines).
 */

export const SIMULATION_CAP = 1000;

export const simulationInputSchema = z
  .object({
    /** The draft: a tariff type and its content, as the Tariffs form would save it. Flat rates are not priced by usage. */
    draft: z.object({ type: z.enum(TARIFF_TYPES), content: z.unknown() }),
    /** The selection: explicit accounts, a route, a category (all may combine), at most `cap` accounts. */
    accountIds: z.array(z.uuid()).max(SIMULATION_CAP).optional(),
    routeId: z.uuid().optional(),
    categoryId: z.uuid().optional(),
    cap: z.number().int().min(1).max(SIMULATION_CAP).default(200),
    /** How many of each account's newest billed spans to price. */
    spansPerAccount: z.number().int().min(1).max(24).default(3),
    topMovers: z.number().int().min(1).max(50).default(10),
  })
  .refine((i) => i.accountIds?.length || i.routeId || i.categoryId, { message: "Choose accounts, a route or a category to simulate" });
export type SimulationInput = z.infer<typeof simulationInputSchema>;

type SpanRow = {
  account_id: string;
  document_id: string;
  position: number;
  service_from: string;
  service_to: string;
  units: number;
  amount: string;
  category_id: string | null;
};

const idList = (ids: readonly string[]) => sql`(select value::uuid from jsonb_array_elements_text(${JSON.stringify(ids)}::jsonb))`;

/**
 * `visible` is the viewer's scope as account ids (undefined: unrestricted). Nothing is written.
 */
export async function runSimulation(env: ActionEnv, input: SimulationInput, visible: string[] | undefined) {
  const check = validateTariffContent({ type: input.draft.type, flatBasis: "none" }, input.draft.content);
  if (!check.ok) throw new TRPCError({ code: "BAD_REQUEST", message: `The draft tariff is not valid: ${check.problems.join("; ")}` });
  if (check.content.type === "flat_rate") throw new TRPCError({ code: "BAD_REQUEST", message: "A flat-rate tariff does not price consumption, so it cannot be simulated on billed units" });
  const draftBands = bandsFor(check.content).map((b) => ({ upTo: b.to, rate: b.rate }));

  // The selection, narrowed to what the viewer may see.
  let ids: string[] | undefined = input.accountIds ? [...new Set(input.accountIds)] : undefined;
  if (input.routeId) {
    const onRoute = new Set((await routeServicePointFacts(env.tx, input.routeId)).map((f) => f.accountId));
    ids = ids ? ids.filter((id) => onRoute.has(id)) : [...onRoute];
  }
  if (visible) {
    const allowed = new Set(visible);
    ids = ids ? ids.filter((id) => allowed.has(id)) : undefined;
  }
  if (ids && ids.length === 0) return emptyResult(env, input, false);

  const rows = await env.tx.execute<SpanRow>(sql`
    with line as (
      select d.account_id, dl.document_id, dl.position, dl.service_from::text as service_from, dl.service_to::text as service_to,
             (dl.calculation->>'units')::int as units, dl.amount::text as amount, d.created_at,
             (select e.category_id from billing.ledger_entry e
               where e.organization_id = dl.organization_id and e.document_id = dl.document_id and e.document_line_position = dl.position
                 and e.category_id is not null limit 1) as category_id
        from billing.document_line dl
        join billing.document d on d.organization_id = dl.organization_id and d.id = dl.document_id
       where d.kind = 'invoice' and dl.line_type = 'consumption' and dl.calculation->>'code' in ('USAGE', 'USAGE_EST')
         and dl.service_from is not null and (dl.calculation->>'units') is not null
         ${ids ? sql`and d.account_id in ${idList(ids)}` : sql``}
         ${visible && !ids ? sql`and d.account_id in ${idList(visible)}` : sql``}
         and not exists (select 1 from billing.document r where r.organization_id = d.organization_id and r.reverses_document_id = d.id)
    ), picked as (
      select * from line ${input.categoryId ? sql`where category_id = ${input.categoryId}` : sql``}
    ), accounts as (
      select distinct account_id from picked order by account_id limit ${input.cap + 1}
    ), ranked as (
      select p.*, row_number() over (partition by p.account_id order by p.service_to desc, p.created_at desc, p.position) as rn
        from picked p where p.account_id in (select account_id from accounts)
    )
    select account_id::text, document_id::text, position, service_from, service_to, units, amount, category_id::text
      from ranked where rn <= ${input.spansPerAccount} order by account_id, service_to desc, position`);

  const accountIds = [...new Set(rows.map((r) => r.account_id))];
  const truncated = accountIds.length > input.cap;
  const keep = new Set(accountIds.slice(0, input.cap));
  const spans: SimSpan[] = rows
    .filter((r) => keep.has(r.account_id))
    .map((r) => ({
      accountId: r.account_id,
      categoryId: r.category_id,
      lineKey: `${r.document_id}:${r.position}`,
      from: periodIndex(periodOf(r.service_from)) - 1,
      to: periodIndex(periodOf(r.service_to)),
      units: r.units,
      billed: BigInt(r.amount),
    }));

  // The tariff in force for each category over the months its spans cover (flat-rate current tariffs cannot price units).
  const current = new Map<string, TariffVersion[]>();
  for (const categoryId of new Set(spans.flatMap((s) => (s.categoryId ? [s.categoryId] : [])))) {
    const mine = spans.filter((s) => s.categoryId === categoryId);
    const first = Math.min(...mine.map((s) => s.from + 1));
    const last = Math.max(...mine.map((s) => s.to));
    const months = Array.from({ length: last - first + 1 }, (_, i) => periodFromIndex(first + i));
    try {
      const priced = await pricing(env, categoryId, months, false);
      current.set(
        categoryId,
        priced.map((m) => ({ id: m.tariffVersionId, from: m.period, standing: 0n, bands: m.bands.map((b) => ({ upTo: b.to, rate: b.rate })) })),
      );
    } catch (error) {
      if (!(error instanceof TRPCError)) throw error;
    }
  }

  const policy = (await readSetting(env.tx, billingPolicySetting)).value;
  const result = simulate({ spans, current, draftBands, scaling: policy.tierScaling, topN: input.topMovers });
  return present(await organizationCurrency(env.tx), input, truncated, result);
}

async function emptyResult(env: ActionEnv, input: SimulationInput, truncated: boolean) {
  return present(await organizationCurrency(env.tx), input, truncated, simulate({ spans: [], current: new Map(), draftBands: [], scaling: "by_period" }));
}

function present(currency: string, input: SimulationInput, truncated: boolean, result: SimulationResult) {
  return {
    currency,
    spansPerAccount: input.spansPerAccount,
    cap: input.cap,
    /** More accounts matched than the cap; the first `cap` by account id were priced. */
    truncated,
    ...result,
  };
}
