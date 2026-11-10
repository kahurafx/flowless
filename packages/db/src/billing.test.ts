import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Transaction } from "./client";
import { document, documentLine, ledgerEntry, ledgerTransaction } from "./schema";
import { withTenant } from "./tenant";
import { startTestDatabase, tenants, type TestDatabase } from "./testing";

/** Drizzle wraps driver errors; the Postgres error is the `cause`. */
const pgError = (pattern: RegExp) => ({ cause: { message: expect.stringMatching(pattern) } });

/** Deferred triggers fire at commit, where the driver error is not wrapped. */
const commitError = (pattern: RegExp) => ({ message: expect.stringMatching(pattern) });

let t: TestDatabase;
beforeAll(async () => {
  t = await startTestDatabase();
});
afterAll(() => t?.stop());

const asA = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app, tenants.a.id, fn);
const asB = <T>(fn: (tx: Transaction) => Promise<T>) => withTenant(t.app, tenants.b.id, fn);
const key = () => `k_${randomUUID()}`;
const accountId = randomUUID();
let seq = 0;

/** An invoice of the given line amounts, with the sub-ledger posting that charges it. */
async function issue(tx: Transaction, org: string, amounts: bigint[], over: Partial<typeof document.$inferInsert> = {}) {
  const total = amounts.reduce((a, b) => a + b, 0n);
  const id = randomUUID();
  const [doc] = await tx
    .insert(document)
    .values({
      id,
      organizationId: org,
      kind: "invoice",
      invoiceTypeId: randomUUID(),
      number: `INV-${++seq}-${randomUUID().slice(0, 6)}`,
      numberSequence: seq,
      accountId,
      currency: "KES",
      total,
      lineCount: amounts.length,
      issuedOn: "2026-10-31",
      idempotencyKey: key(),
      ...over,
    })
    .returning();
  await tx.insert(documentLine).values(
    amounts.map((amount, position) => ({
      organizationId: org,
      documentId: id,
      position,
      lineType: "consumption" as const,
      description: "Water",
      amount,
      serviceFrom: "2026-10-01",
      serviceTo: "2026-10-31",
      tariffVersionId: randomUUID(),
    })),
  );
  return doc!;
}

async function post(
  tx: Transaction,
  org: string,
  entries: { side: "debit" | "credit"; amount: bigint; ledgerAccount?: "receivable" | "revenue" | "cash_clearing" }[],
  header: Partial<typeof ledgerTransaction.$inferInsert> = {},
) {
  const id = randomUUID();
  await tx.insert(ledgerTransaction).values({
    id,
    organizationId: org,
    entryType: "charge",
    currency: "KES",
    entryCount: entries.length,
    effectiveOn: "2026-10-31",
    idempotencyKey: key(),
    ...header,
  });
  await tx.insert(ledgerEntry).values(
    entries.map((e, lineNo) => ({
      organizationId: org,
      transactionId: id,
      lineNo,
      currency: "KES",
      side: e.side,
      amount: e.amount,
      ledgerAccount: e.ledgerAccount ?? (e.side === "debit" ? ("receivable" as const) : ("revenue" as const)),
      accountId,
    })),
  );
  return id;
}

