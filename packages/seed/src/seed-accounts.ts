// Dev data for the foundation domain (Phase 3): tariffs, the charge catalog, accounts at every
// stage of life, applications and a few exceptions, for MAJISAFI. Written through the real API
// as the owner (and the clerk, so the survey approval has a second person), like the rest of the
// seed: permissions, validation and RLS apply. Each part is skipped when it already exists, so a
// re-run changes nothing. Customer names, application addresses and tariff names are the keys.
import { createCaller, sweepDataQuality, sweepStaleAccounts } from "@flowless/api";
import type { Database } from "@flowless/db";
import { sql } from "drizzle-orm";

type Api = ReturnType<typeof createCaller>;
type Place = { lat: number; lng: number };

export interface AccountsSeedContext {
  /** The owner. */
  api: Api;
  /** The clerk (baraka): records surveys and runs the application, so the owner can approve. */
  clerk: Api;
  /** Juma, the technician, who gets the survey job. */
  technicianId: string | null;
  areas: ReadonlyMap<string, string>;
  routes: ReadonlyMap<string, string>;
  /** The runtime connection: the sweeps run on it as the worker would. */
  db: Database;
  /** Delivers outbox events (approval decisions, licence events) as the worker would. */
  drain: () => Promise<unknown>;
  /** The owner connection, only to backdate rows (see `backdate`); null skips the backdating. */
  admin: Database | null;
}

const KAHAWA = { lat: -1.1935, lng: 36.93 };
const GITHURAI = { lat: -1.2012, lng: 36.9194 };
const near = (origin: Place, dLat: number, dLng: number): Place => ({ lat: Number((origin.lat + dLat).toFixed(6)), lng: Number((origin.lng + dLng).toFixed(6)) });
const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const monthsAgoStart = (months: number) => {
  const now = new Date();
  return isoDate(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - months, 1)));
};
const todayNairobi = () => new Date().toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });

export async function seedAccountsData(cx: AccountsSeedContext) {
  const { api } = cx;
  await seedTariffs(api);
  await seedSettings(api);
  const accounts = await seedAccounts(cx);
  await seedApplications(cx);
  await seedRelocation(cx, accounts);
  // The real sweeps, as the worker runs them: stale NEW and PENDING_PAYMENT accounts, and the data-quality rules
  // the organization chose to raise.
  const stale = await sweepStaleAccounts(cx.db);
  const quality = await sweepDataQuality(cx.db);
  return { staleRaised: stale, dataQualityRaised: quality };
}

/* ---------- tariffs and the charge catalog (T-01 to T-03, T-07 to T-10) ---------- */

/** The requirements §6 reference tariff, in minor units per unit (82.50 is 8250); the top band's rate is OQ-1's placeholder. */
const REFERENCE_BANDS = [
  { from: 0, to: 6, rate: 8250n },
  { from: 6, to: 20, rate: 9600n },
  { from: 20, to: 50, rate: 11000n },
  { from: 50, to: 100, rate: 13100n },
  { from: 100, to: 300, rate: 17250n },
  { from: 300, to: null, rate: 24000n },
];
/** The same bands from the scheduled period: the first band rises to 95.00 ("From Oct 2026" in the reference). */
const REVISED_BANDS = REFERENCE_BANDS.map((b, i) => (i === 0 ? { ...b, rate: 9500n } : b));

const CHARGE_AMOUNTS: Record<string, bigint> = {
  standing_charge: 15_000n,
  meter_rent: 5_000n,
  application_fee: 50_000n,
  connection_fee: 250_000n,
  meter: 350_000n,
  materials: 180_000n,
  labour: 120_000n,
  deposit: 200_000n,
  reconnection_fee: 50_000n,
  late_fee: 20_000n,
};

