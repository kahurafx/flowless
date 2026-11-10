import type { Transaction } from "@flowless/db";
import { ledgerEntry, ledgerTransaction } from "@flowless/db/schema/billing";
import { sql } from "drizzle-orm";
import { readSetting } from "../../kernel/config-store";
import {
  activationSetting,
  registerBalanceTransfer,
  registerGateSource,
  registerTerminationCheck,
  type BalanceTransfer,
  type GateSource,
  type TerminationCheck,
} from "../accounts";
import { registerClosedPeriodSource, type ClosedPeriodSource } from "../tariffs";
import { lockAccount, transactionKeyed } from "./post";
import { accountBalance } from "./reads";
import { organizationCurrency, todayOf } from "./usage";

/*
 * Billing's side of the ports Accounts and Tariffs expose (C-06, C-08, C-11, T-03). Registered
 * once at start-up from `registerKernel`; each Accounts port carries `requires: ["billing"]`,
 * so an organization without Billing is never asked and behaves as before Phase 4 (NF-31).
 * Everything runs inside the caller's tenant transaction and reads only Billing's own tables.
 */

/** C-11: the ledger balance, and whether a live (not reversed) final bill exists. */
export const terminationCheck: TerminationCheck = async (tx, _organizationId, accountId) => {
  const rows = await tx.execute<{ n: string }>(sql`
    select count(*)::text as n from billing.document d
     where d.account_id = ${accountId} and d.final_bill
       and not exists (select 1 from billing.document r where r.organization_id = d.organization_id and r.reverses_document_id = d.id)`);
  return { finalBillIssued: Number(rows[0]?.n ?? 0) > 0, balance: (await accountBalance(tx, accountId)).balance };
};

/**
 * What the account has been invoiced (live invoices and debit notes, less credit notes: the
 * receivable's charge, credit and adjustment postings, with reversals netting out) and what it has paid
 * (the receivable's payment postings and their reversals, as a positive number).
 */
export async function connectionPosition(tx: Transaction, accountId: string): Promise<{ invoiced: bigint; paid: bigint }> {
  const rows = await tx.execute<{ invoiced: string | null; paid: string | null }>(sql`
    select
      sum(case when kind = 'invoiced' then amount else 0 end)::text as invoiced,
      (-sum(case when kind = 'paid' then amount else 0 end))::text as paid
    from (
      select case when t.entry_type in ('payment') or o.entry_type = 'payment' then 'paid'
                  when t.entry_type in ('charge', 'credit', 'adjustment', 'deposit') or o.entry_type in ('charge', 'credit', 'adjustment', 'deposit') then 'invoiced'
                  else 'other' end as kind,
             case e.side when 'debit' then e.amount else -e.amount end as amount
        from billing.ledger_entry e
        join billing.ledger_transaction t on t.organization_id = e.organization_id and t.id = e.transaction_id
        left join billing.ledger_transaction o on o.organization_id = t.organization_id and o.id = t.reverses_transaction_id
       where e.account_id = ${accountId} and e.ledger_account = 'receivable'
    ) x`);
  return { invoiced: BigInt(rows[0]?.invoiced ?? "0"), paid: BigInt(rows[0]?.paid ?? "0") };
}

/** C-06: the payment threshold is met when paid covers the configured share (or fixed amount) of what the account was invoiced. */
export const paymentThresholdSource: GateSource = async (tx, _organizationId, accountId) => {
  const gate = (await readSetting(tx, activationSetting)).value.gates.payment_threshold;
  const { invoiced, paid } = await connectionPosition(tx, accountId);
  if (invoiced <= 0n) return { met: false, detail: "No connection invoice has been issued" };
  const required = gate.basis === "fixed" ? BigInt(gate.fixedAmount) : (invoiced * BigInt(gate.percent) + 99n) / 100n;
  return { met: paid >= required, detail: `Paid ${paid} of ${invoiced} invoiced; ${required} needed` };
};

/**
 * C-08: moves the balance of the old account to its successor by one sealed ledger transaction of
 * paired entries (receivable against `transfer_clearing` on each side; excluded from revenue). A
 * credit balance moves the other way. Idempotent on the command id; a zero balance posts nothing.
 */
export const balanceTransfer: BalanceTransfer = async (tx, organizationId, request) => {
  const key = `transfer:${request.commandId}`;
  for (const id of [request.fromAccountId, request.toAccountId].sort()) await lockAccount(tx, id);
  if (await transactionKeyed(tx, key)) return;
  const balance = (await accountBalance(tx, request.fromAccountId)).balance;
  if (balance === 0n) return;
  const amount = balance < 0n ? -balance : balance;
  // Owing: the old account's receivable is credited, the new one's debited. A credit moves the other way.
  const [reduce, raise] = balance > 0n ? (["credit", "debit"] as const) : (["debit", "credit"] as const);
  const other = (side: "debit" | "credit") => (side === "debit" ? ("credit" as const) : ("debit" as const));
  const currency = await organizationCurrency(tx);
  const [header] = await tx
    .insert(ledgerTransaction)
    .values({
      organizationId,
      entryType: "transfer",
      currency,
      entryCount: 4,
      effectiveOn: await todayOf(tx),
      sourceRef: request.commandId,
      idempotencyKey: key,
      description: "Balance transferred on succession",
    })
    .returning({ id: ledgerTransaction.id });
  const entry = (lineNo: number, accountId: string, side: "debit" | "credit", ledgerAccount: "receivable" | "transfer_clearing") => ({
    organizationId,
    transactionId: header!.id,
    lineNo,
    currency,
    side,
    amount,
    ledgerAccount,
    accountId,
    chargeType: "transfer" as const,
  });
  await tx.insert(ledgerEntry).values([
    entry(0, request.fromAccountId, reduce, "receivable"),
    entry(1, request.fromAccountId, other(reduce), "transfer_clearing"),
    entry(2, request.toAccountId, raise, "receivable"),
    entry(3, request.toAccountId, other(raise), "transfer_clearing"),
  ]);
};

/** T-03, B-15: the last day of the latest period billed (live documents, not reversed); a tariff change on or before it is refused. */
export const closedPeriodSource: ClosedPeriodSource = async (tx) => {
  const rows = await tx.execute<{ through: string | null }>(sql`
    select max(d.period_to)::text as through from billing.document d
     where d.kind <> 'reversal' and d.period_to is not null
       and not exists (select 1 from billing.document r where r.organization_id = d.organization_id and r.reverses_document_id = d.id)`);
  const through = rows[0]?.through;
  return through ? new Date(`${through}T00:00:00Z`) : null;
};

/** Registers all of Billing's ports; called by `registerKernel`, replaces earlier registrations. */
export function registerPorts(): void {
  registerTerminationCheck(terminationCheck, { requires: ["billing"] });
  registerGateSource("payment_threshold", paymentThresholdSource, { requires: ["billing"] });
  registerBalanceTransfer(balanceTransfer, { requires: ["billing"] });
  registerClosedPeriodSource(closedPeriodSource);
}
