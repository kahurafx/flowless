# Billing module (`packages/api/src/modules/billing`)

Phase 4 P4-3: B-05, B-06, B-08 to B-11, B-18, T-04, NF-22. Billing maps the pure `@flowless/billing-engine` onto the `billing` schema (append-only documents and double-entry ledger, see `packages/db/CLAUDE.md`). It reads other modules only through their `index.ts` (Tariffs' `categoryPricing`, `tariffVersionInForce`, `chargeItemAmountInForce`, `allocateInvoiceNumber`) and never touches their tables.

## Procedures
`billingRouter` mounted at `billing`, from `procedures.ts`: `read` (`billing:read`), `issue` (`billing:run`), `adjust` (`billing:adjust`).
- `invoices.issueUsage` (issue): price a reading or estimate for an account and period, post the invoice (or credit note when the total is negative) and its ledger transaction, or hold it.
- `adjustments.request` (adjust) asks the K-05 approval `billing.adjustment` (default one level `billing:approve`, `approvals.billing.adjustment`); `creditNotes.issue`, `debitNotes.issue` (adjust) cite the approved request (`approvalId`: same account, kind and amount; used once, the idempotency key is `note:<approvalId>`).
- `documents.void`, `documents.rebill` (adjust: permission, reason and audit, no approval); reads `documents.get`, `documents.list`, `balance`, `statement`.
Every change audits (`billing.<kind>_issued`, `billing.document_voided`, `billing.bill_held`) and publishes `billing.document_issued`, `.document_reversed`, `.bill_held` in the same transaction.

## Files
`usage.ts` (input schema, `prepareUsage` which builds the engine account and prices without writing, `issueUsage`, `holdBill`), `mapping.ts` (pure: tariff months to engine tariffs, engine lines to rows, stored rows to engine docs), `post.ts` (the only writer of documents and ledger entries: number, document, lines, balanced entries, or the mirror of a reversed transaction), `reversal.ts` (void and re-bill), `notes.ts`, `reads.ts` (derived reads), `settings.ts` (`billing.policy`: tier scaling, estimate average, fallback, outlier ceiling, dial digits), `approvals.ts`, `events.ts`.

## Rules in force
- Postings for one account take turns (`lockAccount`, an advisory transaction lock); an idempotency key replays the earlier document, any other request under it is CONFLICT. A ledger transaction's key is `<document key>:ledger`.
- One ledger pair per non-zero line: receivable against revenue (deposit line: `deposit_liability`, transfer: `transfer_clearing`), sides swapped for negative lines; a document with only zero lines posts no ledger transaction. A reversal mirrors the original entries (swapped sides, `reverses_transaction_id`).
- T-04: usage and true-up lines cite `tariff_version_id` (the first when a span crosses versions; all are in `calculation`), standing lines cite `charge_item_id` and `charge_item_amount_id`. Meter rent is added to the standing line's amount and its amount id is in `calculation.chargeItemAmountIds`.
- A void is refused for a reversal, an already voided document, or an invoice with live notes against it. A re-bill prices the replacement as if the original were void; if the engine holds it, nothing is voided. Its pair keys are `<key>:void` and `<key>:rebill`.
- A held bill (engine `BillException`) raises an exception (`UNBILLED_ACCOUNT`, `NO_BASELINE` for that code) owned by the person who ran it, deduped per account, period and code; age is derived from `raised_at`.

## Assumptions until Phase 5 and P4-4
- No Metering: the caller passes the reading history (`readings`, the latest actual before the period is the baseline), the category and the invoice type; `billable: false` stands in for Accounts' `chargesApplying` and holds the bill as STATUS_BLOCKED. Flat-rate tariffs, discounts, quarterly or annual recurrence, final bills (B-12) and late-reading corrections are not priced yet.
- No scope check on reads by area or route (Billing cannot read Accounts' placement); a published Accounts read is needed.
- Termination check, gate source, `chargesApplying`, closed-period source, balance transfer and `markInvoiced` are P4-4.

## Tests
`test/test-support.ts` (`setupBillingEnv`: A with Accounts, Tariffs, Billing; B same; C without Billing; reference tariff effective 2020), `test/billing.test.ts`, `test/mapping.test.ts`; the isolation canary and module matrix cover every procedure.