async function seedTariffs(api: Api) {
  const since = monthsAgoStart(4);
  const existing = new Map((await api.tariffs.list()).map((t) => [t.name, t]));

  /** Creates a tariff (its first version in the past) unless it exists; `next` adds the version scheduled for the next period. */
  const tariff = async (
    name: string,
    input: { type: "increasing_block" | "uniform" | "flat_rate"; flatBasis?: "pipe_size"; content: Parameters<Api["tariffs"]["create"]>[0]["content"] },
    next?: { content: Parameters<Api["tariffs"]["create"]>[0]["content"]; note: string },
  ) => {
    const found = existing.get(name);
    let id = found?.id;
    if (!id) id = (await api.tariffs.create({ name, ...input, effectiveFrom: since, note: "Opening tariff" })).id;
    if (next && (found?.versionCount ?? 1) < 2) await api.tariffs.addVersion({ tariffId: id, content: next.content, note: next.note });
    return id;
  };

  const domestic = await tariff(
    "Domestic block tariff",
    { type: "increasing_block", content: { type: "increasing_block", bands: REFERENCE_BANDS } },
    { content: { type: "increasing_block", bands: REVISED_BANDS }, note: "Review: the first band rises from 82.50 to 95.00" },
  );
  const commercial = await tariff("Commercial and institution tariff", { type: "uniform", content: { type: "uniform", rate: 15_000n } });
  const bulk = await tariff("Bulk reseller tariff", { type: "uniform", content: { type: "uniform", rate: 8_500n } });
  const kiosk = await tariff("Kiosk flat rate", { type: "flat_rate", content: { type: "flat_rate", amounts: [{ key: null, amount: 100_000n }] } });
  const farming = await tariff("Farming flat rate by pipe size", {
    type: "flat_rate",
    flatBasis: "pipe_size",
    content: { type: "flat_rate", amounts: [{ key: "15mm", amount: 150_000n }, { key: "25mm", amount: 300_000n }] },
  });

  // Charge catalog amounts: the first from the same past date, and a scheduled rise of the connection fee.
  for (const [code, amount] of Object.entries(CHARGE_AMOUNTS)) {
    const item = await api.tariffs.chargeItems.get({ code });
    if (item.amounts.length === 0) await api.tariffs.chargeItems.addAmountVersion({ chargeItemId: item.id, amount, effectiveFrom: since, reason: "Opening price" });
  }
  const connection = await api.tariffs.chargeItems.get({ code: "connection_fee" });
  if (connection.amounts.length < 2) {
    await api.tariffs.chargeItems.addAmountVersion({ chargeItemId: connection.id, amount: 275_000n, reason: "Pipe prices rise next period" });
  }

  // The six categories on tariffs, with the recurring charges where they apply.
  const items = new Map((await api.tariffs.chargeItems.list()).map((i) => [i.code, i.id]));
  const standing = items.get("standing_charge")!;
  const rent = items.get("meter_rent")!;
  const plan: Record<string, { tariffId: string; recurring: boolean }> = {
    domestic: { tariffId: domestic, recurring: true },
    institution: { tariffId: commercial, recurring: true },
    commercial: { tariffId: commercial, recurring: true },
    kiosk: { tariffId: kiosk, recurring: false },
    reseller: { tariffId: bulk, recurring: false },
    farming: { tariffId: farming, recurring: false },
  };
  for (const category of await api.tariffs.categories.list({ includeInactive: true })) {
    const wanted = plan[category.code];
    if (!wanted) continue;
    if ((await api.tariffs.categories.get({ id: category.id })).history.length > 0) continue;
    await api.tariffs.categories.assignTariff({
      categoryId: category.id,
      tariffId: wanted.tariffId,
      standingChargeItemId: wanted.recurring ? standing : null,
      meterRentItemId: wanted.recurring ? rent : null,
      effectiveFrom: since,
      reason: "Opening assignment",
    });
  }

  // Terms: a new connection is payable as a deposit and then the rest; a monthly invoice charges a late fee and disconnects when long overdue.
  const types = new Map((await api.tariffs.invoiceTypes.list()).map((t) => [t.code, t]));
  const connectionType = types.get("new_connection");
  if (connectionType && connectionType.terms.kind === "full") {
    await api.tariffs.invoiceTypes.update({
      id: connectionType.id,
      dueDays: 14,
      terms: { kind: "minimum_deposit", percentBp: 5000 },
      overdue: { action: "pause_application", afterDays: 7 },
    });
  }
  const usageType = types.get("usage");
  if (usageType && !usageType.lateFeeRule) {
    await api.tariffs.invoiceTypes.update({ id: usageType.id, overdue: { action: "disconnect", afterDays: 30 } });
    await api.tariffs.invoiceTypes.setLateFeeRule({
      id: usageType.id,
      rule: { triggerDays: 7, base: "overdue_balance", rateBp: null, flatAmount: CHARGE_AMOUNTS.late_fee!, cap: 100_000n, frequency: "monthly" },
    });
  }
}

