# Tariffs module (`packages/api/src/modules/tariffs`)

Module-specific notes moved out of `packages/api/CLAUDE.md` (Phase 3 F2: T-01 to T-04).

## Procedures
`tariffsRouter` mounted at `tariffs`: tariffs at its root (`list`, `get`, `create`, `update`, `addVersion`, `versions`, `inForce`, `nextEffectiveDate`), `simulateLateFee`, and `categories.*` (list, get, create, update, deactivate, reactivate, assignTariff), `chargeItems.*` (list, get, create, update, addAmountVersion, deactivate, reactivate), `invoiceTypes.*` (list, get, create, update, setLines, setLateFeeRule). Procedures come from `tariffsProcedures` (`procedures.ts`): `read` (`tariffs:read`) and `manage` (`tariffs:read` and `tariffs:manage`); every change is audited (`tariffs.*`) and publishes in the same transaction.

## Money and pure files
Rates and amounts are bigint minor units (a rate is minor units per unit consumed, 82.50 is `8250n`; a flat amount is per billing month), so audit and event payloads carry them as decimal strings (`plain()` in `service.ts`). Pure files with no I/O: `content.ts` (zod content per tariff type, `validateTariffContent`, `bandsFor`, `chargeForUnits`, line-row mapping; bands are cumulative thresholds, `[0,6]` then `[6,20]`, first at 0, meeting exactly, last open, rates non-decreasing for increasing and non-increasing for decreasing), `dating.ts` (`versionInForce`, `versionSpans`, `nextPeriodStart`, `planEffectiveDate`; dates are `YYYY-MM-DD` strings in the organization's time zone, `todayIn(zone)`), `late-fee.ts` (`lateFee(rule, balance, daysOverdue, alreadyCharged)`, basis points, rounded once half up, a "month" is 30 days) and `invoice-policy.ts` (terms, overdue rule, `formatInvoiceNumber`).

## Versions and dating
Versions, category assignments and charge amounts are insert-only: "version i is in force from its `effective_from` until the next one's"; a version that shares a still-future date replaces the earlier one (higher `version_no` wins), one dated today or earlier cannot be replaced (CONFLICT). `chooseEffectiveDate` (`service.ts`) is the single rule for T-03: the requested date, else the next period start from the `tariffs.policy` setting (`periodStartDay`, 1 to 28, default 1; today for the first version of something), refused when on or before `closedThrough(tx, orgId)`, the closed-period port (`closed-period.ts`; default null; Billing calls `registerClosedPeriodSource` from the module's `index.ts` in Phase 4).

## Invoice types
Invoice types: `applies_to` `application` or `account`; an application's type can never have overdue action `disconnect` (validation and a DB check); `allocateInvoiceNumber(tx, organizationId, invoiceTypeId)` (exported from `index.ts`, for Billing) takes the next number from `invoice_type_counter` with one upsert, so concurrent callers take turns.

## Defaults
Defaults (`defaults.ts`, `ensureDefaults`): six categories, eleven charge items (no amounts) and five invoice types (the new-connection template carries application fee, connection fee, meter, materials, labour, deposit), added by code with `ON CONFLICT DO NOTHING` by the consumers `tariffs.seed_defaults_on_creation` (`organization.created`) and `tariffs.seed_defaults_on_licence` (`entitlements.changed` when Tariffs is newly licensed), both skipped while Tariffs is unlicensed, so the licence event is what seeds most organizations; write procedures do not seed.

## Published interface and the Accounts boundary
Published reads in `index.ts`: `categoryExists`, `categoriesById`, `categoryPricing`, `tariffVersionInForce`, `chargeItemByCode`, `allocateInvoiceNumber`. `accounts.account.category_id` stays an opaque uuid: Accounts does not import Tariffs (it must work without it), so nothing yet checks that a category exists when an account is opened; a caller that wants that uses `categoryExists`.

## Events
Events (`events.ts`): `tariffs.tariff_version_created`, `.charge_item_created`, `.charge_item_amount_changed`, `.invoice_type_changed`.

## Tests
Tests: `modules/tariffs/test/test-support.ts` (`setupTariffsEnv`: tenants A and B with Accounts and Tariffs, C with Accounts only, roles).
