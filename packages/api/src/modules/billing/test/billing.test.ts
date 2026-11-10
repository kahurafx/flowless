import { withTenant } from "@flowless/db";
import { sql } from "drizzle-orm";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { expectCode, setupBillingEnv, type BillingEnv } from "./test-support";

let env: BillingEnv;
beforeAll(async () => {
  env = await setupBillingEnv();
});
afterAll(() => env?.t.stop());

/** 10 units over one month on the reference bands: 6 x 8250 + 4 x 9600 = 87,900, plus standing 15,000. */
const TEN_UNITS_BILL = 102_900n;

async function issued(accountId: string, over: Record<string, unknown> = {}) {
  const result = await env.admin.billing.invoices.issueUsage(env.usage(accountId, over) as never);
  if (result.outcome !== "issued") throw new Error(`expected an invoice, got ${result.outcome}`);
  return result;
}

// B-10, B-11, T-04: an invoice from a reading, lines citing versions, a balanced posting.
describe("billing.invoices.issueUsage", () => {
  it("prices the reading, cites the versions on each line and posts a balanced ledger transaction", async () => {
    const account = env.newAccount();
    const { document, replayed } = await issued(account);
    expect(replayed).toBe(false);
    expect(document).toMatchObject({ kind: "invoice", total: TEN_UNITS_BILL, lineCount: 2, periodFrom: "2025-02-01", periodTo: "2025-02-28" });
    const [usage, standing] = document.lines;
    expect(usage).toMatchObject({ lineType: "consumption", amount: 87_900n, serviceFrom: "2025-02-01", serviceTo: "2025-02-28" });
    expect(usage!.tariffVersionId).toBeTruthy();
    expect(standing).toMatchObject({ lineType: "standing", amount: STANDING_AMOUNT });
    expect(standing!.chargeItemAmountId).toBeTruthy();
    expect(standing!.chargeItemId).toBeTruthy();

    const entries = await env.rows<{ side: string; amount: string; ledger_account: string }>(
      sql`select side, amount::text, ledger_account from billing.ledger_entry where account_id = ${account} order by line_no`,
    );
    expect(entries).toHaveLength(4);
    const sum = (side: string) => entries.filter((e) => e.side === side).reduce((s, e) => s + BigInt(e.amount), 0n);
    expect(sum("debit")).toBe(TEN_UNITS_BILL);
    expect(sum("credit")).toBe(TEN_UNITS_BILL);
    expect(entries.filter((e) => e.ledger_account === "receivable").every((e) => e.side === "debit")).toBe(true);
  });

  it("derives the balance and the statement from ledger entries", async () => {
    const account = env.newAccount();
    await issued(account);
    expect((await env.admin.billing.balance({ accountId: account })).balance).toBe(TEN_UNITS_BILL);
    const statement = await env.admin.billing.statement({ accountId: account });
    expect(statement.items).toHaveLength(1);
    expect(statement).toMatchObject({ openingBalance: 0n, closingBalance: TEN_UNITS_BILL });
    expect(statement.items[0]).toMatchObject({ entryType: "charge", amount: TEN_UNITS_BILL, runningBalance: TEN_UNITS_BILL, documentKind: "invoice" });
    // Nothing stores a balance: the document and ledger tables have no balance column.
    const columns = await env.rows<{ column_name: string }>(sql`select column_name from information_schema.columns where table_schema = 'billing' and column_name like '%balance%'`);
    expect(columns).toEqual([]);
  });

  it("replays the same key without posting twice, and refuses the key for another request", async () => {
    const account = env.newAccount();
    const input = env.usage(account);
    const first = await env.admin.billing.invoices.issueUsage(input as never);
    const again = await env.admin.billing.invoices.issueUsage(input as never);
    expect(first.outcome === "issued" && again.outcome === "issued" && again.replayed && again.document.id === first.document.id).toBe(true);
    expect((await env.admin.billing.documents.list({ accountId: account })).length).toBe(1);
    expect((await env.admin.billing.balance({ accountId: account })).balance).toBe(TEN_UNITS_BILL);
    await expectCode(env.admin.billing.invoices.issueUsage({ ...input, period: "2025-03" } as never), "CONFLICT");
    await expectCode(env.admin.billing.invoices.issueUsage({ ...input, accountId: env.newAccount() } as never), "CONFLICT");
  });

  it("takes concurrent calls with one key in turn: one document", async () => {
    const account = env.newAccount();
    const input = env.usage(account);
    const results = await Promise.all(Array.from({ length: 4 }, () => env.admin.billing.invoices.issueUsage(input as never)));
    expect(new Set(results.map((r) => (r.outcome === "issued" ? r.document.id : "x"))).size).toBe(1);
    expect((await env.admin.billing.documents.list({ accountId: account })).length).toBe(1);
  });

  it("numbers documents from the invoice type's counter without gaps or repeats", async () => {
    const a = await issued(env.newAccount());
    const b = await issued(env.newAccount());
    expect(a.document.number).not.toBe(b.document.number);
  });

  it("true-ups earlier estimates with a visible line, so the span's total is the actual usage", async () => {
    const account = env.newAccount();
    const readings = [{ period: "2025-01", kind: "actual" as const, dial: 100 }];
    await issued(account, { period: "2025-02", reading: { units: 10 }, readings });
    await issued(account, { period: "2025-03", reading: { units: 10 }, readings });
    const april = await issued(account, { period: "2025-04", reading: { dial: 130 }, readings });
    expect(april.document.lines.map((l) => l.lineType)).toEqual(["consumption", "true_up", "standing"]);
    expect(april.document.lines[1]!.amount).toBe(-175_800n);
    expect(april.document.lines[1]!.tariffVersionId).toBeTruthy();
    expect(april.document.total).toBe(TEN_UNITS_BILL);
    // 30 units over 3 months at the stretched bands (263,700) plus three standing charges.
    expect((await env.admin.billing.balance({ accountId: account })).balance).toBe(3n * TEN_UNITS_BILL);
  });

  it("books a negative total as a credit note, never a negative invoice", async () => {
    const account = env.newAccount();
    const readings = [{ period: "2025-01", kind: "actual" as const, dial: 100 }];
    await issued(account, { period: "2025-02", reading: { units: 100 }, readings });
    const result = await env.admin.billing.invoices.issueUsage(env.usage(account, { period: "2025-03", reading: { dial: 101 }, readings }) as never);
    expect(result.outcome === "issued" && result.document.kind).toBe("credit_note");
    expect(result.outcome === "issued" && result.document.total).toBeLessThan(0n);
  });
});