/* ---------- configuration (K-10) ---------- */

async function seedSettings(api: Api) {
  const settings = await api.config.list();
  const current = (key: string) => settings.find((s) => s.key === key)!;
  const membership = current("accounts.membership");
  if (membership.version === 0) {
    await api.config.set({
      key: membership.key,
      expectedVersion: membership.version,
      value: {
        classes: [
          { key: "member", label: "Member", connectionFeeChargeItemCode: "connection_fee" },
          { key: "non_member", label: "Non-member", connectionFeeChargeItemCode: "connection_fee" },
        ],
      },
    });
  }
  // Raise exceptions for two data-quality rules; the others are reports on the dashboard only.
  const quality = current("accounts.data_quality");
  if (quality.version === 0) {
    await api.config.set({
      key: quality.key,
      expectedVersion: quality.version,
      value: { rules: { account_no_phone: { raiseExceptions: true, severity: "warning" }, zone_equals_route: { raiseExceptions: true, severity: "critical" } } },
    });
  }
}

/* ---------- customers and accounts (C-01 to C-12) ---------- */

type Fate = "active" | "dormant" | "terminated" | "disconnected" | "new" | "new_stale" | "pending" | "pending_stale";
interface AccountSpec {
  name: string;
  fate: Fate;
  category: string | null;
  type?: "person" | "organization";
  /** Null leaves the customer without a phone; "placeholder" gives the all-zero number staff type when they have none. */
  phone?: string | null | "placeholder";
  nationalId?: string;
  registrationNumber?: string;
  parent?: string;
  membershipClass?: string;
  area: "KW" | "G45";
  dma?: boolean;
  route: string;
  address: string;
  /** Offsets from the area's centre; null leaves the service point without coordinates. */
  at: [number, number] | null;
  gis?: string;
}

/* Placeholder numbers 0700 000 xxx; ids are made up. */
let phoneCounter = 0;
const nextPhone = () => `0700 000 ${String(++phoneCounter).padStart(3, "0")}`;

