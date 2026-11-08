import { file, type Transaction } from "@flowless/db";
import { DEFAULT_FILE_LIMITS, FILE_MIME_TYPES, isPhoto, type ModuleKey, type Permission, type Scope } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { and, count, desc, eq, like, lt, not, sql } from "drizzle-orm";
import { z } from "zod";
import { router, tenantProcedure } from "../trpc";
import { fileSubjects } from "./file-subject-registry";
import { subjectLicensed, type FileSubjectDef } from "./file-subjects";
import { defaultStorage, type Storage } from "./storage";

type Row = typeof file.$inferSelect;

/** A file announced and never uploaded stops counting toward the limits after a day. */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;
const UPLOAD_URL_SECONDS = 15 * 60;
const DOWNLOAD_URL_SECONDS = 15 * 60;

const safeName = (name: string) => name.replace(/[^A-Za-z0-9._-]/g, "_");
/** Tenant first (NF-01): an organization's files can be listed, exported or removed by prefix. */
const keyFor = (organizationId: string, f: { subjectKind: string; subjectId: string; id: string; fileName: string }) =>
  `${organizationId}/${f.subjectKind}/${safeName(f.subjectId)}/${f.id}/${safeName(f.fileName)}`;

function present(row: Row) {
  return {
    id: row.id,
    subjectKind: row.subjectKind,
    subjectId: row.subjectId,
    fileName: row.fileName,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    kind: isPhoto(row.mimeType) ? ("photo" as const) : ("document" as const),
    status: row.status,
    position: row.latitude !== null && row.longitude !== null ? { latitude: row.latitude, longitude: row.longitude } : null,
    capturedAt: row.capturedAt,
    uploadedByUserId: row.uploadedByUserId,
    uploadedAt: row.uploadedAt,
  };
}

interface Ctx {
  tx: Transaction;
  organizationId: string;
  session: { user: { id: string } };
  permissions: ReadonlySet<Permission>;
  scope(): Promise<Scope>;
  entitlements(): Promise<readonly ModuleKey[]>;
  storage?: Storage;
}

/**
 * The file service (K-08), adopted from Majimap's attachments. A device announces a file
 * (`announce`) and PUTs the bytes to the presigned URL it gets back, then calls `confirm`;
 * the server checks storage before believing it. Who may do what is the subject's call
 * (`FileSubjectDef.authorize`); subjects of unlicensed modules are not found (K-04).
 */
