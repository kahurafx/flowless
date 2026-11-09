import type { LatLng } from "@flowless/db";
import { application } from "@flowless/db/schema/accounts";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { loadEntitlements } from "../../kernel/entitlement-store";
import { categoryExists } from "../tariffs";
import type { Placement, Viewer } from "./access";
import { presentApplication, type ApplicationResult } from "./application-present";
import { logStep, publishStageChanged } from "./application-steps";
import type { UserActionEnv } from "../../kernel/action-env";
import { createCustomer, type NewCustomer } from "./customers";
import { claimingId, createdStep } from "./idempotent";
import { assertMembershipClass } from "./memberships";
import { notFound } from "../../kernel/errors";
import { tidy } from "../../kernel/text";
import { assertPlacementInScope, findAccount, findCustomer, validatePlacement } from "./service";

/*
 * Logging an enquiry (C-05). The only step that creates the application row, so it replays
 * by the creator rule of `createdStep` (the same id by the same person returns the same
 * application) instead of a step-log fingerprint.
 */

export interface NewApplication {
  /** Client-minted: a retry returns the same application. */
  id?: string | undefined;
  customerId?: string | undefined;
  /** A customer created together with the application, when there is no existing one. */
  newCustomer?: NewCustomer | undefined;
  requestedCategoryId?: string | undefined;
  parentAccountId?: string | undefined;
  membershipClass?: string | undefined;
  address: string;
  location?: LatLng | undefined;
  schemeId?: string | undefined;
  zoneId?: string | undefined;
  dmaId?: string | undefined;
  routeId?: string | undefined;
  notes?: string | undefined;
}

const applicationCreation = createdStep<typeof application.$inferSelect>({
  find: async (tx, id) => (await tx.select().from(application).where(eq(application.id, id)))[0],
  creatorOf: (a) => a.createdByUserId,
});

/** Logs an enquiry (C-05): the application starts at `enquiry`. */
export function createApplication(env: UserActionEnv, viewer: Viewer, input: NewApplication): Promise<ApplicationResult> {
  return applicationCreation.once(env, input.id, undefined, {
    replay: async (existing) => ({ application: await presentApplication(env.tx, existing) }),
    run: () => applyCreation(env, viewer, input),
  });
}

async function applyCreation(env: UserActionEnv, viewer: Viewer, input: NewApplication) {
  const { tx, organizationId } = env;
  const userId = env.actor.userId;
  if ((input.customerId === undefined) === (input.newCustomer === undefined)) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "Name the customer: an existing one or new customer details" });
  }
  const place: Placement = { schemeId: input.schemeId ?? null, zoneId: input.zoneId ?? null, dmaId: input.dmaId ?? null, routeId: input.routeId ?? null };
  await validatePlacement(tx, place, new Set(["schemeId", "zoneId", "dmaId", "routeId"]));
  // An enquiry may start with no area or route yet (the creator keeps seeing it); one that names a place must be inside the scope.
  if (Object.values(place).some((id) => id !== null)) assertPlacementInScope(viewer, place);
  if (input.requestedCategoryId && (await loadEntitlements(tx)).includes("tariffs")) {
    // Tariffs' published read, only while Tariffs is licensed: without it the category stays an opaque id.
    if (!(await categoryExists(tx, organizationId, input.requestedCategoryId, { activeOnly: true }))) {
      throw new TRPCError({ code: "BAD_REQUEST", message: "That category does not exist or is not active" });
    }
  }
  const parent = input.parentAccountId ? await findAccount(tx, viewer, { id: input.parentAccountId }) : null;
  if (input.membershipClass) await assertMembershipClass(tx, input.membershipClass, parent !== null);
  else if (input.parentAccountId && !parent) throw notFound("Account");

  const customerId = input.customerId
    ? (await findCustomer(tx, viewer, input.customerId)).id
    : (await createCustomer(env, input.newCustomer!)).id;

  const [row] = await claimingId(() =>
    tx
      .insert(application)
      .values({
        ...(input.id ? { id: input.id } : {}),
        organizationId,
        customerId,
        requestedCategoryId: input.requestedCategoryId ?? null,
        parentAccountId: parent?.id ?? null,
        membershipClass: input.membershipClass ?? null,
        address: tidy(input.address),
        location: input.location ?? null,
        ...place,
        notes: input.notes ?? null,
        stage: "enquiry",
        createdByUserId: userId,
      })
      .returning(),
  );
  const step = await logStep(env, row!.id, { kind: "created", from: null, to: "enquiry", reason: "Enquiry logged" });
  await env.audit({
    action: "accounts.application_create",
    subjectType: "application",
    subjectId: row!.id,
    after: { customerId, address: row!.address, requestedCategoryId: row!.requestedCategoryId, parentAccountId: row!.parentAccountId, ...place },
  });
  await publishStageChanged(env, row!, step, null, "enquiry");
  return { application: await presentApplication(tx, row!) };
}