const ACCOUNTS: AccountSpec[] = [
  // The water users' group is a parent account; its members are children with letter suffixes and a membership class.
  { name: "Kahawa West Water Users Group", type: "organization", registrationNumber: "CBO/2019/0457", fate: "active", category: "reseller", area: "KW", dma: true, route: "R-07", address: "Group office, Kahawa West Phase 2", at: [-0.0006, 0.0006] },
  { name: "Peter Njoroge", fate: "active", category: "domestic", parent: "Kahawa West Water Users Group", membershipClass: "member", area: "KW", dma: true, route: "R-07", address: "Plot 31, Kahawa West Phase 2", at: [-0.0012, 0.0008] },
  { name: "Grace Wambui", fate: "active", category: "domestic", parent: "Kahawa West Water Users Group", membershipClass: "member", area: "KW", dma: true, route: "R-07", address: "Plot 33, Kahawa West Phase 2", at: [-0.0013, 0.0014] },
  { name: "Samuel Otieno", fate: "new", category: "domestic", parent: "Kahawa West Water Users Group", membershipClass: "non_member", area: "KW", dma: true, route: "R-07", address: "Plot 35, Kahawa West Phase 2", at: [-0.0014, 0.002] },
  // Active and connected, four of them on the GIS connections of the Ruiru network.
  { name: "Mary Akinyi", fate: "active", category: "domestic", area: "KW", dma: true, route: "R-07", address: "Plot 14, Kahawa West", at: [-0.0007, 0.0004], gis: "KW-0001" },
  { name: "James Mutua", fate: "active", category: "domestic", area: "KW", dma: true, route: "R-07", address: "Plot 16, Kahawa West", at: [-0.0009, 0.0011], gis: "KW-0002" },
  { name: "Esther Chebet", fate: "active", category: "domestic", area: "KW", dma: true, route: "R-07", address: "Plot 22, Kahawa West", at: [-0.001, 0.0027], gis: "KW-0003" },
  { name: "Daniel Kiplagat", fate: "active", category: "kiosk", area: "KW", dma: true, route: "R-07", address: "Water kiosk, Kahawa West stage", at: [-0.0003, 0.0021], gis: "KW-0004" },
  { name: "Hassan Abdi", fate: "active", category: "commercial", area: "KW", route: "R-07", address: "Abdi Hardware, Kahawa West shopping centre", at: [0.0004, 0.0031] },
  { name: "Kahawa West Primary School", type: "organization", registrationNumber: "SCH/KW/0113", fate: "active", category: "institution", area: "KW", route: "R-07", address: "Kahawa West Primary School", at: [0.0011, -0.0008] },
  { name: "Joseph Karanja", fate: "active", category: "domestic", area: "G45", route: "R-02", address: "Block C, Githurai 45", at: [-0.0004, 0.0007] },
  { name: "Lucy Naliaka", fate: "active", category: "domestic", area: "G45", route: "R-02", address: "Block D, Githurai 45", at: [-0.0009, 0.0012] },
  // Deliberate data-quality gaps: no phone, a placeholder phone, no coordinates, one national id shared by two customers, a route entered as the zone, no category.
  { name: "Ruth Moraa", fate: "active", category: "domestic", phone: null, area: "KW", dma: true, route: "R-07", address: "Plot 40, Kahawa West", at: [-0.0018, 0.0009] },
  { name: "Patrick Omondi", fate: "active", category: "domestic", area: "KW", dma: true, route: "R-07", address: "Plot 42, Kahawa West (GPS not taken)", at: null },
  { name: "Alice Njeri", fate: "active", category: "domestic", nationalId: "24681357", area: "KW", dma: true, route: "R-07", address: "Plot 44, Kahawa West", at: [-0.0021, 0.0016] },
  { name: "Alex Njenga", fate: "active", category: "domestic", nationalId: "24681357", area: "KW", dma: true, route: "R-07", address: "Plot 46, Kahawa West", at: [-0.0022, 0.0021] },
  { name: "Tabitha Wangari", fate: "active", category: "domestic", area: "KW", route: "R-02", address: "Plot 48, Kahawa West (route keyed from Githurai)", at: [-0.0024, 0.0012] },
  { name: "Samson Kiprop", fate: "active", category: null, area: "KW", dma: true, route: "R-07", address: "Plot 50, Kahawa West", at: [-0.0026, 0.0018] },
  // The rest of the life cycle.
  { name: "Beatrice Atieno", fate: "dormant", category: "domestic", phone: "placeholder", area: "KW", dma: true, route: "R-07", address: "Plot 52, Kahawa West (owner abroad)", at: [-0.0027, 0.0024] },
  { name: "Moses Kariuki", fate: "dormant", category: "domestic", area: "G45", route: "R-02", address: "Block E, Githurai 45 (vacant)", at: [-0.0015, 0.0003] },
  { name: "Nelson Oduor", fate: "terminated", category: "domestic", area: "KW", route: "R-07", address: "Plot 9, Kahawa West", at: [-0.0004, -0.0006] },
  { name: "Francis Maina", fate: "disconnected", category: "domestic", area: "KW", dma: true, route: "R-07", address: "Plot 27, Kahawa West", at: [-0.0016, 0.0019] },
  { name: "Irene Chepkoech", fate: "new", category: "domestic", area: "G45", route: "R-02", address: "Block F, Githurai 45", at: [-0.002, 0.0009] },
  // Dev-only: made to look old so the stale-account sweep has something to raise.
  { name: "Kevin Otieno", fate: "new_stale", category: "domestic", area: "KW", dma: true, route: "R-07", address: "Plot 55, Kahawa West", at: [-0.003, 0.0014] },
  { name: "Sharon Achieng", fate: "pending_stale", category: "domestic", area: "KW", dma: true, route: "R-07", address: "Plot 57, Kahawa West", at: [-0.0031, 0.0019] },
];

/** The succession pair, the change of name and the customer who moves (their accounts are among those above). */
const SUCCESSION = { from: "Joseph Karanja", to: { name: "Margaret Karanja", nationalId: "30112244" }, reason: "Account holder died: his widow takes over, with her own number" };
const NAME_CHANGE = { account: "Hassan Abdi", to: "Abdi Hardware Limited", registrationNumber: "PVT-ABC123", reason: "The shop was incorporated" };

