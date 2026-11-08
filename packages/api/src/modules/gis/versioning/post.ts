import { TRPCError } from "@trpc/server";
import { and, eq, inArray, ne } from "drizzle-orm";
import { z } from "zod";
import { photoCounts } from "../../../kernel/file-subjects";
import { router } from "../../../trpc";
import { BranchSchema, MAIN, rethrowDbError } from "../common";
import { emit, gisConnectionPosted } from "../events";
import { GIS_ASSET_FILES } from "../files";
import type { GisProcedures } from "../procedures";
import { applyWrite, assertNotMain, findViolations, retireHead, type Applied } from "./branch-apply";
import {
  branchChain,
  describePlan,
  entityName,
  headsToken,
  IntegrityFailure,
  KINDS,
  loadEntries,
  needsPhotoEvidence,
  planFor,
  selectRows,
  wireConflict,
  type AnyRow,
} from "./branch-entries";

/**
 * Reconcile (G-02), ported from Majimap's versioning/post.ts: list open branches, preview
 * what posting one would do, post it to main all-or-nothing, or discard it.
 */
export function reconcileRouter(p: GisProcedures) {
  return router({
    /**
     * Every open branch in the organization: what the pending-changes screen lists.
     * `changes` counts entities (of any kind) that have a head on the branch. Who edited it
     * and when cover each head's whole chain of versions back to the fork point, so a
     * reused branch name never inherits an earlier, already-posted round. Authors are user
     * ids (names come from the kernel's member list; GIS never reads identities).
     */
    branches: p.read.query(async ({ ctx }) => {
      const byBranch = new Map<string, { changes: number; versions: Map<string, AnyRow> }>();
      for (const kind of KINDS) {
        const table = kind.table;
        const heads = await selectRows(ctx.tx, kind, and(eq(table.organizationId, ctx.organizationId), eq(table.isHead, true), ne(table.branch, MAIN)));
        if (heads.length === 0) continue;
        const openBranches = [...new Set(heads.map((h) => h.branch))];
        const onOpenBranches = await selectRows(ctx.tx, kind, and(eq(table.organizationId, ctx.organizationId), inArray(table.branch, openBranches)));
        const byVersion = new Map(onOpenBranches.map((row) => [row.versionId, row]));
        for (const head of heads) {
          const summary = byBranch.get(head.branch) ?? { changes: 0, versions: new Map<string, AnyRow>() };
          summary.changes++;
          for (const version of branchChain(head, byVersion)) summary.versions.set(version.versionId, version);
          byBranch.set(head.branch, summary);
        }
      }

      const summaries = [...byBranch.entries()].map(([branch, { changes, versions }]) => {
        const rows = [...versions.values()];
        const times = rows.map((v) => v.createdAt.getTime());
        return {
          branch,
          changes,
          firstEditAt: new Date(Math.min(...times)),
          lastEditAt: new Date(Math.max(...times)),
          authorIds: [...new Set(rows.map((v) => v.createdByUserId))],
        };
      });
      const origins = await ctx.work.annotateBranches(
        ctx.tx,
        summaries.map((s) => s.branch),
      );
      return summaries
        .map((s) => ({ ...s, /** Which job (or other module's work) this branch belongs to, if any. */ origin: origins.get(s.branch) ?? null }))
        .sort((a, b) => b.lastEditAt.getTime() - a.lastEditAt.getTime());
    }),

    /**
     * What posting this branch would do, entity by entity, without doing it. Doesn't check
     * what the result would do to references (see `post`): that needs the writes applied.
     */
    preview: p.read.input(z.object({ branch: BranchSchema })).query(async ({ ctx, input }) => {
      assertNotMain(input.branch);
      const entries = await loadEntries(ctx.tx, ctx.organizationId, input.branch);
      if (entries.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Nothing to reconcile on that branch" });

      const plans = entries.map((entry) => ({ entry, plan: planFor(entry) }));
      const photoIds = plans.filter(({ entry, plan }) => needsPhotoEvidence(entry, plan)).map(({ entry }) => entry.branchHead.id);
      const have = await photoCounts(ctx.tx, GIS_ASSET_FILES, photoIds);
      const entities = plans.map(({ entry, plan }) => ({
        id: entry.branchHead.id,
        entityType: entry.kind.entityType,
        name: entityName(entry),
        ...describePlan(entry, plan),
        /** A required photo hasn't been uploaded yet: posting would be refused. */
        needsPhoto: photoIds.includes(entry.branchHead.id) && (have.get(entry.branchHead.id) ?? 0) === 0,
      }));
      return {
        branch: input.branch,
        token: headsToken(entries),
        origin: (await ctx.work.annotateBranches(ctx.tx, [input.branch])).get(input.branch) ?? null,
        entities,
        summary: {
          writes: entities.filter((e) => e.kind === "write").length,
          skipped: entities.filter((e) => e.kind === "skip").length,
          conflicts: entities.filter((e) => e.kind === "conflict").length,
          needPhoto: entities.filter((e) => e.needsPhoto).length,
        },
      };
    }),

    /**
     * Post a branch onto main: all of it or none of it, across every kind of entity.
     * Anything unresolved is reported back and nothing is written. Otherwise every change
     * lands in one savepoint, references are checked on main, and only if they hold is the
     * branch retired (its rows stay as history); if they don't, nothing is written and the
     * problems come back as `status: "invalid"`. A job's branch whose job isn't completed
     * comes back `not_approved` unless `override` is set; a cancelled job's branch can only
     * be discarded.
     */
    post: p.post
      .input(
        z.object({
          branch: BranchSchema,
          token: z.string().min(1),
          /** entity id → field → which side wins */
          resolutions: z.record(z.string(), z.record(z.string(), z.enum(["branch", "main"]))).optional(),
          /** Post a branch whose job hasn't been approved yet ("Post anyway"). */
          override: z.boolean().default(false),
        }),
      )
      .mutation(async ({ ctx, input }) => {
        assertNotMain(input.branch);
        const origin = (await ctx.work.annotateBranches(ctx.tx, [input.branch])).get(input.branch) ?? null;
        if (origin?.status === "cancelled") {
          throw new TRPCError({ code: "CONFLICT", message: `${origin.ref} was cancelled, so its changes can only be discarded` });
        }
        if (origin && origin.status !== "completed" && !input.override) return { status: "not_approved" as const, origin };
        const userId = ctx.session.user.id;
        try {
          // A savepoint: an integrity failure rolls back every write, then answers normally.
          const result = await ctx.tx.transaction(async (tx) => {
            const entries = await loadEntries(tx, ctx.organizationId, input.branch);
            if (entries.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Nothing to reconcile on that branch" });
            if (headsToken(entries) !== input.token) {
              throw new TRPCError({ code: "CONFLICT", message: "The branch changed since you reviewed it: review it again" });
            }
            const plans = entries.map((entry) => ({ entry, plan: planFor(entry, input.resolutions?.[entry.branchHead.id]) }));
            const unresolved = plans.filter((x) => x.plan.kind === "conflict");
            if (unresolved.length > 0) {
              return {
                status: "conflicts" as const,
                conflicts: unresolved.map(({ entry, plan }) => ({
                  id: entry.branchHead.id,
                  entityType: entry.kind.entityType,
                  name: entityName(entry),
                  conflicts: plan.kind === "conflict" ? plan.conflicts.map(wireConflict) : [],
                })),
              };
            }

            // Retire the branch first: if two people post it at once, only one flips these heads.
            for (const { entry } of plans) await retireHead(tx, entry.kind, entry.branchHead.versionId);

            const summary = { created: 0, fastForwarded: 0, merged: 0, deleted: 0, restored: 0, skipped: 0 };
            const applied: Applied[] = [];
            for (const kind of KINDS) {
              for (const { entry, plan } of plans) {
                if (entry.kind !== kind) continue;
                if (plan.kind !== "write") {
                  summary.skipped++;
                  continue;
                }
                applied.push(await applyWrite(tx, { orgId: ctx.organizationId, userId, branch: input.branch, entry, plan }));
                if (plan.mode === "create") summary.created++;
                else if (plan.mode === "fast-forward") summary.fastForwarded++;
                else if (plan.mode === "merge") summary.merged++;
                else if (plan.mode === "delete") summary.deleted++;
                else summary.restored++;
              }
            }

            const violations = await findViolations(tx, ctx.organizationId, applied);
            if (violations.length > 0) throw new IntegrityFailure(violations);

            // A captured connection is real now: Accounts may pick it up (no customers in GIS).
            for (const a of applied.filter((x) => x.entityType === "connection" && x.mode === "create" && !x.tombstone)) {
              await emit(tx, ctx.organizationId, gisConnectionPosted, {
                connectionId: a.id,
                connectionNumber: String(a.next.connectionNumber),
                location: a.next.location as { lat: number; lng: number },
                servicePointId: (a.next.servicePointId as string | null) ?? null,
                pipeId: (a.next.pipeId as string | null) ?? null,
                branch: input.branch,
                postedByUserId: userId,
              });
            }
            return { status: "posted" as const, summary };
          });
          if (result.status === "posted") {
            await ctx.audit({
              action: "gis.post",
              subjectType: "gis_branch",
              subjectId: input.branch,
              after: { ...result.summary, override: input.override, origin: origin?.ref ?? null },
            });
          }
          return result;
        } catch (err) {
          if (err instanceof IntegrityFailure) return { status: "invalid" as const, violations: err.violations };
          rethrowDbError(err);
        }
      }),

    /** Abandon a branch. Its rows stay as history; it just stops being anyone's view of the network. */
    discard: p.post.input(z.object({ branch: BranchSchema })).mutation(async ({ ctx, input }) => {
      assertNotMain(input.branch);
      let discarded = 0;
      for (const kind of KINDS) {
        const table = kind.table;
        const flipped = await ctx.tx
          .update(table)
          .set({ isHead: false } as never)
          .where(and(eq(table.organizationId, ctx.organizationId), eq(table.branch, input.branch), eq(table.isHead, true)))
          .returning({ versionId: table.versionId });
        discarded += flipped.length;
      }
      if (discarded === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Nothing to discard on that branch" });
      await ctx.audit({ action: "gis.discard", subjectType: "gis_branch", subjectId: input.branch, after: { discarded } });
      return { discarded };
    }),
  });
}
