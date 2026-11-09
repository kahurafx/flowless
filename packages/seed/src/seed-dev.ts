// Dev-only seed (`pnpm db:seed`). Idempotent. Identities come from @flowless/auth; every
// other row is written through the real API as the organization's owner, so seeds obey
// the same permissions, validation and RLS as the app.
import { consumers, createCaller, drainOutbox, setEntitlements } from "@flowless/api";
import { connectAuth } from "@flowless/auth";
import { DEV_ORGANIZATIONS, DEV_PASSWORD, seedDevIdentities } from "@flowless/auth/dev-seed";
import { createDatabase } from "@flowless/db";
import { ORGANIZATION_CODE_HEADER, qualifiedUsername, type AreaLevel, type ModuleKey } from "@flowless/shared-types";
import { seedAccountsData } from "./seed-accounts";
import { seedJobs, seedRuiruNetwork } from "./seed-network";

const authUrl = process.env.DATABASE_AUTH_URL;
const appUrl = process.env.DATABASE_URL;
if (!authUrl || !appUrl) throw new Error("DATABASE_AUTH_URL and DATABASE_URL must be set (see .env.example)");
if (process.env.NODE_ENV === "production") throw new Error("Refusing to seed dev data in production");

interface AreaSeed {
  level: AreaLevel;
  code: string;
  name: string;
  parent?: string;
}
interface RouteSeed {
  code: string;
  name: string;
  parent?: string;
  area?: string;
}

/** Names match the account mocks in apps/web/src/mocks/accounts.ts. */
const KERNEL: Record<
  string,
  {
    /** Licensed modules (K-04). */
    modules: ModuleKey[];
    areas: AreaSeed[];
    routes: RouteSeed[];
    /** Staff username (or owner email) → area or route codes they are limited to. */
    scopes: Record<string, { areas?: string[]; routes?: string[] }>;
  }
> = {
  majisafi: {
    modules: ["accounts", "tariffs", "metering", "billing", "payments", "communications", "collections", "work-orders", "gis", "reporting"],
    areas: [
      { level: "scheme", code: "RUI", name: "Ruiru scheme" },
      { level: "zone", code: "KW", name: "Kahawa West", parent: "RUI" },
      { level: "zone", code: "G45", name: "Githurai 45", parent: "RUI" },
      { level: "zone", code: "KS", name: "Kahawa Sukari", parent: "RUI" },
      { level: "sub_zone", code: "KW-P2", name: "Kahawa West Phase 2", parent: "KW" },
      { level: "dma", code: "DMA-KW1", name: "DMA Kahawa West 1", parent: "KW-P2" },
      { level: "dma", code: "DMA-G1", name: "DMA Githurai 1", parent: "G45" },
    ],
    routes: [
      { code: "NORTH", name: "North readers", area: "RUI" },
      { code: "R-07", name: "Route 7 · Kahawa West", parent: "NORTH", area: "KW" },
      { code: "R-02", name: "Route 2 · Githurai 45", parent: "NORTH", area: "G45" },
      { code: "R-11", name: "Route 11 · Kahawa Sukari", parent: "NORTH", area: "KS" },
    ],
    scopes: { achieng: { areas: ["KW"] } },
  },
  kilima: {
    // A small project licensed for the foundation only.
    modules: ["accounts", "tariffs", "metering", "billing", "payments"],
    areas: [
      { level: "scheme", code: "KIL", name: "Kilima scheme" },
      { level: "zone", code: "KJ", name: "Kilima Juu", parent: "KIL" },
      { level: "zone", code: "KC", name: "Kilima Chini", parent: "KIL" },
    ],
    routes: [
      { code: "K-1", name: "Route K-1 · Kilima Juu", area: "KJ" },
      { code: "K-2", name: "Route K-2 · Kilima Chini", area: "KC" },
    ],
    scopes: { chebet: { routes: ["K-1"] } },
  },
};

await seedDevIdentities(authUrl);

const identity = connectAuth(authUrl);
const database = createDatabase(appUrl);
// Only to backdate the stale accounts in seed-accounts.ts; without it that one step is skipped.
const adminUrl = process.env.DATABASE_ADMIN_URL;
const admin = adminUrl ? createDatabase(adminUrl) : null;