async function seedAccounts(cx: AccountsSeedContext) {
  const { api } = cx;
  const categories = new Map((await api.tariffs.categories.list({ includeInactive: true })).map((c) => [c.code, c.id]));
  const connections = new Map((await api.gis.connections.list()).map((c) => [c.connectionNumber, c.id]));
  const have = new Map((await api.accounts.list({ limit: 200 })).map((a) => [a.customerName, a]));
  const created: Record<string, Awaited<ReturnType<Api["accounts"]["create"]>>> = {};
  const servicePoints = new Map<string, string>();
  const centre = { KW: KAHAWA, G45: GITHURAI };
  const areaIds = (spec: AccountSpec) => {
    const zone = cx.areas.get(spec.area)!;
    return {
      schemeId: cx.areas.get("RUI")!,
      zoneId: zone,
      ...(spec.dma ? { dmaId: cx.areas.get("DMA-KW1")! } : {}),
      routeId: cx.routes.get(spec.route)!,
    };
  };

  for (const spec of ACCOUNTS) {
    const known = have.get(spec.name);
    if (known) {
      created[spec.name] = known as never;
      continue;
    }
    const phone = spec.phone === undefined ? nextPhone() : spec.phone === "placeholder" ? "0000 000 000" : spec.phone;
    const customer = await api.accounts.customers.create({
      type: spec.type ?? "person",
      name: spec.name,
      ...(spec.nationalId ? { nationalId: spec.nationalId } : spec.type === "organization" ? {} : { nationalId: String(20_000_000 + Math.abs(hash(spec.name)) % 9_999_999) }),
      ...(spec.registrationNumber ? { registrationNumber: spec.registrationNumber } : {}),
      contacts: phone ? [{ channel: "phone", value: phone, kind: "personal", isPrimary: spec.phone !== "placeholder" }] : [],
    });
    const parent = spec.parent ? created[spec.parent] : undefined;
    const account = await api.accounts.create({
      customerId: customer.id,
      ...(parent ? { parentAccountId: parent.id, numbering: "suffix" as const } : {}),
      ...(spec.category ? { categoryId: categories.get(spec.category)! } : {}),
      ...(spec.membershipClass ? { membershipClass: spec.membershipClass } : {}),
    });
    created[spec.name] = account as never;
    const place = spec.at ? near(centre[spec.area], ...spec.at) : undefined;
    const point = await api.accounts.servicePoints.create({
      accountId: account.id,
      address: spec.address,
      ...(place ? { location: place } : {}),
      ...areaIds(spec),
      connectionStatus: spec.fate === "active" || spec.fate === "dormant" || spec.fate === "terminated" ? "CONNECTED" : "PLANNED",
      // Accounts holds the GIS connection by id only; GIS's own `service_point_id` is set when the connection is captured, which the network seed did before any service point existed.
      ...(spec.gis && connections.get(spec.gis) ? { gisConnectionId: connections.get(spec.gis)! } : {}),
    });
    servicePoints.set(spec.name, point.id);
    await liveTo(cx, account.id, point.id, spec.fate);
  }

  // Succession (C-08): a full successor with its own number and a new holder; the old account goes dormant.
  const from = created[SUCCESSION.from];
  if (from && !(await api.accounts.get({ id: from.id })).successorAccountId && !have.has(SUCCESSION.to.name)) {
    await api.accounts.succeed({
      accountId: from.id,
      basis: "change_of_name",
      newCustomer: { type: "person", name: SUCCESSION.to.name, nationalId: SUCCESSION.to.nationalId, contacts: [{ channel: "phone", value: nextPhone(), kind: "personal", isPrimary: true }] },
      reason: SUCCESSION.reason,
    });
  }
  // Change of name (C-10): the same account number, a new holder from today.
  const renamed = created[NAME_CHANGE.account];
  if (renamed && cx.admin && (await api.accounts.holders.list({ accountId: renamed.id })).length < 2) {
    // DEV ONLY: a holder who took over today cannot be replaced today, so the opening holder is dated years back.
    await backdate(cx, sql`update accounts.account_holder set valid_from = date '2020-01-01' where account_id = ${renamed.id}`);
    await api.accounts.changeName({
      accountId: renamed.id,
      newCustomer: { type: "organization", name: NAME_CHANGE.to, registrationNumber: NAME_CHANGE.registrationNumber, contacts: [{ channel: "phone", value: nextPhone(), kind: "work", isPrimary: true }] },
      effectiveDate: todayNairobi(),
      reason: NAME_CHANGE.reason,
    });
  }
  return { created, servicePoints };
}

