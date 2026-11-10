# Metering module (`packages/api/src/modules/metering`)

Phase 5 step P5-1a: M-01 to M-05, M-07 (the data side), M-11. Schema `metering` in `packages/db` (migrations `0038_metering.sql`, `0039_metering_access.sql`; see `packages/db/CLAUDE.md`). Not here yet: outcomes and dispositions (M-06), the eligibility snapshot (M-08), miss counters (M-09), the zero-consumption streak policy (M-10), bulk and master meters (M-12), and the Accounts port registrations (`initial_reading` gate, `active_metered_no_meter` rule, reading handover, closing reading; step P5-1b). The module reads other modules only through their `index.ts` (Accounts' `servicePointOf`, `accountVisibleTo`, `visibleAccountIds`; Tariffs' `closedThrough`).

## Procedures
`meteringRouter` mounted at `metering`, from `procedures.ts`: `meters` (`meters:read`), `register` (`meters:read` + `meters:manage`), `read` (`readings:read`), `capture` (+ `readings:capture`), `approve` (+ `readings:approve`). New permissions `meters:read` and `meters:manage` (owner, admin, manager through ALL; supervisor both; accountant, clerk, technician read). Default roles: technician captures, supervisor approves.
- `meters.list/get` (meters), `meters.register`, `meters.changeStatus` (register).
- `installations.list` (meters), `installations.install`, `.remove`, `.replace` (register).
- `readings.record` (capture), `.recordEstimate`, `.correct`, `.approve`, `.void` (approve), `.get`, `.list`, `.latestActual` (read).

## Rules in force
- Meter lifecycle (M-01): `METER_TRANSITIONS` in shared-types. `installed` exactly while there is an open installation: `changeStatus` refuses `installed`, `replaced` and any move out of `installed`; `install`, `remove` and `replace` do those. Every move is an append-only `meter_event` with a client-mintable id (same id and request replays, anything else CONFLICT, via `steps.ts`); a trigger refuses a status change without a matching event.
- Installations: opaque `service_point_id` (existence and account from Accounts' `servicePointOf`); one open installation per meter and per service point; closing sets `removed_at` once (column-level grant plus trigger).
- Readings (M-02): `reading` is insert-only. Status (valid, voided, superseded), `cleared` (may be billed automatically) and a confirmed rollover are rows of `reading_status`; the newest `seq` decides; every reading has a first row (deferred trigger). Previous reading, units and baseline are derived in `reads.ts` (never stored). A baseline is a valid, cleared, non-estimate reading of the same meter. A correction (`correct`) is a new reading with `replaces_reading_id` (unique) and the old one gets a `superseded` row; a void is a `voided` row.
- Client ids (M-04): reading `id` is minted by the device; the same id with the same meter, value, time, source, purpose and reader replays (`replayed: true`), otherwise CONFLICT.
- Validation (M-05, `validate.ts`, pure): flags BELOW_LAST, ROLLOVER_CANDIDATE, ZERO, ABOVE_RANGE, BELOW_RANGE, SAME_DAY_DUPLICATE (organization time zone), OUT_OF_SEQUENCE (back-dated above a later reading) block; ZERO_CONSUMPTION and CLOSED_PERIOD are advisory. Setting `metering.validation` (high factor 3 of the meter's own recent daily use, optional low factor and absolute ceiling, history intervals, rollover fraction). A blocking flag stores `cleared = false`, raises a `READING_EXCEPTION` (subject kind `reading`, key `reading:<id>`, owner the reader, area and route from the service point) and the reading is not a baseline until `approve`; `approve` and `void` resolve the exception. `initial` and `final` readings (meter change) skip the zero and range checks; estimates skip validation.
- Rollover (M-07): drop below the previous reading with wrapped consumption under `rolloverMaxFraction` of the dial range is a candidate; the technician may pass `rolloverConfirmed` at entry or a reviewer `approve({ rollover: true })`; units then count the wrap. A confirmation the arithmetic cannot support is not accepted (BELOW_LAST / BAD_REQUEST).
- Estimates (M-03): `recordEstimate` stores `source = 'estimate'` (`kind: "estimate"`), never validated, never a baseline. Estimation policy (which method, when) is Billing's / later.
- `replaceMeter` (M-07): in one step final reading on the old meter (`purpose = final`), close its installation, old meter `replaced`, install the new meter on the same service point with an `initial` reading, new meter `installed`; replays by `id`. Work Orders will call it later.
- Closed period (M-11): `closedThrough` (Tariffs' port, which Billing fills) says the last closed day; a reading with `read_at` on or before it is accepted, flagged CLOSED_PERIOD (advisory) and published with `inClosedPeriod: true` for Billing's correction document (B-14).
- Scope (K-03): each reading procedure checks the reading's account against `accountVisibleTo` after the change (NOT_FOUND rolls it back); lists filter to `visibleAccountIds`. Meters themselves are not account-scoped.
- Photos (M-04): `photoFileId` is a `kernel.file` id; the file subject kind `reading` (`files.ts`) lets the reader or an approver attach photos after the reading syncs.

## Events and audit
`metering.reading_recorded`, `.reading_status_changed`, `.meter_status_changed`, `.meter_installed`, `.meter_removed`, `.meter_replaced` (`events.ts`). Audit actions `metering.meter_register`, `.meter_status`, `.meter_install`, `.meter_remove`, `.meter_replace`, `.reading_record`, `.reading_approve`, `.reading_void`.

## Published (`index.ts`)
`readingsFor(tx, { servicePointId | meterId | accountId, from, to, validOnly, clearedOnly, actualOnly, order, limit })` and `latestActualReading(tx, { servicePointId | meterId, asOf })` return `ReadingView` with `previousValue` and `units` derived; the pure `validateReading`; the event definitions; `registerKernel` (setting, file subject).

## Assumptions
Dial values are whole numbers (bigint); decimal dials are not modelled. An account is stored on the reading as it was at reading time. `read_at` may not be more than ten minutes in the future. A service point may have only one meter at a time (bulk/master meters are M-12).

## Tests
`validate.test.ts` (pure), `test/metering.test.ts` (integration on `test/test-support.ts`: A with Accounts and Metering, B, C unlicensed); the isolation canary and the module matrix cover every procedure; `packages/db/src/metering.test.ts` covers the append-only and trigger guarantees.
