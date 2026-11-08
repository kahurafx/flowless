import { MAIN_BRANCH } from "@flowless/shared-types";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

/*
 * Input schemas and small helpers every GIS router shares (Majimap's kernel/schemas.ts,
 * values.ts, time.ts and db-errors.ts). Locations on the GIS wire are `{ lat, lng }` (the
 * database's and @flowless/network's LatLng); the kernel ports convert to GeoPoint.
 */

export const MAIN = MAIN_BRANCH;

/**
 * Entity ids may come from the client (an offline device names what it creates before it
 * reaches the server, which also makes retries idempotent), so they are validated: uuids.
 */
export const EntityId = z.uuid();
export const VersionId = z.uuid();

export const GeoPointInput = z.object({ lat: z.number().min(-90).max(90), lng: z.number().min(-180).max(180) });

export const BranchSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[A-Za-z0-9._-]+$/, "Branch names may only contain letters, numbers, dots, dashes and underscores");

/** Drop undefined keys so a partial patch can be spread over a full row without erasing fields. */
export function compact<T extends Record<string, unknown>>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** A patch must change something. */
export const nonEmpty = (patch: Record<string, unknown>) => Object.values(patch).some((v) => v !== undefined);

/**
 * How far ahead of the server a device's clock may claim something happened. A time far
 * in the future would outrank everything real that follows it.
 */
const MAX_CLOCK_AHEAD_MS = 24 * 60 * 60 * 1000;
export function deviceTime(value: Date | undefined): Date {
  const when = value ?? new Date();
  if (when.getTime() > Date.now() + MAX_CLOCK_AHEAD_MS) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That time is more than a day in the future: check the device's clock" });
  }
  return when;
}

function pgErrorChain(err: unknown): { code?: string; message?: string; constraint_name?: string; constraint?: string }[] {
  const chain: { code?: string; message?: string }[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
    chain.push(current as { code?: string; message?: string });
    current = (current as { cause?: unknown }).cause;
  }
  return chain;
}

/** Turns a Postgres error into something the caller can act on; anything else is rethrown as it is. */
export function rethrowDbError(err: unknown): never {
  if (err instanceof TRPCError) throw err;
  const chain = pgErrorChain(err);
  const constraint = (e: (typeof chain)[number]) => e.constraint_name ?? e.constraint;
  if (chain.some((e) => e.code === "23505" && constraint(e) === "service_connection_number_unique")) {
    throw new TRPCError({ code: "CONFLICT", message: "That connection number is already in use", cause: err });
  }
  if (chain.some((e) => e.code === "23505")) {
    throw new TRPCError({ code: "CONFLICT", message: "This was created or changed concurrently: refetch and try again", cause: err });
  }
  if (chain.some((e) => e.code === "23503")) {
    throw new TRPCError({ code: "CONFLICT", message: "Something still refers to this, or what it refers to no longer exists", cause: err });
  }
  if (chain.some((e) => e.code === "23514")) {
    throw new TRPCError({ code: "BAD_REQUEST", message: "That value isn't allowed: check the sizes and details and try again", cause: err });
  }
  const rule = chain.find((e) => /may not be housed|does not reference an existing structure/.test(e.message ?? ""));
  if (rule) throw new TRPCError({ code: "BAD_REQUEST", message: rule.message ?? "Invalid structure attachment", cause: err });
  throw err;
}

/** Runs `fn`, mapping database errors. */
export async function guarded<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    rethrowDbError(err);
  }
}