/** Takes a new account to the status its story calls for, through the real commands. */
async function liveTo(cx: AccountsSeedContext, accountId: string, servicePointId: string, fate: Fate) {
  const { api } = cx;
  const activate = async () => {
    let status = await api.accounts.activation.status({ accountId });
    // With payment as a gate a new account goes through PENDING_PAYMENT first.
    if (status.needsPendingPaymentFirst) await api.accounts.markPendingPayment({ accountId, reason: "Connection invoice paid at the office" });
    status = await api.accounts.activation.status({ accountId });
    // No Billing, Work Orders-and-Inventory or Metering behind the gates yet: the office ticks the checklist.
    for (const gate of status.gates) {
      if (gate.state === "unmet" && gate.via === "checklist") await api.accounts.activation.tick({ accountId, gateKey: gate.key, note: "Dev seed: migrated from the paper register" });
    }
    await api.accounts.activate({ accountId, reason: "Gates met" });
  };

  switch (fate) {
    case "active":
      return activate();
    case "dormant":
      await activate();
      return void (await api.accounts.makeDormant({ accountId, reason: "Customer away, asked to pause the account", reasonCode: "customer_request" }));
    case "terminated":
      await activate();
      await api.accounts.terminate({ accountId, reason: "Customer left the scheme", reasonCode: "left_scheme", acknowledgeNoLedger: true });
      return void (await api.accounts.servicePoints.update({ id: servicePointId, patch: { connectionStatus: "DECOMMISSIONED" } }));
    case "disconnected":
      await activate();
      await api.accounts.disconnectService({ accountId, reason: "Non-payment: three months overdue", reasonCode: "non_payment" });
      return void (await api.accounts.servicePoints.update({ id: servicePointId, patch: { connectionStatus: "DISCONNECTED" } }));
    case "new":
      return;
    case "new_stale":
      return backdate(cx, sql`update accounts.account set opened_at = now() - interval '30 days' where id = ${accountId}`);
    case "pending":
      return void (await api.accounts.markPendingPayment({ accountId, reason: "Connection invoice issued" }));
    case "pending_stale":
      await api.accounts.markPendingPayment({ accountId, reason: "Connection invoice issued" });
      return backdate(cx, sql`update accounts.account_command set occurred_at = now() - interval '30 days' where account_id = ${accountId} and kind = 'mark_pending_payment'`);
  }
}

/**
 * DEV ONLY: age a row so the stale-account sweep has something to find. There is no API for it
 * (and must not be): `opened_at` and a command's time are history. This goes through the owner
 * connection, the way the integration tests backdate, and is skipped without DATABASE_ADMIN_URL.
 */
async function backdate(cx: AccountsSeedContext, statement: ReturnType<typeof sql>) {
  if (!cx.admin) {
    console.warn("  (DATABASE_ADMIN_URL is not set: leaving the stale accounts young, so no STALE_ACTIVATION exception will be raised)");
    return;
  }
  await cx.admin.execute(statement);
}

function hash(text: string) {
  let h = 7;
  for (const ch of text) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return h;
}

/* ---------- applications (C-05) ---------- */

interface ApplicationSpec {
  name: string;
  address: string;
  area: "KW" | "G45";
  at: [number, number];
  stage: "enquiry" | "survey_pending" | "survey_job" | "application" | "invoiced" | "ready" | "converted";
}

const APPLICATIONS: ApplicationSpec[] = [
  { name: "Nancy Wanjiku", address: "Plot 61, Kahawa West Phase 2 (survey booked)", area: "KW", at: [-0.0033, 0.0007], stage: "survey_job" },
  { name: "Peter Kamau", address: "Plot 63, Kahawa West Phase 2", area: "KW", at: [-0.0035, 0.0013], stage: "survey_pending" },
  { name: "Lydia Auma", address: "Plot 65, Kahawa West Phase 2", area: "KW", at: [-0.0036, 0.0019], stage: "application" },
  { name: "Carol Muthoni", address: "Block G, Githurai 45", area: "G45", at: [-0.0021, 0.0017], stage: "invoiced" },
  { name: "Brian Ochieng", address: "Block H, Githurai 45", area: "G45", at: [-0.0023, 0.0021], stage: "ready" },
  { name: "Dennis Mwangi", address: "Plot 67, Kahawa West Phase 2", area: "KW", at: [-0.0038, 0.0025], stage: "converted" },
];