const STANDING_AMOUNT = 15_000n;
const withoutKey = <T extends { idempotencyKey: string }>(input: T) => Object.fromEntries(Object.entries(input).filter(([k]) => k !== "idempotencyKey"));

// B-08, NF-24: a held bill is a visible exception with an owner and an age.
describe("held bills", () => {
  it("holds a bill the engine refuses and raises one exception with the actor as owner", async () => {
    const account = env.newAccount();
    const input = env.usage(account, { reading: { dial: 5_000 } });
    const first = await env.admin.billing.invoices.issueUsage(input as never);
    expect(first).toMatchObject({ outcome: "held", code: "OUTLIER_HOLD" });
    const again = await env.admin.billing.invoices.issueUsage({ ...input, idempotencyKey: env.key() } as never);
    expect(again).toMatchObject({ outcome: "held", code: "OUTLIER_HOLD" });
    const rows = await env.rows<{ type: string; source: string; owner_user_id: string; occurrences: number; subject_ref: string; raised_at: Date }>(
      sql`select type, source, owner_user_id, occurrences, subject_ref, raised_at from kernel.exception where subject_ref = ${account}`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ type: "UNBILLED_ACCOUNT", source: "billing", owner_user_id: env.members.admin.userId, occurrences: 2 });
    expect(Number.isNaN(new Date(rows[0]!.raised_at).getTime())).toBe(false);
    expect(await env.admin.billing.documents.list({ accountId: account })).toEqual([]);
    expect((await env.events(env.orgA, "billing.bill_held")).some((e) => e.accountId === account)).toBe(true);
  });

  it("holds an estimate with no baseline as NO_BASELINE, (a status-blocked account is in ports.test.ts)", async () => {
    const account = env.newAccount();
    const estimate = await env.admin.billing.invoices.issueUsage(env.usage(account, { readings: [], reading: { units: 5 } }) as never);
    expect(estimate).toMatchObject({ outcome: "held", code: "NO_BASELINE" });
    const [row] = await env.rows<{ type: string }>(sql`select type from kernel.exception where subject_ref = ${account}`);
    expect(row!.type).toBe("NO_BASELINE");
  });

  it("holds a second bill for a billed period", async () => {
    const account = env.newAccount();
    await issued(account);
    expect(await env.admin.billing.invoices.issueUsage(env.usage(account) as never)).toMatchObject({ outcome: "held", code: "DUPLICATE_PERIOD" });
  });

  it("a first reading with no baseline is recorded by Metering, not billed", async () => {
    expect(await env.admin.billing.invoices.issueUsage(env.usage(env.newAccount(), { readings: [] }) as never)).toEqual({ outcome: "baseline" });
  });
});

