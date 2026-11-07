/** Postgres error codes the kernel maps to client errors. Drizzle wraps the driver error in `cause`. */
const pgCode = (error: unknown) => (error as { cause?: { code?: string } })?.cause?.code;

/** foreign_key_violation: a referenced row does not exist in this organization. */
export const isForeignKeyViolation = (error: unknown) => pgCode(error) === "23503";

/** unique_violation: e.g. a code already used in this organization. */
export const isUniqueViolation = (error: unknown) => pgCode(error) === "23505";