async function seedApplications(cx: AccountsSeedContext) {
  const { api, clerk } = cx;
  const have = new Set((await api.accounts.applications.list({ limit: 200 })).map((a) => a.address));
  const categoryId = (await api.tariffs.categories.list()).find((c) => c.code === "domestic")?.id;
  const centre = { KW: KAHAWA, G45: GITHURAI };

  for (const spec of APPLICATIONS) {
    if (have.has(spec.address)) continue;
    const place = near(centre[spec.area], ...spec.at);
    const { application } = await clerk.accounts.applications.create({
      newCustomer: { type: "person", name: spec.name, nationalId: String(30_000_000 + Math.abs(hash(spec.name)) % 9_999_999), contacts: [{ channel: "phone", value: nextPhone(), kind: "personal", isPrimary: true }] },
      address: spec.address,
      location: place,
      schemeId: cx.areas.get("RUI")!,
      zoneId: cx.areas.get(spec.area)!,
      routeId: cx.routes.get(spec.area === "KW" ? "R-07" : "R-02")!,
      ...(categoryId ? { requestedCategoryId: categoryId } : {}),
    });
    const id = application.id;
    const step = clerk.accounts.applications;

    if (spec.stage === "survey_job") {
      // Work Orders: the office raises the survey job against the application; Juma is to visit.
      await api.workOrders.create({
        kind: "connection_survey",
        title: `Survey ${spec.address}`,
        assetId: id,
        location: { latitude: place.lat, longitude: place.lng },
        assigneeId: cx.technicianId,
      });
      continue;
    }
    const survey = await step.recordSurvey({ applicationId: id, feasibility: "feasible", findings: "Main about 20 m away, no road crossing", materialsNote: "20 m of 25 mm pipe, one meter" });
    if (spec.stage === "survey_pending") continue; // enquiry, survey waiting for approval
    await api.approvals.approve({ id: survey.approval!.id, note: "Dev seed" });
    await cx.drain();
    await step.submitApplication({ applicationId: id });
    if (spec.stage === "application") continue;
    await step.markInvoiced({ applicationId: id, invoiceRef: `NC-${String(100 + APPLICATIONS.indexOf(spec)).padStart(6, "0")}` });
    if (spec.stage === "invoiced") continue;
    await step.markPaid({ applicationId: id, paymentRef: `MPESA-DEV-${APPLICATIONS.indexOf(spec)}` });
    await step.startInstallation({ applicationId: id });
    await step.markReady({ applicationId: id });
    if (spec.stage === "ready") continue;
    await step.convert({ applicationId: id }); // the account is opened PENDING_PAYMENT
  }
}

/* ---------- relocation (C-09) ---------- */

async function seedRelocation(cx: AccountsSeedContext, accounts: Awaited<ReturnType<typeof seedAccounts>>) {
  const { api } = cx;
  const account = accounts.created["James Mutua"];
  const from = accounts.servicePoints.get("James Mutua") ?? (account ? (await api.accounts.servicePoints.list({ accountId: account.id }))[0]?.id : undefined);
  if (!account || !from || (await api.accounts.relocations.list({ accountId: account.id })).length > 0) return;
  const to = near(GITHURAI, -0.0007, 0.0004);
  const { relocation } = await api.accounts.relocations.request({
    accountId: account.id,
    fromServicePointId: from,
    to: { address: "Block J, Githurai 45", location: to, schemeId: cx.areas.get("RUI")!, zoneId: cx.areas.get("G45")!, routeId: cx.routes.get("R-02")! },
    reason: "Customer is moving house within the scheme",
    feeItemCodes: ["connection_fee"],
  });
  // In progress: surveyed and waiting for the work and completion.
  await api.accounts.relocations.recordSurvey({ relocationId: relocation.id, feasibility: "feasible", findings: "Main 5 m from the new plot" });
}
