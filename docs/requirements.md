# Flowless: Functional and Non-Functional Requirements v0.2

Water utility management SaaS.

This document says **what** Flowless must do. **When** and **where in the code** each requirement is built is in [build-plan.md](build-plan.md). Executable billing behaviour is in [billing-engine.html](billing-engine.html).

Every requirement has a stable ID (for example `B-10`). Cite IDs in task lists, commits, PRs and test names. Never renumber an ID; retire it instead.

Priority: **M** = must (MVP), **S** = should, **C** = could.

## 1. Scope and locked decisions

- Tenants are Organizations. Each has its own paybill, till and bank accounts. Flowless integrates with them and never holds customer money (no float, no settlement).
- Modules are optional, not isolated. Modules communicate through events and capability checks, never through each other's tables.
- Account number is the only auto-match key for payments.
- A user belongs to exactly one organization; there is no switching between organizations. Sign-in takes the organization code, then email (owners and admins) or a username unique within the organization (other staff), then password. Flowless support access to other tenants is K-12, not a second membership.
- Billing basis is the calendar month by default; period length and trigger are configurable per organization.
- General ledger is a later module. The core keeps a double-entry customer sub-ledger and the seam described in [section 5](#5-finance-and-gl-seam-kept-now-module-later).
- Out of scope for now: GL, tax and e-invoicing, WASREB reporting and tariff approval, smart metering (reading model stays source-agnostic), HR and payroll.
- Dropped legacy codes: Pay Later, Has Paid, Pending Memo (unused).

## 2. Glossary

| Term | Meaning |
| --- | --- |
| Organization | A tenant (water company or project). |
| Customer | The organization's customer. |
| Account | The billing relationship (number, category, tariff, balance, membership class). |
| Service point | The physical connection (GPS, scheme, zone, DMA, route). |
| Meter installation | A meter at a service point over a time interval. Readings belong to this. |
| Reading outcome | What the technician found (read, gate locked, and so on). |
| Flag | A system-computed anomaly (over, under, zero, negative). |
| Disposition | What billing does with a reading outcome. |
| Service period | The month consumed. |
| Posting period | The finance period an entry lands in. |

## 3. Module tiers

| Tier | Modules |
| --- | --- |
| Kernel (always on) | Tenancy, identity and RBAC, workflow and approvals, audit, notifications, files, import service, event bus (outbox), entitlements, reporting engine, configuration |
| Foundation (normally on) | Customers and Accounts, Tariffs and Charge Catalog, Billing and Sub-ledger, Payments, Metering and Readings |
| Sellable add-ons | Communications, Collections, Inventory, Work Orders, GIS and Network, NRW, Customer Portal, Mobile Apps, Landing Page, Finance and GL (later) |

If an add-on is absent, its events have no subscribers and the dependent features degrade gracefully (for example, disconnection works from the office without Work Orders).

## 4. Functional requirements

### 4.1 Kernel

- **K-01** (M) Multi-tenancy with `organization_id` on every record, enforced in the database (row-level security), not only in the application.
- **K-02** (M) Organization hierarchy: organization, scheme, zone, sub-zone, DMA (configurable), plus a separate operational Route hierarchy.
- **K-03** (M) Users, roles and permissions (RBAC), with optional per-scope restrictions (by scheme, zone or route).
- **K-04** (M) Entitlements: each organization is licensed per module. Enforced on every API route and report; navigation is built from entitlements.
- **K-05** (M) Configurable workflow engine: N-level approvals with thresholds, reason codes, SLA and escalation.
- **K-06** (M) Immutable audit log: who, what, when, before and after, source (UI, API, mobile, import).
- **K-07** (M) Notification service with channels (SMS, email, push, in-app, WhatsApp later), templates and per-organization wallet.
- **K-08** (M) File service for photos, evidence and documents, tenant-scoped.
- **K-09** (M) Event bus with transactional outbox, stable event IDs, idempotent consumers, and a replay flag.
- **K-10** (M) Organization-level configuration store: billing policy, estimation policy, charge catalog, templates, statuses.
- **K-11** (S) Public API and webhooks per organization, with API keys and rate limits.
- **K-12** (M) Support access to tenant data is time-boxed, justified and audited.

### 4.2 Customers, Accounts and Service Points

- **C-01** (M) Customer records with contacts; placeholder phone numbers (for example `25400000000`) are treated as no phone.
- **C-02** (M) Account number unique per organization, with a check digit, configurable format, and support for parent/child numbering (for example `1008B` or `1009` as a child of `1008`).
- **C-03** (M) Commercial status: `NEW`, `PENDING_PAYMENT`, `ACTIVE`, `DORMANT`, `TERMINATED`. Service status (separate axis): `CONNECTED` or `DISCONNECTED` with reason. Every change is a logged command with actor and reason.
- **C-04** (M) Configurable status rules: which statuses are billed for consumption, which standing charges and rent apply per status (table of status by charge type).
- **C-05** (M) Account opening workflow: enquiry, survey (1 and 2 approvals), application, new-connection invoice, payment, work order, meter installation with inventory confirmation, initial reading, activation.
- **C-06** (M) Activation is gated and configurable (payment threshold met, meter installed and inventory-confirmed, initial reading captured). It can happen automatically or by checklist. Alerts fire for accounts stuck in `NEW` or `PENDING_PAYMENT` beyond N days, and for any account with an installed meter and readings that is not `ACTIVE`.
- **C-07** (M) Memberships: parent/child account links with their own pricing for connection fees.
- **C-08** (M) Succession: child to full membership, change of name, or relocation with a new number creates a successor account. The old account goes `DORMANT` with a pointer, the balance moves through paired transfer entries (excluded from revenue and collection statistics), and the final reading becomes the opening reading.
- **C-09** (M) Relocation on the same account: survey, transfer fees, work order closing the old service point with a final reading and installing at the new one with an initial reading; zone, DMA, route and tariff are re-derived.
- **C-10** (M) Change of name: split at the effective date, with a closing reading for the previous holder.
- **C-11** (M) Termination requires a final bill and zero or settled balance (or write-off by approval).
- **C-12** (M) Data-quality rules and dashboards: active metered account with no meter, no phone, no coordinates, zone equal to route, duplicate customers.

### 4.3 Tariffs and Charge Catalog

- **T-01** (M) Tariffs are versioned and effective-dated. Types: increasing or decreasing block, uniform, flat rate (by property, pipe size or taps), per category.
- **T-02** (M) Per-organization categories (domestic, institution, kiosk, commercial, reseller, farming, and so on) each with its own tariff, standing charge, meter rent and discounts.
- **T-03** (M) Tariff changes take effect at a billing period start by default. Billing period can be configurable by date. Changes dated inside a closed period are blocked. Optional rule: tariff in force on the reading date applies to the whole period.
- **T-04** (M) Every invoice line stores the tariff version used. Issued bills are never re-priced.
- **T-05** (M) Policy `tier_scaling = by_period | none`. Default `by_period` (monthly bands multiplied by months in the span). `none` reproduces legacy behavior for parallel runs.
- **T-06** (S) Tariff simulation: preview billing for a selection of accounts under a draft tariff.
- **T-07** (M) Configurable charge catalog with types: usage, recurring (standing, meter rent), fee, penalty, deposit (a liability, not revenue), material, labour, transfer, adjustment. Items can map to inventory items when Inventory is on.
- **T-08** (M) Invoice is a document (number, dates, terms) with typed lines. A new-connection invoice carries application, connection, meter, materials, labour and deposit as lines (configurable).
- **T-09** (M) Payment terms per invoice type: full, minimum deposit, or installments. Each invoice type has its own overdue policy (an unpaid new-connection invoice pauses or cancels the application and never triggers disconnection).
- **T-10** (S) Late-fee rules: trigger, base, rate, cap and frequency, or manual only.

### 4.4 Metering and Readings

- **M-01** (M) Meter register: model, serial, dial digit count, status, lifecycle (procured, in stock, issued, installed, tested, replaced, disposed).
- **M-02** (M) Readings are append-only with status valid, voided or superseded. Previous reading is derived (latest valid reading before this one), never stored in an editable field.
- **M-03** (M) Reading sources: technician (mobile, offline), office entry, customer (portal, USSD, WhatsApp), import, and estimate. Estimated readings are a separate type and never baselines.
- **M-04** (M) Each reading stores `read_at`, source, reader, photo, GPS, quality flag.
- **M-05** (M) Validation at entry and sync: below last actual (negative), above or below expected range, zero, rollover candidate, same-day duplicate. Failures create exceptions and are not auto-billed.
- **M-06** (M) Reading outcomes (about 8 groups) plus condition tags, note and photo. Organizations map each outcome to a disposition: bill actual, estimate, hold, standing only, skip.
- **M-07** (M) Dial rollover detected from dial digits and confirmed by the technician. Meter change is one work order capturing the old final and new initial reading; the two-reading-per-cycle limit does not exist.
- **M-08** (M) Reading tasks and billing both derive from one eligibility snapshot, per route. Walking sequence per route is (S).
- **M-09** (M) Consecutive-miss counter triggers revisit task, customer self-read prompt, and escalation. An optional cap on consecutive estimates, with alerts, is (S).
- **M-10** (M) Zero-consumption policy: bill and flag; a streak opens a meter-check task.
- **M-11** (M) Late customer readings accepted with `read_at` inside a closed period (see B-14).
- **M-12** (S) Bulk and master meters with their own reading schedule per DMA.

### 4.5 Billing

- **B-01** (M) Billing trigger per organization: on reading (default, validators run at sync, clean accounts issue) or batch per cycle.
- **B-02** (M) Billing cycle is a state machine: open, reading window, validation, estimation, calculation, review, issue, deliver, completeness check, close. Frequency is configurable (monthly default).
- **B-03** (M) Eligibility snapshot taken at cycle date from account status. Billing and tasks use the same snapshot.
- **B-04** (M) Completeness rule: every eligible account ends the cycle as billed, billed-estimate, exception (with reason) or excluded (with reason). A cycle cannot close with unexplained accounts.
- **B-05** (M) Estimation policy per organization: N-month average (median or trimmed mean), same month last year, last actual, fixed minimum, or none. Under none, the organization chooses hold, standing only, or skip, and the account is always flagged. Accounts with no readings history have a configurable baseline for estimates.
- **B-06** (M) Estimation excludes spans flagged `baseline_gap`, corrected or disputed, and normalizes multi-month spans to units per month.
- **B-07** (M) Each account is calculated as its own job; failures never stop the batch or pass silently. Runs are resumable.
- **B-08** (M) Bill validators: consumption but no volumetric charge, missing standing charge, zero or standing-only bills, outlier versus history, absolute ceiling, status mismatch, missing tariff, lines not summing to total. Failures create exceptions.
- **B-09** (M) Bills for `DISCONNECTED`, `DORMANT` and `TERMINATED` accounts are blocked except the final bill.
- **B-10** (M) Actual and estimate true-up as specified in [section 6](#6-billing-engine-reference-rules). The correction is a visible, typed line with plain-language text.
- **B-11** (M) Issued invoices are frozen. Changes are credit note, debit note, or re-bill (void plus replacement as a linked pair). Adjustments are never used to emulate re-billing.
- **B-12** (M) Disconnection is one command with a mandatory final reading (metered), posting the closing bill and turn-off fee once, keyed by the disconnection event. The disconnection month bills in full; later charges follow the status table (default none, configurable). Reconnection starts from the final reading; a moved dial raises a suspected illegal consumption case. An account disconnected and reconnected in the same month must not have two different readings.
- **B-13** (M) Customer-facing adjustment text uses a configurable plain-language template; the calculation is attached for office users.
- **B-14** (M) Late readings and corrections post in the current open period as a correction document referencing the original invoice, with `service_from` and `service_to` on lines. Grace window (default: invoice due date) allows clerk-level approval-free corrections; after it, accountant or manager approval; large deviations need evidence. Finance periods remain locked.
- **B-15** (M) Billing period lock: no changes to closed periods; corrections go through B-14.
- **B-16** (S) Random-sample plus exception-based review; bulk approve clean bills; approval thresholds by amount.
- **B-17** (M) Statements: typed lines (invoice, payment, adjustment, credit note, transfer), running balance derived from entries, linked pairs collapsible for customers.
- **B-18** (M) Money in integer minor units with explicit currency; rounding once per line.
- **B-19** (M) Revenue-protection cases: illegal consumption, terminated-but-consuming, unbilled accounts, back-billing rules.

### 4.6 Payments

- **P-01** (M) Channels: M-Pesa (C2B, STK push), banks (API or statement file), card, cash, cheque, bulk receipts.
- **P-02** (M) Raw payment events stored immutably, de-duplicated by provider reference.
- **P-03** (M) Match on account number only; invalid numbers rejected at M-Pesa validation where the organization has it enabled. Phone or name candidates are shown for staff, never auto-applied.
- **P-04** (M) Allocation: oldest invoice first (configurable), then arrears; remainder held as customer credit.
- **P-05** (M) States: initiated, pending, received, matched or unmatched, allocated, reconciled, failed, reversed, duplicate. All visible in one queue.
- **P-06** (M) Unmatched payments go to suspense with a manual resolution queue.
- **P-07** (M) Backstops: scheduled provider status polling, statement import, customer claim by transaction code in portal.
- **P-08** (M) Daily three-way reconciliation (provider, Flowless, ledger) with exception types: missed callback, missing at provider, amount mismatch, duplicate, fees.
- **P-09** (M) Manual receipts require channel and reference. Receipt cancellation and large manual receipts are approval workflows.
- **P-10** (M) Receipts issued and notified, with receipt numbers.
- **P-11** (M) Each organization configures its own paybill, till and bank credentials, stored encrypted.

### 4.7 Communications

- **N-01** (M) One message record per invoice, channel and purpose with a unique key (no duplicates). States: queued, submitted, delivered, failed. Billing customers for a resend they requested is configurable (C).
- **N-02** (M) Provider delivery receipts plus polling backstop and capped retries.
- **N-03** (M) Campaign view: expected, generated, sent, delivered counts and the list of accounts without a message.
- **N-04** (M) Accounts with no or placeholder phone are never submitted; they go to a fallback queue (portal, email, print list, technician delivery).
- **N-05** (M) Per-organization SMS wallet reconciled to provider cost; low-balance alerts.
- **N-06** (S) Reading reminder messages. The reminder fee (legacy 1.60) is a ledger charge (off by default), billed only on confirmed delivery by default, configurable.
- **N-07** (S) Templates per language, bill and reminder triggers, opt-out handling.

### 4.8 Collections

- **D-01** (M) Staged collection rules by days overdue and balance, producing tasks for collectors; list printing remains an export.
- **D-02** (M) Commitments are configurable: single promise, installments or others. Accounts with a commitment in good standing, an open dispute, or a pending payment claim are excluded from disconnection lists. A missed installment moves the commitment to defaulted.
- **D-03** (M) Disconnection tasks flow into work orders (or office action when Work Orders is off).
- **D-04** (M) Disputes: case linked to an inspection work order with photos, GPS and finding; rebate policy with approval by accountant then manager; rebate posts as a typed credit.
- **D-05** (S) Write-off and penalty waiver by reason code and approval.
- **D-06** (S) Debtor ageing by zone, category and collector.

### 4.9 Inventory

- **I-01** (M) Items, stores and stock movements (consumables, fittings, tools), valuation, reorder levels; meters tracked individually by serial.
- **I-02** (M) Work-order material issue and return; meter issue, install, removal and custody trail.
- **I-03** (M) Disconnection alignment: removing a meter moves it to store; nightly consistency check across service status, physical connection state and meter location raises exceptions.
- **I-04** (S) Procurement (requisition, PO, GRN) as a later sub-module.
- **I-05** (S) Material items consumed in a work order generate the customer charge when Billing is on.

### 4.10 Work Orders and Staff

- **W-01** (M) Types: reading, disconnection, reconnection, meter installation, meter change, repair, leak, inspection, survey.
- **W-02** (M) Assignment per route or crew, with supervisor, scheduling, priority, SLA; offline-first mobile execution with photo and GPS evidence.
- **W-03** (M) Work order completion publishes events (`MeterInstalled`, `ServiceDisconnected`, and so on) consumed by Accounts, Inventory and Billing if present.
- **W-04** (S) Technician performance and exception rates.

### 4.11 GIS and Network

- **G-01** (S) Spatial entities for schemes, zones, DMAs, pipes, valves, bulk meters and customer points, with hierarchy.
- **G-02** (S) GPS tagging of service points from mobile; missing-coordinate dashboards.
- **G-03** (C) Interactive map with layers, leak and work order overlays.

### 4.12 NRW

- **R-01** (S) NRW by DMA: bulk meter inflow against billed consumption for matching read windows.
- **R-02** (S) Loss components where data exists (apparent and real).

### 4.13 Customer Portal and Mobile

- **U-01** (M) Portal: bills, statements, payment history, pay via STK or card, self-submit reading, claim a payment, raise and track complaints. Branded per organization.
- **U-02** (M) Technician app: tasks, offline readings, outcomes, photo, GPS, sync with conflict rules and per-item sync status.
- **U-03** (S) Admin and customer mobile apps.
- **U-04** (M) Landing page: static, independent of everything else.

### 4.14 Reporting

- **X-01** (M) Metadata-driven report definitions (dimensions, measures, filters) over tenant-scoped read models. The legacy tree of hundreds of reports should collapse to roughly 30 to 40 parameterized reports.
- **X-02** (M) Exception queues are the main operational UI: unbilled accounts, reading exceptions with age, unmatched payments, undelivered messages, stale activations, stuck commitments.
- **X-03** (M) Export to CSV and Excel; scheduled delivery.
- **X-04** (M) A report touching a table without a tenant column fails to publish.

### 4.15 Data Migration

- **Q-01** (M) Import service for Excel, CSV and zipped CSV (large volumes), with downloadable templates and column mapping.
- **Q-02** (M) Pipeline: chunked upload, staging, validation, error report, dry-run summary, chunked commit, rollback by batch ID.
- **Q-03** (M) Dependency order: hierarchy, tariffs and categories, customers, accounts, service points, meters, last valid reading per meter, opening balances, optional history.
- **Q-04** (M) Tiers: A (opening balances plus last reading), B (12 to 24 months of readings, invoices, payments, adjustments), C (full history).
- **Q-05** (M) History is written with `source = migration` and original dates, does not run billing or notifications, emits only replay events, and shares tables with live data.
- **Q-06** (M) Per-account reconciliation gate: opening plus invoices minus payments plus adjustments equals the legacy closing balance. Differences are shown and can be accepted only as an explicit legacy-variance line.
- **Q-07** (M) Idempotent on `legacy_id`. Voided legacy readings are imported as voided. Legacy adjustments are imported typed, with reason inferred or marked unknown.
- **Q-08** (M) Active metered account without a trusted last reading is held with a `NO_BASELINE` exception; its first verified reading becomes the baseline and is not billed.
- **Q-09** (S) Read-only connector to a restored legacy database, run by Flowless's migration team (no tenant-supplied SQL).
- **Q-10** (M) Parallel run: compare counts, balances and last-cycle billing against legacy before go-live.

## 5. Finance and GL seam (kept now, module later)

- Append-only double-entry customer sub-ledger with entry types: charge, payment, adjustment, credit, deposit, write-off, transfer.
- Dimensions on every entry: scheme, zone, category, charge type, payment channel, service period.
- Stable events: `InvoiceIssued`, `PaymentAllocated`, `AdjustmentPosted`, `ReceiptCancelled`, `DepositReceived`, `TransferPosted`.
- Later module: chart of accounts, periods, posting rules as data, idempotent event consumer, manual journals with approval, bank mapping, period close. Control check: sub-ledger total equals GL AR control account.

## 6. Billing engine reference rules

The executable reference for these rules is [billing-engine.html](billing-engine.html). Where the two disagree, this section wins and the HTML is fixed.

**Core formula.** On every actual reading:

```
adjustment = charge(actual - last_actual, months) - sum(unit charges already billed since last_actual)
```

Positive means debit, negative means credit. Standing charges are separate lines and are never re-billed.

**Invoice lines** (always sum to the total):

1. Consumption charge for the span.
2. Less estimates already billed in the span (only if any). The words "true-up" appear only when this line exists.
3. Standing charge or rent.
4. Other typed charges.

If the total is below zero, issue a credit note.

**Scaling.** With `by_period`, each monthly band is multiplied by the months in the span. Each portion of a span is priced at the tariff version in force in that sub-period.

### Invariants (automated tests)

| # | Invariant |
| --- | --- |
| I-1 | After any actual, unit charges billed since the previous actual equal `charge(span)`. |
| I-2 | Balance equals the sum of debits minus credits, always derived. |
| I-3 | Voiding any reading or invoice restores the exact prior state. |
| I-4 | Every invoice's lines sum to its total. |
| I-5 | An estimate never becomes a baseline; an actual below the last actual is rejected unless rollover or meter change is declared. |
| I-6 | A first estimate with no history raises an exception rather than billing zero. |
| I-7 | Total billed for a span is independent of the estimate path (with `by_period`). |
| I-8 | Disconnected, dormant and terminated accounts produce no bills except the final one. |

### Reference tariff (from the legacy statement)

Monthly bands, in KES per unit:

| Units per month | Rate | From Oct 2026 |
| --- | ---: | ---: |
| 0–6 | 82.50 | 95.00 |
| 7–20 | 96.00 | 96.00 |
| 21–50 | 110.00 | 110.00 |
| 51–100 | 131.00 | 131.00 |
| 101–300 | 172.50 | 172.50 |
| Above 300 | unknown (see OQ-1) | unknown |

Standing charge: 150.00 per month.

### Test scenarios

| # | Scenario | Expected |
| --- | --- | --- |
| S-1 | 6 units, estimated | 6 × 82.50 + 150 = 645 (matches legacy) |
| S-2 | 2 units, Oct 2026 tariff | 2 × 95 + 150 = 340 (matches legacy; the earlier unexplained 25 was the tariff change) |
| S-3 | 20 units in a month | 1,839 consumption |
| S-4 | Sep actual 20, Oct estimate 4 units, Nov actual 22, Dec actual 23 | Oct 480; Nov: 165 − 330 + 150 = −15 (credit note); Dec 232.50; total 697.50 equals 3 × 150 + 3 units × 82.50 |
| S-5 | 20 units a month for 3 months, 2 estimated at 10 units, then actual of 60 | Scaled: 5,517, equal to reading every month. Legacy style (month-1 bands for the remainder): 2 × 879 + 4,039 = 5,797 |
| S-6 | Wrong actual keyed 30 instead of 25 (Sep 20, Nov 36) | Credit 5 units in Oct, debit 5 units in Nov, near zero-sum |
| S-7 | Dial 9990 to 0015 on a 4-digit meter | Rollover candidate: 25 units pending confirmation |
| S-8 | Baseline lost at import (prev 6, curr 707) | Held with `NO_BASELINE`; no bill issued |
| S-9 | Disconnect with unbilled dial movement | Closing bill with consumption plus that month's standing charge; none afterward |
| S-10 | Manual disconnection fee plus status change | One fee only |

## 7. Non-functional requirements

### 7.1 Security and isolation

- **NF-01** Database-enforced tenant isolation (row-level security, app role cannot bypass). Caches, files, queues, exports and search indexes tenant-keyed.
- **NF-02** CI isolation test: two tenants with canary data, every endpoint and report run as tenant A must return zero tenant B identifiers.
- **NF-03** Server-side entitlement checks on every route and report.
- **NF-04** Encryption in transit and at rest; provider credentials in a secrets store.
- **NF-05** Strong authentication, MFA for staff, session management, brute-force protection.
- **NF-06** Data protection: consent, retention, access and deletion, breach notification process; Flowless acts as processor.
- **NF-07** Complete audit trail of sensitive actions, tamper-evident.

### 7.2 Performance and scale

- **NF-10** Support at least 1,000 organizations and 1,000,000 accounts in total, with large tenants of 200,000 or more; design so these can grow.
- **NF-11** Billing run throughput: at least 100,000 accounts per hour per tenant, horizontally scalable; interactive screens under 2 seconds at p95.
- **NF-12** Heavy work (billing, imports, reconciliation, messaging) runs as queued jobs, never in request threads. Large tables partitioned by organization and time.
- **NF-13** Reports run on read models, not live OLTP tables; large exports are asynchronous.
- **NF-14** Mobile sync handles thousands of readings per technician per day with resumable uploads.

### 7.3 Reliability and integrity

- **NF-20** Availability 99.9 percent monthly for core; payment callback endpoints designed for 99.95 percent with durable queueing so no callback is lost.
- **NF-21** RPO 15 minutes, RTO 4 hours; tested backups and restore drills; point-in-time recovery.
- **NF-22** All financial writes are append-only and idempotent; no mutation of posted entries.
- **NF-23** Every external call has timeouts, retries with backoff, and a dead-letter queue visible to operators.
- **NF-24** Zero silent failures: any job failure produces a visible exception with owner and age.

### 7.4 Modularity and extensibility

- **NF-30** Module boundaries enforced in code (per-module schemas, no cross-module table access), starting as a modular monolith.
- **NF-31** Absent modules never break others; tested in CI with each module combination matrix.
- **NF-32** Behavior is configuration, never code per tenant. Versioned APIs and event schemas, with backward compatibility.
- **NF-33** Localization: currency, language (English and Kiswahili first), time zone, number and date formats.

### 7.5 Usability

- **NF-40** Exception-queue-first UX, role-based dashboards, fast data grids with saved filters, keyboard-friendly entry for clerks.
- **NF-41** Mobile-first for technician flows: offline, low bandwidth, low-end Android devices, large touch targets, battery-aware GPS.
- **NF-42** Accessibility to WCAG 2.1 AA for portal and web app.
- **NF-43** Customer-facing text in plain language; every number on a bill explainable.

### 7.6 Observability and operations

- **NF-50** Structured logs, metrics and tracing; per-tenant dashboards for job health, queue depth, SMS delivery and payment callbacks.
- **NF-51** Alerts on billing completeness, reconciliation drift, callback failures, SMS wallet.
- **NF-52** Automated deployments, environment parity, migrations that are reversible and zero-downtime.
- **NF-53** Data retention policy per record type, archive without breaking statements.

### 7.7 Testing and quality

- **NF-60** Billing engine property tests for the section 6 invariants and the scenario table, run on every build.
- **NF-61** Replay tests: re-run migrated history through the engine in a sandbox and compare to legacy.
- **NF-62** Load tests for billing run, import, and callback burst at month end.

## 8. Open questions

| ID | Question | Blocks |
| --- | --- | --- |
| OQ-1 | Rate above 300 units a month. In the legacy 689-unit bill, units through 300 cost 46,189. The remaining 139,642 − 46,189 = 93,453 over 389 units implies about 240 per unit above 300, so there are likely higher bands. `billing-engine.html` uses 240.00 as a placeholder. Please confirm the real bands. | Reproducing legacy bills above 300 units (Q-10 parallel run); no S-scenario depends on it. |
