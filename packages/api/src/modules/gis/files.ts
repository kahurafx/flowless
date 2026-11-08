import { asset } from "@flowless/db/schema/gis";
import { TRPCError } from "@trpc/server";
import { eq } from "drizzle-orm";
import { defineFileSubject } from "../../kernel/file-subjects";

/** The file subject kind for photos and documents on GIS assets (nodes, pipes, structures, connections). */
export const GIS_ASSET_FILES = "gis_asset";

/**
 * Photos on network assets (K-08, ported from Majimap's node, pipe and structure
 * attachments). Reading needs `gis:read`, adding and removing `gis:edit`; the asset must be
 * this organization's, which also covers a proposed asset that exists only on a branch, so
 * a technician can photograph what they capture before it is posted. Members who may post
 * (`gis:post`) manage everyone's files. Required photos (NODE_PHOTO_RULE) are checked when
 * a branch is posted.
 */
export const gisAssetFileSubject = defineFileSubject({
  kind: GIS_ASSET_FILES,
  module: "gis",
  label: "Network asset",
  async authorize(ctx, subjectId, mode) {
    const notFound = () => new TRPCError({ code: "NOT_FOUND", message: "Asset not found" });
    if (!ctx.permissions.has("gis:read") || !/^[0-9a-f-]{36}$/i.test(subjectId)) throw notFound();
    const [found] = await ctx.tx.select({ id: asset.id }).from(asset).where(eq(asset.id, subjectId)).limit(1);
    if (!found) throw notFound();
    if (mode !== "read" && !ctx.permissions.has("gis:edit")) throw new TRPCError({ code: "FORBIDDEN", message: "Missing permission: gis:edit" });
    return { manage: ctx.permissions.has("gis:post") };
  },
});
