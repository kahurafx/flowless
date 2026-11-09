import { TRPCError } from "@trpc/server";

/** NOT_FOUND for a record the caller named (or could not see): "<what> not found". */
export const notFound = (what: string) => new TRPCError({ code: "NOT_FOUND", message: `${what} not found` });