// NF-01, NF-22, B-11, B-18, T-04: the billing schema isolates tenants and keeps the ledger append-only and balanced in the database.
describe("billing schema", () => {
  it("has row-level security on every table of the schema", async () => {
    const rows = await t.admin.execute<{ relname: string; relrowsecurity: boolean }>(
      sql`select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'billing' and c.relkind = 'r'`,
    );
    expect(rows.map((r) => r.relname).sort()).toEqual(["document", "document_line", "ledger_entry", "ledger_transaction"]);
    expect(rows.filter((r) => !r.relrowsecurity)).toEqual([]);
  });

  it("hides one tenant's rows from another and fails closed with no tenant", async () => {
    const doc = await asA((tx) => issue(tx, tenants.a.id, [1000n, 150n]));
    await asA((tx) => post(tx, tenants.a.id, [{ side: "debit", amount: 1150n }, { side: "credit", amount: 1150n }]));
    for (const table of [document, documentLine, ledgerTransaction, ledgerEntry]) {
      expect(await asB((tx) => tx.select().from(table))).toEqual([]);
      expect(await t.app.select().from(table)).toEqual([]);
    }
    expect((await asA((tx) => tx.select().from(document))).map((r) => r.id)).toContain(doc.id);
    await expect(asA((tx) => issue(tx, tenants.b.id, [1n]))).rejects.toMatchObject(pgError(/row-level security/));
    await expect(asA((tx) => post(tx, tenants.b.id, [{ side: "debit", amount: 1n }, { side: "credit", amount: 1n }]))).rejects.toMatchObject(pgError(/row-level security/));
  });

  it("composite keys stop a line or entry pointing at another tenant's record", async () => {
    const theirs = await asB((tx) => issue(tx, tenants.b.id, [500n]));
    await expect(
      asA((tx) => tx.insert(documentLine).values({ organizationId: tenants.a.id, documentId: theirs.id, position: 5, lineType: "adjustment", description: "x", amount: 1n })),
    ).rejects.toMatchObject(pgError(/document_line_document_fk/));
    const theirTx = await asB((tx) => post(tx, tenants.b.id, [{ side: "debit", amount: 5n }, { side: "credit", amount: 5n }]));
    await expect(
      asA((tx) => tx.insert(ledgerEntry).values({ organizationId: tenants.a.id, transactionId: theirTx, lineNo: 9, currency: "KES", side: "debit", amount: 1n, ledgerAccount: "receivable", accountId })),
    ).rejects.toMatchObject(pgError(/ledger_entry_transaction_fk/));
  });

  it("refuses UPDATE, DELETE and TRUNCATE on ledger and documents for the app role", async () => {
    const doc = await asA((tx) => issue(tx, tenants.a.id, [700n]));
    const txId = await asA((tx) => post(tx, tenants.a.id, [{ side: "debit", amount: 7n }, { side: "credit", amount: 7n }], { documentId: doc.id }));
    const denied = pgError(/permission denied/);
    await expect(asA((tx) => tx.update(document).set({ total: 1n }).where(sql`id = ${doc.id}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.update(document).set({ finalBill: true }).where(sql`id = ${doc.id}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.delete(document).where(sql`id = ${doc.id}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.update(documentLine).set({ amount: 1n }).where(sql`document_id = ${doc.id}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.delete(documentLine).where(sql`document_id = ${doc.id}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.update(ledgerTransaction).set({ description: "x" }).where(sql`id = ${txId}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.delete(ledgerTransaction).where(sql`id = ${txId}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.update(ledgerEntry).set({ amount: 1n }).where(sql`transaction_id = ${txId}`))).rejects.toMatchObject(denied);
    await expect(asA((tx) => tx.delete(ledgerEntry).where(sql`transaction_id = ${txId}`))).rejects.toMatchObject(denied);
    for (const table of ["document", "document_line", "ledger_transaction", "ledger_entry"]) {
      await expect(t.app.execute(sql.raw(`truncate billing.${table} cascade`))).rejects.toMatchObject(denied);
    }
  });

  it("marks a final bill at insert and only on an invoice or credit note (B-12, C-11)", async () => {
    const doc = await asA((tx) => issue(tx, tenants.a.id, [500n], { finalBill: true }));
    expect(doc.finalBill).toBe(true);
    expect((await asA((tx) => issue(tx, tenants.a.id, [500n]))).finalBill).toBe(false);
    await expect(asA((tx) => issue(tx, tenants.a.id, [500n], { kind: "debit_note", finalBill: true }))).rejects.toMatchObject(pgError(/document_final_kind/));
  });

  it("refuses an unbalanced transaction, a wrong entry count and a late entry", async () => {
    const unbalanced = commitError(/unbalanced/);
    await expect(asA((tx) => post(tx, tenants.a.id, [{ side: "debit", amount: 100n }, { side: "credit", amount: 99n }]))).rejects.toMatchObject(unbalanced);
    await expect(asA((tx) => post(tx, tenants.a.id, [{ side: "debit", amount: 100n }, { side: "debit", amount: 100n }]))).rejects.toMatchObject(unbalanced);
    // Declares three entries, supplies two (balanced).
    await expect(
      asA((tx) => post(tx, tenants.a.id, [{ side: "debit", amount: 5n }, { side: "credit", amount: 5n }], { entryCount: 3 })),
    ).rejects.toMatchObject(commitError(/declares 3 entries but has 2/));
    // A header with no entries at all.
    await expect(
      asA((tx) => tx.insert(ledgerTransaction).values({ organizationId: tenants.a.id, entryType: "charge", currency: "KES", entryCount: 2, effectiveOn: "2026-10-31", idempotencyKey: key() })),
    ).rejects.toMatchObject(commitError(/declares 2 entries but has 0/));
    // A balanced pair added to a committed transaction is still refused: the count no longer matches.
    const id = await asA((tx) => post(tx, tenants.a.id, [{ side: "debit", amount: 5n }, { side: "credit", amount: 5n }]));
    await expect(
      asA((tx) =>
        tx.insert(ledgerEntry).values([
          { organizationId: tenants.a.id, transactionId: id, lineNo: 2, currency: "KES", side: "debit", amount: 1n, ledgerAccount: "receivable", accountId },
          { organizationId: tenants.a.id, transactionId: id, lineNo: 3, currency: "KES", side: "credit", amount: 1n, ledgerAccount: "revenue", accountId },
        ]),
      ),
    ).rejects.toMatchObject(commitError(/declares 2 entries but has 4/));
  });

  it("accepts a balanced transaction of several entries and keeps entry currency equal to the header's", async () => {
    await expect(
      asA((tx) =>
        post(tx, tenants.a.id, [
          { side: "debit", amount: 1000n },
          { side: "credit", amount: 850n },
          { side: "credit", amount: 150n },
        ]),
      ),
    ).resolves.toBeTruthy();
    await expect(
      asA(async (tx) => {
        const id = randomUUID();
        await tx.insert(ledgerTransaction).values({ id, organizationId: tenants.a.id, entryType: "charge", currency: "KES", entryCount: 2, effectiveOn: "2026-10-31", idempotencyKey: key() });
        await tx.insert(ledgerEntry).values({ organizationId: tenants.a.id, transactionId: id, lineNo: 0, currency: "USD", side: "debit", amount: 1n, ledgerAccount: "receivable", accountId });
      }),
    ).rejects.toMatchObject(pgError(/ledger_entry_transaction_fk/));
  });

  it("refuses non-positive amounts, bad currency codes and a reversal without its link", async () => {
    await expect(asA((tx) => post(tx, tenants.a.id, [{ side: "debit", amount: 0n }, { side: "credit", amount: 0n }]))).rejects.toMatchObject(pgError(/ledger_entry_amount_positive/));
    await expect(asA((tx) => post(tx, tenants.a.id, [{ side: "debit", amount: 1n }, { side: "credit", amount: 1n }], { currency: "kes" }))).rejects.toMatchObject(pgError(/ledger_transaction_currency_valid/));
    await expect(asA((tx) => post(tx, tenants.a.id, [{ side: "debit", amount: 1n }, { side: "credit", amount: 1n }], { entryType: "reversal" }))).rejects.toMatchObject(pgError(/ledger_transaction_reversal_link/));
  });

  it("reverses a transaction once, by mirror entries", async () => {
    const original = await asA((tx) => post(tx, tenants.a.id, [{ side: "debit", amount: 40n }, { side: "credit", amount: 40n }]));
    const mirror = [{ side: "credit" as const, amount: 40n, ledgerAccount: "receivable" as const }, { side: "debit" as const, amount: 40n, ledgerAccount: "revenue" as const }];
    await asA((tx) => post(tx, tenants.a.id, mirror, { entryType: "reversal", reversesTransactionId: original }));
    await expect(asA((tx) => post(tx, tenants.a.id, mirror, { entryType: "reversal", reversesTransactionId: original }))).rejects.toMatchObject(pgError(/ledger_transaction_reverses_unique/));
  });

  it("makes posting idempotent by key", async () => {
    const k = key();
    await asA((tx) => post(tx, tenants.a.id, [{ side: "debit", amount: 1n }, { side: "credit", amount: 1n }], { idempotencyKey: k }));
    await expect(asA((tx) => post(tx, tenants.a.id, [{ side: "debit", amount: 1n }, { side: "credit", amount: 1n }], { idempotencyKey: k }))).rejects.toMatchObject(pgError(/ledger_transaction_idempotency_unique/));
    await expect(asB((tx) => post(tx, tenants.b.id, [{ side: "debit", amount: 1n }, { side: "credit", amount: 1n }], { idempotencyKey: k }))).resolves.toBeTruthy();
  });

  it("requires a document's lines to be its declared count and to sum to its total (I-4)", async () => {
    await expect(asA((tx) => issue(tx, tenants.a.id, [100n, 50n], { total: 151n }))).rejects.toMatchObject(commitError(/lines sum to 150 but its total is 151/));
    await expect(asA((tx) => issue(tx, tenants.a.id, [100n, 50n], { lineCount: 3 }))).rejects.toMatchObject(commitError(/declares 3 lines but has 2/));
    // A true-up credit line among positive ones: the sum still has to match.
    await expect(asA((tx) => issue(tx, tenants.a.id, [165n, -330n, 150n], { total: -15n, kind: "credit_note" }))).resolves.toBeTruthy();
    // A line added later to an issued document is refused.
    const doc = await asA((tx) => issue(tx, tenants.a.id, [10n]));
    await expect(
      asA((tx) => tx.insert(documentLine).values({ organizationId: tenants.a.id, documentId: doc.id, position: 1, lineType: "adjustment", description: "late", amount: 5n })),
    ).rejects.toMatchObject(commitError(/declares 1 lines but has 2/));
  });

  it("checks document shape: sign by kind, numbers, links, tariff citation and service span", async () => {
    await expect(asA((tx) => issue(tx, tenants.a.id, [-5n], { total: -5n }))).rejects.toMatchObject(pgError(/document_total_sign/));
    await expect(asA((tx) => issue(tx, tenants.a.id, [5n], { kind: "credit_note" }))).rejects.toMatchObject(pgError(/document_total_sign/));
    await expect(asA((tx) => issue(tx, tenants.a.id, [5n], { kind: "reversal" }))).rejects.toMatchObject(pgError(/document_reversal_links/));
    const base = await asA((tx) => issue(tx, tenants.a.id, [5n]));
    await expect(asA((tx) => issue(tx, tenants.a.id, [5n], { number: base.number }))).rejects.toMatchObject(pgError(/document_number_unique/));
    await expect(asA((tx) => issue(tx, tenants.a.id, [5n], { kind: "invoice", relatedDocumentId: base.id }))).rejects.toMatchObject(pgError(/document_related_kinds/));
    await expect(asA((tx) => issue(tx, tenants.a.id, [-5n], { kind: "reversal", total: -5n, reversesDocumentId: base.id }))).resolves.toBeTruthy();
    await expect(asA((tx) => issue(tx, tenants.a.id, [-5n], { kind: "reversal", total: -5n, reversesDocumentId: base.id }))).rejects.toMatchObject(pgError(/document_reverses_unique/));
    const line = (over: Partial<typeof documentLine.$inferInsert>) => ({ organizationId: tenants.a.id, position: 0, lineType: "consumption" as const, description: "Water", amount: 0n, ...over });
    const bare = async (over: Partial<typeof documentLine.$inferInsert>) =>
      asA(async (tx) => {
        const id = randomUUID();
        await tx.insert(document).values({ id, organizationId: tenants.a.id, kind: "invoice", invoiceTypeId: randomUUID(), number: `N-${randomUUID()}`, numberSequence: 1, accountId, currency: "KES", total: 0n, lineCount: 1, issuedOn: "2026-10-31", idempotencyKey: key() });
        await tx.insert(documentLine).values({ ...line(over), documentId: id });
      });
    await expect(bare({})).rejects.toMatchObject(pgError(/document_line_cites_tariff_version/));
    await expect(bare({ lineType: "standing" })).rejects.toMatchObject(pgError(/document_line_cites_charge_amount/));
    await expect(bare({ tariffVersionId: randomUUID(), serviceFrom: "2026-10-31", serviceTo: "2026-10-01" })).rejects.toMatchObject(pgError(/document_line_service_span/));
    await expect(bare({ tariffVersionId: randomUUID(), serviceFrom: "2026-10-01" })).rejects.toMatchObject(pgError(/document_line_service_span/));
    await expect(bare({ lineType: "standing", chargeItemAmountId: randomUUID() })).resolves.toBeUndefined();
  });

  it("links a posting to its document and requires the document line to exist", async () => {
    const doc = await asA((tx) => issue(tx, tenants.a.id, [300n]));
    await asA(async (tx) => {
      const id = randomUUID();
      await tx.insert(ledgerTransaction).values({ id, organizationId: tenants.a.id, entryType: "charge", currency: "KES", entryCount: 2, effectiveOn: "2026-10-31", documentId: doc.id, idempotencyKey: key() });
      await tx.insert(ledgerEntry).values([
        { organizationId: tenants.a.id, transactionId: id, lineNo: 0, currency: "KES", side: "debit", amount: 300n, ledgerAccount: "receivable", accountId, documentId: doc.id, documentLinePosition: 0 },
        { organizationId: tenants.a.id, transactionId: id, lineNo: 1, currency: "KES", side: "credit", amount: 300n, ledgerAccount: "revenue", accountId, documentId: doc.id, documentLinePosition: 0, serviceFrom: "2026-10-01", serviceTo: "2026-10-31" },
      ]);
    });
    await expect(
      asA(async (tx) => {
        const id = randomUUID();
        await tx.insert(ledgerTransaction).values({ id, organizationId: tenants.a.id, entryType: "charge", currency: "KES", entryCount: 2, effectiveOn: "2026-10-31", idempotencyKey: key() });
        await tx.insert(ledgerEntry).values({ organizationId: tenants.a.id, transactionId: id, lineNo: 0, currency: "KES", side: "debit", amount: 1n, ledgerAccount: "receivable", accountId, documentId: doc.id, documentLinePosition: 7 });
      }),
    ).rejects.toMatchObject(pgError(/ledger_entry_document_line_fk/));
    // A currency different from the document's is refused on the header.
    await expect(
      asA(async (tx) => {
        const id = randomUUID();
        await tx.insert(ledgerTransaction).values({ id, organizationId: tenants.a.id, entryType: "charge", currency: "USD", entryCount: 2, effectiveOn: "2026-10-31", documentId: doc.id, idempotencyKey: key() });
      }),
    ).rejects.toMatchObject(pgError(/ledger_transaction_document_fk/));
  });
});