export function createFilesRouter(subjects: readonly FileSubjectDef[]) {
  const storageOf = (ctx: Ctx) => ctx.storage ?? defaultStorage();

  async function authorize(ctx: Ctx, kind: string, subjectId: string, mode: "read" | "write" | "remove") {
    const subject = subjects.find((s) => s.kind === kind);
    const licensed = subject && subjectLicensed(subject, await ctx.entitlements());
    if (!subject || !licensed) throw new TRPCError({ code: "NOT_FOUND", message: "Record not found" });
    const { manage } = await subject.authorize(
      { tx: ctx.tx, organizationId: ctx.organizationId, userId: ctx.session.user.id, permissions: ctx.permissions, scope: ctx.scope },
      subjectId,
      mode,
    );
    return { subject, manage, limits: { ...DEFAULT_FILE_LIMITS, ...subject.limits } };
  }

  async function findRow(ctx: Ctx, id: string) {
    const [row] = await ctx.tx.select().from(file).where(eq(file.id, id));
    if (!row) throw new TRPCError({ code: "NOT_FOUND", message: "File not found" });
    return row;
  }

  const ownOrManage = (ctx: Ctx, row: Row, manage: boolean, message: string) => {
    if (row.uploadedByUserId !== ctx.session.user.id && !manage) throw new TRPCError({ code: "FORBIDDEN", message });
  };

  return router({
    /**
     * Announces a file and returns where to PUT the bytes. Safe to repeat with the same
     * id: it returns the same file, with a fresh upload URL while the bytes are missing.
     * Runs under a lock per record, so two devices cannot both slip past a limit.
     */
    announce: tenantProcedure
      .input(
        z
          .object({
            id: z.uuid(),
            subjectKind: z.string(),
            subjectId: z.string().min(1).max(200),
            fileName: z.string().trim().min(1).max(200),
            mimeType: z.enum(FILE_MIME_TYPES),
            sizeBytes: z.number().int().min(1),
            latitude: z.number().min(-90).max(90).optional(),
            longitude: z.number().min(-180).max(180).optional(),
            capturedAt: z.date().optional(),
          })
          .refine((v) => (v.latitude === undefined) === (v.longitude === undefined), "Give both latitude and longitude, or neither"),
      )
      .mutation(async ({ ctx, input }) => {
        const { limits } = await authorize(ctx, input.subjectKind, input.subjectId, "write");
        if (input.sizeBytes > limits.maxBytes) {
          throw new TRPCError({ code: "BAD_REQUEST", message: `Files can be at most ${Math.floor(limits.maxBytes / 1024 / 1024)} MB` });
        }
        await ctx.tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`file:${ctx.organizationId}:${input.subjectKind}:${input.subjectId}`}, 0))`,
        );

        const storage = storageOf(ctx);
        const [existing] = await ctx.tx.select().from(file).where(eq(file.id, input.id));
        let row: Row;
        if (existing) {
          if (existing.subjectKind !== input.subjectKind || existing.subjectId !== input.subjectId) {
            throw new TRPCError({ code: "CONFLICT", message: "That id is already in use" });
          }
          row =
            existing.status === "pending"
              ? ((await ctx.tx.update(file).set({ announcedAt: new Date() }).where(eq(file.id, existing.id)).returning())[0] ?? existing)
              : existing;
        } else {
          const sameRecord = and(eq(file.subjectKind, input.subjectKind), eq(file.subjectId, input.subjectId));
          const expired = await ctx.tx
            .delete(file)
            .where(and(sameRecord, eq(file.status, "pending"), lt(file.announcedAt, new Date(Date.now() - PENDING_TTL_MS))))
            .returning({ key: file.storageKey });
          const photo = isPhoto(input.mimeType);
          const [counted] = await ctx.tx
            .select({ n: count() })
            .from(file)
            .where(and(sameRecord, photo ? like(file.mimeType, "image/%") : not(like(file.mimeType, "image/%"))));
          const limit = photo ? limits.photos : limits.documents;
          if ((counted?.n ?? 0) >= limit) {
            throw new TRPCError({ code: "BAD_REQUEST", message: `At most ${limit} ${photo ? "photos" : "documents"} can be attached` });
          }
          const [inserted] = await ctx.tx
            .insert(file)
            .values({
              id: input.id,
              organizationId: ctx.organizationId,
              subjectKind: input.subjectKind,
              subjectId: input.subjectId,
              fileName: input.fileName,
              storageKey: keyFor(ctx.organizationId, input),
              mimeType: input.mimeType,
              sizeBytes: input.sizeBytes,
              latitude: input.latitude ?? null,
              longitude: input.longitude ?? null,
              capturedAt: input.capturedAt ?? null,
              uploadedByUserId: ctx.session.user.id,
            })
            // An id taken in another organization: RLS hides the row, the primary key does not.
            .onConflictDoNothing()
            .returning();
          if (!inserted) throw new TRPCError({ code: "CONFLICT", message: "That id is already in use" });
          row = inserted;
          // An orphaned object is harmless, so cleaning up storage is best effort.
          await Promise.all(expired.map((e) => storage.delete(e.key).catch(() => undefined)));
        }

        const upload =
          row.status === "pending"
            ? await storage.presignPut(row.storageKey, { mimeType: row.mimeType, sizeBytes: row.sizeBytes, expiresInSec: UPLOAD_URL_SECONDS })
            : null;
        return { file: present(row), upload };
      }),

    /**
     * The device says the bytes are up; the server checks storage before believing it. A
     * file whose size differs from its announcement is removed (committed, so not thrown)
     * and `problem` says to add it again.
     */
    confirm: tenantProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
      const row = await findRow(ctx, input.id);
      const { manage } = await authorize(ctx, row.subjectKind, row.subjectId, "write");
      ownOrManage(ctx, row, manage, "Only the person who added a file can confirm it");
      if (row.status === "uploaded") return { file: present(row), problem: null };

      const storage = storageOf(ctx);
      const stored = await storage.head(row.storageKey);
      if (!stored) throw new TRPCError({ code: "PRECONDITION_FAILED", message: "The file hasn't finished uploading" });
      if (stored.sizeBytes !== row.sizeBytes) {
        await storage.delete(row.storageKey).catch(() => undefined);
        await ctx.tx.delete(file).where(eq(file.id, row.id));
        return { file: null, problem: "The uploaded file doesn't match what was announced. Add it again." };
      }
      const [updated] = await ctx.tx.update(file).set({ status: "uploaded", uploadedAt: new Date() }).where(eq(file.id, row.id)).returning();
      await ctx.audit({
        action: "files.add",
        subjectType: row.subjectKind,
        subjectId: row.subjectId,
        after: { file: row.id, name: row.fileName, sizeBytes: row.sizeBytes },
      });
      return { file: present(updated!), problem: null };
    }),

    /** Uploaded files of one record, newest first, each with a short-lived download URL. */
    list: tenantProcedure
      .input(z.object({ subjectKind: z.string(), subjectId: z.string().min(1).max(200) }))
      .query(async ({ ctx, input }) => {
        await authorize(ctx, input.subjectKind, input.subjectId, "read");
        const rows = await ctx.tx
          .select()
          .from(file)
          .where(and(eq(file.subjectKind, input.subjectKind), eq(file.subjectId, input.subjectId), eq(file.status, "uploaded")))
          .orderBy(desc(file.uploadedAt));
        const storage = storageOf(ctx);
        return Promise.all(rows.map(async (row) => ({ ...present(row), url: await storage.presignGet(row.storageKey, DOWNLOAD_URL_SECONDS) })));
      }),

    /** Removes a file: the person who added it, or someone the record lets manage its files. */
    remove: tenantProcedure.input(z.object({ id: z.uuid() })).mutation(async ({ ctx, input }) => {
      const row = await findRow(ctx, input.id);
      const { manage } = await authorize(ctx, row.subjectKind, row.subjectId, "remove");
      ownOrManage(ctx, row, manage, "Only the person who added a file can remove it");
      await ctx.tx.delete(file).where(eq(file.id, row.id));
      if (row.status === "uploaded") {
        await ctx.audit({
          action: "files.remove",
          subjectType: row.subjectKind,
          subjectId: row.subjectId,
          before: { file: row.id, name: row.fileName, sizeBytes: row.sizeBytes },
        });
      }
      // A dangling row is worse than an orphaned object.
      await storageOf(ctx).delete(row.storageKey).catch(() => undefined);
    }),
  });
}

export const filesRouter = createFilesRouter(fileSubjects);