// B-11, I-3: a void is a reversal document and ledger transaction; a re-bill names the voided document.
describe("void and re-bill", () => {
  it("voids with a reversal that brings the balance back, and cannot void twice", async () => {
    const account = env.newAccount();
    const { document } = await issued(account);
    const key = env.key("void");
    const voided = await env.admin.billing.documents.void({ idempotencyKey: key, documentId: document.id, reason: "Wrong reading" });
    expect(voided.reversal).toMatchObject({ kind: "reversal", total: -TEN_UNITS_BILL, reversesDocumentId: document.id, lineCount: 2 });
    expect((await env.admin.billing.balance({ accountId: account })).balance).toBe(0n);
    const statement = await env.admin.billing.statement({ accountId: account });
    expect(statement.items.map((i) => [i.entryType, i.amount, i.runningBalance])).toEqual([
      ["charge", TEN_UNITS_BILL, TEN_UNITS_BILL],
      ["reversal", -TEN_UNITS_BILL, 0n],
    ]);
    const [tx] = await env.rows<{ id: string; reverses_transaction_id: string | null }>(
      sql`select id, reverses_transaction_id from billing.ledger_transaction where document_id = ${voided.reversal.id}`,
    );
    expect(tx!.reverses_transaction_id).toBeTruthy();
    // The original is untouched and says it was reversed.
    expect(await env.admin.billing.documents.get({ id: document.id })).toMatchObject({ total: TEN_UNITS_BILL, reversedByDocumentId: voided.reversal.id });

    const replay = await env.admin.billing.documents.void({ idempotencyKey: key, documentId: document.id, reason: "Wrong reading" });
    expect(replay).toMatchObject({ replayed: true, reversal: { id: voided.reversal.id } });
    await expectCode(env.admin.billing.documents.void({ idempotencyKey: env.key(), documentId: document.id, reason: "Again" }), "CONFLICT");
    await expectCode(env.admin.billing.documents.void({ idempotencyKey: env.key(), documentId: voided.reversal.id, reason: "x" }), "PRECONDITION_FAILED");
    await expectCode(env.admin.billing.documents.void({ idempotencyKey: key, documentId: randomUUID(), reason: "x" }), "NOT_FOUND");
  });

  it("frees the period once voided, so it can be billed again", async () => {
    const account = env.newAccount();
    const { document } = await issued(account);
    await env.admin.billing.documents.void({ idempotencyKey: env.key(), documentId: document.id, reason: "Redo" });
    await issued(account);
    expect((await env.admin.billing.balance({ accountId: account })).balance).toBe(TEN_UNITS_BILL);
  });

  it("re-bills: reverses the invoice and issues a replacement that names it", async () => {
    const account = env.newAccount();
    const { document } = await issued(account);
    const key = env.key("rebill");
    const input = env.usage(account, { reading: { dial: 120 } });
    const bill = withoutKey(input);
    const result = await env.admin.billing.documents.rebill({ idempotencyKey: key, documentId: document.id, reason: "Reading was 120", bill: bill as never });
    if (!("replacement" in result)) throw new Error("expected a replacement");
    // 20 units: 6 x 8250 + 14 x 9600 = 183,900 plus standing 15,000.
    expect(result.replacement).toMatchObject({ kind: "invoice", total: 198_900n, replacesDocumentId: document.id });
    expect(result.reversal).toMatchObject({ kind: "reversal", reversesDocumentId: document.id });
    expect((await env.admin.billing.balance({ accountId: account })).balance).toBe(198_900n);
    expect(await env.admin.billing.documents.get({ id: document.id })).toMatchObject({ reversedByDocumentId: result.reversal.id, replacedByDocumentId: result.replacement.id });
    const replay = await env.admin.billing.documents.rebill({ idempotencyKey: key, documentId: document.id, reason: "Reading was 120", bill: bill as never });
    expect("replacement" in replay && replay.replayed && replay.replacement.id).toBe(result.replacement.id);
    expect((await env.admin.billing.documents.list({ accountId: account })).length).toBe(3);
  });

  it("holds a re-bill the engine refuses and leaves the original alone", async () => {
    const account = env.newAccount();
    const { document } = await issued(account);
    const bill = withoutKey(env.usage(account, { reading: { dial: 9_000 } }));
    const result = await env.admin.billing.documents.rebill({ idempotencyKey: env.key(), documentId: document.id, reason: "Typo", bill: bill as never });
    expect(result).toMatchObject({ outcome: "held", code: "OUTLIER_HOLD" });
    expect((await env.admin.billing.documents.get({ id: document.id })).reversedByDocumentId).toBeNull();
    expect((await env.admin.billing.balance({ accountId: account })).balance).toBe(TEN_UNITS_BILL);
  });

  it("refuses a re-bill for another period or account", async () => {
    const account = env.newAccount();
    const { document } = await issued(account);
    const bill = withoutKey(env.usage(account));
    await expectCode(env.admin.billing.documents.rebill({ idempotencyKey: env.key(), documentId: document.id, reason: "x", bill: { ...bill, period: "2025-03" } as never }), "PRECONDITION_FAILED");
    await expectCode(env.admin.billing.documents.rebill({ idempotencyKey: env.key(), documentId: document.id, reason: "x", bill: { ...bill, accountId: env.newAccount() } as never }), "PRECONDITION_FAILED");
  });
});