/** Signs in the way the app does (organization code header, then email or the code-qualified username). */
async function signIn(code: string, who: { email: string } | { username: string }) {
  const orgHeader = new Headers({ [ORGANIZATION_CODE_HEADER]: code });
  const { headers: signedIn } =
    "email" in who
      ? await identity.auth.api.signInEmail({ body: { email: who.email, password: DEV_PASSWORD }, headers: orgHeader, returnHeaders: true })
      : await identity.auth.api.signInUsername({ body: { username: qualifiedUsername(code, who.username), password: DEV_PASSWORD }, headers: orgHeader, returnHeaders: true });
  const headers = new Headers({ cookie: signedIn.getSetCookie().map((c) => c.split(";")[0]).join("; ") });
  const caller = await identity.getCaller(headers);
  if (!caller?.member) throw new Error(`Could not sign in as ${"email" in who ? who.email : who.username}`);
  return { headers, caller };
}
try {
  // Onboarding publishes organization.created; deliver it now (the worker would) so new
  // organizations get their settings before the API is used.
  await drainOutbox(database.db, consumers);

  for (const org of DEV_ORGANIZATIONS) {
    const plan = KERNEL[org.code];
    if (!plan) continue;

    // Act as the owner, signed in the way the app signs in.
    const { headers, caller } = await signIn(org.code, { email: org.owner.email });
    const organizationId = caller.member!.organizationId;
    const api = createCaller({ db: database.db, session: caller });

    // Licences are set by Flowless, never by the tenant, so there is no procedure for this.
    await setEntitlements(database.db, organizationId, plan.modules);
    // Licensing publishes entitlements.changed, which is what gives Tariffs its default categories,
    // charge items and invoice types (and GIS its attachment rules): settle it before the API is used.
    await drainOutbox(database.db, consumers);
    // A database licensed for Tariffs before Tariffs could seed its defaults never got the licence event, so the
    // catalog is empty and no change of licence will come: license again from nothing so the event fires once.
    if (plan.modules.includes("tariffs") && (await api.tariffs.categories.list({ includeInactive: true })).length === 0) {
      await setEntitlements(database.db, organizationId, [], { label: "Flowless", reason: "Dev seed: re-license so Tariffs adds its defaults" });
      await drainOutbox(database.db, consumers);
      await setEntitlements(database.db, organizationId, plan.modules, { label: "Flowless", reason: "Dev seed: re-license so Tariffs adds its defaults" });
      await drainOutbox(database.db, consumers);
    }

    const areas = new Map((await api.hierarchy.areas({ includeArchived: true })).map((a) => [a.code, a.id]));
    for (const a of plan.areas) {
      if (areas.has(a.code)) continue;
      const created = await api.hierarchy.createArea({
        level: a.level,
        code: a.code,
        name: a.name,
        parentId: a.parent ? areas.get(a.parent)! : null,
      });
      areas.set(a.code, created.id);
    }

    const routes = new Map((await api.hierarchy.routes({ includeArchived: true })).map((r) => [r.code, r.id]));
    for (const r of plan.routes) {
      if (routes.has(r.code)) continue;
      const created = await api.hierarchy.createRoute({
        code: r.code,
        name: r.name,
        parentId: r.parent ? routes.get(r.parent)! : null,
        areaId: r.area ? areas.get(r.area)! : null,
      });
      routes.set(r.code, created.id);
    }

    const { members } = await identity.auth.api.listMembers({ headers, query: { organizationId } });
    for (const [who, scope] of Object.entries(plan.scopes)) {
      const person = members.find((m) => m.user.email === who || m.user.email.startsWith(`${who}@`));
      if (!person) throw new Error(`No member ${who} in ${org.code}`);
      await api.access.setScope({
        userId: person.userId,
        areaIds: (scope.areas ?? []).map((c) => areas.get(c)!),
        routeIds: (scope.routes ?? []).map((c) => routes.get(c)!),
      });
    }

    // Work Orders and GIS (Phase 2): a small network and a few jobs, only where both are licensed.
    if (plan.modules.includes("gis") && plan.modules.includes("work-orders") && org.code === "majisafi") {
      await seedRuiruNetwork(api, areas);
      await seedJobs(api, areas, members.map((m) => ({ id: m.userId, who: m.user.email.split("@")[0] === "wanjiru" ? m.user.email : m.user.email.split("@")[0]! })));
    }

    // Tariffs and Accounts (Phase 3), after the network so service points can name its connections.
    if (plan.modules.includes("accounts") && plan.modules.includes("tariffs") && org.code === "majisafi") {
      await drainOutbox(database.db, consumers);
      const clerk = await signIn(org.code, { username: "baraka" });
      const outcome = await seedAccountsData({
        api,
        clerk: createCaller({ db: database.db, session: clerk.caller }),
        technicianId: members.find((m) => m.user.email.startsWith("juma@"))?.userId ?? null,
        areas,
        routes,
        db: database.db,
        drain: () => drainOutbox(database.db, consumers),
        admin: admin?.db ?? null,
      });
      console.log("Accounts seed: %d stale and %d data-quality exceptions raised this run", outcome.staleRaised, outcome.dataQualityRaised);
    }
    // Let whatever the seed published (approvals, status changes) settle, as the worker would.
    await drainOutbox(database.db, consumers);
  }

  console.log("Dev sign-in (password: %s):", DEV_PASSWORD);
  for (const org of DEV_ORGANIZATIONS) {
    const scopes = KERNEL[org.code]?.scopes ?? {};
    const staff = org.staff.map((s) => {
      const limit = scopes[s.username];
      const where = limit ? `, limited to ${[...(limit.areas ?? []), ...(limit.routes ?? [])].join(", ")}` : "";
      return `${s.username} (${s.role}${where})`;
    });
    console.log(`  ${org.code.toUpperCase()}: ${org.owner.email} (owner), ${staff.join(", ")}`);
    console.log(`    modules: ${KERNEL[org.code]?.modules.join(", ")}`);
  }
} finally {
  await identity.close();
  await admin?.close();
  await database.close();
}
