import type { LatLng, Transaction } from "@flowless/db";
import { account, servicePoint } from "@flowless/db/schema/accounts";
import { TRPCError } from "@trpc/server";
import type { Viewer } from "./access";
import { eq } from "drizzle-orm";
import { planAdvance } from "./application-stages";
import { configOf, findApplication, placeOf, presentApplication, userOf } from "./application-present";
import { applicationLog, moveStage } from "./application-steps";
import { fingerprintOfRequest, runCommand, type CommandEnv } from "./commands";
import { applicationConverted } from "./events";
import { openAccount } from "./open-account";
import { createServicePoint } from "./service-points";
import { presentAccount, toServicePointDto } from "./service";

/*
 * Converting a ready application into an account (C-05). The application keeps the
 * account's and service point's ids; activation stays the F3a gates' business.
 */

/**
 * Converts a ready application into an account (C-05): opens the account with the next
 * number (a child under `parentAccountId`, with its membership class), creates the service
 * point from the requested place, and, when the organization uses the new-connection
 * invoice, moves the account NEW to PENDING_PAYMENT with the F3a command.
 */
export async function convertApplication(
  env: CommandEnv,
  viewer: Viewer,
  req: { id?: string | undefined; applicationId: string; reason: string },
) {
  const { tx } = env;
  const userId = userOf(env);
  const before = await findApplication(tx, viewer, req.applicationId, true);
  const fingerprint = fingerprintOfRequest({ kind: "stage_changed", action: "convert", applicationId: req.applicationId, reason: req.reason });
  return applicationLog.once(
    env,
    req.id,
    { parentId: before.id, kind: "stage_changed", fingerprint },
    {
      replay: async () => ({ application: await presentApplication(tx, before), ...(await createdBy(tx, before.accountId, before.servicePointId)) }),
      run: async () => {
        const config = await configOf(tx);
        const plan = planAdvance(before.stage, "convert", config);
        if (!plan.ok) throw new TRPCError({ code: "PRECONDITION_FAILED", message: plan.problem });

        const userEnv = { tx, organizationId: env.organizationId, userId, audit: env.audit, publish: env.publish };
        const row = await openAccount(userEnv, viewer, {
          customerId: before.customerId,
          parentAccountId: before.parentAccountId ?? undefined,
          categoryId: before.requestedCategoryId,
          membershipClass: before.membershipClass,
        });
        const point = await createServicePoint(userEnv, viewer, {
          accountId: row.id,
          address: before.address,
          location: before.location as LatLng | null,
          ...placeOf(before),
          connectionStatus: "PLANNED",
        });
        const moved = await moveStage(env, before, {
          id: req.id,
          to: "converted",
          reason: req.reason,
          payload: { accountId: row.id, accountNumber: row.number, servicePointId: point.id },
          fingerprint,
          set: { accountId: row.id, servicePointId: point.id },
          action: "application_convert",
        });
        if (config.invoice.required) {
          // The new-connection invoice is out: payment is awaited (F3a command, logged and audited as any status change).
          await runCommand(env, viewer, {
            kind: "mark_pending_payment",
            accountId: row.id,
            reason: `New-connection invoice for application ${before.id.slice(0, 8)}`,
          });
        }
        await env.publish(applicationConverted, {
          applicationId: before.id,
          accountId: row.id,
          accountNumber: row.number,
          servicePointId: point.id,
          customerId: before.customerId,
          categoryId: before.requestedCategoryId,
          parentAccountId: before.parentAccountId,
          membershipClass: before.membershipClass,
          convertedByUserId: userId,
          occurredAt: moved.event.occurredAt.toISOString(),
        });
        return { application: await presentApplication(tx, moved.row), ...(await createdBy(tx, row.id, point.id)) };
      },
    },
  );
}

/** The account and service point a converted application made, as the caller sees them. */
async function createdBy(tx: Transaction, accountId: string | null, servicePointId: string | null) {
  if (!accountId || !servicePointId) return {};
  const [acc] = await tx.select().from(account).where(eq(account.id, accountId));
  const [sp] = await tx.select().from(servicePoint).where(eq(servicePoint.id, servicePointId));
  if (!acc || !sp) return {};
  return { account: await presentAccount(tx, acc), servicePoint: toServicePointDto(sp) };
}