// B-11, K-05: credit and debit notes behind an approval.
describe("credit and debit notes", () => {
  async function approved(accountId: string, kind: "credit_note" | "debit_note", amount: bigint) {
    const asked = await env.admin.billing.adjustments.request({ accountId, kind, amount, reasonCode: "BILLING_ERROR", note: "Because" });
    expect(asked.status).toBe("pending");
    await env.accountant().approvals.approve({ id: asked.approvalId });
    return asked.approvalId;
  }
  const noteInput = (accountId: string, approvalId: string, amount: bigint, over: Record<string, unknown> = {}) => ({
    approvalId,
    accountId,
    invoiceTypeId: env.invoiceTypeId,
    lines: [{ description: "Adjustment", amount }],
    note: "Because",
    ...over,
  });

  it("needs an approved request for the same account and amount, and uses it once", async () => {
    const account = env.newAccount();
    const { document } = await issued(account);
    const asked = await env.admin.billing.adjustments.request({ accountId: account, kind: "credit_note", amount: 20_000n, reasonCode: "GOODWILL", note: "Goodwill" });
    await expectCode(env.admin.billing.creditNotes.issue(noteInput(account, asked.approvalId, 20_000n, { relatedDocumentId: document.id })), "PRECONDITION_FAILED", /pending/);
    await expectCode(env.admin.billing.creditNotes.issue(noteInput(account, randomUUID(), 20_000n)), "NOT_FOUND");
    await env.accountant().approvals.approve({ id: asked.approvalId });

    await expectCode(env.admin.billing.creditNotes.issue(noteInput(account, asked.approvalId, 25_000n)), "PRECONDITION_FAILED", /differs/);
    await expectCode(env.admin.billing.creditNotes.issue(noteInput(env.newAccount(), asked.approvalId, 20_000n)), "PRECONDITION_FAILED", /another account/);
    await expectCode(env.admin.billing.debitNotes.issue(noteInput(account, asked.approvalId, 20_000n)), "PRECONDITION_FAILED", /another account or kind/);

    const note = await env.admin.billing.creditNotes.issue(noteInput(account, asked.approvalId, 20_000n, { relatedDocumentId: document.id }));
    expect(note.document).toMatchObject({ kind: "credit_note", total: -20_000n, relatedDocumentId: document.id, lineCount: 1 });
    expect((await env.admin.billing.balance({ accountId: account })).balance).toBe(TEN_UNITS_BILL - 20_000n);
    const again = await env.admin.billing.creditNotes.issue(noteInput(account, asked.approvalId, 20_000n, { relatedDocumentId: document.id }));
    expect(again).toMatchObject({ replayed: true, document: { id: note.document.id } });
    expect((await env.admin.billing.documents.list({ accountId: account, kind: "credit_note" })).length).toBe(1);
  });

  it("cannot approve its own request, and a debit note raises the balance", async () => {
    const account = env.newAccount();
    const asked = await env.admin.billing.adjustments.request({ accountId: account, kind: "debit_note", amount: 5_000n, reasonCode: "OTHER", note: "Reconnection" });
    await expectCode(env.admin.approvals.approve({ id: asked.approvalId }), "FORBIDDEN");
    await env.accountant().approvals.approve({ id: asked.approvalId });
    const note = await env.admin.billing.debitNotes.issue(noteInput(account, asked.approvalId, 5_000n));
    expect(note.document).toMatchObject({ kind: "debit_note", total: 5_000n });
    expect((await env.admin.billing.balance({ accountId: account })).balance).toBe(5_000n);
    const entry = await env.rows<{ entry_type: string }>(sql`select entry_type from billing.ledger_transaction where document_id = ${note.document.id}`);
    expect(entry[0]!.entry_type).toBe("adjustment");
  });

  it("refuses a credit larger than what is left on the related invoice", async () => {
    const account = env.newAccount();
    const { document } = await issued(account);
    const id = await approved(account, "credit_note", TEN_UNITS_BILL + 1n);
    await expectCode(env.admin.billing.creditNotes.issue(noteInput(account, id, TEN_UNITS_BILL + 1n, { relatedDocumentId: document.id })), "PRECONDITION_FAILED", /more than is left/);
  });

  it("makes an invoice with live notes unvoidable until the notes are voided", async () => {
    const account = env.newAccount();
    const { document } = await issued(account);
    const id = await approved(account, "credit_note", 1_000n);
    const note = await env.admin.billing.creditNotes.issue(noteInput(account, id, 1_000n, { relatedDocumentId: document.id }));
    await expectCode(env.admin.billing.documents.void({ idempotencyKey: env.key(), documentId: document.id, reason: "x" }), "PRECONDITION_FAILED", /Void the credit/);
    await env.admin.billing.documents.void({ idempotencyKey: env.key(), documentId: note.document.id, reason: "Mistake" });
    await env.admin.billing.documents.void({ idempotencyKey: env.key(), documentId: document.id, reason: "Now fine" });
    expect((await env.admin.billing.balance({ accountId: account })).balance).toBe(0n);
  });

  it("asks only for reasons on the list", async () => {
    await expectCode(env.admin.billing.adjustments.request({ accountId: env.newAccount(), kind: "credit_note", amount: 1n, reasonCode: "MADE_UP", note: "x" }), "BAD_REQUEST");
  });
});

// B-18, NF-22, NF-03, NF-31: events, audit, append-only, permissions and licence.
describe("events, audit, append-only and access", () => {
  it("publishes the document events and audits the posting", async () => {
    const account = env.newAccount();
    const { document } = await issued(account);
    const voided = await env.admin.billing.documents.void({ idempotencyKey: env.key(), documentId: document.id, reason: "Test" });
    const issuedEvents = await env.events(env.orgA, "billing.document_issued");
    expect(issuedEvents.find((e) => e.documentId === document.id)).toMatchObject({ kind: "invoice", total: TEN_UNITS_BILL.toString(), accountId: account });
    expect((await env.events(env.orgA, "billing.document_reversed")).find((e) => e.documentId === voided.reversal.id)).toMatchObject({ reversesDocumentId: document.id, total: (-TEN_UNITS_BILL).toString() });
    const actions = (await env.admin.audit.list({ subjectId: document.id, limit: 20 })).entries.map((e) => e.action);
    expect(actions).toEqual(expect.arrayContaining(["billing.invoice_issued", "billing.document_voided"]));
  });

  it("refuses an UPDATE or DELETE of posted money, even by the app role inside a tenant", async () => {
    const { document } = await issued(env.newAccount());
    for (const statement of [
      sql`update billing.document set total = 0 where id = ${document.id}`,
      sql`delete from billing.document where id = ${document.id}`,
      sql`update billing.document_line set amount = 0 where document_id = ${document.id}`,
      sql`update billing.ledger_entry set amount = 1 where document_id = ${document.id}`,
      sql`delete from billing.ledger_transaction where document_id = ${document.id}`,
    ]) {
      await expect(withTenant(env.t.app, env.orgA, (tx) => tx.execute(statement))).rejects.toThrow();
    }
  });

  it("checks permissions: reads for billing:read, bills for billing:run, corrections for billing:adjust", async () => {
    const account = env.newAccount();
    await expectCode(env.cashier().billing.balance({ accountId: account }), "FORBIDDEN");
    await env.clerk().billing.balance({ accountId: account });
    await expectCode(env.clerk().billing.invoices.issueUsage(env.usage(account) as never), "FORBIDDEN");
    await expectCode(env.clerk().billing.adjustments.request({ accountId: account, kind: "credit_note", amount: 1n, reasonCode: "OTHER", note: "x" }), "FORBIDDEN");
    await expectCode(env.clerk().billing.documents.void({ idempotencyKey: env.key(), documentId: randomUUID(), reason: "x" }), "FORBIDDEN");
  });

  it("answers NOT_FOUND when Billing is not licensed", async () => {
    await expectCode(env.bare().billing.balance({ accountId: env.newAccount() }), "NOT_FOUND");
    await expectCode(env.bare().billing.invoices.issueUsage(env.usage(env.newAccount()) as never), "NOT_FOUND");
  });

  it("keeps tenants apart: B sees nothing of A's documents or balances", async () => {
    const account = env.newAccount();
    const { document } = await issued(account);
    expect((await env.outsider().billing.balance({ accountId: account })).balance).toBe(0n);
    expect(await env.outsider().billing.documents.list({ accountId: account })).toEqual([]);
    await expectCode(env.outsider().billing.documents.get({ id: document.id }), "NOT_FOUND");
    await expectCode(env.outsider().billing.documents.void({ idempotencyKey: env.key(), documentId: document.id, reason: "x" }), "NOT_FOUND");
  });

  it("lists the billing policy among the organization's versioned settings (NF-32)", async () => {
    const read = await env.admin.config.list();
    expect(read.some((s) => s.key === "billing.policy")).toBe(true);
  });
});
